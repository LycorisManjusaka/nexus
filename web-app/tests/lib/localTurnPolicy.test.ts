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

// ── Reasoning depth selector ─────────────────────────────────────────────────
//
// First shipped the same day as a BOOLEAN read off `qwenEnableThinking`, which
// was wrong in a way no test could see: the Local model panel has never shown
// that checkbox, so the switch existed on the wire and nowhere on screen. The
// instruction "turn thinking off in the model panel" could not be carried out.
// It now reads its own field, which the Local panel actually renders.

test('every effort value the selector offers reaches the wire', () => {
  for (const v of ['none', 'low', 'medium', 'high']) {
    assert.equal(localReasoningEffort(v), v);
  }
});

test('the default choice sends NO field — the wire stays byte-identical', () => {
  // The empty string is what the selector's first option submits, and it has
  // to mean "send nothing", not "send some default depth". This is the clause
  // that keeps every pre-selector local conversation on exactly the request it
  // has today; returning 'high' here would push a new field at every model in
  // the catalogue, including ones that never reason and have never been
  // measured with it.
  assert.equal(localReasoningEffort(''), undefined);
  assert.equal(localReasoningEffort(undefined), undefined);
});

test('an unrecognised saved value falls back to sending nothing', () => {
  // Saved logs are data, and data outlives the code that wrote it. A value
  // from an older or newer build must not be forwarded to the provider
  // unchecked — LM Studio 400s on an unknown enum, which would turn a stale
  // setting into a conversation that cannot send at all.
  assert.equal(localReasoningEffort('minimal'), undefined);
  assert.equal(localReasoningEffort('NONE'), undefined);
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
