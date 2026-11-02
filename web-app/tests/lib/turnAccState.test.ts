/**
 * turnAccState — the fourteen accumulator locals of ChatArea's streaming loop,
 * extracted 2026-10-28 into one object so the server-side runner can fill the
 * same state the browser fills.
 *
 * NEW TEST. No probe existed: the state lived inside a React closure, so
 * nothing outside ChatArea could reach it.
 *
 * Most of these were written from the closure they were transcribed from, so
 * they pin what is there rather than proving it right. Three say something a
 * reading cannot:
 *
 *   - COPY-VS-SHARE: the blocks array is copied and the notices array is not.
 *     Getting either backwards is silent in the browser and wrong on disk.
 *   - NO SHARED STATE: two turns must not share arrays.
 *   - CONTRACT: the keys the finalizer actually READS, recorded with a Proxy,
 *     must be exactly the keys the state has. That is the only check here that
 *     can catch the failure this module exists to prevent.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurnAccState,
  assertFinalizable,
  type TurnAccState,
} from '../../src/lib/turnAccState';
import { finalizeTurnMessage } from '../../src/lib/finalizeTurnMessage';

const freshSeed = () => ({
  continuedSeed: '',
  continuedThought: '',
  continuedBlocks: [] as { thinking: string; signature: string }[],
  notices: [] as string[],
});

describe('createTurnAccState — a fresh turn', () => {
  it('starts with nothing accumulated', () => {
    const acc = createTurnAccState(freshSeed());
    assert.equal(acc.currentText, '');
    assert.equal(acc.currentThought, '');
    assert.deepEqual(acc.claudeThinkingBlocks, []);
    assert.equal(acc.continuationCount, 0);
    assert.equal(acc.chosenModelFamily, '');
    assert.equal(acc.chosenModelSpecific, '');
    assert.equal(acc.chosenModelThinking, false);
    assert.equal(acc.chosenModelLabel, '');
    assert.equal(acc.cacheUsage, null);
    assert.equal(acc.webSources, null);
    assert.deepEqual(acc.notices, []);
    assert.deepEqual(acc.toolCalls, []);
    assert.deepEqual(acc.askedQuestions, []);
    assert.deepEqual(acc.subagentRuns, []);
  });

  it('WHAT-BREAKS: the model tag starts EMPTY, not undefined', () => {
    // The streaming flush spreads the four model fields conditionally on
    // chosenModelFamily being truthy. `undefined` would be falsy too, so this
    // does not change the flush — it changes what lands on the message if a
    // caller ever spreads the state directly. Empty string is what the closure
    // used.
    const acc = createTurnAccState(freshSeed());
    assert.equal(typeof acc.chosenModelFamily, 'string');
    assert.equal(typeof acc.chosenModelLabel, 'string');
    assert.equal(typeof acc.chosenModelThinking, 'boolean');
  });
});

describe('createTurnAccState — a continuation', () => {
  it('seeds text and thinking from what the message already says', () => {
    // Joined with no separator on purpose: the model was told its text
    // attaches directly onto the previous part, so it may resume mid-word.
    const acc = createTurnAccState({
      ...freshSeed(),
      continuedSeed: 'half a sen',
      continuedThought: 'thinking so far',
    });
    assert.equal(acc.currentText, 'half a sen');
    acc.currentText += 'tence';
    assert.equal(acc.currentText, 'half a sentence');
    assert.equal(acc.currentThought, 'thinking so far');
  });

  it('seeds the thinking blocks from the continued message', () => {
    const blocks = [{ thinking: 'a', signature: 'sig-a' }];
    const acc = createTurnAccState({ ...freshSeed(), continuedBlocks: blocks });
    assert.deepEqual(acc.claudeThinkingBlocks, blocks);
  });
});

describe('COPY-VS-SHARE — the two decisions that are silent when wrong', () => {
  it('COPY: pushing a block does NOT mutate the continued message', () => {
    // The seed array belongs to a message already saved on disk. If the state
    // held that array instead of a copy, every continuation would append to
    // the PREVIOUS message's blocks — and nothing would report it.
    const blocks = [{ thinking: 'a', signature: 'sig-a' }];
    const acc = createTurnAccState({ ...freshSeed(), continuedBlocks: blocks });
    acc.claudeThinkingBlocks.push({ thinking: 'b', signature: 'sig-b' });
    assert.equal(blocks.length, 1, 'the seed array must be untouched');
    assert.equal(acc.claudeThinkingBlocks.length, 2);
  });

  it('COPY: clearing the blocks does NOT clear the continued message', () => {
    // `claudeThinkingBlocks.length = 0` is a real site: the betrayal guard
    // discards everything the turn produced.
    const blocks = [{ thinking: 'a', signature: 'sig-a' }];
    const acc = createTurnAccState({ ...freshSeed(), continuedBlocks: blocks });
    acc.claudeThinkingBlocks.length = 0;
    assert.equal(blocks.length, 1);
  });

  it('SHARE: pushing a notice IS visible to the caller that owns the array', () => {
    // notices is created before the stream opens and read after the stream's
    // scope ends (the error path pushes to it; the catch reads it onto the
    // message). A copy here loses every notice pushed during the stream.
    const notices: string[] = ['carried from the previous part'];
    const acc = createTurnAccState({ ...freshSeed(), notices });
    acc.notices.push('token limit hit');
    assert.deepEqual(notices, ['carried from the previous part', 'token limit hit']);
    assert.equal(acc.notices, notices, 'must be the SAME array, not a copy');
  });
});

describe('NO SHARED STATE — two turns are independent', () => {
  it('two states do not share any of the owned arrays', () => {
    // A module-level array would make turn 2 inherit turn 1's tool calls.
    const a = createTurnAccState(freshSeed());
    const b = createTurnAccState(freshSeed());
    a.toolCalls.push({ name: 'Write' });
    a.askedQuestions.push({ askId: '1', questions: [], answers: null, timedOut: false });
    a.subagentRuns.push({ task: 't', result: null });
    a.claudeThinkingBlocks.push({ thinking: 'x', signature: 'y' });
    assert.deepEqual(b.toolCalls, []);
    assert.deepEqual(b.askedQuestions, []);
    assert.deepEqual(b.subagentRuns, []);
    assert.deepEqual(b.claudeThinkingBlocks, []);
  });
});

describe('the open/closed flag the subagent records depend on', () => {
  it('result:null is writable through a found reference', () => {
    // findOpenSubagentRun matches on `result === null` and the caller writes
    // the result back through the returned object. If the element type were
    // `unknown` this would not compile — which is why the three arrays are
    // narrowed in TurnAccState rather than left as the finalizer's unknown[].
    const acc = createTurnAccState(freshSeed());
    acc.subagentRuns.push({ task: 'read the log', result: null });
    const rec = acc.subagentRuns.find((r) => r.task === 'read the log');
    assert.ok(rec);
    rec.result = 'done';
    assert.equal(acc.subagentRuns[0].result, 'done');
  });
});

/**
 * Build a state with every field non-empty, so the finalizer's conditional
 * spreads all fire and every key gets read.
 */
function filledState(): TurnAccState {
  const acc = createTurnAccState({
    continuedSeed: 'text',
    continuedThought: 'thought',
    continuedBlocks: [{ thinking: 't', signature: 's' }],
    notices: ['a notice'],
  });
  acc.continuationCount = 2;
  acc.chosenModelFamily = 'claude';
  acc.chosenModelSpecific = 'claude-opus-5';
  acc.chosenModelThinking = true;
  acc.chosenModelLabel = 'Opus 5';
  acc.cacheUsage = {
    cachedInputTokens: 1, uncachedInputTokens: 2, totalInputTokens: 3,
    outputTokens: 4, cacheCreationTokens: 5, providerHint: 'anthropic',
  };
  acc.webSources = [{ url: 'https://example.invalid', title: 'x' }];
  acc.toolCalls.push({ name: 'Write' });
  acc.askedQuestions.push({ askId: '1', questions: [], answers: null, timedOut: false });
  acc.subagentRuns.push({ task: 't', result: 'r' });
  return acc;
}

describe('CONTRACT — what the finalizer reads is what the state has', () => {
  it('the finalizer reads EXACTLY the keys the state holds', () => {
    // This is the only assertion here that can catch the failure the module
    // exists to prevent, and it catches it in both directions:
    //
    //   a key read but not held  -> the finalizer writes `undefined` to disk
    //   a key held but not read  -> the field never reaches the saved message
    //                               (the toolAttachments story, which is why
    //                               toolAttachments is NOT in this state)
    const acc = filledState();
    const stateKeys = new Set(Object.keys(acc));
    const read = new Set<string>();
    const spy = new Proxy(acc, {
      get(target, prop, recv) {
        if (typeof prop === 'string') read.add(prop);
        return Reflect.get(target, prop, recv);
      },
    });
    finalizeTurnMessage({ id: 'm1' }, spy, {
      genStartTime: 1000, nowMs: 1500, autoPlay: false, tokenModel: 'claude',
    });
    assert.deepEqual(
      [...read].sort(), [...stateKeys].sort(),
      'every accumulated field must be read, and only accumulated fields read',
    );
  });

  it('a filled state round-trips through the finalizer with nothing dropped', () => {
    const acc = filledState();
    const out = finalizeTurnMessage({ id: 'm1' }, acc, {
      genStartTime: 1000, nowMs: 1500, autoPlay: false, tokenModel: 'claude',
    });
    assert.equal(out.content, 'text');
    assert.equal(out.continuationCount, 2);
    assert.equal(out.modelLabel, 'Opus 5');
    assert.equal(out.generationMs, 500);
    assert.deepEqual(out.cacheUsage, acc.cacheUsage);
    assert.deepEqual(out.webSources, acc.webSources);
    assert.deepEqual(out.notices, ['a notice']);
    assert.deepEqual(out.toolCalls, acc.toolCalls);
    assert.deepEqual(out.askedQuestions, acc.askedQuestions);
    assert.deepEqual(out.subagentRuns, acc.subagentRuns);
    assert.deepEqual(out.claudeThinkingBlocks, acc.claudeThinkingBlocks);
  });

  it('assertFinalizable is an identity, and compiles only while the types agree', () => {
    // The compile-time half is the point: if FinalizeAccumulator grows a field
    // TurnAccState does not have, that function stops type-checking. Calling it
    // here is what keeps it from being an exported symbol nobody reads.
    const acc = createTurnAccState(freshSeed());
    assert.equal(assertFinalizable(acc), acc);
  });
});
