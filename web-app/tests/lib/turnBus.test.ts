/**
 * turnBus — the live relay for a turn running somewhere other than your tab
 * (phase 4b-5, 2026-10-29).
 *
 * NEW TEST. The module did not exist this morning.
 *
 * The usual caveat applies: several cases below were written from the
 * implementation and therefore restate it. These were not — each names the
 * failure the design is meant to make impossible, and each is INVISIBLE when
 * it happens, which is why it is worth a test rather than a comment:
 *
 *   "no chunk can land between the snapshot and the registration" — absent,
 *       a tab that subscribes while the model is mid-sentence silently loses
 *       the frames emitted in that gap. On screen that reads as a model that
 *       said less, with nothing in any log. MEASURED cost of getting this
 *       wrong in lib/sseFrames.ts for the same reason.
 *   "begin replaces, and tells the old watchers" — absent, a tab watching the
 *       previous turn hangs on a stream that will never produce another byte,
 *       because its relay object is no longer the one being published to.
 *   "a dead subscriber cannot block the others" — absent, one closed
 *       controller throwing on enqueue takes down delivery to every other
 *       watcher of the same turn.
 *   "endTurn's note is published BEFORE the end signal" — absent, a turn that
 *       failed ends identically to one that succeeded, and the watcher has to
 *       guess. This is the only channel a detached runner has to explain
 *       itself to a tab.
 *
 * ⚠ Deliberately NOT tested: eviction's preference for finished relays. The
 * property is real (dropping a live one blinds a watcher) but asserting it
 * needs 17 conversations' worth of setup to reach MAX_LIVE_TURNS, and the
 * constant is not exported. Named here rather than left as an untested claim.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  beginTurn,
  publishTurnText,
  endTurn,
  subscribeTurn,
  liveTurnStatus,
  __resetTurnBus,
} from '@/lib/turnBus';

const CONVO = 'c-1';

/** Collect everything a subscriber receives, end signal included. */
function watcher() {
  const got: Array<string | null> = [];
  return { got, fn: (t: string | null) => { got.push(t); } };
}

describe('turnBus: nothing is running', () => {
  test('subscribing to an unknown conversation answers null, not an error', () => {
    __resetTurnBus();
    assert.equal(subscribeTurn('never-seen', () => {}), null);
    assert.equal(liveTurnStatus('never-seen'), null);
  });

  test('publishing with no relay open is a no-op, not a throw', () => {
    __resetTurnBus();
    publishTurnText('never-seen', 'data: {}\n\n');
    assert.equal(liveTurnStatus('never-seen'), null);
  });

  test('ending a relay that was never opened is a no-op', () => {
    __resetTurnBus();
    endTurn('never-seen');
    assert.equal(liveTurnStatus('never-seen'), null);
  });
});

describe('turnBus: replay and live', () => {
  test('a late subscriber gets everything that came before, in order', () => {
    __resetTurnBus();
    beginTurn(CONVO, 1000);
    publishTurnText(CONVO, 'a');
    publishTurnText(CONVO, 'b');

    const w = watcher();
    const sub = subscribeTurn(CONVO, w.fn)!;
    assert.deepEqual(sub.replay, ['a', 'b']);
    assert.equal(sub.done, false);
    assert.equal(sub.startedAt, 1000);
    // Replay is handed back, NOT pushed through the callback: the caller
    // writes it into its own response. Pushing both would double every frame.
    assert.deepEqual(w.got, []);
  });

  test('frames published after subscribing reach the callback', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const w = watcher();
    subscribeTurn(CONVO, w.fn);
    publishTurnText(CONVO, 'x');
    publishTurnText(CONVO, 'y');
    assert.deepEqual(w.got, ['x', 'y']);
  });

  test('WHAT-BREAKS: no chunk can land between the snapshot and the registration', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    publishTurnText(CONVO, '1');

    // Publish from inside the subscribe callback's own registration window by
    // driving both through one synchronous block, which is exactly how the
    // route uses it. Replay + received must be the whole stream with nothing
    // duplicated and nothing missing.
    const w = watcher();
    const sub = subscribeTurn(CONVO, w.fn)!;
    publishTurnText(CONVO, '2');
    publishTurnText(CONVO, '3');

    assert.deepEqual([...sub.replay, ...w.got.filter((t) => t !== null)], ['1', '2', '3']);
  });

  test('two watchers of one turn each get the whole stream', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const a = watcher();
    const b = watcher();
    subscribeTurn(CONVO, a.fn);
    subscribeTurn(CONVO, b.fn);
    publishTurnText(CONVO, 'shared');
    assert.deepEqual(a.got, ['shared']);
    assert.deepEqual(b.got, ['shared']);
  });

  test('unsubscribing stops delivery without affecting the other watcher', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const a = watcher();
    const b = watcher();
    const sa = subscribeTurn(CONVO, a.fn)!;
    subscribeTurn(CONVO, b.fn);
    sa.unsubscribe();
    publishTurnText(CONVO, 'after');
    assert.deepEqual(a.got, []);
    assert.deepEqual(b.got, ['after']);
  });

  test('relays do not cross conversations', () => {
    __resetTurnBus();
    beginTurn('one');
    beginTurn('two');
    const w = watcher();
    subscribeTurn('one', w.fn);
    publishTurnText('two', 'not yours');
    assert.deepEqual(w.got, []);
  });

  test('an empty string is not published — it would be a frame carrying nothing', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const w = watcher();
    subscribeTurn(CONVO, w.fn);
    publishTurnText(CONVO, '');
    assert.deepEqual(w.got, []);
  });
});

describe('turnBus: ending', () => {
  test('WHAT-BREAKS: the note is published BEFORE the end signal', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const w = watcher();
    subscribeTurn(CONVO, w.fn);

    endTurn(CONVO, { type: 'error', error: 'vessel refused' });

    assert.equal(w.got.length, 2);
    assert.match(String(w.got[0]), /^data: /);
    assert.deepEqual(JSON.parse(String(w.got[0]).slice(6)), { type: 'error', error: 'vessel refused' });
    assert.equal(w.got[1], null, 'the end signal must be last');
  });

  test('ending with no note signals the end and adds no frame', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const w = watcher();
    subscribeTurn(CONVO, w.fn);
    endTurn(CONVO);
    assert.deepEqual(w.got, [null]);
  });

  test('a finished relay still replays, and says it is done', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    publishTurnText(CONVO, 'all of it');
    endTurn(CONVO);

    const w = watcher();
    const sub = subscribeTurn(CONVO, w.fn)!;
    assert.deepEqual(sub.replay, ['all of it']);
    assert.equal(sub.done, true);
    // No registration on a finished relay. Publishing cannot show this —
    // publish early-returns on `done` either way — so the discriminating
    // observation is the NEXT turn: a watcher left on the finished relay
    // would be carried into it and handed an end signal for a turn it never
    // watched. MEASURED: without the `!t.done` guard this assertion is the
    // only one in the file that changes.
    publishTurnText(CONVO, 'late');
    assert.deepEqual(w.got, []);
    beginTurn(CONVO);
    assert.deepEqual(w.got, [], 'a watcher of a finished relay is not carried into the next turn');
  });

  test('publishing after the end changes nothing', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    endTurn(CONVO);
    publishTurnText(CONVO, 'too late');
    assert.deepEqual(subscribeTurn(CONVO, () => {})!.replay, []);
  });

  test('ending twice signals once', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const w = watcher();
    subscribeTurn(CONVO, w.fn);
    endTurn(CONVO);
    endTurn(CONVO);
    assert.deepEqual(w.got, [null]);
  });

  test('liveTurnStatus distinguishes running from finished', () => {
    __resetTurnBus();
    beginTurn(CONVO, 500);
    publishTurnText(CONVO, 'abc');
    assert.deepEqual(liveTurnStatus(CONVO), { live: true, done: false, startedAt: 500, chars: 3 });
    endTurn(CONVO);
    assert.deepEqual(liveTurnStatus(CONVO), { live: false, done: true, startedAt: 500, chars: 3 });
  });
});

describe('turnBus: a second turn in the same conversation', () => {
  test('WHAT-BREAKS: begin replaces, and tells the old watchers', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    publishTurnText(CONVO, 'first turn');
    const old = watcher();
    subscribeTurn(CONVO, old.fn);

    beginTurn(CONVO);

    // The old watcher is released rather than left on a relay that will never
    // publish again — it can reconnect and get the new turn from its start.
    assert.deepEqual(old.got, [null]);
    assert.deepEqual(subscribeTurn(CONVO, () => {})!.replay, [], 'the buffer is the new turn, not both');
  });
});

describe('turnBus: a broken subscriber', () => {
  test('WHAT-BREAKS: a throwing watcher cannot stop delivery to the others', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const good = watcher();
    subscribeTurn(CONVO, () => { throw new Error('controller already closed'); });
    subscribeTurn(CONVO, good.fn);
    publishTurnText(CONVO, 'still arrives');
    assert.deepEqual(good.got, ['still arrives']);
  });

  test('a throwing watcher cannot stop the end signal either', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const good = watcher();
    subscribeTurn(CONVO, () => { throw new Error('gone'); });
    subscribeTurn(CONVO, good.fn);
    endTurn(CONVO);
    assert.deepEqual(good.got, [null]);
  });
});

describe('turnBus: the buffer is bounded', () => {
  test('past the cap, LIVE delivery continues and the replay says it is short', () => {
    __resetTurnBus();
    beginTurn(CONVO);
    const big = 'x'.repeat(1_000_000);
    for (let i = 0; i < 9; i++) publishTurnText(CONVO, big);

    const w = watcher();
    const sub = subscribeTurn(CONVO, w.fn)!;
    assert.ok(sub.replay.length < 9, 'the replay stopped growing');
    assert.equal(sub.truncated, true, 'and says so rather than looking complete');

    publishTurnText(CONVO, 'live frames keep flowing');
    assert.deepEqual(w.got, ['live frames keep flowing']);
  });
});
