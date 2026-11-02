/**
 * turnEvents — normalising the SSE payloads a turn emits.
 *
 * EXTRACTION, not a new rule. Every function under test is a transcription
 * of a statement that lived inline in ChatArea.tsx's generateAiResponse, so
 * most assertions below pin behaviour that already shipped. Their job is to
 * fail if the Phase 4b runner's copy, or a later edit, drifts from it —
 * which matters more here than usual, because the output of these rules is
 * what gets written to the conversation log. A divergence would make the
 * saved log depend on WHO ran the turn.
 *
 * The ones marked WHAT-BREAKS are the ones where I wrote down what would
 * look different in the product if the property were absent, BEFORE writing
 * the assertion. Two of them caught me during the extraction itself: I had
 * "improved" `findOpenSubagentRun` (normalising task to '') and
 * `collapseBetrayalPhrases` (coercing Map keys to string) while transcribing
 * them. Both are reverted; the tests below pin the ORIGINAL behaviour,
 * including the parts nothing relies on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseHandoff,
  normaliseCacheUsage,
  normaliseWebSources,
  normaliseNotice,
  collapseBetrayalPhrases,
  betrayalNoticeKey,
  normaliseToolCall,
  normaliseToolAttachment,
  findOpenSubagentRun,
  resolveToolActivity,
} from '../../src/lib/turnEvents';

describe('normaliseHandoff', () => {
  it('WHAT-BREAKS: missing fields become "", never the text "undefined"', () => {
    // Without this: the plan is read AFTER the teardown to build the next
    // request, and these values are interpolated into labels and model ids.
    // An absent field would travel as undefined and render as "undefined"
    // in the UI, or be sent as a model id of that name.
    const p = normaliseHandoff({});
    assert.equal(p.family, '');
    assert.equal(p.specificModel, '');
    assert.equal(p.label, '');
    assert.equal(p.note, '');
    assert.equal(p.fromFamily, '');
    assert.equal(p.fromSpecificModel, '');
    assert.equal(p.fromLabel, '');
    assert.equal(p.thinking, false);
    for (const v of Object.values(p)) assert.notEqual(v, 'undefined');
  });

  it('copies all eight fields through', () => {
    const p = normaliseHandoff({
      family: 'claude', specificModel: 'claude-opus-5', label: 'Opus 5',
      thinking: 1, note: 'handing over', fromFamily: 'gemini',
      fromSpecificModel: 'gemini-3.8-flash', fromLabel: 'Flash',
    });
    assert.deepEqual(p, {
      family: 'claude', specificModel: 'claude-opus-5', label: 'Opus 5',
      thinking: true, note: 'handing over', fromFamily: 'gemini',
      fromSpecificModel: 'gemini-3.8-flash', fromLabel: 'Flash',
    });
  });
});

describe('normaliseCacheUsage', () => {
  it('WHAT-BREAKS: reportedUsd is ABSENT, not 0, when the provider is silent', () => {
    // Without this: a stored 0 says "the provider told us it cost nothing",
    // an absent key says "the provider did not say". The cost column renders
    // those differently, and zeroing turns an unknown into a claim.
    const u = normaliseCacheUsage({ totalInputTokens: 10 });
    assert.equal('reportedUsd' in u, false);
    assert.equal('serverToolCalls' in u, false);
  });

  it('WHAT-BREAKS: a reported zero is also absent, not stored as 0', () => {
    // The guard is `> 0`, not `!== undefined`. Pinned because the obvious
    // "simplification" to a presence check would change what reaches disk.
    const u = normaliseCacheUsage({ reportedUsd: 0, serverToolCalls: 0 });
    assert.equal('reportedUsd' in u, false);
    assert.equal('serverToolCalls' in u, false);
  });

  it('keeps positive extras and coerces the six base counters', () => {
    const u = normaliseCacheUsage({
      cachedInputTokens: '5', uncachedInputTokens: 6, totalInputTokens: 11,
      outputTokens: 7, cacheCreationTokens: 2, providerHint: 'anthropic',
      reportedUsd: 0.25, serverToolCalls: 3,
    });
    assert.deepEqual(u, {
      cachedInputTokens: 5, uncachedInputTokens: 6, totalInputTokens: 11,
      outputTokens: 7, cacheCreationTokens: 2, providerHint: 'anthropic',
      reportedUsd: 0.25, serverToolCalls: 3,
    });
  });

  it('absent counters are 0 and providerHint is "", not NaN or undefined', () => {
    const u = normaliseCacheUsage({});
    assert.equal(u.cachedInputTokens, 0);
    assert.equal(u.totalInputTokens, 0);
    assert.equal(u.providerHint, '');
    for (const k of ['cachedInputTokens', 'uncachedInputTokens', 'totalInputTokens',
      'outputTokens', 'cacheCreationTokens'] as const) {
      assert.equal(Number.isNaN(u[k]), false, `${k} must not be NaN`);
    }
  });
});

describe('normaliseWebSources', () => {
  it('WHAT-BREAKS: an empty list returns null so the caller keeps its value', () => {
    // Without this: a later event carrying no sources would overwrite a real
    // earlier list with [], which renders as "this search found nothing"
    // rather than "this frame carried nothing".
    assert.equal(normaliseWebSources({}), null);
    assert.equal(normaliseWebSources({ sources: [] }), null);
    assert.equal(normaliseWebSources({ sources: 'not an array' }), null);
  });

  it('drops entries with no url and omits absent titles', () => {
    const s = normaliseWebSources({
      sources: [
        { url: 'https://a.example', title: 'A' },
        { url: 'https://b.example' },
        { title: 'no url' },
        null,
        { url: 42 },
      ],
    });
    assert.deepEqual(s, [
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example' },
    ]);
    // Omitted, not set to undefined: the bubble renders a source with a
    // title differently, and `{title: undefined}` would pass a truthiness
    // check on the key.
    assert.equal(Object.prototype.hasOwnProperty.call(s![1], 'title'), false);
  });
});

describe('normaliseNotice', () => {
  it('WHAT-BREAKS: blank content yields null, so no empty notice row appears', () => {
    // Without this: a whitespace-only frame adds a visible warning row with
    // no text, which reads as a diagnostic the reader failed to understand.
    assert.equal(normaliseNotice({ content: '   ' }), null);
    assert.equal(normaliseNotice({ content: '' }), null);
    assert.equal(normaliseNotice({}), null);
    assert.equal(normaliseNotice({ content: 123 }), null);
  });

  it('trims surviving content', () => {
    assert.equal(normaliseNotice({ content: '  stopped early \n' }), 'stopped early');
  });
});

describe('collapseBetrayalPhrases', () => {
  it('WHAT-BREAKS: one phrase said eight times reads as one finding, not eight', () => {
    // Without this: the raw join printed the phrase eight times, which reads
    // as eight different hits. That is the whole reason this collapse exists.
    assert.equal(collapseBetrayalPhrases(['as an AI', 'as an AI', 'as an AI']),
      'as an AI ×3');
  });

  it('keeps first-seen order and leaves singletons uncounted', () => {
    assert.equal(
      collapseBetrayalPhrases(['beta', 'alpha', 'beta']),
      'beta ×2, alpha',
    );
  });

  it('non-array input yields ""', () => {
    assert.equal(collapseBetrayalPhrases(undefined), '');
    assert.equal(collapseBetrayalPhrases('as an AI'), '');
  });

  it('EXTRACTION FIDELITY: Map keys are not coerced to string', () => {
    // While transcribing I "improved" this to String(p), which would merge
    // 1 and "1" into one entry with x2. The guard never sends a mixed list,
    // so nothing observable depends on it today -- which is exactly why an
    // identity-preserving extraction must not quietly decide it.
    assert.equal(collapseBetrayalPhrases([1, '1']), '1, 1');
  });
});

describe('betrayalNoticeKey', () => {
  it('WHAT-BREAKS: three outcomes get three different sentences', () => {
    // Without this: "nothing was deleted" has two quite different reasons --
    // the defence is off, or this turn read a file and the guard stood down
    // by itself -- and telling them apart is the difference between a
    // warning you can act on and one you cannot.
    assert.equal(betrayalNoticeKey({ redacted: true }), 'notice.betrayal.redacted');
    assert.equal(betrayalNoticeKey({ quoting: true }), 'notice.betrayal.quoting');
    assert.equal(betrayalNoticeKey({}), 'notice.betrayal.detected');
  });

  it('redacted wins over quoting', () => {
    assert.equal(betrayalNoticeKey({ redacted: true, quoting: true }),
      'notice.betrayal.redacted');
  });
});

describe('normaliseToolCall', () => {
  it('WHAT-BREAKS: thinkingOffset anchors the chip where the model paused', () => {
    // Without this: every chip renders in arrival order at the end of the
    // thinking panel, losing the think -> call -> think sequence that is the
    // whole point of showing them inline.
    const c = normaliseToolCall({ call: { name: 'Read', input: { x: 1 } } }, 512);
    assert.equal(c?.thinkingOffset, 512);
    assert.equal(c?.name, 'Read');
    assert.deepEqual(c?.input, { x: 1 });
  });

  it('WHAT-BREAKS: a call with no string name is dropped, not recorded', () => {
    // Without this: the tool report would list an entry with no name, and
    // the report exists to answer "was this really called?".
    assert.equal(normaliseToolCall({}, 0), null);
    assert.equal(normaliseToolCall({ call: {} }, 0), null);
    assert.equal(normaliseToolCall({ call: { name: 42 } }, 0), null);
  });

  it('a payload thinkingOffset does not win over the measured one', () => {
    // The spread is of `call`, and thinkingOffset is applied after it.
    const c = normaliseToolCall({ call: { name: 'Write', thinkingOffset: 9 } }, 77);
    assert.equal(c?.thinkingOffset, 77);
  });
});

describe('normaliseToolAttachment', () => {
  it('WHAT-BREAKS: the three isX defaults exist, and the payload can override', () => {
    // Without the defaults: undefined flags make the bubble pick no renderer.
    // Without the payload winning: a tool-produced image would render as a
    // plain file, because the defaults are spread FIRST on purpose.
    const plain = normaliseToolAttachment({ attachment: { name: 'a.txt' } }, () => 'id-1');
    assert.equal(plain.isImage, false);
    assert.equal(plain.isAudio, false);
    assert.equal(plain.isVideo, false);
    assert.equal(plain.id, 'id-1');

    const img = normaliseToolAttachment(
      { attachment: { name: 'a.png', isImage: true } }, () => 'id-2');
    assert.equal(img.isImage, true);
  });

  it('a payload id wins over the generated one', () => {
    const a = normaliseToolAttachment({ attachment: { id: 'from-wire' } }, () => 'gen');
    assert.equal(a.id, 'from-wire');
  });

  it('calls the id generator exactly once per attachment', () => {
    let n = 0;
    normaliseToolAttachment({ attachment: {} }, () => `id-${++n}`);
    assert.equal(n, 1);
  });
});

describe('findOpenSubagentRun', () => {
  it('WHAT-BREAKS: searches BACKWARDS, so the newest open run gets the result', () => {
    // Without this: two dispatches of the same task in one turn would land
    // the second result on the first run, and the real second run would stay
    // open forever -- the chip never clears and the log records the wrong
    // pairing.
    //
    // CORRECTED 2026-10-28, caught by mutation testing. The first version of
    // this test was:
    //     [{task:'audit', result:'first done'}, {task:'audit', result:null},
    //      {task:'other', result:null}]  -> expect runs[1]
    // A FORWARD search passes that, because the only other run with this task
    // is already closed and gets skipped either way. I had even written "a
    // forward search passes every other test in this file" in the comment --
    // and then did not write the case that tells them apart. Telling direction
    // apart needs TWO OPEN runs with the same task.
    const runs: { task: string; result: string | null }[] = [
      { task: 'audit', result: null },   // older, still open
      { task: 'audit', result: null },   // newer, still open  <- must win
      { task: 'other', result: null },
    ];
    const r = findOpenSubagentRun(runs, 'audit');
    assert.equal(r, runs[1]);
    assert.notEqual(r, runs[0]);
  });

  it('skips closed runs to reach an older open one', () => {
    // The direction test above uses two open runs, so this keeps the
    // "closed runs are skipped" property under its own assertion rather
    // than leaving it implied.
    const runs: { task: string; result: string | null }[] = [
      { task: 'audit', result: null },
      { task: 'audit', result: 'done' },
    ];
    assert.equal(findOpenSubagentRun(runs, 'audit'), runs[0]);
  });

  it('returns null when every run with that task is closed', () => {
    const runs = [{ task: 'audit', result: 'done' }];
    assert.equal(findOpenSubagentRun(runs, 'audit'), null);
  });

  it('returns null for an unknown task', () => {
    assert.equal(findOpenSubagentRun([{ task: 'a', result: null }], 'b'), null);
  });

  it('EXTRACTION FIDELITY: task is compared with ===, not normalised', () => {
    // While transcribing I "improved" this to (task ?? '') === task, which
    // makes an undefined task match the empty string. Every run this code
    // creates stores `data.task || ''`, so the case does not arise -- but an
    // extraction does not get to decide which of its inputs are impossible.
    const runs = [{ task: undefined, result: null }];
    assert.equal(findOpenSubagentRun(runs, ''), null);
  });

  it('a result of "" counts as CLOSED, only null is open', () => {
    // The guard is `result === null`. An empty result is a subagent that
    // returned nothing, which is finished.
    const runs = [{ task: 'a', result: '' }];
    assert.equal(findOpenSubagentRun(runs, 'a'), null);
  });
});

describe('resolveToolActivity', () => {
  const echo = (k: string) => k;              // what a runner passes: no i18n
  const dict: Record<string, string> = { 'chat.toolAction.Read': 'read a file' };
  const t = (k: string) => dict[k] ?? k;

  it('WHAT-BREAKS: a missing translation falls back to the server label', () => {
    // Without this: the indicator would show the raw key
    // "chat.toolAction.SomeNewTool" to the reader -- which is how an
    // untranslated key looks when t() returns its argument.
    const a = resolveToolActivity({ tool: 'running a new tool', name: 'SomeNewTool' }, t);
    assert.equal(a?.activity, 'running a new tool');
    assert.equal(a?.localized, false);
  });

  it('uses the translation when there is one, and says so', () => {
    const a = resolveToolActivity({ tool: 'Read', name: 'Read' }, t);
    assert.equal(a?.activity, 'read a file');
    assert.equal(a?.localized, true);
    assert.equal(a?.name, 'Read');
  });

  it('WHAT-BREAKS: no tool means null, which the caller turns into "clear"', () => {
    // Without this: the "finished" frame would be indistinguishable from a
    // frame that started a tool with a blank name, and the spinner would
    // keep claiming a tool is running after the turn moved on.
    assert.equal(resolveToolActivity({}, t), null);
    assert.equal(resolveToolActivity({ tool: '' }, t), null);
    assert.equal(resolveToolActivity({ tool: 42 }, t), null);
  });

  it('name and detail are null (not "") when absent or blank', () => {
    const a = resolveToolActivity({ tool: 'working' }, t);
    assert.equal(a?.name, null);
    assert.equal(a?.detail, null);
    const b = resolveToolActivity({ tool: 'working', name: '', detail: '' }, t);
    assert.equal(b?.name, null);
    assert.equal(b?.detail, null);
  });

  it('an identity t() yields localized=false, which is the runner case', () => {
    // The runner has no language context and passes k => k. It must land on
    // the server label, never on a key.
    const a = resolveToolActivity({ tool: 'read a file', name: 'Read' }, echo);
    assert.equal(a?.localized, false);
    assert.equal(a?.activity, 'read a file');
  });

  it('a nameless activity never consults t()', () => {
    let calls = 0;
    const spy = (k: string) => { calls++; return k; };
    const a = resolveToolActivity({ tool: 'working' }, spy);
    assert.equal(calls, 0);
    assert.equal(a?.activity, 'working');
  });
});
