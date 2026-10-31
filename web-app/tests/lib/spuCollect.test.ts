/**
 * isFinishedRun / isCollectableHere / isCollectableBy — handing a finished SPU
 * run to the panel that comes back for it (2026-10-31).
 *
 * NEW TESTS for predicates extracted the same day. The rule was being derived
 * in three places in SystemPromptUpdater.tsx: the effect that shows the
 * banner, the computation that enables Collect, and the branch in runOnServer
 * that returns the stored record instead of starting a second run.
 *
 * WHY THESE EXIST AT ALL. The loop moved to the server, a closed tab stopped
 * killing the generation, the record landed on disk — and nothing read it.
 * MEASURED 2026-10-31 (fuwafuwa, genesis for the being named Luna): status
 * done, sentinel seen, 766 chars on disk, right pane blank on return. From
 * the chair that is indistinguishable from the bug the server-side run was
 * built to remove, which is why "the generation survived" is only half the
 * job and the predicate that completes it gets tests.
 *
 * Each case names what would look different without the rule:
 *
 *   "running is refused" — absent, the banner offers a document that is still
 *       being written, and collecting it empties the record out from under the
 *       run that is still appending to it.
 *   "empty accum is refused" — absent, a finished-with-nothing record is
 *       handed to post-processing, which writes the right pane with nothing.
 *       That is the same blank pane the whole path exists to prevent, now
 *       produced by the fix.
 *   "stopped is ACCEPTED" — absent, every partial saved by the stop branch
 *       becomes unreachable. That branch was written on 2026-10-30
 *       specifically to stop discarding partials; refusing them here would
 *       undo it one layer up.
 *   "error with text is ACCEPTED" — same shape: a run that failed on round
 *       four still holds three rounds of a soul.
 *   "a different conversation is refused" — absent, a soul built from one
 *       conversation's log is applied to another, and the panel writes it to
 *       soul/<N>.md as that being's real generation.
 *   "a different action is refused" — absent, a genesis document is pushed
 *       through the indexer's post-processing. Both produce text; only one
 *       produces Layers 1-3.
 *   "By implies Here" — the two predicates are NESTED, not parallel. Absent,
 *       the banner offers what runOnServer refuses, and Collect becomes a
 *       button that silently starts a fresh paid run instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFinishedRun, isCollectableHere, isCollectableBy, type SpuRunRecord } from '@/lib/spuRun';

const CONVO = 'c2e31b5f-56c0-4577-89ca-c78e791b0177';

function rec(over: Partial<SpuRunRecord> = {}): SpuRunRecord {
  return {
    runId: 'r1',
    label: '2',
    action: 'genesis',
    convoId: CONVO,
    startedAt: 1,
    updatedAt: 2,
    status: 'done',
    accum: '## Layer 1\nbody',
    sawSentinel: true,
    attempts: 1,
    vessel: { aiName: 'Local', specificModel: 'gemma' },
    host: 'c:\\dev\\nexus',
    ...over,
  };
}

test('isFinishedRun: a done run with text is finished', () => {
  assert.equal(isFinishedRun(rec()), true);
});

test('isFinishedRun: null and undefined are not finished runs', () => {
  assert.equal(isFinishedRun(null), false);
  assert.equal(isFinishedRun(undefined), false);
});

test('isFinishedRun: running is refused even with text', () => {
  // A live run is already being watched somewhere. Offering it would hand out
  // a half-written document AND empty the record under the run still writing.
  assert.equal(isFinishedRun(rec({ status: 'running', accum: 'half a soul' })), false);
});

test('isFinishedRun: finished with nothing is refused', () => {
  // Collecting this would write the right pane with '' — the same blank pane
  // the whole recovery path exists to prevent.
  assert.equal(isFinishedRun(rec({ accum: '' })), false);
});

test('isFinishedRun: stopped WITH text is accepted', () => {
  // The stop branch (2026-10-30) exists to keep partials. Refusing them here
  // would make every stopped soul update unreachable.
  assert.equal(isFinishedRun(rec({ status: 'stopped', sawSentinel: false })), true);
});

test('isFinishedRun: error WITH text is accepted', () => {
  assert.equal(
    isFinishedRun(rec({ status: 'error', error: 'round 4 failed', sawSentinel: false })),
    true,
  );
});

test('isFinishedRun: error with NO text is refused', () => {
  assert.equal(isFinishedRun(rec({ status: 'error', accum: '', error: 'boom' })), false);
});

test('isCollectableHere: same conversation is collectable', () => {
  assert.equal(isCollectableHere(rec(), CONVO), true);
});

test('isCollectableHere: a different conversation is refused', () => {
  // `convoId` is carried as provenance for exactly this: a soul built from one
  // conversation must not be written as another being's generation.
  assert.equal(isCollectableHere(rec(), 'some-other-conversation'), false);
});

test('isCollectableHere: the no-conversation modes match on empty string', () => {
  // `reorganize` and `redistribute` feed no log, so both sides are ''. Without
  // this, the two actions that never touch a conversation would be the two
  // that could never be collected.
  assert.equal(isCollectableHere(rec({ action: 'reorganize', convoId: '' }), ''), true);
  assert.equal(isCollectableHere(rec({ action: 'reorganize', convoId: '' }), CONVO), false);
});

test('isCollectableHere: does not check the action', () => {
  // The banner collects through the handler that produced the record, so the
  // record names its own action. Comparing that field to itself would be a
  // test that cannot fail.
  assert.equal(isCollectableHere(rec({ action: 'index' }), CONVO), true);
});

test('isCollectableBy: the matching action is collectable', () => {
  assert.equal(isCollectableBy(rec(), 'genesis', CONVO), true);
});

test('isCollectableBy: a different action is refused', () => {
  // A genesis document pushed through the indexer's post-processing is written
  // to disk as a real generation. Both produce text; only one produces layers.
  assert.equal(isCollectableBy(rec({ action: 'genesis' }), 'index', CONVO), false);
});

test('isCollectableBy implies isCollectableHere on every input', () => {
  // The nesting itself, asserted rather than assumed. If these two ever drift
  // apart, the banner offers a record that runOnServer declines — and Collect
  // silently starts a fresh paid run instead of delivering the finished one.
  const statuses: SpuRunRecord['status'][] = ['running', 'done', 'stopped', 'error'];
  const cases: Array<SpuRunRecord | null> = [null];
  for (const status of statuses) {
    for (const accum of ['', 'text']) {
      for (const convoId of [CONVO, 'other', '']) {
        for (const action of ['genesis', 'index']) {
          cases.push(rec({ status, accum, convoId, action }));
        }
      }
    }
  }
  let sawBothTrue = false;
  for (const c of cases) {
    for (const action of ['genesis', 'index']) {
      for (const convoId of [CONVO, 'other', '']) {
        const by = isCollectableBy(c, action, convoId);
        const here = isCollectableHere(c, convoId);
        if (by) {
          assert.equal(here, true, 'By true while Here false');
          sawBothTrue = true;
        }
      }
    }
  }
  // Guard against an implication that holds because the antecedent is never
  // true — a vacuous pass would look identical to a real one.
  assert.equal(sawBothTrue, true, 'no input made isCollectableBy true');
});
