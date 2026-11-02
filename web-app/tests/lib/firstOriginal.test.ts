/**
 * firstOriginal — the copied/original boundary, extracted 2026-10-27 from four
 * independent derivations (ChatArea, api/stats, conversationSearch, and the
 * since-deleted addTimestamps action).
 *
 * NEW TEST. No probe existed: the rule had HTTP and e2e coverage through
 * handover restore, but no unit test of its own — which is how a fix could land
 * in one of four copies and leave the other three on the old behaviour.
 *
 * Written against the lib's documented contract, which was in turn transcribed
 * from the surviving copies. So these cases do not prove the rule is RIGHT;
 * they pin the rule that is there, and they fail if a refactor moves it. The
 * one case that says something about correctness is marked REGRESSION: it is
 * the defect that actually shipped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeIsOriginalIndex, makeIsOriginalId, optimisticMarkerIndex,
  isMarkerPending, promotePendingMarker, adoptResolvedMarker,
} from '../../src/lib/firstOriginal';

const msgs = (...ids: string[]) => ids.map((id) => ({ id }));
const FIVE = msgs('a', 'b', 'c', 'd', 'e');

describe('makeIsOriginalIndex', () => {
  it('REGRESSION: no marker at all means EVERY message is original', () => {
    // Reading the marker's absence as `false` is the defect that made handover
    // restore return nothing on 2026-10-23: 245 conversations have no marker
    // because they predate it or were hand-built.
    const isOriginal = makeIsOriginalIndex({}, FIVE);
    assert.deepEqual(FIVE.map((_, i) => isOriginal(i)), [true, true, true, true, true]);
  });

  it('REGRESSION: an explicitly null marker is still "no marker"', () => {
    const isOriginal = makeIsOriginalIndex(
      { firstOriginalMessageId: null, firstOriginalIsNext: false }, FIVE);
    assert.equal(isOriginal(0), true);
  });

  it('pending with no marker yet means NOTHING is original', () => {
    // The post-clone state: the marker lands on the next message added, so
    // everything currently in the log is carry-over.
    const isOriginal = makeIsOriginalIndex({ firstOriginalIsNext: true }, FIVE);
    assert.deepEqual(FIVE.map((_, i) => isOriginal(i)), [false, false, false, false, false]);
  });

  it('a marker splits the list: before = copied, at and after = original', () => {
    const isOriginal = makeIsOriginalIndex({ firstOriginalMessageId: 'c' }, FIVE);
    assert.deepEqual(FIVE.map((_, i) => isOriginal(i)), [false, false, true, true, true]);
  });

  it('a marker on the first message makes everything original', () => {
    const isOriginal = makeIsOriginalIndex({ firstOriginalMessageId: 'a' }, FIVE);
    assert.deepEqual(FIVE.map((_, i) => isOriginal(i)), [true, true, true, true, true]);
  });

  it('a marker whose message was deleted falls back to everything original', () => {
    const isOriginal = makeIsOriginalIndex({ firstOriginalMessageId: 'gone' }, FIVE);
    assert.deepEqual(FIVE.map((_, i) => isOriginal(i)), [true, true, true, true, true]);
  });

  it('a set marker WINS over a stale pending flag', () => {
    // The two fields are meant to be mutually exclusive (the clone sets the
    // flag; the next user turn consumes it and sets the marker). If both are
    // somehow set, the marker decides. Pinned because ChatArea's token
    // accounting HAD a separate partial form — `markerIdx < 0 &&
    // firstOriginalIsNext` — which answers the OPPOSITE way for a set-but-
    // deleted marker.
    //
    // ⚠ CORRECTED 2026-11-02: that partial copy is gone; the breakdown calls
    // this predicate now. So this case no longer guards against a refactor
    // TOWARD the other shape — it pins the contract the breakdown inherited
    // by being pointed here. The warning was accurate the day it was written
    // and became a claim about code that no longer exists.
    //
    // (It was the FIFTH derivation, not one of the four the lib's header
    // names: those were full copies, and this one survived the 2026-10-27
    // extraction because it was a partial form. My first draft of this
    // correction said "fourth" and had to be corrected in turn.)
    const isOriginal = makeIsOriginalIndex(
      { firstOriginalMessageId: 'c', firstOriginalIsNext: true }, FIVE);
    assert.deepEqual(FIVE.map((_, i) => isOriginal(i)), [false, false, true, true, true]);
  });

  it('treats a non-boolean pending flag as not pending', () => {
    // The client holds this as useState<boolean>, but a log on disk is JSON
    // and can carry anything. `=== true` is the contract.
    const isOriginal = makeIsOriginalIndex({ firstOriginalIsNext: 'yes' as never }, FIVE);
    assert.equal(isOriginal(0), true);
  });

  it('handles an empty message list without throwing', () => {
    assert.equal(makeIsOriginalIndex({ firstOriginalMessageId: 'c' }, [])(0), true);
    assert.equal(makeIsOriginalIndex({ firstOriginalIsNext: true }, [])(0), false);
  });
});

describe('makeIsOriginalId — the client adapter', () => {
  it('answers by message id', () => {
    const isOriginal = makeIsOriginalId({ firstOriginalMessageId: 'c' }, FIVE);
    assert.deepEqual(FIVE.map((m) => isOriginal(m.id)), [false, false, true, true, true]);
  });

  it('an unknown id resolves to index -1, matching the old inline copy', () => {
    // ChatArea's removed copy did `messages.findIndex(...) >= markerIdx` with
    // no guard, so an id that is not in the list compared -1 against the
    // marker index. Preserved exactly, including this case.
    assert.equal(makeIsOriginalId({ firstOriginalMessageId: 'c' }, FIVE)('nope'), false);
    assert.equal(makeIsOriginalId({ firstOriginalMessageId: 'a' }, FIVE)('nope'), false);
    assert.equal(makeIsOriginalId({}, FIVE)('nope'), true);
    assert.equal(makeIsOriginalId({ firstOriginalIsNext: true }, FIVE)('nope'), false);
    assert.equal(makeIsOriginalId({ firstOriginalMessageId: 'gone' }, FIVE)('nope'), true);
  });
});

describe('the two adapters cannot drift apart', () => {
  it('agree for every message under every marker state', () => {
    // THIS is the single-source guarantee. If someone re-implements the rule
    // inside one adapter instead of calling the other, this goes red — which
    // is the failure that four copies of this rule actually produced.
    const states = [
      {},
      { firstOriginalIsNext: true },
      { firstOriginalIsNext: false },
      { firstOriginalMessageId: null },
      { firstOriginalMessageId: 'a' },
      { firstOriginalMessageId: 'c' },
      { firstOriginalMessageId: 'e' },
      { firstOriginalMessageId: 'gone' },
      { firstOriginalMessageId: 'c', firstOriginalIsNext: true },
      { firstOriginalMessageId: null, firstOriginalIsNext: true },
    ];
    let checked = 0;
    for (const state of states) {
      const byIndex = makeIsOriginalIndex(state, FIVE);
      const byId = makeIsOriginalId(state, FIVE);
      for (let i = 0; i < FIVE.length; i++) {
        assert.equal(
          byId(FIVE[i].id), byIndex(i),
          `adapters disagree at idx ${i} for ${JSON.stringify(state)}`,
        );
        checked++;
      }
    }
    // Say what was covered, so a shrunken list cannot pass quietly.
    assert.equal(checked, states.length * FIVE.length);
    assert.equal(checked, 50);
  });
});

// ── the clone boundary's SECOND HALF (2026-10-31) ────────────────────────────
//
// REGRESSION, reported by ふわふわ: "Next = First Original" stopped working on
// dev. The rule used to be three lines in ChatArea.handleSend, which minted the
// user message; the server-side runner mints it now, and nothing took over. The
// flag stayed pending forever, and pending-with-no-marker reads as "NOTHING is
// original" — so every message in every cloned conversation read as carry-over,
// permanently. These pin the rule in its new home.

describe('isMarkerPending', () => {
  it('pending means the flag is set and no marker has landed yet', () => {
    assert.equal(isMarkerPending({ firstOriginalIsNext: true }), true);
    assert.equal(isMarkerPending({ firstOriginalIsNext: true, firstOriginalMessageId: null }), true);
  });

  it('a marker that already landed is NOT pending', () => {
    // Without this, a second send would move the boundary to itself and
    // everything between the clone and now would flip to "copied".
    assert.equal(isMarkerPending({ firstOriginalIsNext: true, firstOriginalMessageId: 'u9' }), false);
  });

  it('no flag is not pending, and a non-boolean flag is not pending', () => {
    assert.equal(isMarkerPending({}), false);
    assert.equal(isMarkerPending({ firstOriginalIsNext: 'yes' as never }), false);
  });
});

describe('promotePendingMarker', () => {
  it('a pending boundary lands on the new user message and the flag clears', () => {
    assert.deepEqual(
      promotePendingMarker({ firstOriginalIsNext: true }, 'u-new'),
      { firstOriginalMessageId: 'u-new', firstOriginalIsNext: false },
    );
  });

  it('REGRESSION: a log that was never cloned is NOT touched', () => {
    // The load-bearing case. Without the pending gate every ordinary send
    // would set the marker to its own message, and the whole conversation
    // above it would read as copied context — the inverse of today's bug and
    // just as invisible.
    assert.equal(promotePendingMarker({}, 'u-new'), null);
    assert.equal(promotePendingMarker({ firstOriginalIsNext: false }, 'u-new'), null);
  });

  it('an already-resolved boundary is not moved', () => {
    assert.equal(
      promotePendingMarker({ firstOriginalIsNext: true, firstOriginalMessageId: 'u1' }, 'u-new'),
      null,
    );
  });

  it('an empty id does not resolve the boundary', () => {
    // A patch carrying '' would clear the pending flag AND resolve to no
    // marker (`markerId || null`), which reads as "everything original" — the
    // boundary would be lost with nothing left to say it was ever pending.
    assert.equal(promotePendingMarker({ firstOriginalIsNext: true }, ''), null);
  });
});

describe('adoptResolvedMarker', () => {
  it('a pending tab learns the marker the runner resolved', () => {
    assert.deepEqual(
      adoptResolvedMarker({ firstOriginalIsNext: true }, { firstOriginalMessageId: 'u-run', firstOriginalIsNext: false }),
      { firstOriginalMessageId: 'u-run', firstOriginalIsNext: false },
    );
  });

  it('MONOTONE: a marker the state already holds is never overruled', () => {
    // Without this a reload could overwrite a boundary the human set by hand
    // from the message menu, and the only trace would be the screen changing.
    assert.equal(
      adoptResolvedMarker(
        { firstOriginalIsNext: false, firstOriginalMessageId: 'mine' },
        { firstOriginalMessageId: 'other', firstOriginalIsNext: false },
      ),
      null,
    );
  });

  it('MONOTONE: a tab that is not pending never acquires a boundary', () => {
    // A conversation that never went through the clone workflow must not read
    // its own early history as carry-over because disk happens to carry a
    // marker from somewhere.
    assert.equal(adoptResolvedMarker({}, { firstOriginalMessageId: 'u-run' }), null);
  });

  it('nothing is adopted while disk is still pending too', () => {
    assert.equal(adoptResolvedMarker({ firstOriginalIsNext: true }, { firstOriginalIsNext: true }), null);
    assert.equal(adoptResolvedMarker({ firstOriginalIsNext: true }, {}), null);
  });

  it('a non-string marker on disk is not adopted', () => {
    assert.equal(
      adoptResolvedMarker({ firstOriginalIsNext: true }, { firstOriginalMessageId: 7 as never }),
      null,
    );
  });
});

// ── the boundary DURING a turn (2026-11-02) ──────────────────────────────────
//
// REPORTED by Lizard-kun: after a sleep, the pending flag is set; you send a
// message and both it and the reply stay grey, and the flag does not land on
// your message — but only until the turn ends. The runner mints the user
// message, so the marker only reaches disk at save; between send and save
// `isNext && !markerId` read this tab's own copy of the sent text, and the
// reply growing under it, as pre-clone carry-over.

// The only fixture in this file that carries `role` — it is the only field
// `optimisticMarkerIndex` reads besides `id`.
const CLONED = [
  { id: 'c1', role: 'user' },       // carry-over
  { id: 'c2', role: 'assistant' },  // carry-over
  { id: 'o1', role: 'user' },       // this tab's optimistic bubble
  { id: 'o2', role: 'assistant' },  // the placeholder growing under it
];
const PENDING = { firstOriginalIsNext: true };

describe('optimisticMarkerIndex', () => {
  it('finds the optimistic user message the pending boundary will land on', () => {
    // Without this the whole fix has nothing to hand the predicate.
    assert.equal(optimisticMarkerIndex(PENDING, CLONED, ['o1']), 2);
  });

  it('the FIRST optimistic user message in list order, not the last', () => {
    // A batch can contribute several; the pending marker lands on the next
    // user message ADDED, so the boundary belongs at the earliest of them.
    // Without this, a two-message batch would read its own first half as
    // carry-over.
    const two = [...CLONED, { id: 'o3', role: 'user' }];
    assert.equal(optimisticMarkerIndex(PENDING, two, ['o1', 'o3']), 2);
    // Order of the id array must not decide it — the list is the one that is
    // true. Reversed input, same answer.
    assert.equal(optimisticMarkerIndex(PENDING, two, ['o3', 'o1']), 2);
  });

  it('NOT pending means no landing index, even with optimistic bubbles', () => {
    // The load-bearing gate. Without it, every ordinary send in a conversation
    // that was never cloned would report a boundary at its own message, and
    // everything above would flip to copied — the same inverse that
    // promotePendingMarker's pending gate prevents on disk.
    assert.equal(optimisticMarkerIndex({}, CLONED, ['o1']), -1);
    assert.equal(optimisticMarkerIndex({ firstOriginalIsNext: false }, CLONED, ['o1']), -1);
  });

  it('an already-resolved marker means no landing index', () => {
    // Pending is defined as flag-set AND no marker; a resolved boundary must
    // not be second-guessed by a bubble.
    assert.equal(
      optimisticMarkerIndex(
        { firstOriginalIsNext: true, firstOriginalMessageId: 'c1' }, CLONED, ['o1']),
      -1,
    );
  });

  it('no optimistic ids, or ids not in the list, means no landing index', () => {
    // The pre-send state (pending, nothing typed yet) and the post-patch state
    // (the bubble was replaced by the runner's copy, the list cleared a beat
    // later). Both must fall back to the old answer rather than guess.
    assert.equal(optimisticMarkerIndex(PENDING, CLONED, []), -1);
    assert.equal(optimisticMarkerIndex(PENDING, CLONED, ['not-here']), -1);
  });

  it('an optimistic ASSISTANT id does not place the boundary', () => {
    // Only a user message can be the marker. Without the role check, a
    // placeholder id would place the boundary on the reply and leave the
    // question that produced it reading as carry-over.
    assert.equal(optimisticMarkerIndex(PENDING, CLONED, ['o2']), -1);
  });

  it('handles an empty list and messages with no id', () => {
    assert.equal(optimisticMarkerIndex(PENDING, [], ['o1']), -1);
    assert.equal(optimisticMarkerIndex(PENDING, [{ role: 'user' }], ['o1']), -1);
  });
});

describe('makeIsOriginal* with an optimistic landing index', () => {
  it('REGRESSION: the sent message and its reply are original mid-turn', () => {
    // Lizard-kun's report, as a predicate: carry-over stays grey, the message
    // just sent and the reply under it do not.
    const isOriginal = makeIsOriginalIndex(PENDING, CLONED, 2);
    assert.deepEqual(CLONED.map((_, i) => isOriginal(i)), [false, false, true, true]);
  });

  it('-1 keeps the old answer exactly — nothing original', () => {
    // The no-regression guarantee: every caller that passes nothing (both
    // server walks) and every mid-turn state where the landing message is not
    // present gets the pre-2026-11-02 behaviour.
    const withDefault = makeIsOriginalIndex(PENDING, CLONED);
    const withMinusOne = makeIsOriginalIndex(PENDING, CLONED, -1);
    assert.deepEqual(CLONED.map((_, i) => withDefault(i)), [false, false, false, false]);
    assert.deepEqual(CLONED.map((_, i) => withMinusOne(i)), [false, false, false, false]);
  });

  it('a RESOLVED marker ignores the optimistic index entirely', () => {
    // Once the runner's marker is adopted, the bubble is gone and the real
    // boundary decides. Passing a stale index must not move it.
    const isOriginal = makeIsOriginalIndex(
      { firstOriginalMessageId: 'c2' }, CLONED, 0);
    assert.deepEqual(CLONED.map((_, i) => isOriginal(i)), [false, true, true, true]);
  });

  it('the id adapter agrees with the index adapter, optimistic index included', () => {
    // The single-source guarantee, extended to the new argument: the token
    // breakdown uses the index form and the bubbles use the id form, on the
    // same screen, from the same number.
    let checked = 0;
    for (const idx of [-1, 0, 2, 3, 99]) {
      const byIndex = makeIsOriginalIndex(PENDING, CLONED, idx);
      const byId = makeIsOriginalId(PENDING, CLONED, idx);
      for (let i = 0; i < CLONED.length; i++) {
        assert.equal(byId(CLONED[i].id), byIndex(i), `disagree at idx ${i}, landing ${idx}`);
        checked++;
      }
    }
    assert.equal(checked, 20);
  });

  it('a landing index past the end makes nothing original', () => {
    // Not reachable from optimisticMarkerIndex (it returns a real index or
    // -1), but the predicate is exported and the arithmetic should not invert.
    const isOriginal = makeIsOriginalIndex(PENDING, CLONED, 99);
    assert.deepEqual(CLONED.map((_, i) => isOriginal(i)), [false, false, false, false]);
  });

  it('a landing index of 0 makes EVERYTHING original', () => {
    // The mirror of "a marker on the first message makes everything original",
    // and REACHABLE: a cloned conversation whose carry-over was all
    // auto-trimmed away leaves the optimistic bubble at messages[0]. Found by
    // a surviving mutation (`< 0` -> `<= 0`) — I had written the upper bound
    // of this range (99, above) and not the lower one, so the guard could be
    // tightened into rejecting a real case and every test stayed green.
    const isOriginal = makeIsOriginalIndex(PENDING, CLONED, 0);
    assert.deepEqual(CLONED.map((_, i) => isOriginal(i)), [true, true, true, true]);
  });
});
