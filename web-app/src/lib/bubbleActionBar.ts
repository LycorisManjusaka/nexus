/**
 * Geometry of the per-message action bar ON MOBILE (read aloud, copy, edit, …).
 *
 * ONE definition, two readers, because the two are physically coupled:
 *   - MessageBubble DRAWS the bar. It is `absolute top-full`, so it hangs below
 *     the bubble and contributes NOTHING to layout height.
 *   - ChatArea LEAVES ROOM for it, in two places: the gutter between messages,
 *     and the bottom padding of the scroll area, under the last one.
 *
 * Because the bar is out of flow, too little room fails SILENTLY — the bar
 * simply draws on top of the next message. That exact bug was once reported
 * from a phone ("it overlaps the message above"), which is why these numbers
 * live in one file instead of two.
 *
 * MEASURED, not derived from intent. One button is
 *     icon ICON px + padding PAD px on each side + 1px border on each side
 * so at ICON=21 / PAD=6 the button (and therefore the bar) is 35px tall. The
 * value it replaced was 24px (icon 14, `p-1`), so this is 1.46x — Pilot asked
 * for "1.5x bigger" and that is the honest number for what shipped.
 *
 * 35px is still under the 44px (Apple HIG) / 48px (Material) touch-target
 * floor. ICON is the dial if it needs to go further; when it moves, BOTH class
 * constants below have to be re-checked against the new height, and the check
 * is `mobile_action_bar.mjs` in the workspace probe folder, which reads the
 * real computed boxes out of a browser rather than recomputing this sum.
 */

/** Icon px for the PRIMARY bar buttons on mobile. Exactly 1.5x the old 14. */
export const MOBILE_ACTION_ICON = 21;

/** Tailwind padding for one bar button on mobile: 6px a side. */
export const MOBILE_ACTION_PAD = 'p-1.5';

/**
 * Height of one bar button at the two values above, in px. Kept by hand and
 * verified by the probe — it exists so the two spacings below can be read
 * against a number instead of against a guess.
 */
export const MOBILE_ACTION_BAR_PX = 35;

/** Gutter between messages on mobile. 40px, i.e. 5px clear of the 35px bar. */
export const MOBILE_MSG_GAP = 'space-y-10';

/**
 * Bottom padding of the message scroll area on mobile, so the LAST message's
 * bar clears the input box. Same 40px as the gutter, for the same reason.
 */
export const MOBILE_LIST_PAD_BOTTOM = 'pb-10';
