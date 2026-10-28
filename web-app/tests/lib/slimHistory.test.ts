/**
 * slimHistory — the one place the wire copy of the conversation is built.
 *
 * EXTRACTION, not a new rule. Every assertion below pins behaviour that already
 * shipped inside ChatArea.tsx's inline `slimHistory` map.
 *
 * WHAT WOULD LOOK DIFFERENT IF THIS MODULE WERE ABSENT (written before the
 * assertions): the Phase 4b runner builds its own request body, and four of the
 * five rules here fail SILENTLY when they are missing — the POST still
 * succeeds, it just carries the wrong thing.
 *
 *   allowlist       display-only metadata leaks into the context window
 *   turn notices    every old stopped turn replays its failure text forever
 *   attachments     an excluded attachment's base64 goes back on the wire
 *   tool window     the body grows by every past turn's calls, not one
 *   vessel gate     one provider's raw reasoning is fed to another, which is
 *                   exactly what distillation guards look for -> a refusal
 *                   manufactured out of nothing, on a turn nobody is watching
 *
 * So the two load-bearing tests are `exact key set` (the allowlist, whose bug
 * shape is an EXTRA key) and `the third gate` (the vessel comparison). The
 * rest are regressions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSlimHistory,
  stripTurnNotices,
  type SlimHistoryMessage,
  type SlimHistoryOptions,
} from '@/lib/slimHistory';

/** Everything off — the narrowest body NEXUS ever sends. */
function opts(over: Partial<SlimHistoryOptions> = {}): SlimHistoryOptions {
  return {
    hiddenAttachmentsAccessible: false,
    attachmentPathsVisible: false,
    toolHistoryEnabled: false,
    saveThinkingToLog: false,
    turnAiName: 'claude',
    ...over,
  };
}

/** A stored assistant message carrying every display-only field we know of. */
function storedMessage(): Record<string, unknown> {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'the reply',
    timestamp: 1700000000000,
    // --- everything below is display-only and must NOT travel ---
    tokens: 123,
    textTokens: 100,
    thinkingTokens: 23,
    generationMs: 4567,
    modelFamily: 'claude',
    modelSpecific: 'claude-opus-5',
    modelThinking: true,
    modelLabel: 'Claude Opus 5',
    cacheUsage: { totalInputTokens: 10 },
    webSources: [{ url: 'https://example.com' }],
    notices: ['a notice'],
    askedQuestions: [],
    subagentRuns: [],
    thoughtProcess: 'my reasoning',
    claudeThinkingBlocks: [{ thinking: 'my reasoning', signature: 's' }],
    streaming: false,
    autoPlay: true,
    continuationCount: 1,
    thinkingExcluded: false,
    archived: false,
  };
}

describe('buildSlimHistory — the allowlist', () => {
  it('WHAT-BREAKS: a stored message travels as exactly four keys', () => {
    const [slim] = buildSlimHistory([storedMessage() as SlimHistoryMessage], opts());
    assert.deepEqual(Object.keys(slim).sort(), ['content', 'id', 'role', 'timestamp']);
  });

  it('WHAT-BREAKS: values are forwarded unchanged, not re-derived', () => {
    const [slim] = buildSlimHistory([storedMessage() as SlimHistoryMessage], opts());
    assert.equal(slim.id, 'm1');
    assert.equal(slim.role, 'assistant');
    assert.equal(slim.content, 'the reply');
    assert.equal(slim.timestamp, 1700000000000);
  });

  it('absent content becomes the empty string, never the text "undefined"', () => {
    const [slim] = buildSlimHistory([{ id: 'x', role: 'user' }], opts());
    assert.equal(slim.content, '');
  });

  it('returns one entry per input, in order, and copies rather than mutates', () => {
    const input: SlimHistoryMessage[] = [
      { id: 'a', role: 'user', content: 'one' },
      { id: 'b', role: 'assistant', content: 'two' },
    ];
    const before = JSON.stringify(input);
    const out = buildSlimHistory(input, opts());
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(m => m.id), ['a', 'b']);
    assert.equal(JSON.stringify(input), before);
    assert.notEqual(out[0] as unknown, input[0] as unknown);
  });

  it('an empty history is an empty array, not an error', () => {
    assert.deepEqual(buildSlimHistory([], opts()), []);
  });
});

describe('stripTurnNotices', () => {
  it('WHAT-BREAKS: a baked-in stop notice does not replay to the model', () => {
    const body = 'Here is the answer.\n\n⚠️ _[Turn stopped: the operator pressed stop]_';
    assert.equal(stripTurnNotices(body), 'Here is the answer.');
  });

  it('removes every notice in one body, not just the first', () => {
    const body = 'a\n⚠️ _[Turn stopped: one]_\nb\n⚠️ _[Turn stopped: two]_';
    assert.equal(stripTurnNotices(body), 'a\nb');
  });

  it('EXTRACTION FIDELITY: anchors on "]_" so a path with brackets survives', () => {
    const body = 'x\n⚠️ _[Turn stopped: could not read C:\\dir\\[odd]\\f.txt]_\ny';
    assert.equal(stripTurnNotices(body), 'x\ny');
  });

  it('returns the SAME string when there is no notice (the fast path)', () => {
    const body = 'nothing to strip here ⚠️ but a warning sign';
    assert.equal(stripTurnNotices(body), body);
  });

  it('does not touch a body that merely mentions brackets', () => {
    const body = 'see _[note]_ and [other]';
    assert.equal(stripTurnNotices(body), body);
  });

  it('is applied by the builder, not left to the caller', () => {
    const [slim] = buildSlimHistory(
      [{ id: 'a', role: 'assistant', content: 'kept\n⚠️ _[Turn stopped: x]_' }],
      opts(),
    );
    assert.equal(slim.content, 'kept');
  });
});

describe('buildSlimHistory — attachments', () => {
  const withAttachments = (atts: Record<string, unknown>[]): SlimHistoryMessage[] =>
    [{ id: 'a', role: 'user', content: 'see file', attachments: atts }];

  it('WHAT-BREAKS: an excluded attachment does not travel at all', () => {
    const out = buildSlimHistory(
      withAttachments([{ name: 'big.png', excluded: true, dataUrl: 'data:...', ref: 'r1' }]),
      opts(),
    );
    assert.equal('attachments' in out[0], false);
  });

  it('an excluded attachment WITH a ref travels when the entity may open it', () => {
    const out = buildSlimHistory(
      withAttachments([{ name: 'big.png', excluded: true, dataUrl: 'data:X', textData: 'T', ref: 'r1' }]),
      opts({ hiddenAttachmentsAccessible: true }),
    );
    const kept = out[0].attachments as Record<string, unknown>[];
    assert.equal(kept.length, 1);
    // WHAT-BREAKS: the ref travels, the PAYLOAD does not. Sending it would be
    // the 413 the exclusion exists to prevent.
    assert.equal(kept[0].ref, 'r1');
    assert.equal(kept[0].dataUrl, null);
    assert.equal(kept[0].textData, null);
  });

  it('full PC access is the other way an excluded ref becomes worth sending', () => {
    const out = buildSlimHistory(
      withAttachments([{ name: 'b.png', excluded: true, ref: 'r1' }]),
      opts({ attachmentPathsVisible: true }),
    );
    assert.equal((out[0].attachments as unknown[]).length, 1);
  });

  it('an excluded attachment with NO ref is dropped even when hidden ones are allowed', () => {
    const out = buildSlimHistory(
      withAttachments([{ name: 'b.png', excluded: true, dataUrl: 'data:X' }]),
      opts({ hiddenAttachmentsAccessible: true, attachmentPathsVisible: true }),
    );
    assert.equal('attachments' in out[0], false);
  });

  it('WHAT-BREAKS: fileObj is stripped — a File handle cannot be serialised', () => {
    const out = buildSlimHistory(
      withAttachments([{ name: 'ok.png', dataUrl: 'data:X', fileObj: { nope: true } }]),
      opts(),
    );
    const kept = out[0].attachments as Record<string, unknown>[];
    assert.equal('fileObj' in kept[0], false);
    assert.equal(kept[0].dataUrl, 'data:X');
  });

  it('a kept attachment keeps its payload', () => {
    const out = buildSlimHistory(
      withAttachments([{ name: 'ok.png', dataUrl: 'data:X', textData: 'T' }]),
      opts(),
    );
    const kept = out[0].attachments as Record<string, unknown>[];
    assert.equal(kept[0].dataUrl, 'data:X');
    assert.equal(kept[0].textData, 'T');
  });

  it('an empty attachment list adds no key', () => {
    const out = buildSlimHistory(withAttachments([]), opts());
    assert.equal('attachments' in out[0], false);
  });

  it('mixes kept and dropped in one message, preserving order', () => {
    const out = buildSlimHistory(
      withAttachments([
        { name: 'one.png', dataUrl: 'd1' },
        { name: 'two.png', excluded: true },
        { name: 'three.png', dataUrl: 'd3' },
      ]),
      opts(),
    );
    const kept = out[0].attachments as Record<string, unknown>[];
    assert.deepEqual(kept.map(a => a.name), ['one.png', 'three.png']);
  });
});

describe('buildSlimHistory — the tool-call window', () => {
  const bearing = (): SlimHistoryMessage[] => [{
    id: 'a',
    role: 'assistant',
    content: 'done',
    toolCalls: [
      { name: 'Write', input: { path: 'x' }, result: 'ok' },
      { kind: 'event', name: 'notice' },
    ],
  }];

  it('WHAT-BREAKS: with the toggle off, no past call travels', () => {
    const out = buildSlimHistory(bearing(), opts({ toolHistoryEnabled: false }));
    assert.equal('toolCalls' in out[0], false);
  });

  it('with the toggle on, a windowed call travels as name+input ONLY', () => {
    const out = buildSlimHistory(bearing(), opts({ toolHistoryEnabled: true }));
    const calls = out[0].toolCalls as Record<string, unknown>[];
    assert.equal(calls.length, 1, 'the kind:event record is not a call');
    assert.deepEqual(Object.keys(calls[0]).sort(), ['input', 'name']);
    assert.equal(calls[0].name, 'Write');
  });

  it('a message with no id cannot be selected, so nothing is attached', () => {
    const out = buildSlimHistory(
      [{ role: 'assistant', content: 'x', toolCalls: [{ name: 'Write' }] }],
      opts({ toolHistoryEnabled: true }),
    );
    assert.equal('toolCalls' in out[0], false);
  });

  it('a USER message carrying toolCalls is never selected', () => {
    const out = buildSlimHistory(
      [{ id: 'u', role: 'user', content: 'x', toolCalls: [{ name: 'Write' }] }],
      opts({ toolHistoryEnabled: true }),
    );
    assert.equal('toolCalls' in out[0], false);
  });

  it('only notice-shaped records means no key, not an empty array', () => {
    const out = buildSlimHistory(
      [{ id: 'a', role: 'assistant', content: 'x', toolCalls: [{ kind: 'event', name: 'n' }] }],
      opts({ toolHistoryEnabled: true }),
    );
    assert.equal('toolCalls' in out[0], false);
  });

  it('WHAT-BREAKS: the window keeps the NEWEST bearing turns, not all of them', () => {
    // 12 bearing assistant turns, which is more than any window this house
    // ships. The test asserts the SHAPE of the bound, not its value: some
    // turns carry calls and the OLDEST ones do not.
    const many: SlimHistoryMessage[] = Array.from({ length: 12 }, (_v, i) => ({
      id: `m${i}`,
      role: 'assistant',
      content: 'x',
      toolCalls: [{ name: 'Write', input: { i } }],
    }));
    const out = buildSlimHistory(many, opts({ toolHistoryEnabled: true }));
    const carried = out.map(m => 'toolCalls' in m);
    assert.ok(carried.some(Boolean), 'at least the last turn carries its calls');
    assert.ok(carried.includes(false), 'the window is a bound, not everything');
    assert.equal(carried[carried.length - 1], true, 'the newest bearing turn is in');
    assert.equal(carried[0], false, 'the oldest is out');
  });
});

describe('buildSlimHistory — the three thinking gates', () => {
  const thought = (over: Partial<SlimHistoryMessage> = {}): SlimHistoryMessage[] => [{
    id: 'a',
    role: 'assistant',
    content: 'answer',
    modelFamily: 'claude',
    claudeThinkingBlocks: [{ thinking: 'signed reasoning', signature: 'sig' }],
    ...over,
  }];

  it('GATE 1: off by default — thinking is withheld from the wire entirely', () => {
    const out = buildSlimHistory(thought(), opts({ saveThinkingToLog: false }));
    assert.equal('claudeThinkingBlocks' in out[0], false);
  });

  it('GATE 1 on: signed blocks travel, by reference', () => {
    const input = thought();
    const out = buildSlimHistory(input, opts({ saveThinkingToLog: true }));
    assert.equal(out[0].claudeThinkingBlocks, input[0].claudeThinkingBlocks);
  });

  it('GATE 2: a manually excluded message withholds its thinking', () => {
    const out = buildSlimHistory(
      thought({ thinkingExcluded: true }),
      opts({ saveThinkingToLog: true }),
    );
    assert.equal('claudeThinkingBlocks' in out[0], false);
  });

  it('WHAT-BREAKS — GATE 3: another vessel reasoning is NOT replayed', () => {
    // The failure mode is not a wrong answer. It is a refusal manufactured out
    // of nothing: feeding one provider's raw chain-of-thought to another is
    // what distillation guards look for.
    const out = buildSlimHistory(
      thought({ modelFamily: 'gemini' }),
      opts({ saveThinkingToLog: true, turnAiName: 'claude' }),
    );
    assert.equal('claudeThinkingBlocks' in out[0], false);
  });

  it('GATE 3: coming back to a vessel brings your own thinking with you', () => {
    const out = buildSlimHistory(
      thought({ modelFamily: 'gemini' }),
      opts({ saveThinkingToLog: true, turnAiName: 'gemini' }),
    );
    assert.equal((out[0].claudeThinkingBlocks as unknown[]).length, 1);
  });

  it('GATE 3: a message with NO recorded family passes through', () => {
    // Every conversation written before handoff existed is single-vessel;
    // withholding their thinking would be a silent regression there.
    const out = buildSlimHistory(
      thought({ modelFamily: undefined }),
      opts({ saveThinkingToLog: true, turnAiName: 'claude' }),
    );
    assert.equal((out[0].claudeThinkingBlocks as unknown[]).length, 1);
  });

  it('OAuth fallback: thoughtProcess becomes ONE signature-less block', () => {
    const out = buildSlimHistory(
      [{ id: 'a', role: 'assistant', content: 'x', modelFamily: 'claude', thoughtProcess: 'unsigned reasoning' }],
      opts({ saveThinkingToLog: true }),
    );
    assert.deepEqual(out[0].claudeThinkingBlocks, [{ thinking: 'unsigned reasoning', signature: '' }]);
  });

  it('signed blocks WIN over thoughtProcess when both are present', () => {
    const out = buildSlimHistory(
      thought({ thoughtProcess: 'unsigned' }),
      opts({ saveThinkingToLog: true }),
    );
    const blocks = out[0].claudeThinkingBlocks as { thinking: string }[];
    assert.equal(blocks[0].thinking, 'signed reasoning');
  });

  it('an EMPTY block list falls through to thoughtProcess', () => {
    const out = buildSlimHistory(
      thought({ claudeThinkingBlocks: [], thoughtProcess: 'unsigned' }),
      opts({ saveThinkingToLog: true }),
    );
    assert.deepEqual(out[0].claudeThinkingBlocks, [{ thinking: 'unsigned', signature: '' }]);
  });

  it('neither source means no key at all', () => {
    const out = buildSlimHistory(
      [{ id: 'a', role: 'assistant', content: 'x', modelFamily: 'claude' }],
      opts({ saveThinkingToLog: true }),
    );
    assert.equal('claudeThinkingBlocks' in out[0], false);
  });
});

describe('buildSlimHistory — all rules at once', () => {
  it('a realistic turn travels with exactly the keys the rules allow', () => {
    const out = buildSlimHistory(
      [{
        ...storedMessage(),
        content: 'reply\n⚠️ _[Turn stopped: x]_',
        attachments: [
          { name: 'ok.png', dataUrl: 'd', fileObj: {} },
          { name: 'no.png', excluded: true },
        ],
        toolCalls: [{ name: 'Write', input: { p: 1 } }],
      } as SlimHistoryMessage],
      opts({ toolHistoryEnabled: true, saveThinkingToLog: true, turnAiName: 'claude' }),
    );
    assert.deepEqual(
      Object.keys(out[0]).sort(),
      ['attachments', 'claudeThinkingBlocks', 'content', 'id', 'role', 'timestamp', 'toolCalls'],
    );
    assert.equal(out[0].content, 'reply');
  });
});
