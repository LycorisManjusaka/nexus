// ───────────────────────────────────────────────────────────────────────────
// Client-side signal: "an entity's Layer-4 summary files just changed on disk,
// so any cached copy of them in THIS tab is now stale."
//
// WHY THIS EXISTS
// The Sidebar fetches every summary in the active folder ONCE (keyed on the
// folder name) to drive the hover-hint preview. When a summary is then written
// — the "Write Summary" button, an auto-save of the summary pane, or
// "Redistribute Layers 1-4" — the file on disk changes but the Sidebar's cached
// map does not. Until the page is reloaded the new hint is invisible, which
// reads to the user as "the summary was not created" (reported 2026-11-06,
// トカゲくん). This lets the writer tell the Sidebar to re-fetch, with no reload.
//
// WHY A PLAIN MODULE Set AND NOT globalThis
// turnBus/turnStop/lastWriter anchor on globalThis because they cross the
// server/route boundary, where Next hands each route its own module instance
// (F, 2026-10-29). THIS signal never leaves the browser: every summary file
// write is a client POST /api/summaries from the SPU, and the only reader is
// the Sidebar in the same tab. A client bundle is one module instance per tab,
// so a module-level Set is the whole of it. If a summary ever starts being
// written server-side, this stops covering it — and that is a real limit, not
// a silent one: the new path simply would not refresh, exactly as today.
//
// WHY A LIB AND NOT an inline window CustomEvent
// A CustomEvent is not unit-testable without a DOM; a subscribe/notify pair is.
// The same reasoning diskVersion.ts gives for being a predicate and not a
// boolean in the poll.
// ───────────────────────────────────────────────────────────────────────────

export type SummariesChangedListener = (folder: string) => void;

const listeners = new Set<SummariesChangedListener>();

/**
 * Tell every listener that `folder`'s summary files changed. Safe to call from
 * any successful summary write; a listener that throws cannot stop the others
 * (one stale sidebar must not take the notification path down with it).
 */
export function notifySummariesChanged(folder: string): void {
  const name = String(folder || '').trim();
  if (!name) return;
  for (const l of Array.from(listeners)) {
    try { l(name); } catch { /* one listener's failure is not the others' */ }
  }
}

/**
 * Subscribe. Returns an unsubscribe function (call it from an effect cleanup so
 * a remounted Sidebar does not stack duplicate listeners).
 */
export function onSummariesChanged(cb: SummariesChangedListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// Visible for testing only — asserts the Set is emptied between cases so one
// test's leaked listener cannot make the next one pass for the wrong reason.
export function _listenerCountForTest(): number {
  return listeners.size;
}
