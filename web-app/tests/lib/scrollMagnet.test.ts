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
  assert.equal(nextStickState(atBottom), true);
  assert.equal(nextStickState(scrolledUp), false);
  // And the state is a function of position ONLY — no memory of who scrolled.
  assert.equal(nextStickState(atBottom), nextStickState(atBottom));
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
 * The reason it is a function and not two copies of one line is the `'auto'`:
 * an animated jump has midpoints, and a midpoint is positionally identical to
 * a reader scrolling up, so `nextStickState` would detach the magnet in the
 * middle of our own animation. A caller that forgets re-opens that bug.
 */
test('jumpToBottom asks for the bottom in one frame, never a smooth scroll', () => {
  const calls: any[] = [];
  jumpToBottom({ scrollHeight: 4200, scrollTo: (o) => calls.push(o) });
  assert.deepEqual(calls, [{ top: 4200, behavior: 'auto' }]);
});

test('jumpToBottom still targets the bottom when there is nothing to scroll', () => {
  const calls: any[] = [];
  jumpToBottom({ scrollHeight: 0, scrollTo: (o) => calls.push(o) });
  assert.deepEqual(calls, [{ top: 0, behavior: 'auto' }]);
});
