/**
 * Which reasons are allowed to start a turn BY THEMSELVES.
 *
 * Until now a turn had exactly one cause: a person pressed send, and the
 * browser that person was looking at ran the turn. Phase 4 breaks that, so
 * "why did this turn start?" becomes a real question with more than one
 * answer, and the answer has to be configurable per conversation — some
 * beings should wake on their own, some should not.
 *
 * This module holds ONLY the rule, deliberately: the client asks it today
 * (ChatArea's auto-drain effect) and the server-side runner will ask it in
 * 4b. A second copy of "is this allowed to start?" inside the runner would
 * mean the same conversation behaves differently depending on who looked at
 * it, which is the worst shape of divergence in this series.
 *
 * ── Shape: a map, not one boolean per reason
 *
 * A map extends by adding a key; a boolean field extends by adding a field
 * to five call sites (useState, conversation load, folder-defaults load, the
 * save list, the defaults list). `instructionOverrides` is the house
 * precedent for an extensible map living in exactly this settings block.
 *
 * ── Absent means OFF
 *
 * Same discipline as `browserEnabled === true` and friends: a conversation
 * saved before this existed never asked to wake on its own, so it does not
 * get it. That direction is also the safe one — losing the field turns
 * auto-start OFF (someone has to press a button), never ON.
 *
 * ── Unknown keys are PRESERVED
 *
 * Not politeness: 3000 and 3001 currently run different branches against one
 * shared local_data. A tree that does not know a key must not delete it when
 * it saves. (The outer save list in ChatArea is an explicit field list, so a
 * build with no knowledge of `autoTriggers` at all still drops the whole
 * map — that is a branch-skew consequence this module cannot reach. It
 * drops toward OFF, which is why it is tolerable rather than urgent.)
 *
 * ── What is NOT decided here
 *
 * つよ described future rows for mail and timers. Whether those become their
 * own keys, or whether they are already covered by `stock` (because a letter
 * notification would arrive AS a stock item, kind `letter`), is not
 * knowable until that mechanism exists — today's drain takes every waiting
 * item in one batch regardless of kind, so there is no per-kind behaviour to
 * gate yet. Per-kind gating would need `composeBatch` to filter by kind and
 * leave the rest waiting, which is a different change. Naming that taxonomy
 * now would be inventing it.
 */

/** Keys this build knows how to show and honour. */
export type AutoTriggerKey = 'stock';

/**
 * Display/iteration order for the panel. Adding a reason means adding it
 * here plus two i18n strings — no storage change.
 */
export const AUTO_TRIGGER_KEYS: readonly AutoTriggerKey[] = ['stock'];

/**
 * Stored form. Intentionally `Record<string, boolean>` and not
 * `Record<AutoTriggerKey, boolean>`: a newer build's keys must survive a
 * round trip through this one.
 */
export type AutoTriggers = Record<string, boolean>;

/**
 * Coerce whatever was on disk into the stored form.
 *
 * Non-boolean values are dropped rather than coerced. `"true"` from a
 * hand-edited JSON file is not evidence that someone asked for this; a
 * truthy-string coercion would turn a typo into a being that wakes up.
 */
export function parseAutoTriggers(raw: unknown): AutoTriggers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AutoTriggers = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * The single question both the client and (later) the runner ask.
 *
 * Takes `unknown` on purpose so callers holding a raw log field do not each
 * have to remember to parse first — forgetting that is exactly how a second,
 * subtly different reading of the same field gets born.
 */
export function autoTriggerEnabled(raw: unknown, key: AutoTriggerKey): boolean {
  return parseAutoTriggers(raw)[key] === true;
}

/** Set one key, leaving every other key (including unknown ones) alone. */
export function setAutoTrigger(
  raw: unknown,
  key: AutoTriggerKey,
  on: boolean
): AutoTriggers {
  return { ...parseAutoTriggers(raw), [key]: on };
}
