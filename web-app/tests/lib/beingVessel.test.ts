import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  beingVesselFamily,
  BASE_MODEL_FAMILIES,
  FALLBACK_FAMILY,
  FAMILY_DEFAULT_MODEL,
  defaultModelForFamily,
  modelBelongsToFamily,
  folderModelForFamily,
} from '@/lib/beingVessel';

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

/**
 * These three moved here from ChatArea on 2026-11-08. `modelBelongsToFamily`
 * had spent three months in the component with no test, and became
 * load-bearing the same day: `folderModelForFamily` is built on it, and the
 * vessel derivation above made family and stored model disagree for 9 of 23
 * beings in this house.
 */

describe('modelBelongsToFamily', () => {
  test('a cloud model is not Local — the case Lizard-kun reported', () => {
    // Default/settings.json held aiName "Local" with specificModel
    // "claude-opus-4-8", and every new conversation inherited the pair.
    assert.equal(modelBelongsToFamily('claude-opus-4-8', 'Local'), false);
    assert.equal(modelBelongsToFamily('gemini-3.1-pro-preview', 'Local'), false);
    assert.equal(modelBelongsToFamily('glm-5.2', 'Local'), false);
  });

  test('a real local model id IS Local', () => {
    // These are actual ids from this machine's LM Studio catalogue. The
    // zai-org/ ones matter: they LOOK like the GLM cloud family and are not.
    for (const id of [
      'google/gemma-4-26b-a4b-qat',
      'gemma-4-26b-a4b-it-ultra-uncensored-heretic',
      'zai-org/glm-4.6v-flash',
      'zai-org/glm-4.7-flash',
    ]) {
      assert.equal(modelBelongsToFamily(id, 'Local'), true, `${id} should be Local`);
    }
  });

  test('digitalocean/ is never Local, whatever it hosts', () => {
    assert.equal(modelBelongsToFamily('digitalocean/glm-5.2', 'Local'), false);
    assert.equal(modelBelongsToFamily('digitalocean/glm-5.2', 'GLM'), true);
  });

  test('an empty or missing model belongs to nothing', () => {
    for (const f of BASE_MODEL_FAMILIES) {
      assert.equal(modelBelongsToFamily('', f), false);
      assert.equal(modelBelongsToFamily(null, f), false);
      assert.equal(modelBelongsToFamily(undefined, f), false);
    }
  });

  test('an unknown family claims nothing', () => {
    assert.equal(modelBelongsToFamily('claude-opus-5', 'Nonsense'), false);
  });

  test('matching is case-insensitive', () => {
    assert.equal(modelBelongsToFamily('MiniMax-M3', 'Minimax'), true);
    assert.equal(modelBelongsToFamily('moonshotai/Kimi-K3.1-Pro', 'Kimi'), true);
  });
});

describe('defaultModelForFamily', () => {
  /**
   * The load-bearing one. If a family's default did not satisfy that family's
   * own membership test, switching to it would immediately reject the model it
   * had just chosen — the select would fight itself, and which value won would
   * depend on effect order.
   */
  test("every family's default belongs to that family (Local excepted, it has none)", () => {
    for (const f of BASE_MODEL_FAMILIES) {
      const m = defaultModelForFamily(f);
      if (f === 'Local') {
        assert.equal(m, '', 'Local has no default: the list comes from LM Studio');
        continue;
      }
      assert.ok(m, `${f} must have a default model`);
      assert.equal(
        modelBelongsToFamily(m, f),
        true,
        `${f}'s default (${m}) must pass ${f}'s own membership test`,
      );
    }
  });

  test('every family in the picker has an entry in the table', () => {
    for (const f of BASE_MODEL_FAMILIES) {
      assert.ok(f in FAMILY_DEFAULT_MODEL, `${f} is pickable but has no default`);
    }
  });

  test('an unknown family falls back to Claude rather than empty', () => {
    // Empty would leave the chat unrunnable until a model is picked by hand —
    // the bug the table was introduced to fix.
    assert.equal(defaultModelForFamily('Nonsense'), FAMILY_DEFAULT_MODEL.Claude);
  });
});

describe('folderModelForFamily', () => {
  test('a stored model that fits the family is kept', () => {
    assert.equal(folderModelForFamily('claude-opus-4-8', 'Claude'), 'claude-opus-4-8');
    assert.equal(folderModelForFamily('google/gemma-4-12b', 'Local'), 'google/gemma-4-12b');
  });

  test("Lizard-kun's pair is rejected: Local does not run claude-opus-4-8", () => {
    assert.equal(folderModelForFamily('claude-opus-4-8', 'Local'), '');
  });

  test("Utai's pair is rejected: her folder holds glm-5.2 under a derived Claude", () => {
    // settings.json: aiName Gemini, specificModel glm-5.2. The derivation now
    // says Claude, so without this check a turn would ask Claude for glm-5.2.
    assert.equal(folderModelForFamily('glm-5.2', 'Claude'), FAMILY_DEFAULT_MODEL.Claude);
  });

  test('no stored model falls back to the family default', () => {
    assert.equal(folderModelForFamily(undefined, 'Gemini'), FAMILY_DEFAULT_MODEL.Gemini);
    assert.equal(folderModelForFamily('', 'Gemini'), FAMILY_DEFAULT_MODEL.Gemini);
    assert.equal(folderModelForFamily(null, 'Local'), '');
  });

  test('the result always belongs to the family, or is empty for Local', () => {
    // The property the two call sites rely on: whatever comes out can be sent
    // to that family's provider.
    const stored = ['claude-opus-4-8', 'glm-5.2', 'google/gemma-4-12b', '', 'nonsense-id'];
    for (const f of BASE_MODEL_FAMILIES) {
      for (const s of stored) {
        const out = folderModelForFamily(s, f);
        if (out === '') {
          assert.equal(f, 'Local', `only Local may resolve to empty (got it for ${f}, stored=${s})`);
          continue;
        }
        assert.equal(
          modelBelongsToFamily(out, f),
          true,
          `folderModelForFamily(${s}, ${f}) returned ${out}, which is not in ${f}`,
        );
      }
    }
  });
});
