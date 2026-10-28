/**
 * finalizeTurnMessage — the one place the saved assistant message is built.
 *
 * EXTRACTION, not a new rule. Every assertion below pins behaviour that
 * already shipped inside ChatArea.tsx's `buildFinalizedMessage` closure.
 *
 * WHAT WOULD LOOK DIFFERENT IF THIS MODULE WERE ABSENT (written before the
 * assertions): a second caller builds its own copy of the message and silently
 * drops a field. That is not hypothetical — it is MEASURED. The vessel-handoff
 * path used to hand-build its own object and lost cacheUsage, generationMs,
 * textTokens, thinkingTokens, toolCalls and notices; a real handoff put the
 * handing-over message on disk with tokens=0 and no cacheUsage. The Phase 4b
 * runner is the third caller, and it is the one that would make the saved log
 * depend on WHO ran the turn.
 *
 * So the load-bearing test here is `exact key set` — not any single field.
 * A dropped spread shows up as a missing key, which is exactly the shape of
 * the bug this module exists to make impossible.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeTurnMessage,
  type FinalizeAccumulator,
  type FinalizeContext,
} from '@/lib/finalizeTurnMessage';

/** Everything present and non-empty — the "full record" case. */
function fullAcc(): FinalizeAccumulator {
  return {
    currentText: 'hello world',
    currentThought: 'thinking about it',
    claudeThinkingBlocks: [{ thinking: 'a', signature: 'sig' }],
    continuationCount: 2,
    chosenModelFamily: 'claude',
    chosenModelSpecific: 'claude-opus-5',
    chosenModelThinking: true,
    chosenModelLabel: 'Claude Opus 5',
    cacheUsage: {
      cachedInputTokens: 10,
      uncachedInputTokens: 20,
      totalInputTokens: 30,
      outputTokens: 40,
      cacheCreationTokens: 5,
      providerHint: 'anthropic',
    },
    webSources: [{ url: 'https://example.invalid', title: 'T' }],
    notices: ['a notice'],
    toolCalls: [{ name: 'Write' }],
    askedQuestions: [{ q: 'which?' }],
    subagentRuns: [{ task: 'x' }],
  };
}

/** Nothing accumulated — a turn that produced no text and no usage. */
function emptyAcc(): FinalizeAccumulator {
  return {
    currentText: '',
    currentThought: '',
    claudeThinkingBlocks: [],
    continuationCount: 0,
    chosenModelFamily: '',
    chosenModelSpecific: '',
    chosenModelThinking: false,
    chosenModelLabel: '',
    cacheUsage: null,
    webSources: null,
    notices: [],
    toolCalls: [],
    askedQuestions: [],
    subagentRuns: [],
  };
}

function ctx(over?: Partial<FinalizeContext>): FinalizeContext {
  return {
    genStartTime: 1_000,
    nowMs: 4_500,
    autoPlay: false,
    tokenModel: 'claude-opus-5',
    ...over,
  };
}

const BASE = { id: 'm1', role: 'assistant', timestamp: 7, attachments: [] as unknown[] };

describe('finalizeTurnMessage — exact key set', () => {
  it('WHAT-BREAKS: a full record carries every accumulated field', () => {
    const out = finalizeTurnMessage({ ...BASE }, fullAcc(), ctx());
    assert.deepEqual(
      Object.keys(out).sort(),
      [
        'askedQuestions', 'attachments', 'autoPlay', 'cacheUsage',
        'claudeThinkingBlocks', 'content', 'continuationCount', 'generationMs',
        'id', 'modelFamily', 'modelLabel', 'modelSpecific', 'modelThinking',
        'notices', 'role', 'streaming', 'subagentRuns', 'textTokens',
        'thinkingTokens', 'timestamp', 'tokens', 'toolCalls', 'webSources',
      ],
    );
  });

  it('WHAT-BREAKS: an empty record omits every conditional field', () => {
    const out = finalizeTurnMessage({ ...BASE }, emptyAcc(), ctx());
    assert.deepEqual(
      Object.keys(out).sort(),
      [
        'attachments', 'autoPlay', 'content', 'generationMs', 'id', 'role',
        'streaming', 'textTokens', 'thinkingTokens', 'timestamp', 'tokens',
      ],
    );
  });
});

describe('finalizeTurnMessage — conditional spreads', () => {
  it('continuationCount 0 is omitted, 1 is kept', () => {
    const a = emptyAcc();
    assert.equal('continuationCount' in finalizeTurnMessage({}, a, ctx()), false);
    a.continuationCount = 1;
    assert.equal(finalizeTurnMessage({}, a, ctx()).continuationCount, 1);
  });

  it('empty arrays are omitted; one element is kept', () => {
    for (const key of ['claudeThinkingBlocks', 'notices', 'toolCalls', 'askedQuestions', 'subagentRuns'] as const) {
      const a = emptyAcc();
      assert.equal(key in finalizeTurnMessage({}, a, ctx()), false, `${key} should be absent when empty`);
      (a as unknown as Record<string, unknown[]>)[key] = [{ x: 1 }];
      assert.equal(key in finalizeTurnMessage({}, a, ctx()), true, `${key} should be present when non-empty`);
    }
  });

  it('null cacheUsage and null webSources are omitted', () => {
    const out = finalizeTurnMessage({}, emptyAcc(), ctx());
    assert.equal('cacheUsage' in out, false);
    assert.equal('webSources' in out, false);
  });

  it('WHAT-BREAKS: the four model fields are gated together by family', () => {
    // A stream that reported a specific model but no family must write NONE of
    // the four — otherwise the meta bar shows a model with a blank family.
    const a = emptyAcc();
    a.chosenModelSpecific = 'claude-opus-5';
    a.chosenModelLabel = 'Claude Opus 5';
    const out = finalizeTurnMessage({}, a, ctx());
    for (const k of ['modelFamily', 'modelSpecific', 'modelThinking', 'modelLabel']) {
      assert.equal(k in out, false, `${k} must be absent without a family`);
    }
    a.chosenModelFamily = 'claude';
    const out2 = finalizeTurnMessage({}, a, ctx());
    assert.equal(out2.modelSpecific, 'claude-opus-5');
    assert.equal(out2.modelThinking, false);
  });
});

describe('finalizeTurnMessage — computed fields', () => {
  it('generationMs is nowMs - genStartTime', () => {
    const out = finalizeTurnMessage({}, emptyAcc(), ctx({ genStartTime: 500, nowMs: 2_750 }));
    assert.equal(out.generationMs, 2_250);
  });

  it('tokens and textTokens are the same estimate', () => {
    const out = finalizeTurnMessage({}, fullAcc(), ctx());
    assert.equal(typeof out.tokens, 'number');
    assert.equal(out.tokens, out.textTokens);
    assert.ok((out.tokens as number) > 0);
  });

  it('thinkingTokens is 0 for an empty thought (does NOT discriminate the ternary)', () => {
    // I first wrote this as WHAT-BREAKS, claiming it pins the original's
    // `currentThought ? estimate(...) : 0` guard. Then I MEASURED:
    // estimateTokensForModel('', 'claude-opus-5') === 0. So deleting the
    // ternary changes nothing observable and this assertion cannot tell the
    // two apart — it pins the VALUE, not the guard. Kept (the value is worth
    // pinning) but not labelled as a discriminating test, and the ternary is
    // kept as-is because this is an identity-preserving extraction, not a
    // place to decide whether dead-for-this-estimator code should go.
    const out = finalizeTurnMessage({}, emptyAcc(), ctx());
    assert.equal(out.thinkingTokens, 0);
    const out2 = finalizeTurnMessage({}, fullAcc(), ctx());
    assert.ok((out2.thinkingTokens as number) > 0);
  });

  it('streaming is always false and autoPlay comes from context', () => {
    assert.equal(finalizeTurnMessage({ streaming: true }, emptyAcc(), ctx()).streaming, false);
    assert.equal(finalizeTurnMessage({}, emptyAcc(), ctx({ autoPlay: true })).autoPlay, true);
  });
});

describe('finalizeTurnMessage — base interaction', () => {
  it('base fields survive, and computed fields win over base', () => {
    const out = finalizeTurnMessage(
      { id: 'keep-me', thoughtProcess: 'carried', content: 'STALE', tokens: 999 },
      fullAcc(),
      ctx(),
    );
    assert.equal(out.id, 'keep-me');
    assert.equal(out.thoughtProcess, 'carried');
    // WHAT-BREAKS: if the spread came last, a stopped stream would save the
    // placeholder's stale content instead of the accumulated text.
    assert.equal(out.content, 'hello world');
    assert.notEqual(out.tokens, 999);
  });

  it('does not mutate the accumulator or the base', () => {
    const base = { id: 'm1' };
    const acc = fullAcc();
    const before = JSON.stringify(acc);
    finalizeTurnMessage(base, acc, ctx());
    assert.equal(JSON.stringify(acc), before);
    assert.deepEqual(base, { id: 'm1' });
  });

  it('arrays are passed through by reference, not copied', () => {
    // Pinning the ORIGINAL behaviour: the closure spread the same array
    // objects. A defensive copy here would be a behaviour change, and the
    // streaming flush relies on the live arrays elsewhere in the turn.
    const acc = fullAcc();
    const out = finalizeTurnMessage({}, acc, ctx());
    assert.equal(out.toolCalls, acc.toolCalls);
    assert.equal(out.claudeThinkingBlocks, acc.claudeThinkingBlocks);
  });
});
