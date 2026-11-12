/**
 * Which Preferences keys get mirrored from the browser to `user_settings.json`.
 *
 * WHY THIS FILE EXISTS
 *
 * `globalSettings` lives in localStorage (NexusApp 186/234) — per browser, and
 * invisible to the server. Since the 2026-10-30 runner migration every turn is
 * built OUTSIDE the browser, by `buildTurnRequestBody` with
 * `globalSettings = loadUserSettings()` (runner/tick 167). So a server-side
 * turn reads the FILE, and nothing had ever written the file: measured
 * 2026-11-12, `user_settings.json` was 26 bytes from 2026-05-29 carrying only
 * `userName`, and no client code POSTs `/api/user` at all.
 *
 * Two Preferences controls were therefore dead, not mis-wired:
 *
 *   betrayalDefense    the wire said `true` on every server-side turn, because
 *                      `g?.betrayalDefense !== false` and the key was absent.
 *                      Unticking "Model-betrayal defence" blanked the turn
 *                      anyway — 津代 reported it on the 先輩_46 test, where the
 *                      point of unticking is to KEEP the betrayal so the anchor
 *                      can read it.
 *   maxToolIterations  always 300, whatever the slider said.
 *
 * This is the same family as `uiLang` (lib/noticeLanguage.ts) and `aiName`: a
 * value the server reads from a source nobody fills. On 2026-11-06 this house
 * measured the very same dead file for `language` and fixed only that one
 * consumer, per queue item. The source itself stayed empty, so the other two
 * consumers stayed broken for six more days.
 *
 * WHY `language` IS NOT MIRRORED — and must not be
 *
 * It is not an oversight, it is the measured decision recorded in
 * lib/noticeLanguage.ts and at chat/route.ts 4328: `language` is BEING-facing.
 * It selects 85 built-in instruction strings (the Absolute Base Binding among
 * them). Letting a browser write it would switch every being's hidden
 * instructions house-wide as a side effect of a settings save, and break prompt
 * caching whenever someone answers from a phone instead of a desktop. That is
 * トカゲくん's and 謡's decision to make deliberately, not a sync's to make
 * silently. Human-facing notices already follow the screen via `uiLang`.
 *
 * So the rule is narrow on purpose: mirror only keys that (a) the server reads
 * out of this file and (b) are properties of the HOUSE rather than of the
 * device. Adding a key here means a browser can now change it for the whole
 * install, including for autonomous turns nobody is watching.
 */

/** The subset that may cross from localStorage to `user_settings.json`. */
export interface MirroredGlobalSettings {
  betrayalDefense?: boolean;
  maxToolIterations?: number;
}

/**
 * Pick the mirrorable keys out of a Preferences blob.
 *
 * ABSENT KEYS STAY ABSENT. The caller merges this into the stored file, so an
 * omitted key means "this browser has no opinion" and the file keeps whatever
 * it had. Writing a default instead would let a browser that has never opened
 * Preferences overwrite a choice another device made.
 *
 * `betrayalDefense` is mirrored for BOTH booleans, not just `false`: ticking the
 * box back on has to be able to undo an untick, and the server's own fallback
 * (`!== false`) cannot tell "chose true" from "never chose".
 *
 * `maxToolIterations` is clamped the way the UI clamps it (1..300) and dropped
 * when it is not a finite number, because the route turns a 0 or a NaN into 300
 * anyway — a stored bad value would just be a lie on disk.
 */
export function pickMirroredGlobalSettings(g: unknown): MirroredGlobalSettings {
  const out: MirroredGlobalSettings = {};
  if (!g || typeof g !== 'object') return out;
  const src = g as Record<string, unknown>;

  if (typeof src.betrayalDefense === 'boolean') out.betrayalDefense = src.betrayalDefense;

  const n = Number(src.maxToolIterations);
  if (Number.isFinite(n) && n > 0) out.maxToolIterations = Math.min(300, Math.max(1, Math.round(n)));

  return out;
}

/**
 * True when two mirrors differ — the browser only POSTs on a real change.
 *
 * Preferences state changes on every keystroke in a text field (userName, the
 * VRChat path), and none of those are mirrored. Comparing the SUBSET rather
 * than the whole blob keeps the write count at "once per actual decision".
 */
export function mirrorChanged(a: MirroredGlobalSettings, b: MirroredGlobalSettings): boolean {
  return a.betrayalDefense !== b.betrayalDefense || a.maxToolIterations !== b.maxToolIterations;
}
