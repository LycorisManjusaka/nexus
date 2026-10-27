/**
 * retiredModels — a saved id a provider has withdrawn is DECLARED, never
 * hidden and never swapped.
 *
 * NEW TEST, written 2026-10-27. No probe existed. The guarded failure is a
 * `<select>` whose value matches no option rendering THE FIRST OPTION: the
 * screen then names a model the folder is not on, while requests still go out
 * on the retired id.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RETIRED_MODELS, retiredModelLabel } from '../../src/lib/retiredModels';

describe('retiredModelLabel', () => {
  it('labels a retired id with its kind and date', () => {
    const label = retiredModelLabel('mimo-v2.5');
    assert.ok(label, 'a retired id must produce a label');
    assert.match(label!, /RETIRED/, 'the kind is declared, not implied');
    assert.match(label!, /\d{4}-\d{2}-\d{2}/, 'with the date it happened');
  });

  it('returns null for a live id — the common case renders nothing extra', () => {
    assert.equal(retiredModelLabel('claude-opus-5'), null);
    assert.equal(retiredModelLabel('gemini-3.8-flash'), null);
  });

  it('returns null rather than throwing on absent input', () => {
    assert.equal(retiredModelLabel(undefined), null);
    assert.equal(retiredModelLabel(null), null);
    assert.equal(retiredModelLabel(''), null);
  });

  it('does not match a composite picker value', () => {
    // The Subagent picker uses `family|model` option values. The string shown
    // to the browser and the string looked up here are not the same string;
    // callers must pass the id, and a composite must not half-match.
    assert.equal(retiredModelLabel('mimo|mimo-v2.5'), null);
  });

  it('is NOT a remapper — no successor id is substituted', () => {
    // Swapping in a successor behind the owner's back would change a being's
    // vessel with nobody deciding it.
    for (const [id, label] of Object.entries(RETIRED_MODELS)) {
      assert.equal(retiredModelLabel(id), label, 'the label is all it returns');
    }
  });
});

describe('RETIRED_MODELS table', () => {
  it('every entry declares both the kind and a date', () => {
    const entries = Object.entries(RETIRED_MODELS);
    assert.ok(entries.length > 0);
    for (const [id, label] of entries) {
      assert.ok(id.length > 0);
      assert.match(label, /RETIRED \d{4}-\d{2}-\d{2}/, `${id} must say when`);
    }
  });
});
