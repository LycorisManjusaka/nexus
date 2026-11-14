// ── May the auto-save skip this fire? ──────────────────────────────────────
//
// REPORTED 2026-11-14 (Навигатор for Пилот, and 津代's open item 3): the
// conversation settings say one vessel, a different one answers, with no
// error. Sonnet 5 chosen and confirmed, Fable 5.2 replying; Meta chosen three
// times, Gemini 3.8 Flash on the fifth turn. A reload "fixes" it.
//
// MEASURED in ChatArea's save effect: it returns on `loading` BEFORE it
// consumes `skipNextAutoSave`. So a vessel changed DURING a turn:
//   1. the change fires the effect -> `loading` -> return, nothing saved;
//   2. the turn ends, the patch/reload sets the skip flag (still loading);
//   3. `loading` clears -> the effect fires -> consumes the flag -> return.
// The change never reaches disk. The screen shows the new vessel; the runner,
// which reads the vessel from disk every turn, answers with the old one; a
// reload makes the screen agree with disk and looks like a fix.
//
// The skip flag exists for one reason: applying state that CAME FROM disk
// must not write it straight back. So the honest rule is narrower than "skip
// the next fire": skip only if the settings on screen are still the settings
// this tab last saw on disk. Settings changed since then are an edit, and an
// edit is saved.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Fields left out of the signature.
 *
 * `messages` — the thing the skip flag is actually about.
 * The marker pair — the RUNNER resolves it and the tab adopts it after a
 *   reload (adoptResolvedMarker); counting it would turn every adoption into
 *   a save that merely echoes disk.
 * `claudeAgentSessionId` — written by the turn machinery, not by a person.
 */
const NOT_SETTINGS = new Set([
  'messages',
  'firstOriginalMessageId',
  'firstOriginalIsNext',
  'claudeAgentSessionId',
]);

/** A stable string for the settings part of a log object. */
export function settingsSignature(logData: Record<string, unknown>): string {
  const keys = Object.keys(logData).filter((k) => !NOT_SETTINGS.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, logData[k] ?? null]));
}

/**
 * `persisted` is the signature this tab last saw on disk (after a load, a
 * skipped fire, or a save it sent), or null when it has none yet — a freshly
 * opened conversation, where the old one-shot behaviour is exactly right.
 */
export function shouldSkipAutoSave(
  skipFlag: boolean,
  current: string,
  persisted: string | null,
): boolean {
  if (!skipFlag) return false;
  if (persisted === null) return true;
  return current === persisted;
}
