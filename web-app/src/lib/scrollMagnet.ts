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
 * Deliberately a pure function of position alone — it does NOT care who
 * scrolled. An earlier draft tried to distinguish "the user scrolled" from
 * "we scrolled", with a time window to ignore our own smooth-scroll midpoints.
 * That window is unmeasurable: the duration of a CSS smooth scroll depends on
 * the distance travelled, so in a long conversation our own animation passes
 * through positions indistinguishable from a user reading upward.
 *
 * The auto-scroll therefore jumps instantly instead of animating, which
 * removes the midpoints entirely and makes position sufficient. See the call
 * site in ChatArea for why that is also the better behaviour while streaming.
 */
export function nextStickState(m: ScrollMetrics, threshold = STICK_THRESHOLD_PX): boolean {
  return isNearBottom(m, threshold);
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
