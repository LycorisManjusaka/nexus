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
import { makeIsOriginalIndex, makeIsOriginalId } from '../../src/lib/firstOriginal';

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
