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

import {
  isFinishedRun, isCollectableHere, isCollectableBy,
  decideRunRecord, spuRecordKey, type SpuRunRecord,
} from '@/lib/spuRun';

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

// ── decideRunRecord — what the panel DOES with what it found ────────────────
//
// NEW 2026-10-31, second pass. The panel used to OFFER a finished record
// behind a Collect button. fuwafuwa pressed it, it worked, and she said the
// button should not exist: the target is a panel that looks exactly like it
// always did, where closing a tab simply does not cost a run. Automating the
// delivery takes the decision out of a person's hands, so the decision gets
// tests.
//
// Each case names what would look different without the rule:
//
//   "running -> none" — absent, a half-written document is delivered as a
//       result, and the DELETE empties the record out from under the run that
//       is still appending to it.
//   "other conversation -> show" — absent, output built from one log is
//       applied to another and written to soul/<N>.md as that being's real
//       generation. SHOW and not none, because a record that can never be
//       collected here still has to be visible to be discarded.
//   "already seen -> none" — absent, one failed best-effort DELETE re-offers
//       the same record every time `running` settles. Not a duplicate
//       delivery: an unbounded loop.
//   "seen is checked BEFORE hasHandler" — absent, a record that WAS delivered
//       (whose DELETE then failed) gets announced as "could not be collected"
//       — a false statement about something already collected. Silence is
//       incomplete; this would be wrong.
//   "no handler -> show" — absent, a record written by a newer build is
//       dropped in silence. Somebody paid for that text.
//   "key is label@startedAt" — absent (label alone), the second run of the
//       same generation is suppressed as a duplicate of the first.
//   "stopped with text -> collect" — absent, every partial the stop branch
//       saved on 2026-10-30 becomes undeliverable, undoing that work one
//       layer up.

const ALL = () => true;
const NONE = () => false;
const EMPTY: ReadonlySet<string> = new Set();

test('decideRunRecord: a finished record for this conversation is collected', () => {
  const r = rec();
  assert.deepEqual(decideRunRecord(r, CONVO, EMPTY, ALL), {
    kind: 'collect', key: '2@1',
  });
});

test('decideRunRecord: running is none — not shown, not collected', () => {
  const r = rec({ status: 'running', accum: 'half a soul' });
  assert.deepEqual(decideRunRecord(r, CONVO, EMPTY, ALL), { kind: 'none' });
});

test('decideRunRecord: no record at all is none', () => {
  assert.deepEqual(decideRunRecord(null, CONVO, EMPTY, ALL), { kind: 'none' });
  assert.deepEqual(decideRunRecord(undefined, CONVO, EMPTY, ALL), { kind: 'none' });
});

test('decideRunRecord: finished with nothing is none', () => {
  // Same reasoning as isFinishedRun: delivering an empty accum writes the
  // right pane with nothing, which is the blank pane this path exists to
  // prevent — produced by the fix.
  assert.deepEqual(decideRunRecord(rec({ accum: '' }), CONVO, EMPTY, ALL), { kind: 'none' });
});

test('decideRunRecord: a record for another conversation is SHOWN, not collected', () => {
  const r = rec({ convoId: 'some-other-log' });
  assert.deepEqual(decideRunRecord(r, CONVO, EMPTY, ALL), { kind: 'show' });
});

test('decideRunRecord: a key already seen is none', () => {
  const r = rec();
  const seen = new Set([spuRecordKey(r)]);
  assert.deepEqual(decideRunRecord(r, CONVO, seen, ALL), { kind: 'none' });
});

test('decideRunRecord: seen is checked BEFORE hasHandler', () => {
  // Both conditions true at once. If the order flipped this would be 'show',
  // which claims the record could not be collected — about a record that was.
  const r = rec();
  const seen = new Set([spuRecordKey(r)]);
  assert.deepEqual(decideRunRecord(r, CONVO, seen, NONE), { kind: 'none' });
});

test('decideRunRecord: an action this build cannot apply is SHOWN', () => {
  const r = rec({ action: 'some-future-action' });
  assert.deepEqual(decideRunRecord(r, CONVO, EMPTY, NONE), { kind: 'show' });
});

test('decideRunRecord: hasHandler is asked about the RECORD\'s action', () => {
  // Not about whatever the panel is pointed at. Absent, a panel on 'genesis'
  // would answer for genesis while holding an 'index' record.
  const asked: string[] = [];
  decideRunRecord(rec({ action: 'index' }), CONVO, EMPTY, (a) => { asked.push(a); return true; });
  assert.deepEqual(asked, ['index']);
});

test('decideRunRecord: stopped WITH text is collected', () => {
  const r = rec({ status: 'stopped', sawSentinel: false, accum: 'three rounds of a soul' });
  assert.deepEqual(decideRunRecord(r, CONVO, EMPTY, ALL), { kind: 'collect', key: '2@1' });
});

test('spuRecordKey: two runs of the same label are different keys', () => {
  // label alone would make the second run look like a duplicate of the first.
  const a = rec({ label: '7', startedAt: 1000 });
  const b = rec({ label: '7', startedAt: 2000 });
  assert.notEqual(spuRecordKey(a), spuRecordKey(b));
  assert.equal(spuRecordKey(a), '7@1000');
});

test('decideRunRecord: the returned key is the one seen is tested against', () => {
  // The round trip is the actual contract: the caller adds d.key to its set,
  // and the next call must recognise it. A key built differently in the two
  // places would re-collect forever while looking correct in each half.
  const r = rec({ label: '9', startedAt: 4242 });
  const d = decideRunRecord(r, CONVO, EMPTY, ALL);
  assert.equal(d.kind, 'collect');
  const seen = new Set([(d as { key: string }).key]);
  assert.deepEqual(decideRunRecord(r, CONVO, seen, ALL), { kind: 'none' });
});
