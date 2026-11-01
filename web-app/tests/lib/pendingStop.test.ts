/**
 * pendingStop — Stop pressed before the turn has a name.
 *
 * NEW TEST for a reported bug (2026-11-01, トカゲくん): "I sent a message by
 * mistake and pressed Stop at once — it did nothing. The thinking had not
 * started yet. Quite a dangerous bug."
 *
 * These are written from the FAILURE MODE, not from the implementation. The
 * old behaviour was not a wrong value; it was a silent third outcome — no POST
 * and no memory — so the thing to assert is that every press leads to exactly
 * one of "sent now" or "held for the name", and never to neither.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planStopPress, planTurnNamed } from '../../src/lib/pendingStop';

const KEY = { convoId: 'c1', turnId: 'turn_abc' };

describe('planStopPress', () => {
  it('posts at once when the turn already has a name', () => {
    const p = planStopPress(KEY, true);
    assert.deepEqual(p.post, KEY);
    assert.equal(p.remember, false, 'already delivered — holding it would double-send');
  });

  it('REMEMBERS the press when a turn is in flight but unnamed', () => {
    // THE regression. This case used to produce neither a POST nor a flag, so
    // the press vanished and the turn ran to completion.
    const p = planStopPress(null, true);
    assert.equal(p.post, null, 'there is nothing to address yet');
    assert.equal(p.remember, true, 'and that is exactly why it must be kept');
  });

  it('drops a press when no turn is on its way', () => {
    // A remembered press with no turn would land on whatever runs NEXT —
    // the same class of harm as turnStop's stale-record warning.
    const p = planStopPress(null, false);
    assert.equal(p.post, null);
    assert.equal(p.remember, false);
  });

  it('treats a key with an empty turnId as no name at all', () => {
    // The relay answers `X-Turn-Id: ''` when it has nothing; posting that
    // would address a turn that does not exist, and requestStop would record
    // it under a key no listener can ever match.
    const p = planStopPress({ convoId: 'c1', turnId: '' }, true);
    assert.equal(p.post, null);
    assert.equal(p.remember, true, 'the press is still live — it just has no address');
  });

  it('never produces both a POST and a held press', () => {
    for (const active of [KEY, null, { convoId: 'c1', turnId: '' }]) {
      for (const inFlight of [true, false]) {
        const p = planStopPress(active, inFlight);
        assert.equal(
          p.post !== null && p.remember, false,
          'holding a press that was already sent means stopping the next turn too',
        );
      }
    }
  });
});

describe('planTurnNamed', () => {
  it('delivers a held press the moment the name arrives', () => {
    const p = planTurnNamed(true, KEY);
    assert.deepEqual(p.post, KEY);
  });

  it('does NOT offer the interjection box for a turn being torn down', () => {
    // A control addressing something already going away is the shape this
    // house refuses — and it is literally what the Stop button was doing
    // before this module existed.
    assert.equal(planTurnNamed(true, KEY).showInterjection, false);
  });

  it('offers the interjection box on a normal handover', () => {
    const p = planTurnNamed(false, KEY);
    assert.equal(p.post, null, 'nobody asked to stop');
    assert.equal(p.showInterjection, true);
  });
});
