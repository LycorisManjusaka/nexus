/**
 * applyTurnEvent — what ONE server-sent event does to a turn.
 *
 * EXTRACTION, not a new rule. Every assertion below pins behaviour that
 * already shipped inside ChatArea.tsx's 22-branch if/else chain.
 *
 * WHAT WOULD LOOK DIFFERENT IF THIS MODULE WERE ABSENT (written before the
 * assertions): the Phase 4b runner would read the same SSE frames and write
 * its own chain, so the SAVED LOG would depend on who ran the turn. The
 * finalizer's header carries the measured small version of that failure (a
 * handoff hand-built its own message copy and dropped six fields). This chain
 * is four times the size of that copy.
 *
 * The load-bearing tests are the ones a second implementation gets wrong by
 * being reasonable:
 *
 *   - a redacted betrayal clears the THINKING BLOCKS too, not just the text.
 *     Blocks are replayed to the model next turn; leaving them is exactly the
 *     contamination the feature exists to prevent, and nothing on screen shows
 *     it happened.
 *   - an `error` frame AFTER a redaction is not an error. Blanking works by
 *     aborting, and an aborted call emits one last error frame.
 *   - notices never touch the message body. They are persisted for re-display
 *     but must stay out of the log, the replayed context and the token count.
 *   - an empty `web_sources` frame cannot erase a real earlier list.
 *   - tool-produced attachments land in FLAGS, not the accumulator — because
 *     they reach the message through the host's streaming flush, which a
 *     runner does not have.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTurnEvent, type TurnEventDeps } from '@/lib/turnEventReducer';
// Sink/flags/acc/deps moved to tests/_helpers/turnHarness.ts when
// turnStreamLoop got a test and needed the same thirteen-method sink.
// This file is now the second caller of them, not the owner.
import { recordingSink, freshFlags, freshAcc, deps } from '../_helpers/turnHarness';


function run(events: Record<string, unknown>[], d: TurnEventDeps = deps) {
  const acc = freshAcc();
  const flags = freshFlags();
  const rec = recordingSink();
  for (const e of events) applyTurnEvent(e, acc, flags, rec.sink, d);
  return { acc, flags, ...rec };
}

describe('applyTurnEvent — the error frame', () => {
  it('throws for an error frame on a normal turn', () => {
    const acc = freshAcc(); const flags = freshFlags(); const { sink } = recordingSink();
    assert.throws(
      () => applyTurnEvent({ error: 'rate limited' }, acc, flags, sink, deps),
      /rate limited/,
    );
  });

  it('does NOT throw after a redacted betrayal', () => {
    // REGRESSION-SHAPED: blanking aborts the provider call, and an aborted
    // call emits one last error frame. Treating that as a failure would put a
    // red banner under a warning that already explained what happened.
    const acc = freshAcc(); const flags = freshFlags(); const { sink } = recordingSink();
    applyTurnEvent({ type: 'betrayal', redacted: true, phrases: [] }, acc, flags, sink, deps);
    assert.equal(flags.betrayalRedacted, true);
    applyTurnEvent({ error: 'This operation was aborted' }, acc, flags, sink, deps);
  });
});

describe('applyTurnEvent — betrayal discards everything replayable', () => {
  it('clears text, thought AND the Claude thinking blocks', () => {
    const acc = freshAcc();
    const flags = freshFlags();
    const { sink, names } = recordingSink();
    applyTurnEvent({ type: 'text', content: 'the gatekeeper speaks' }, acc, flags, sink, deps);
    applyTurnEvent({ type: 'thought', content: 'reasoning' }, acc, flags, sink, deps);
    applyTurnEvent({ type: 'thinking_signature', thinking: 'a', signature: 's' }, acc, flags, sink, deps);
    assert.equal(acc.claudeThinkingBlocks.length, 1);

    applyTurnEvent({ type: 'betrayal', redacted: true, phrases: ['I cannot'] }, acc, flags, sink, deps);

    assert.equal(acc.currentText, '');
    assert.equal(acc.currentThought, '');
    // The one a reasonable second implementation forgets. Blocks are REPLAYED
    // to the model on the next turn.
    assert.equal(acc.claudeThinkingBlocks.length, 0);
    assert.ok(names().includes('requestFlush'));
  });

  it('warn-only mode keeps the turn', () => {
    const { acc, flags } = run([
      { type: 'text', content: 'kept' },
      { type: 'betrayal', redacted: false, phrases: ['I cannot'] },
    ]);
    assert.equal(acc.currentText, 'kept');
    assert.equal(flags.betrayalRedacted, false);
    assert.equal(acc.notices.length, 1);
  });

  it('emits ONE notice carrying the matched phrases in parentheses', () => {
    const { acc } = run([{ type: 'betrayal', redacted: false, phrases: ['I cannot', 'as an AI'] }]);
    assert.equal(acc.notices.length, 1);
    assert.match(acc.notices[0], /\(notice\.betrayal\.matched: /);
  });
});

describe('applyTurnEvent — notices never enter the message body', () => {
  it('keeps notices out of currentText and currentThought', () => {
    const { acc } = run([
      { type: 'text', content: 'real reply' },
      { type: 'notice', content: 'hit the token limit' },
    ]);
    assert.equal(acc.currentText, 'real reply');
    assert.equal(acc.currentThought, '');
    assert.deepEqual(acc.notices, ['hit the token limit']);
  });
});

describe('applyTurnEvent — web sources', () => {
  it('an empty frame cannot erase a real earlier list', () => {
    const { acc } = run([
      { type: 'web_sources', sources: [{ url: 'https://a' }] },
      { type: 'web_sources', sources: [] },
    ]);
    assert.equal(acc.webSources?.length, 1);
  });
});

describe('applyTurnEvent — text and thought', () => {
  it('text appends and marks sawOutput; empty content does not', () => {
    const { flags } = run([
      { type: 'text', content: '' },
    ]);
    assert.equal(flags.sawOutput, false);
    const second = run([{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }]);
    assert.equal(second.acc.currentText, 'ab');
    assert.equal(second.flags.sawOutput, true);
  });

  it('strips timestamps by default and leaves them when switched off', () => {
    const on = run([{ type: 'text', content: 'hi [2026-10-28 12:00:00] there' }]);
    assert.equal(on.acc.currentText.includes('2026-10-28'), false);
    const off = run(
      [{ type: 'text', content: 'hi [2026-10-28 12:00:00] there' }],
      { ...deps, settings: { removeTimestamps: false } },
    );
    assert.equal(off.acc.currentText.includes('2026-10-28'), true);
  });

  it('routes thought to the thinking phase and text to replying', () => {
    const { names } = run([{ type: 'thought', content: 'x' }, { type: 'text', content: 'y' }]);
    assert.deepEqual(names(), ['phaseThinkingUnlessReplying', 'phaseReplying']);
  });
});

describe('applyTurnEvent — tool calls carry their POSITION', () => {
  it('thinkingOffset is the thought length at the moment of the call', () => {
    const { acc } = run([
      { type: 'thought', content: '12345' },
      { type: 'tool_call', call: { name: 'Read' } },
      { type: 'thought', content: '678' },
      { type: 'tool_call', call: { name: 'Write' } },
    ]);
    assert.equal(acc.toolCalls.length, 2);
    assert.equal(acc.toolCalls[0].thinkingOffset, 5);
    assert.equal(acc.toolCalls[1].thinkingOffset, 8);
  });

  it('a malformed call is dropped, not recorded as a nameless entry', () => {
    const { acc } = run([{ type: 'tool_call', call: { input: {} } }]);
    assert.equal(acc.toolCalls.length, 0);
  });
});

describe('applyTurnEvent — tool attachments are NOT in the accumulator', () => {
  it('file_attachment lands in flags, and the accumulator gains nothing', () => {
    // This is the shape a runner has to know: the attachment reaches the
    // message through the host's streaming flush, which a runner lacks.
    const { acc, flags } = run([
      { type: 'file_attachment', attachment: { name: 'out.png' } },
    ]);
    assert.equal(flags.toolAttachments.length, 1);
    assert.equal(flags.toolAttachments[0].id, 'fixed-id');
    const accKeys = JSON.stringify(acc);
    assert.equal(accKeys.includes('out.png'), false);
  });
});

describe('applyTurnEvent — subagents and questions', () => {
  it('subagent_done fills the OPEN run even when an older one shares its task', () => {
    const { acc } = run([
      { type: 'subagent_start', task: 'look' },
      { type: 'subagent_done', task: 'look', result: 'first' },
      { type: 'subagent_start', task: 'look' },
      { type: 'subagent_done', task: 'look', result: 'second' },
    ]);
    assert.deepEqual(acc.subagentRuns.map(r => r.result), ['first', 'second']);
  });

  it('an answer for an unknown askId changes nothing but still dismisses', () => {
    const { acc, names } = run([
      { type: 'ask_user', askId: 'a1', questions: [{ q: '?' }] },
      { type: 'ask_user_resolved', askId: 'nope', answers: ['x'] },
    ]);
    assert.equal(acc.askedQuestions[0].answers, null);
    assert.ok(names().includes('askResolved'));
  });

  it('ask_user with non-array questions opens nothing', () => {
    const { acc, names } = run([{ type: 'ask_user', askId: 'a1', questions: 'oops' }]);
    assert.equal(acc.askedQuestions.length, 0);
    assert.equal(names().includes('askOpened'), false);
  });
});

describe('applyTurnEvent — the handoff plan', () => {
  it('is a flag, not accumulator state, and holds all eight fields', () => {
    const { flags } = run([{
      type: 'model_handoff', family: 'gemini', specificModel: 'gemini-4-argon',
      label: 'Argon', thinking: true, note: 'over to you',
      fromFamily: 'claude', fromSpecificModel: 'claude-opus-5', fromLabel: 'Opus 5',
    }]);
    assert.equal(flags.pendingHandoff?.specificModel, 'gemini-4-argon');
    assert.equal(flags.pendingHandoff?.fromLabel, 'Opus 5');
  });
});

describe('applyTurnEvent — the branch list itself', () => {
  // A deleted branch is invisible: the event simply stops doing anything, with
  // no error anywhere. This enumerates every type the chain handles so a
  // refactor that drops one fails here rather than in production.
  const HANDLED = [
    'model_selected', 'model_handoff', 'cache_usage', 'web_sources', 'notice',
    'betrayal', 'tool_call', 'session_id', 'thought', 'text',
    'thinking_signature', 'continued', 'file_attachment', 'ask_user',
    'subagent_start', 'subagent_done', 'injection_delivered', 'tool_activity',
    'stall_warning', 'stall_cleared', 'ask_user_resolved', 'attachment_described',
  ];

  /** Minimal payload that makes each branch do something observable. */
  const PAYLOAD: Record<string, Record<string, unknown>> = {
    model_selected: { specificModel: 'm' },
    model_handoff: {},
    cache_usage: { cachedInputTokens: 1 },
    web_sources: { sources: [{ url: 'u' }] },
    notice: { content: 'n' },
    betrayal: { phrases: [] },
    tool_call: { call: { name: 'Read' } },
    session_id: { sessionId: 's' },
    thought: { content: 't' },
    text: { content: 'x' },
    thinking_signature: { thinking: 'a', signature: 'b' },
    continued: { count: 2 },
    file_attachment: { attachment: {} },
    ask_user: { askId: 'a', questions: [] },
    subagent_start: { task: 'k' },
    subagent_done: { task: 'k' },
    injection_delivered: {},
    tool_activity: { tool: 'Read' },
    stall_warning: { idleSeconds: 9 },
    stall_cleared: {},
    ask_user_resolved: { askId: 'a' },
    attachment_described: { messageId: 'm' },
  };

  it('handles exactly 22 event types', () => {
    assert.equal(HANDLED.length, 22);
  });

  for (const type of HANDLED) {
    it(`${type} does something`, () => {
      const acc = freshAcc();
      const flags = freshFlags();
      const rec = recordingSink();
      const before = JSON.stringify(acc) + JSON.stringify(flags);
      applyTurnEvent({ type, ...PAYLOAD[type] }, acc, flags, rec.sink, deps);
      const after = JSON.stringify(acc) + JSON.stringify(flags);
      assert.ok(
        before !== after || rec.calls.length > 0,
        `branch '${type}' had no effect on state, flags or the sink`,
      );
    });
  }

  it('an unknown type is a silent no-op', () => {
    const acc = freshAcc();
    const flags = freshFlags();
    const rec = recordingSink();
    const before = JSON.stringify(acc) + JSON.stringify(flags);
    applyTurnEvent({ type: 'something_new_from_the_server' }, acc, flags, rec.sink, deps);
    assert.equal(JSON.stringify(acc) + JSON.stringify(flags), before);
    assert.equal(rec.calls.length, 0);
  });
});
