/**
 * Scroll magnet — should the message list follow new content to the bottom?
 *
 * The old rule was unconditional: while a turn is running, every re-render
 * slammed `scrollTop` to `scrollHeight`. That is right for the common case
 * (watch the reply arrive) and wrong for the one Lizard-kun asked about —
 * reading earlier messages while the being is still thinking was impossible,
 * because the next chunk yanked the viewport back down.
 *
 * The magnet models his description directly: near the bottom it pulls, far
 * from the bottom it lets go, and returning to the bottom re-attaches it.
 *
 * Why the three numbers are ARGUMENTS and not read off a DOM node here: the
 * states that matter are the ones that are awkward to produce in a browser on
 * purpose — a list shorter than its own viewport, a sub-pixel scroll offset, a
 * container measured while the conversation is still empty. Those are cheap to
 * write as data and expensive to stage by hand.
 */

export type ScrollMetrics = {
  /** Full height of the content, including the part scrolled out of view. */
  scrollHeight: number;
  /** How far down the content the viewport currently sits. */
  scrollTop: number;
  /** Visible height of the scrolling container. */
  clientHeight: number;
};

/**
 * How close to the bottom still counts as "at the bottom".
 *
 * Not zero, for three separate reasons, each of which alone would break an
 * exact comparison: browsers report fractional scroll offsets on non-100%
 * display scaling (this house runs 125% and 150% monitors), touch scrolling
 * settles a few pixels short of the end, and a reply that grows by one line
 * between two frames moves the bottom away from a viewport that never moved.
 */
export const STICK_THRESHOLD_PX = 64;

/** Pixels of content hidden below the viewport. Never negative. */
export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/**
 * Is the viewport close enough to the bottom for the magnet to hold?
 *
 * A container whose content is shorter than itself has nothing to scroll and
 * is therefore always at the bottom — that is the state of every conversation
 * before its messages load, and it has to answer `true` or the very first
 * render would detach the magnet before the user has done anything.
 */
export function isNearBottom(m: ScrollMetrics, threshold = STICK_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/**
 * The magnet's next state after a scroll event.
 *
 * It does NOT care WHO scrolled — an earlier draft tried that, with a time
 * window to ignore our own smooth-scroll midpoints, and the window is
 * unmeasurable: the duration of a CSS smooth scroll depends on the distance
 * travelled, so in a long conversation our own animation passes through
 * positions indistinguishable from a user reading upward. The auto-scroll
 * jumps in one frame instead of animating, which removes those midpoints.
 *
 * It does care WHICH WAY the viewport moved, and that is not the same
 * question. MEASURED 2026-11-07, from the probe on this house's own tab:
 *
 *     magnet:detach dist:192.97 scrollTop:3.03 scrollHeight:1190 clientHeight:994
 *
 * Nobody read anything upward there. A conversation opened, `jumpToBottom`
 * ran while the list was still shorter than its own viewport (so the bottom
 * WAS scrollTop 0), and then 196px of markdown finished laying out below it.
 * The viewport had not moved; the bottom had moved away from it. Position
 * alone cannot tell that from a deliberate scroll up, and the 64px threshold
 * exists to absorb ONE line of growth, not a whole conversation rendering.
 * So the magnet let go of a conversation the moment it opened, and every
 * refusal after that was a consequence.
 *
 * The direction separates the two cases exactly, with no new constant:
 *
 *   - near the bottom            -> attached (unchanged)
 *   - moved UP, now far          -> let go. This is the only thing a reader does.
 *   - moved DOWN or not at all   -> keep whatever it was. Growth below a still
 *                                   viewport, and a reader heading back toward
 *                                   the end, both land here; neither is a reason
 *                                   to let go.
 *
 * `prev.scrollTop` is the offset this function was last called with (or the
 * one we last jumped to), NOT the previous frame's — a scroll event only
 * fires when the offset actually changes, so "not at all" arrives via the
 * resize path in ChatArea rather than through here.
 */
export function nextStickState(
  m: ScrollMetrics,
  prev: { scrollTop: number; stuck: boolean },
  threshold = STICK_THRESHOLD_PX,
): boolean {
  if (isNearBottom(m, threshold)) return true;
  if (m.scrollTop < prev.scrollTop) return false;
  return prev.stuck;
}

/**
 * Jump the viewport to the bottom in ONE frame.
 *
 * An animated jump has midpoints, and a midpoint is positionally identical to
 * a reader moving upward, so the magnet would let go of itself part-way down.
 * That is the whole reason this is a function and not two copies of one line.
 *
 * ⚠ IT HAS TO BE `'instant'`, AND IT WAS `'auto'` UNTIL 2026-11-07. The comment
 * here used to claim that `'auto'` "overrides the container's scroll-smooth
 * class on purpose". That is backwards. In CSSOM View, `'auto'` means *use the
 * element's computed `scroll-behavior`* — and the message list carries
 * Tailwind's `scroll-smooth`, so every "one-frame jump" this function has ever
 * performed was in fact a smooth animation. `'instant'` is the value that
 * actually forces the jump.
 *
 * Measured, from the probe, opening a 530 KB conversation:
 *
 *     magnet:short stick:true lengthIncreased:true before:96813 after:96813
 *
 * `before` and `after` are the distance from the bottom either side of the
 * call. They are the same number: the viewport did not move at all, because
 * the animation had not started yet when the next line read the position. Then
 * the animation crawled through 96,813px of conversation, firing scroll events
 * at every position on the way — the exact midpoints this function was written
 * to abolish. Tsuyo described it as "it moves halfway, not to the bottom";
 * halfway is what an interrupted 96,000px animation looks like.
 *
 * So the wrong value re-opened the bug, and the comment asserting the right
 * one was the reason nobody looked. Kept as a correction rather than a quiet
 * edit: this is the second time this week a sentence of mine outlived the
 * thing it described.
 *
 * The parameter is structural, not `HTMLElement`, so the tests can call it.
 */
export function jumpToBottom(el: {
  scrollHeight: number;
  scrollTo: (opts: { top: number; behavior: 'instant' }) => void;
}): void {
  el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
}

export type AutoScrollInput = {
  /** Is the magnet currently attached (set by the last scroll event)? */
  stick: boolean;
  /** Is a turn streaming right now? */
  generating: boolean;
  /** Did the message count go up since the previous render? */
  lengthIncreased: boolean;
  /**
   * Is a deep link still waiting to scroll to its target? A pending link owns
   * the viewport: without this, the initial 0 → N load counts as "length
   * increased", slams to the bottom, and the link then animates all the way
   * back up through the whole conversation.
   */
  deepLinkPending: boolean;
};

/** Should this render push the viewport to the bottom? */
export function shouldAutoScroll(i: AutoScrollInput): boolean {
  if (i.deepLinkPending) return false;
  if (!i.stick) return false;
  return i.generating || i.lengthIncreased;
}
