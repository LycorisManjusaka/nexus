/**
 * autoTriggers — which reasons may start a turn by themselves.
 *
 * NEW MODULE, new tests. Written alongside the module, so most of these pin
 * the contract rather than discovering anything: they fail if a refactor
 * moves the rule, which is their whole job.
 *
 * The four marked WHAT-BREAKS are different. For each one I wrote down what
 * would look different in the product if the property were absent, BEFORE
 * writing the assertion — because a test whose removal changes nothing
 * observable is looking at the thing next door.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAutoTriggers,
  autoTriggerEnabled,
  setAutoTrigger,
  AUTO_TRIGGER_KEYS,
} from '../../src/lib/autoTriggers';

describe('parseAutoTriggers', () => {
  it('WHAT-BREAKS: absent field is off, so old conversations stay manual', () => {
    // Without this: every conversation saved before today (all of them) would
    // read as "allowed to wake on its own" the moment a runner exists.
    assert.deepEqual(parseAutoTriggers(undefined), {});
    assert.equal(autoTriggerEnabled(undefined, 'stock'), false);
    assert.equal(autoTriggerEnabled(null, 'stock'), false);
    assert.equal(autoTriggerEnabled({}, 'stock'), false);
  });

  it('WHAT-BREAKS: a non-boolean is dropped, not coerced to on', () => {
    // Without this: a hand-edited log with "stock": "true" — or "false",
    // which is ALSO truthy as a string — wakes a being up. The string
    // "false" is the case that makes coercion indefensible.
    assert.deepEqual(parseAutoTriggers({ stock: 'true' }), {});
    assert.deepEqual(parseAutoTriggers({ stock: 'false' }), {});
    assert.deepEqual(parseAutoTriggers({ stock: 1 }), {});
    assert.equal(autoTriggerEnabled({ stock: 'true' }, 'stock'), false);
  });

  it('reads an explicit true and an explicit false', () => {
    assert.deepEqual(parseAutoTriggers({ stock: true }), { stock: true });
    assert.deepEqual(parseAutoTriggers({ stock: false }), { stock: false });
    assert.equal(autoTriggerEnabled({ stock: true }, 'stock'), true);
    assert.equal(autoTriggerEnabled({ stock: false }, 'stock'), false);
  });

  it('WHAT-BREAKS: an unknown key survives parsing', () => {
    // Without this: 3000 (dev) writes {stock, letter}; 3001 (main) loads,
    // parses away `letter`, saves — and a setting someone deliberately turned
    // on is gone with no error anywhere. The two trees share one local_data
    // right now, so this is today's situation, not a hypothetical.
    assert.deepEqual(
      parseAutoTriggers({ stock: true, somethingLater: false }),
      { stock: true, somethingLater: false }
    );
  });

  it('rejects shapes that are not plain objects', () => {
    // An array has Object.entries() too, and would silently parse into
    // {"0": true}. Named so the next reader knows it was considered.
    assert.deepEqual(parseAutoTriggers([true]), {});
    assert.deepEqual(parseAutoTriggers('stock'), {});
    assert.deepEqual(parseAutoTriggers(42), {});
    assert.deepEqual(parseAutoTriggers(true), {});
  });
});

describe('setAutoTrigger', () => {
  it('WHAT-BREAKS: setting one key leaves unknown keys alone', () => {
    // Without this: toggling the checkbox this build CAN show erases the
    // checkbox it cannot — and the person doing it sees a successful save.
    const after = setAutoTrigger({ stock: false, somethingLater: true }, 'stock', true);
    assert.deepEqual(after, { stock: true, somethingLater: true });
  });

  it('does not mutate its input', () => {
    const before = { stock: false };
    const after = setAutoTrigger(before, 'stock', true);
    assert.deepEqual(before, { stock: false });
    assert.equal(after.stock, true);
  });

  it('creates the map when there was none', () => {
    assert.deepEqual(setAutoTrigger(undefined, 'stock', true), { stock: true });
  });

  it('round trips through parse', () => {
    const on = setAutoTrigger(undefined, 'stock', true);
    assert.equal(autoTriggerEnabled(JSON.parse(JSON.stringify(on)), 'stock'), true);
  });
});

describe('AUTO_TRIGGER_KEYS', () => {
  it('every listed key is honoured by autoTriggerEnabled', () => {
    // Guards the panel against listing a row that does nothing: the UI
    // iterates this list, so a key here with no reader is a checkbox that
    // saves and is never consulted — the ok:true/updated:0 shape.
    for (const k of AUTO_TRIGGER_KEYS) {
      assert.equal(autoTriggerEnabled({ [k]: true }, k), true, `${k} on`);
      assert.equal(autoTriggerEnabled({ [k]: false }, k), false, `${k} off`);
      assert.equal(autoTriggerEnabled({}, k), false, `${k} absent`);
    }
  });

  it('has no duplicate keys', () => {
    assert.equal(new Set(AUTO_TRIGGER_KEYS).size, AUTO_TRIGGER_KEYS.length);
  });
});
