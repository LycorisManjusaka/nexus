import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceFromBottom,
  isNearBottom,
  nextStickState,
  shouldAutoScroll,
  STICK_THRESHOLD_PX,
  jumpToBottom,
} from '@/lib/scrollMagnet';

// ── The report these tests exist for ─────────────────────────────────────
//
// Auto-scroll has been unconditional since NEXUS existed: while a turn runs,
// every new thought / tool call / output chunk slammed the viewport to the
// bottom. Convenient while watching a reply arrive, impossible while trying
// to read earlier messages — the next chunk took the view away again.
//
// The magnet keeps the old behaviour near the bottom and lets go above it.
// The tests below pin BOTH halves, because a magnet that never lets go and a
// magnet that never pulls are each one boolean away.

const atBottom = { scrollHeight: 5000, scrollTop: 4000, clientHeight: 1000 };
const scrolledUp = { scrollHeight: 5000, scrollTop: 1200, clientHeight: 1000 };

test('distance is measured from the bottom edge of the viewport', () => {
  assert.equal(distanceFromBottom(atBottom), 0);
  assert.equal(distanceFromBottom(scrolledUp), 2800);
});

test('content shorter than its own container counts as at the bottom', () => {
  // This is EVERY conversation before its messages load, and the state of the
  // very first render. If it answered `false`, the magnet would detach before
  // the user had done anything and no conversation would ever follow its own
  // first reply.
  const empty = { scrollHeight: 300, scrollTop: 0, clientHeight: 900 };
  assert.equal(distanceFromBottom(empty), 0);
  assert.equal(isNearBottom(empty), true);
});

test('the threshold is a band, not an exact comparison', () => {
  // Three independent sources of a few stray pixels, any one of which would
  // break `scrollTop + clientHeight === scrollHeight`: fractional offsets on
  // non-100% display scaling, touch scrolling settling short of the end, and a
  // reply growing by a line between two frames.
  const near = { scrollHeight: 5000, scrollTop: 4000 - STICK_THRESHOLD_PX, clientHeight: 1000 };
  assert.equal(isNearBottom(near), true);
  const justPast = { scrollHeight: 5000, scrollTop: 4000 - STICK_THRESHOLD_PX - 1, clientHeight: 1000 };
  assert.equal(isNearBottom(justPast), false);
});

test('a scroll event re-attaches at the bottom and detaches above it', () => {
  // Lizard-kun's two sentences, as a round trip: scrolling up releases the
  // magnet, scrolling back down makes it hold again.
  const high = { scrollTop: 9999, stuck: true };
  assert.equal(nextStickState(atBottom, high), true);
  assert.equal(nextStickState(scrolledUp, high), false);
  // Still no memory of WHO scrolled — same inputs, same answer, every time.
  assert.equal(nextStickState(atBottom, high), nextStickState(atBottom, high));
});

/**
 * ⚠ CORRECTION, 2026-11-07. The test above used to also assert that the state
 * is "a function of position ONLY". That was true of the question it was
 * written against (our own smooth-scroll midpoints) and FALSE in general, and
 * the difference cost Tsuyo four rounds of "it still does not scroll".
 *
 * These are the numbers the probe wrote on this house's own tab, at the moment
 * the magnet let go of a conversation that had just been opened:
 *
 *     magnet:detach dist:192.97 scrollTop:3.03 scrollHeight:1190 clientHeight:994
 *
 * Nobody scrolled up. `jumpToBottom` had run while the list was still shorter
 * than its viewport — scrollTop 0 genuinely WAS the bottom then — and 196px of
 * markdown finished laying out underneath afterwards. Position alone cannot
 * separate that from a reader moving up; the direction of travel can.
 */
test('content growing below a still viewport does NOT detach the magnet', () => {
  // Verbatim from the probe line above.
  const grown = { scrollHeight: 1190, scrollTop: 3.03, clientHeight: 994 };
  assert.ok(distanceFromBottom(grown) > STICK_THRESHOLD_PX, 'precondition: far from the bottom');
  // The viewport moved DOWN by 3px (0 → 3.03) while the bottom ran away from
  // it. Keeping the magnet is the whole fix.
  assert.equal(nextStickState(grown, { scrollTop: 0, stuck: true }), true);
  // Same geometry, but the reader came from further down: that IS a scroll up.
  assert.equal(nextStickState(grown, { scrollTop: 400, stuck: true }), false);
  // And growth must not ATTACH a magnet the reader had already released.
  assert.equal(nextStickState(grown, { scrollTop: 0, stuck: false }), false);
});

test('streaming follows the reply down while the magnet holds', () => {
  // The old behaviour, preserved exactly for the common case.
  assert.equal(shouldAutoScroll({
    stick: true, generating: true, lengthIncreased: false, deepLinkPending: false,
  }), true);
});

test('streaming does NOT follow once the reader has scrolled up', () => {
  // THE reported case. Without this the whole feature is absent: a turn is
  // running, chunks keep arriving, and each one took the viewport back.
  assert.equal(shouldAutoScroll({
    stick: false, generating: true, lengthIncreased: false, deepLinkPending: false,
  }), false);
  // Including when a whole new message lands — the arrival of content is not
  // a licence to move someone else's viewport.
  assert.equal(shouldAutoScroll({
    stick: false, generating: true, lengthIncreased: true, deepLinkPending: false,
  }), false);
});

test('a new message pulls the view down even when nothing is streaming', () => {
  // Sending a message, or another tab's reply landing via a disk reload.
  assert.equal(shouldAutoScroll({
    stick: true, generating: false, lengthIncreased: true, deepLinkPending: false,
  }), true);
});

test('an idle conversation with no new messages is left alone', () => {
  assert.equal(shouldAutoScroll({
    stick: true, generating: false, lengthIncreased: false, deepLinkPending: false,
  }), false);
});

test('a pending deep link outranks the magnet', () => {
  // The regression this guard was originally written for: the cold 0 → N load
  // counts as "length increased", so without it the view slams to the bottom
  // and the link's smooth scroll then animates all the way back up through a
  // long conversation. The magnet must not reintroduce that.
  assert.equal(shouldAutoScroll({
    stick: true, generating: true, lengthIncreased: true, deepLinkPending: true,
  }), false);
});

/**
 * jumpToBottom — extracted 2026-11-06 when a second caller appeared (the
 * unconditional jump on send, asked for by Lizard-kun: "送るタイミングで真下
 * じゃなければ違和感がある").
 *
 * The reason it is a function and not two copies of one line is the behaviour
 * value: an animated jump has midpoints, and a midpoint is positionally
 * identical to a reader scrolling up, so `nextStickState` would let the magnet
 * go in the middle of our own animation.
 *
 * ⚠ THESE TWO TESTS PINNED THE BUG THEY WERE WRITTEN TO PREVENT. They asserted
 * `behavior: 'auto'`, and in CSSOM View `'auto'` means *use the element's
 * computed `scroll-behavior`* — which on the message list is Tailwind's
 * `scroll-smooth`. So the assertion was green, the name said "never a smooth
 * scroll", and every jump was a smooth scroll. `'instant'` is the value that
 * forces one frame.
 *
 * The probe caught it from outside, opening a 530 KB conversation:
 *
 *     magnet:short before:96813 after:96813
 *
 * — the distance from the bottom, either side of the call: unchanged, because
 * the animation had not begun when the next line read the position. A test can
 * only check the value that was passed; it cannot check what the platform does
 * with it. That is the third time this week that "all green" and "broken on
 * screen" were both true at once.
 */
test('jumpToBottom asks for the bottom in one frame, never a smooth scroll', () => {
  const calls: any[] = [];
  jumpToBottom({ scrollHeight: 4200, scrollTo: (o) => calls.push(o) });
  assert.deepEqual(calls, [{ top: 4200, behavior: 'instant' }]);
});

test('jumpToBottom still targets the bottom when there is nothing to scroll', () => {
  const calls: any[] = [];
  jumpToBottom({ scrollHeight: 0, scrollTo: (o) => calls.push(o) });
  assert.deepEqual(calls, [{ top: 0, behavior: 'instant' }]);
});

test("'auto' is never passed again — it defers to CSS scroll-behavior", () => {
  // The guard is on the VALUE, because the value is the only thing this layer
  // controls. 'auto' is a legal ScrollBehavior, so TypeScript alone would not
  // have stopped the regression — the parameter type is what makes it a
  // compile error now, and this is the belt for anyone who widens that type.
  const calls: any[] = [];
  jumpToBottom({ scrollHeight: 10, scrollTo: (o) => calls.push(o) });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].behavior, 'auto');
  assert.notEqual(calls[0].behavior, 'smooth');
});
