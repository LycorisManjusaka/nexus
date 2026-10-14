/**
 * The one number that moves every text size in NEXUS.
 *
 * Reported by Pilot, 2026-10-13: a phone cannot change the font size. The
 * browser's page zoom is a DIFFERENT thing and not a substitute — it grows the
 * padding and the fixed heights too, so less text fits on the screen than
 * before. What was asked for is bigger glyphs in the same layout.
 *
 * Stored in `globalSettings`, which is localStorage — i.e. PER BROWSER, and
 * that is the right grain rather than an accident: the phone that needs 125%
 * and the desktop monitor that does not are different devices, and a value
 * kept on the server would drag one device's choice onto the other.
 *
 * Applied by NexusApp as the `--ui-font-scale` custom property on <html>.
 * Every rule that reads it lives in ONE commented block at the end of
 * globals.css; nothing else in the app needs to know this setting exists.
 *
 * Both the picker and the applier resolve the stored value through here, so
 * they cannot disagree about what it means. A Preferences panel drawing "100%"
 * while 150% is on screen is exactly the kind of interface lie this house does
 * not ship.
 */

/** 1 = the sizes NEXUS has always used. The default, and labelled as such. */
export const UI_FONT_SCALE_DEFAULT = 1;

/**
 * The offered steps. Discrete, because the control this reaches is a native
 * <select> on a phone — a big OS picker with real tap targets beats dragging a
 * slider thumb, and the person who asked for this is on a phone every day.
 */
export const UI_FONT_SCALE_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6] as const;

/**
 * The clamp is deliberately WIDER than the steps. The value arrives from
 * localStorage, where a hand edit, a corrupt save, or a save from some future
 * version can put anything at all. A scale of 8 would push the Preferences
 * button itself off the screen and leave no way back; 0.7 and 2 are both still
 * navigable, so a bad stored value degrades instead of locking the app.
 */
export const UI_FONT_SCALE_MIN = 0.7;
export const UI_FONT_SCALE_MAX = 2;

/** Whatever was stored → a usable number. Absent or non-numeric → the default. */
export function resolveUiFontScale(stored: unknown): number {
  const n = Number(stored);
  if (!Number.isFinite(n)) return UI_FONT_SCALE_DEFAULT;
  return Math.min(UI_FONT_SCALE_MAX, Math.max(UI_FONT_SCALE_MIN, n));
}

/**
 * The steps to draw, with `current` folded in when it is not one of them — so
 * the picker always shows the value that is actually on screen, even if that
 * value came from a hand edit or from a step later removed from the list.
 */
export function uiFontScaleOptions(current: number): number[] {
  const steps = [...UI_FONT_SCALE_STEPS] as number[];
  return steps.includes(current) ? steps : [...steps, current].sort((a, b) => a - b);
}
