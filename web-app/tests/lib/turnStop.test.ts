/**
 * turnStop — the per-turn stop channel (phase 4b-1, 2026-10-27).
 *
 * NEW TEST. No probe existed; this module did not exist this morning.
 *
 * The honest caveat from turnQueue.test.ts applies to most of these: they were
 * written from the implementation and therefore restate it. Three were not,
 * and those are the ones worth having. Each was written by naming the failure
 * the design is meant to make impossible, BEFORE checking whether the code
 * achieves it — "what would look different if this property were absent?":
 *
 *   "a stop names ONE turn"  — absent, a lingering record would kill the next
 *       turn in the same conversation the instant it started. That is exactly
 *       the failure turnRegistry.ts refuses to risk ("a new way for a
 *       conversation to stop working"), and it is invisible: the turn simply
 *       ends, with no error anywhere.
 *   "request before register still fires" — absent, a stop sent in the first
 *       milliseconds of a turn is silently lost, and the person sees "I
 *       pressed stop and nothing happened".
 *   "a second request after firing re-fires nothing" — absent, a listener
 *       outlives the turn that registered it. This is the test that actually
 *       pins the detach-before-firing order; mutation p34 confirms it goes red
 *       when the order is flipped.
 *
 * ⚠ One case below is NOT discriminating today and says so inline: "a listener
 * that unregisters itself does not hide the next one" passes whether the
 * implementation iterates a copy or the live Set, because the key is detached
 * first. It was written believing it tested the copy. It does not — p34's
 * MISSED row proved that, and the copy has been removed. The case is kept
 * because it documents the chat route's real call shape and would go red if
 * the detach order were ever removed, but it is not evidence for anything the
 * line above does not already cover.
 *
 * Everything here is in-process; there is no disk and no local_data to touch.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestStop,
  onStop,
  isStopRequested,
  forgetStop,
  stopKey,
  _stopState,
  _resetStops,
  MAX_STOP_RECORDS,
} from '@/lib/turnStop';

const C = 'convo-A';
const T1 = 'turn_abc_111111';
const T2 = 'turn_abc_222222';

describe('turnStop', () => {
  beforeEach(() => { _resetStops(); });

  // ── The safety property. See the header. ──────────────────────────────────
  it('a stop names ONE turn: another turn in the same conversation is untouched', () => {
    let firedT2 = 0;
    onStop(C, T2, () => { firedT2++; });

    const outcome = requestStop(C, T1);

    assert.equal(outcome, 'recorded', 'T1 had no listener, so it records');
    assert.equal(firedT2, 0, 'T2 must not be woken by a stop aimed at T1');
    assert.equal(isStopRequested(C, T2), false);
    assert.equal(isStopRequested(C, T1), true);
  });

  it('a stop does not cross conversations even with the same turnId', () => {
    let fired = 0;
    onStop('convo-B', T1, () => { fired++; });
    requestStop(C, T1);
    assert.equal(fired, 0);
    assert.equal(isStopRequested('convo-B', T1), false);
  });

  // ── The rendezvous, both orders. ──────────────────────────────────────────
  it('register then request: the listener fires', () => {
    let fired = 0;
    onStop(C, T1, () => { fired++; });
    const outcome = requestStop(C, T1);
    assert.equal(outcome, 'fired');
    assert.equal(fired, 1);
  });

  it('request before register still fires — synchronously, during onStop', () => {
    requestStop(C, T1);

    let firedDuringCall = false;
    let fired = 0;
    const unregister = onStop(C, T1, () => { fired++; firedDuringCall = true; });

    assert.equal(fired, 1, 'a turn that registers late is told at once');
    assert.equal(firedDuringCall, true, 'and before onStop returns, not on a later tick');
    // The returned handle must still be safe to call.
    assert.doesNotThrow(() => unregister());
  });

  // ── Unregistering must really stop delivery. ──────────────────────────────
  it('unregister prevents the callback from being called', () => {
    let fired = 0;
    const off = onStop(C, T1, () => { fired++; });
    off();
    requestStop(C, T1);
    assert.equal(fired, 0);
    assert.equal(_stopState().listeners, 0, 'and the empty set is not left behind');
  });

  it('unregister is idempotent and does not disturb a sibling listener', () => {
    let a = 0, b = 0;
    const offA = onStop(C, T1, () => { a++; });
    onStop(C, T1, () => { b++; });
    offA();
    offA();
    requestStop(C, T1);
    assert.equal(a, 0);
    assert.equal(b, 1);
  });

  // ── Multiple listeners, and the mutate-while-firing shape. ────────────────
  it('every listener registered for the turn fires', () => {
    const seen: string[] = [];
    onStop(C, T1, () => { seen.push('a'); });
    onStop(C, T1, () => { seen.push('b'); });
    onStop(C, T1, () => { seen.push('c'); });
    requestStop(C, T1);
    assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
  });

  // ⚠ NOT DISCRIMINATING for the iteration strategy — see the header. Kept for
  // the call shape and for the detach ordering it would catch.
  it('a listener that unregisters itself does not hide the next one', () => {
    const seen: string[] = [];
    // This is the chat route's real shape: the callback tears down its own
    // registration while it runs.
    let offA: () => void = () => {};
    offA = onStop(C, T1, () => { seen.push('a'); offA(); });
    onStop(C, T1, () => { seen.push('b'); });

    requestStop(C, T1);

    assert.deepEqual(seen.sort(), ['a', 'b'], 'b must still be called');
  });

  it('a throwing listener does not swallow the others', () => {
    const seen: string[] = [];
    onStop(C, T1, () => { throw new Error('boom'); });
    onStop(C, T1, () => { seen.push('survivor'); });
    assert.doesNotThrow(() => requestStop(C, T1));
    assert.deepEqual(seen, ['survivor']);
  });

  // ── Outcomes are reportable facts, not always-ok. ─────────────────────────
  it('outcome distinguishes recorded / fired / already', () => {
    assert.equal(requestStop(C, T1), 'recorded', 'nobody listening yet');
    assert.equal(requestStop(C, T1), 'already', 'same turn, second ask');

    let fired = 0;
    onStop(C, T2, () => { fired++; });
    assert.equal(requestStop(C, T2), 'fired');
    assert.equal(fired, 1);
  });

  it('a second request after firing reports already, and re-fires nothing', () => {
    let fired = 0;
    onStop(C, T1, () => { fired++; });
    requestStop(C, T1);
    assert.equal(requestStop(C, T1), 'already');
    assert.equal(fired, 1, 'the listener was consumed, not kept for replay');
  });

  // ── Cleanup. ──────────────────────────────────────────────────────────────
  it('forgetStop removes both the record and any listener', () => {
    let fired = 0;
    onStop(C, T1, () => { fired++; });
    requestStop(C, T2);          // a record with no listener
    forgetStop(C, T1);
    forgetStop(C, T2);

    assert.equal(isStopRequested(C, T2), false);
    assert.deepEqual(_stopState(), { requests: 0, listeners: 0 });

    requestStop(C, T1);
    assert.equal(fired, 0, 'the forgotten listener must not be reachable');
  });

  it('forgetStop on an unknown turn is a no-op, not a throw', () => {
    assert.doesNotThrow(() => forgetStop(C, 'never-existed'));
    assert.deepEqual(_stopState(), { requests: 0, listeners: 0 });
  });

  // ── Degenerate input. ─────────────────────────────────────────────────────
  it('empty ids are refused rather than creating a wildcard record', () => {
    assert.equal(requestStop('', T1), 'already');
    assert.equal(requestStop(C, ''), 'already');
    assert.equal(isStopRequested('', ''), false);
    assert.deepEqual(_stopState(), { requests: 0, listeners: 0 },
      'an empty key must never land in the map — that is the wildcard this design forbids');

    let fired = 0;
    const off = onStop('', '', () => { fired++; });
    assert.doesNotThrow(() => off());
    assert.equal(fired, 0);
  });

  // ── Bounded memory. ───────────────────────────────────────────────────────
  it('the record map is capped, evicting oldest first', () => {
    const over = MAX_STOP_RECORDS + 25;
    for (let i = 0; i < over; i++) requestStop(C, `turn_${i}`);

    assert.equal(_stopState().requests, MAX_STOP_RECORDS);
    assert.equal(isStopRequested(C, 'turn_0'), false, 'oldest evicted');
    assert.equal(isStopRequested(C, `turn_${over - 1}`), true, 'newest kept');
  });

  // ── The key is one derivation. ────────────────────────────────────────────
  it('stopKey separates ids that would collide under naive concatenation', () => {
    // 'a' + 'bc' and 'ab' + 'c' must not be the same key.
    assert.notEqual(stopKey('a', 'bc'), stopKey('ab', 'c'));
  });
});
