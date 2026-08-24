"use client";

// ───────────────────────────────────────────────────────────────────────────
// Close/reload guard.
//
// Purpose: a page reload or tab close in the middle of a generation kills the
// turn outright. The reply in flight is NOT on disk — ChatArea's auto-save
// effect deliberately skips the POST while `loading === true` (one POST per
// SSE frame would pile up against Chrome's 6-connection cap), so everything
// streamed so far lives only in memory until the reply completes. The same is
// true of a System Prompt Updater run, which can be minutes of paid model call
// with nothing written until it finishes.
//
// So: closing an IDLE page must be frictionless, and closing a BUSY one must
// ask first.
//
// ── What the browser will and will not do ────────────────────────────────
// The confirmation dialog itself is entirely browser-controlled. Since ~2017
// every major engine shows its own generic string ("Leave site? / Changes you
// made may not be saved") and IGNORES any text the page supplies. There is no
// way to put a name into that dialog. `event.returnValue` is still set below
// for old embedded webviews that honour it, but on any current browser it is
// dead weight — do not "fix" the wording there and expect it to appear.
//
// The message therefore has to reach the reader through a surface we DO own.
// That surface is the tab title: while busy it reads "● <who is working> —
// <conversation>", which is visible in the tab strip and behind the dialog, so
// the generic "Leave site?" arrives with context attached.
//
// Two further browser rules worth knowing before debugging a no-show dialog:
//   - Sticky activation: the dialog only appears if the user has interacted
//     with the page at least once. A page opened and never clicked closes
//     silently no matter what is registered here. Not a bug.
//   - preventDefault() is the modern trigger. Returning a string from an
//     addEventListener handler does nothing.
//
// ── Why a module-level registry ──────────────────────────────────────────
// The busy states live in different components (`loading` in ChatArea,
// `running` inside the SystemPromptUpdater modal) and a save can be in flight
// from a third place. Threading all of that up to a single owner would mean
// prop-drilling three unrelated flags through the tree for one window-level
// concern. Instead each site registers its own key here and forgets about it;
// the listener is attached only while at least one key is held, so an idle app
// has no `beforeunload` listener registered at all (which also keeps the page
// eligible for the back/forward cache).
// ───────────────────────────────────────────────────────────────────────────

import { useSyncExternalStore } from 'react';

/** key → human-readable label describing why we are busy. */
const reasons = new Map<string, string>();
const subscribers = new Set<() => void>();
let attached = false;

function onBeforeUnload(e: BeforeUnloadEvent) {
  // Defensive: the listener is detached when idle, but a race between a state
  // change and the detach must never block an idle close.
  if (reasons.size === 0) return;
  e.preventDefault();
  // Legacy only. Modern browsers ignore this string entirely (see header).
  e.returnValue = describeBusy() ?? '';
}

/** Attach the listener only while something is actually busy. */
function syncListener() {
  if (typeof window === 'undefined') return;
  const busy = reasons.size > 0;
  if (busy && !attached) {
    window.addEventListener('beforeunload', onBeforeUnload);
    attached = true;
  } else if (!busy && attached) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    attached = false;
  }
}

/**
 * Register or clear one reason the page must not be closed silently.
 *
 * @param key   stable per call-site ('generation', 'spu', 'save', …)
 * @param label what to show the reader, or null to clear this key
 */
export function setUnloadGuard(key: string, label: string | null): void {
  const prev = reasons.get(key);
  if (label) {
    if (prev === label) return; // no-op: keeps effects from thrashing
    reasons.set(key, label);
  } else {
    if (prev === undefined) return;
    reasons.delete(key);
  }
  syncListener();
  subscribers.forEach(fn => { try { fn(); } catch { /* never let one subscriber break the rest */ } });
}

/**
 * Current busy description, or null when idle. Multiple concurrent reasons
 * (e.g. a generation running while a save is still in flight) are joined.
 */
export function describeBusy(): string | null {
  if (reasons.size === 0) return null;
  return Array.from(reasons.values()).join(' / ');
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

// Stable across renders: the snapshot is a string (or null), so React's
// Object.is check settles on value equality and never loops.
const serverSnapshot = () => null;

/** Re-renders the caller whenever the busy description changes. */
export function useBusyLabel(): string | null {
  return useSyncExternalStore(subscribe, describeBusy, serverSnapshot);
}
