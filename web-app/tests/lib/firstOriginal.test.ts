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
  makeIsOriginalIndex, makeIsOriginalId,
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
    // accounting has a separate partial form — `markerIdx < 0 &&
    // firstOriginalIsNext` — which answers the OPPOSITE way for a set-but-
    // deleted marker. A refactor toward that shape should go red here.
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
