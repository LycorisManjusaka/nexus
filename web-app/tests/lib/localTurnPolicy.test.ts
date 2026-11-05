import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localReasoningEffort,
  maxContinuationsFor,
  shouldReportLoadFailure,
} from '@/lib/localTurnPolicy';

// Reported 2026-11-06 (Lizard-kun): every Gemma build in the catalogue started
// reasoning when it used not to, spent the whole output budget doing it, and
// came back as "⚠️ Response hit the token limit and is still unfinished after
// 2/2 continuation(s)" — with the second round's THINKING leaking into the
// answer. Conversations with beings he used to talk to became impossible.
//
// The route's own comment at the time said there was no portable way to turn
// local reasoning off. That was true when written (2026-06-08) and is now
// false; the measurement table lives in lib/localTurnPolicy.ts.

// ── Thinking switch ──────────────────────────────────────────────────────────

test('thinking OFF sends reasoning_effort none', () => {
  assert.equal(localReasoningEffort(false), 'none');
});

test('thinking ON sends NO field — the wire stays byte-identical', () => {
  // This is the clause that keeps every existing local conversation on exactly
  // the request it has today. Returning 'high' here would push a new field at
  // every model in the catalogue, including ones that never reason and have
  // never been measured with it.
  assert.equal(localReasoningEffort(true), undefined);
});

test('absent toggle counts as ON, not as OFF', () => {
  // `undefined` means the toggle was never saved for this conversation. The
  // house default for thinking is ON, so a `!thinkingEnabled` test here would
  // silently disable reasoning for every local chat predating the toggle —
  // a behaviour change nobody asked for, applied to the oldest logs first.
  assert.equal(localReasoningEffort(undefined), undefined);
});

// ── Continuation ceiling ─────────────────────────────────────────────────────

test('local gets a high ceiling, paid providers stay at 2', () => {
  // The gap is about the BILL. A cloud continuation re-sends the whole
  // conversation and is charged for it; a local one costs electricity. If
  // these two ever return the same number, either money is being spent on
  // replies that may never land, or local turns are being cut off at 2 again.
  assert.ok(maxContinuationsFor(true) > maxContinuationsFor(false));
  assert.equal(maxContinuationsFor(true), 12);
  assert.equal(maxContinuationsFor(false), 2);
});

// ── Load-failure reporting ───────────────────────────────────────────────────

test('a failed load is reported', () => {
  // The silent version of this is the whole "context size is 8192" bug class:
  // `lms load` fails, nobody is told, and the request still succeeds because
  // LM Studio JIT-loads the model at ITS OWN default context. The turn then
  // runs at a context NEXUS never chose, and the only symptom arrives much
  // later as a rejection against a limit far below the model's real maximum.
  assert.equal(shouldReportLoadFailure({ ok: false, aborted: false }), true);
  assert.equal(shouldReportLoadFailure({ ok: false }), true);
});

test('a successful load is not reported', () => {
  assert.equal(shouldReportLoadFailure({ ok: true }), false);
});

test('Stop is not reported as a loader failure', () => {
  // `lms unload --all` + `lms load` can hold the line for 150 seconds, so Stop
  // lands here often. Without this clause every stopped local turn would also
  // accuse the loader — a true statement about the return value and a false
  // one about what happened.
  assert.equal(shouldReportLoadFailure({ ok: false, aborted: true }), false);
});

test('a missing result is not reported', () => {
  assert.equal(shouldReportLoadFailure(null), false);
  assert.equal(shouldReportLoadFailure(undefined), false);
});
