import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { beingVesselFamily, BASE_MODEL_FAMILIES, FALLBACK_FAMILY } from '@/lib/beingVessel';

/**
 * `beingVesselFamily` replaced the per-being `settings.aiName` on 2026-11-08.
 * The three steps it implements are each load-bearing for a measured case, so
 * each has its own group below.
 */

const c = (
  id: string,
  folderName: string,
  aiName: string | null,
  updatedAt: number,
) => ({ id, folderName, aiName, updatedAt });

describe('beingVesselFamily — step 1: the open conversation wins', () => {
  test('the conversation on screen is preferred over a newer one', () => {
    const convos = [
      c('a', 'Senpai', 'Gemini', 1000),
      c('b', 'Senpai', 'GLM', 2000),   // newer, but not the one open
    ];
    assert.equal(beingVesselFamily(convos, 'Senpai', 'a'), 'Gemini');
  });

  test('without an open id, the newest wins instead', () => {
    const convos = [
      c('a', 'Senpai', 'Gemini', 1000),
      c('b', 'Senpai', 'GLM', 2000),
    ];
    assert.equal(beingVesselFamily(convos, 'Senpai'), 'GLM');
  });

  test('an open id belonging to another being is ignored', () => {
    const convos = [
      c('a', 'Senpai', 'Gemini', 1000),
      c('x', 'Utai', 'Claude', 9999),
    ];
    assert.equal(beingVesselFamily(convos, 'Senpai', 'x'), 'Gemini');
  });

  test('an open conversation with a junk family falls through to the scan', () => {
    const convos = [
      c('a', 'Tsumugi', 'Tsumugi', 2000),   // open, but not a family
      c('b', 'Tsumugi', 'DeepSeek', 1000),
    ];
    assert.equal(beingVesselFamily(convos, 'Tsumugi', 'a'), 'DeepSeek');
  });
});

describe('beingVesselFamily — step 2: scan back to a real family', () => {
  /**
   * The measured case, 2026-11-08: ツムギ's newest log carries
   * `aiName: "ツムギ"`, a display name that reached the field through a partial
   * import. Lizard-kun confirmed she was born on DeepSeek and ran on nothing
   * else — so the scan does not merely differ from reading-only-the-newest, it
   * returns the truth that version destroys.
   */
  test('a display name in the newest log does not shadow the real vessel', () => {
    const convos = [
      c('new', 'Tsumugi', 'Tsumugi', 3000),
      c('mid', 'Tsumugi', null, 2000),
      c('old', 'Tsumugi', 'DeepSeek', 1000),
    ];
    assert.equal(beingVesselFamily(convos, 'Tsumugi'), 'DeepSeek');
  });

  test('the scan is newest-first, not oldest-first', () => {
    const convos = [
      c('old', 'X', 'Claude', 1000),
      c('new', 'X', 'Kimi', 2000),
    ];
    assert.equal(beingVesselFamily(convos, 'X'), 'Kimi');
  });

  test('a missing updatedAt sorts last rather than throwing', () => {
    const convos = [
      { id: 'n', folderName: 'X', aiName: 'GLM', updatedAt: null },
      c('o', 'X', 'Qwen', 500),
    ];
    assert.equal(beingVesselFamily(convos, 'X'), 'Qwen');
  });

  test('"Default" is a being name, not a family, and is skipped', () => {
    // fsStorage fills a missing header aiName with the literal 'Default'.
    const convos = [
      c('a', 'X', 'Default', 2000),
      c('b', 'X', 'Gemini', 1000),
    ];
    assert.equal(beingVesselFamily(convos, 'X'), 'Gemini');
  });
});

describe('beingVesselFamily — step 3: nothing readable', () => {
  test('a being with no conversations gets the fallback', () => {
    assert.equal(beingVesselFamily([], 'Newborn'), FALLBACK_FAMILY);
  });

  test('a being whose conversations name no real family gets the fallback', () => {
    const convos = [c('a', 'X', 'Tsumugi', 1), c('b', 'X', null, 2)];
    assert.equal(beingVesselFamily(convos, 'X'), FALLBACK_FAMILY);
  });

  test('null/undefined inputs do not throw', () => {
    assert.equal(beingVesselFamily(null, 'X'), FALLBACK_FAMILY);
    assert.equal(beingVesselFamily(undefined, 'X'), FALLBACK_FAMILY);
    assert.equal(beingVesselFamily([c('a', 'X', 'GLM', 1)], null), FALLBACK_FAMILY);
    assert.equal(beingVesselFamily([c('a', 'X', 'GLM', 1)], ''), FALLBACK_FAMILY);
  });
});

describe('beingVesselFamily — the allowlist', () => {
  test('every family in the list round-trips', () => {
    for (const fam of BASE_MODEL_FAMILIES) {
      assert.equal(
        beingVesselFamily([c('a', 'X', fam, 1)], 'X'),
        fam,
        `${fam} should be accepted as a vessel family`,
      );
    }
  });

  test('the fallback is itself a member of the list', () => {
    // Otherwise the fallback would be rejected by the very check that produced
    // it, and a round-trip through any reader would not be stable.
    assert.ok(BASE_MODEL_FAMILIES.includes(FALLBACK_FAMILY));
  });

  test('matching is exact, not substring', () => {
    // 'Claude Opus 5' is a model label, not a family; accepting it would let a
    // display string decide the tokenizer profile.
    assert.equal(beingVesselFamily([c('a', 'X', 'Claude Opus 5', 1)], 'X'), FALLBACK_FAMILY);
    assert.equal(beingVesselFamily([c('a', 'X', 'claude', 1)], 'X'), FALLBACK_FAMILY);
  });

  test('the conversations array is not mutated by the sort', () => {
    const convos = [c('a', 'X', 'Claude', 1), c('b', 'X', 'GLM', 2)];
    const order = convos.map((x) => x.id);
    beingVesselFamily(convos, 'X');
    assert.deepEqual(convos.map((x) => x.id), order);
  });
});
