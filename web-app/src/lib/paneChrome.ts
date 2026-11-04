/**
 * Does the pane that is NOT a conversation need its own way to summon the
 * conversation drawer?
 *
 * Mobile only. On a phone the sidebar is a drawer (see Sidebar.tsx): taken out
 * of the flex row entirely, so the only way to reach the being list is a
 * control that opens it. That control has always lived in ChatArea's header,
 * and the comment next to it said the list "can never become unreachable"
 * because that header is always rendered.
 *
 * That was true for as long as ChatArea was always rendered. It stopped being
 * true on 2026-11-04 (`90cd1e0`), when the bare root URL deliberately stopped
 * auto-opening a being: the welcome pane renders INSTEAD of ChatArea, so on a
 * phone it took the only opener down with it — reported by Lizard-kun the same
 * night. The empty states below it (returning reader with nothing selected,
 * and a fresh install with no beings at all) had the same hole, and the fresh
 * install one is older than this change: with zero beings there was never a
 * ChatArea, so a brand-new phone install could not reach the panel that
 * CREATES the first being.
 *
 * Hence the shape of the predicate: it asks nothing about `folders.length`,
 * nothing about which pane is showing. **Whenever the conversation pane is not
 * rendered, the opener is.** A future fourth pane inherits it without anyone
 * remembering to, which is the whole reason this is one guard outside the
 * branch rather than a button copied into each arm.
 *
 * Desktop is never true: there the sidebar is a column that is always on
 * screen, so a second opener would be a control that does nothing visible.
 */
export function needsSidebarOpener(args: {
  /** Phone or tablet — the layout decision, not the three-value measurement. */
  isMobile: boolean;
  /** Is ChatArea rendered? It carries its own opener when it is. */
  chatOpen: boolean;
}): boolean {
  return args.isMobile && !args.chatOpen;
}
