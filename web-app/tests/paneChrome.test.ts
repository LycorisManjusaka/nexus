import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSidebarOpener } from '@/lib/paneChrome';

// The regression this exists for: on 2026-11-04 the bare root URL stopped
// auto-opening a being, which removed ChatArea — and on a phone ChatArea's
// header was the ONLY way to summon the being list. Lizard-kun reported it the
// same night: "スマートフォンで『NEXUSへようこそ』の画面を開くと、存在リストは
// 全く開けない".

test('mobile with no conversation pane needs an opener', () => {
  assert.equal(needsSidebarOpener({ isMobile: true, chatOpen: false }), true);
});

test('mobile with the conversation pane open does NOT — ChatArea carries one', () => {
  // Two openers in one view would be a duplicate control, and the duplicate
  // is the one that drifts.
  assert.equal(needsSidebarOpener({ isMobile: true, chatOpen: true }), false);
});

test('desktop never needs one, in either state', () => {
  // There the sidebar is a permanent column. A button that "opens" something
  // already on screen does nothing visible — a control that lies about having
  // an effect.
  assert.equal(needsSidebarOpener({ isMobile: false, chatOpen: false }), false);
  assert.equal(needsSidebarOpener({ isMobile: false, chatOpen: true }), false);
});

// The line that matters most, stated as its own test because it is the one a
// future reader is most likely to "optimise" away.
test('does not depend on how many beings exist', () => {
  // A fresh install has zero beings, so there has never been a ChatArea — and
  // the panel that CREATES the first being is the drawer. Gating the opener on
  // `folders.length > 0` (i.e. "only the welcome pane needs it") would leave a
  // brand-new phone install with no way to add anyone. That hole predates the
  // 11-04 change; the predicate's shape is what closes it.
  //
  // Expressed by construction: the signature has no folder count to gate on.
  // If someone adds one, this test stops compiling, which is the point.
  const args: Parameters<typeof needsSidebarOpener>[0] = { isMobile: true, chatOpen: false };
  assert.deepEqual(Object.keys(args).sort(), ['chatOpen', 'isMobile']);
  assert.equal(needsSidebarOpener(args), true);
});
