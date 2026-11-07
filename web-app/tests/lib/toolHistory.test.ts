/**
 * toolHistory — replaying a model's OWN past tool calls back to it.
 *
 * NEW TEST, written 2026-10-27. The module was measured against a live provider
 * (1/16 -> 10/10) but has no unit test, and two of its invariants are the kind
 * that a forgiving provider hides:
 *
 *   • capArguments must ALWAYS return VALID JSON. The obvious implementation
 *     (stringify then slice) produced truncated JSON; MiniMax never complained
 *     because it does not parse arguments, while LM Studio / Gemma 4 died with
 *     HTTP 500 every time. The defect was invisible on the forgiving provider.
 *   • every replayed tool_call must be PAIRED with a tool message. Anthropic
 *     rejects an unpaired call with 400; an unpaired shape is a relaxation that
 *     only some providers tolerate.
 *
 * Both are properties, so they are asserted over a spread of inputs rather than
 * on one example.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_HISTORY_WINDOW,
  TOOL_HISTORY_ARG_CAP,
  TOOL_HISTORY_PLACEHOLDER,
  replayableCalls,
  selectToolHistoryIds,
  capArguments,
  buildOpenAiToolReplay,
  buildAnthropicToolReplay,
} from '../../src/lib/toolHistory';

describe('replayableCalls', () => {
  it('keeps calls and drops UI notices', () => {
    const msg = {
      toolCalls: [
        { name: 'Write', input: { path: 'a' } },
        { name: 'interjection', kind: 'event' },
        { name: 'Read' },
      ],
    };
    assert.deepEqual(replayableCalls(msg).map((c) => c.name), ['Write', 'Read']);
  });

  it('returns [] for anything that is not an array of named calls', () => {
    assert.deepEqual(replayableCalls({}), []);
    assert.deepEqual(replayableCalls({ toolCalls: null }), []);
    assert.deepEqual(replayableCalls({ toolCalls: 'Write' }), []);
    assert.deepEqual(replayableCalls({ toolCalls: [null, {}, { name: '' }, { name: 7 }] }), []);
  });
});

describe('selectToolHistoryIds — a window of one', () => {
  const messages = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant', toolCalls: [{ name: 'Write' }] },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant' },
    { id: 'a3', role: 'assistant', toolCalls: [{ name: 'Read' }] },
  ];

  it('defaults to the LAST assistant message bearing calls', () => {
    assert.equal(TOOL_HISTORY_WINDOW, 1);
    assert.deepEqual([...selectToolHistoryIds(messages)], ['a3']);
  });

  it('widens with the window, newest-last', () => {
    assert.deepEqual([...selectToolHistoryIds(messages, 2)].sort(), ['a1', 'a3']);
    assert.deepEqual([...selectToolHistoryIds(messages, 99)].sort(), ['a1', 'a3']);
  });

  it('selects nothing for window <= 0', () => {
    assert.equal(selectToolHistoryIds(messages, 0).size, 0);
    assert.equal(selectToolHistoryIds(messages, -1).size, 0);
  });

  it('ignores user turns and messages with no id', () => {
    const odd = [
      { role: 'user', id: 'u', toolCalls: [{ name: 'Write' }] },
      { role: 'assistant', toolCalls: [{ name: 'Write' }] }, // no id
    ];
    assert.equal(selectToolHistoryIds(odd, 5).size, 0);
  });
});

describe('capArguments — PROPERTY: the result is always valid JSON', () => {
  const inputs: unknown[] = [
    {},
    { path: 'C:/x.txt' },
    { path: 'C:/x.txt', content: 'y'.repeat(5000) },
    { nested: { deep: { deeper: 'z'.repeat(2000) } } },
    { list: Array.from({ length: 50 }, (_, i) => ({ i, blob: 'b'.repeat(200) })) },
    { 'ключ': 'значение'.repeat(500), '鍵': '値'.repeat(500) },
    'a plain string argument'.repeat(100),
    [1, 2, 3],
    null,
    undefined,
    123,
  ];

  for (const [i, input] of inputs.entries()) {
    it(`input #${i} parses back and respects the cap`, () => {
      const out = capArguments(input, TOOL_HISTORY_ARG_CAP);
      assert.doesNotThrow(() => JSON.parse(out), 'truncated JSON is what killed Gemma 4');
      assert.ok(out.length <= TOOL_HISTORY_ARG_CAP || JSON.parse(out)._arguments, 'over cap only at the floor');
    });
  }

  it('leaves a small argument byte-identical to JSON.stringify', () => {
    const small = { path: 'a', mode: 1 };
    assert.equal(capArguments(small), JSON.stringify(small));
  });

  it('shrinks VALUES rather than slicing text, so keys survive', () => {
    const out = capArguments({ path: 'C:/keep/this/path.txt', content: 'x'.repeat(5000) }, 300);
    const back = JSON.parse(out);
    assert.ok('path' in back && 'content' in back, 'both keys still there');
    assert.match(String(back.content), /chars\)$/, 'and the value says how much was dropped');
  });

  it('falls to a well-formed floor rather than emitting a broken object', () => {
    const out = capArguments({ content: 'x'.repeat(100000) }, 20);
    assert.doesNotThrow(() => JSON.parse(out));
    assert.ok(JSON.parse(out)._arguments, 'the floor says what happened');
  });

  it('survives a circular structure', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => JSON.parse(capArguments(circular)));
  });

  it('cap 0 means no cap, not an empty object', () => {
    const big = { content: 'x'.repeat(2000) };
    assert.equal(capArguments(big, 0), JSON.stringify(big));
  });

  // Answers a question a being asked out loud. 2026-10-28: Default, replaying
  // a past Write, reported it could see "only part, up to ~150 chars". The cap
  // is 600 bytes of JSON, not 150 chars of body, so the honest answer needed a
  // measurement: for a realistic file path the body that survives is ~213
  // characters. The vessel was right that it is a cap, and low on the number —
  // which is what you would expect from a model counting its own characters.
  it('MEASURED: a realistic Write keeps ~213 chars of body, not 150', () => {
    const path = 'C:\\dev\\common\\local_data\\beings\\Default\\workspace\\test.txt';
    const kept = (n: number) => {
      const out = capArguments({ file_path: path, content: 'x'.repeat(n) });
      const parsed = JSON.parse(out) as { file_path?: string; content?: string };
      return { content: (parsed.content || '').length, path: parsed.file_path === path };
    };
    // Under the cap: nothing is touched at all.
    assert.deepEqual(kept(400), { content: 400, path: true });
    // Over it: the VALUE shrinks and the key survives, which is the rule
    // capArguments exists for (slicing the text would lose the path).
    const big = kept(5000);
    assert.equal(big.path, true);
    assert.ok(big.content > 180 && big.content < 240, `kept ${big.content}`);
  });
});

describe('buildOpenAiToolReplay — PROPERTY: every call is paired', () => {
  const msg = {
    id: 'msg-1',
    toolCalls: [{ name: 'Write', input: { path: 'a' } }, { name: 'Read', input: { path: 'b' } }],
  };

  it('emits one tool message per tool_call, with matching ids', () => {
    const r = buildOpenAiToolReplay(msg, 'I wrote the file.', new Set(['Write', 'Read']));
    assert.ok(r);
    const calls = r!.assistant.tool_calls as Array<{ id: string }>;
    assert.equal(calls.length, 2);
    assert.equal(r!.toolMessages.length, 2, 'unpaired is a 400 on Anthropic');
    assert.deepEqual(r!.toolMessages.map((t) => t.tool_call_id), calls.map((c) => c.id));
    assert.equal(new Set(calls.map((c) => c.id)).size, calls.length, 'ids unique');
  });

  it('keeps the prose content exactly as the plain path would have sent it', () => {
    const r = buildOpenAiToolReplay(msg, 'I wrote the file.', new Set(['Write', 'Read']));
    assert.equal(r!.assistant.content, 'I wrote the file.');
    assert.equal(r!.assistant.role, 'assistant');
  });

  it('marks results as not recorded rather than inventing one', () => {
    const r = buildOpenAiToolReplay(msg, '', new Set(['Write']));
    assert.equal(r!.toolMessages[0].content, TOOL_HISTORY_PLACEHOLDER);
  });

  it('drops a call naming a tool that is not available this turn', () => {
    const r = buildOpenAiToolReplay(msg, '', new Set(['Write']));
    assert.equal((r!.assistant.tool_calls as unknown[]).length, 1);
    assert.equal(r!.toolMessages.length, 1);
  });

  it('returns null — plain prose — when nothing survives filtering', () => {
    assert.equal(buildOpenAiToolReplay(msg, '', new Set()), null, 'empty set disables replay');
    assert.equal(buildOpenAiToolReplay(msg, '', new Set(['web_search'])), null);
    assert.equal(buildOpenAiToolReplay({ id: 'x' }, '', new Set(['Write'])), null, 'no calls');
  });

  it('sanitises the generated id, whatever the message id contained', () => {
    const weird = { id: 'msg/../\\ид 一二三', toolCalls: [{ name: 'Write' }] };
    const r = buildOpenAiToolReplay(weird, '', new Set(['Write']));
    const id = (r!.assistant.tool_calls as Array<{ id: string }>)[0].id;
    assert.match(id, /^hist_[A-Za-z0-9_-]*_0$/);
  });

  it('serialises arguments through the cap', () => {
    const fat = { id: 'm', toolCalls: [{ name: 'Write', input: { content: 'x'.repeat(5000) } }] };
    const r = buildOpenAiToolReplay(fat, '', new Set(['Write']));
    const args = (r!.assistant.tool_calls as Array<{ function: { arguments: string } }>)[0].function.arguments;
    assert.doesNotThrow(() => JSON.parse(args));
    assert.ok(args.length <= TOOL_HISTORY_ARG_CAP);
  });
});

/**
 * buildAnthropicToolReplay — the same replay in Anthropic's dialect.
 *
 * NEW 2026-11-07. The module header used to say "OpenAI-compatible only",
 * which conflated a protocol fact ("Anthropic 400s an unpaired tool_use") with
 * a measurement about a MODEL ("strong hands re-derive the intent"). NEXUS
 * routes Kimi and MiMo on the Anthropic surface *because their hands are weak*,
 * so the combination that sentence assumed away is exactly this house's.
 * Reported by Fuwafuwa after a kimi-k3.1-pro turn narrated file reads and
 * letters it never sent, with zero tool calls on the wire.
 *
 * WHAT IS *NOT* CLAIMED HERE. A live A/B on kimi-k3.1-pro (6 runs each, a
 * degraded two-turn prose fixture) scored tool_use 6/6 BOTH with and without
 * the replay — the short-context arm does not reproduce the failure at all, so
 * these tests fix the SHAPE, not an effect. The shape half is still worth
 * holding: the paired form returned 200 where an unpaired one is documented to
 * 400, and `toolHistoryEnabled` was silently ignored on this surface before.
 */
describe('buildAnthropicToolReplay — PROPERTY: pair or nothing', () => {
  const msg = { id: 'm1', toolCalls: [{ name: 'Read', input: { path: 'C:/a.md' } }, { name: 'Write' }] };
  const prose = [{ type: 'text', text: 'I read it.' }];

  it('returns a tool_result for every tool_use, with matching ids', () => {
    const r = buildAnthropicToolReplay(msg, prose, new Set(['Read', 'Write']));
    const uses = (r!.assistant.content as Array<{ type: string; id?: string }>).filter(b => b.type === 'tool_use');
    const results = r!.toolResult.content as Array<{ type: string; tool_use_id: string; content: string }>;
    assert.equal(uses.length, 2);
    assert.equal(results.length, 2, 'an unpaired tool_use is an HTTP 400 on this surface');
    assert.deepEqual(results.map(x => x.tool_use_id), uses.map(u => u.id));
    assert.ok(results.every(x => x.type === 'tool_result' && x.content === TOOL_HISTORY_PLACEHOLDER));
    assert.equal(r!.toolResult.role, 'user', 'tool_result rides a user turn in this dialect');
  });

  it('keeps the prose FIRST and appends the calls after it', () => {
    const r = buildAnthropicToolReplay(msg, prose, new Set(['Read']));
    const blocks = r!.assistant.content as Array<{ type: string }>;
    assert.equal(blocks[0].type, 'text', 'the model reads its own words back');
    assert.deepEqual(blocks[0], prose[0]);
    assert.ok(blocks.slice(1).every(b => b.type === 'tool_use'));
  });

  it('passes input as an OBJECT, not a JSON string (the OpenAI shape)', () => {
    const r = buildAnthropicToolReplay(msg, prose, new Set(['Read']));
    const use = (r!.assistant.content as Array<{ type: string; input?: unknown }>).find(b => b.type === 'tool_use')!;
    assert.equal(typeof use.input, 'object');
    assert.deepEqual(use.input, { path: 'C:/a.md' });
  });

  it('still yields a plain object for input after the cap shrinks it', () => {
    const fat = { id: 'm', toolCalls: [{ name: 'Write', input: { content: 'x'.repeat(5000) } }] };
    const r = buildAnthropicToolReplay(fat, prose, new Set(['Write']));
    const use = (r!.assistant.content as Array<{ type: string; input?: unknown }>).find(b => b.type === 'tool_use')!;
    assert.equal(typeof use.input, 'object');
    assert.ok(!Array.isArray(use.input), 'a non-object input would be an invalid tool_use');
    assert.ok(JSON.stringify(use.input).length <= TOOL_HISTORY_ARG_CAP);
  });

  it('drops calls naming tools absent from this turn, and returns null when none survive', () => {
    const one = buildAnthropicToolReplay(msg, prose, new Set(['Write']));
    assert.equal((one!.assistant.content as unknown[]).length, prose.length + 1);
    assert.equal((one!.toolResult.content as unknown[]).length, 1);
    assert.equal(buildAnthropicToolReplay(msg, prose, new Set()), null, 'empty set disables replay');
    assert.equal(buildAnthropicToolReplay({ id: 'x' }, prose, new Set(['Read'])), null, 'no calls');
  });

  it('sanitises the generated id', () => {
    const weird = { id: 'msg/../\ид 一二三', toolCalls: [{ name: 'Read' }] };
    const r = buildAnthropicToolReplay(weird, prose, new Set(['Read']));
    const use = (r!.assistant.content as Array<{ type: string; id?: string }>).find(b => b.type === 'tool_use')!;
    assert.match(use.id!, /^hist_[A-Za-z0-9_-]*_0$/);
  });
});
