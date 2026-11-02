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
// So: closing an IDLE page must be frictionless, and closing a page whose work
// would DIE with it must ask first.
//
// ⚠ Those are two different tests, and until 2026-11-02 this file only had
// one. Work that survives the tab — a server-side SPU run, a queued turn the
// runner owns — must still be VISIBLE (the `●` below) and must NOT be guarded.
// A reason is registered with `blocking: false` for that; see the Reason type.
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
// That surface is the tab title: while busy it reads "● <being> <action> —
// <conversation>" (e.g. "● Cairn read a file — Cairn_24 — Nexus"), which is
// visible in the tab strip and behind the dialog, so the generic "Leave site?"
// arrives with context attached.
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

/**
 * key → what to SHOW, and whether it must also BLOCK leaving.
 *
 * ── WHY THESE ARE TWO THINGS (2026-11-02) ─────────────────────────────────
 *
 * This registry drove three surfaces off one Map: the `beforeunload` dialog,
 * the in-app `confirmIfBusy` gate, and the tab title's `●`. Once the SPU run
 * moved server-side there was no longer a reason to BLOCK a close during it,
 * so I narrowed the SPU's registration to the one case that still chains
 * through the tab (`auto`) — and that silently took the `●` away with the
 * dialog.
 *
 * REPORTED by トカゲくん the same day: "that had a different role. It is how
 * you see at a glance whether something is running right now. If the dialog is
 * not needed any more by your judgement, you may delete it. But put the
 * working `●` back."
 *
 * He is right, and the mistake was treating "tell the reader" and "stop the
 * reader" as one flag. They are different questions with different answers for
 * the same work: a server-side run must be VISIBLE and must not be GUARDED.
 */
interface Reason {
  label: string;
  /** Does this reason also justify holding the reader back? */
  blocking: boolean;
}
const reasons = new Map<string, Reason>();
const subscribers = new Set<() => void>();
let attached = false;

/** How many held reasons justify stopping a close / a navigation. */
function blockingCount(): number {
  let n = 0;
  for (const r of reasons.values()) if (r.blocking) n += 1;
  return n;
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  // Defensive: the listener is detached when idle, but a race between a state
  // change and the detach must never block an idle close.
  if (blockingCount() === 0) return;
  e.preventDefault();
  // Legacy only. Modern browsers ignore this string entirely (see header).
  e.returnValue = describeBlocking() ?? '';
}

/** Attach the listener only while something BLOCKING is held. */
function syncListener() {
  if (typeof window === 'undefined') return;
  const busy = blockingCount() > 0;
  if (busy && !attached) {
    window.addEventListener('beforeunload', onBeforeUnload);
    attached = true;
  } else if (!busy && attached) {
    window.removeEventListener('beforeunload', onBeforeUnload);
    attached = false;
  }
}

/**
 * Register or clear one reason the page is busy.
 *
 * @param key   stable per call-site ('generation', 'spu', 'save', …)
 * @param label what to show the reader, or null to clear this key
 * @param opts  `blocking: false` for work that must SHOW in the tab title but
 *              must not hold a close or a navigation back — i.e. work that
 *              survives the tab. Defaults to true, so every call site that
 *              predates this parameter keeps its old behaviour exactly.
 */
export function setUnloadGuard(
  key: string,
  label: string | null,
  opts?: { blocking?: boolean },
): void {
  const blocking = opts?.blocking !== false;
  const prev = reasons.get(key);
  if (label) {
    // no-op: keeps effects from thrashing. BOTH fields have to match, or a
    // reason that changed only its blocking-ness would never take effect.
    if (prev && prev.label === label && prev.blocking === blocking) return;
    reasons.set(key, { label, blocking });
  } else {
    if (prev === undefined) return;
    reasons.delete(key);
  }
  syncListener();
  subscribers.forEach(fn => { try { fn(); } catch { /* never let one subscriber break the rest */ } });
}

/**
 * Register work that must be VISIBLE but must not be guarded — a named
 * wrapper rather than a bare `{ blocking: false }` at the call site, so the
 * intent is readable where it is used and the one-argument form cannot be
 * mistaken for it.
 */
export function setBusyOnly(key: string, label: string | null): void {
  setUnloadGuard(key, label, { blocking: false });
}

/**
 * Current busy description, or null when idle — EVERY reason, blocking or
 * not. This is what the tab title reads: the `●` answers "is something
 * running", which is true of server-side work too.
 */
export function describeBusy(): string | null {
  if (reasons.size === 0) return null;
  return Array.from(reasons.values()).map(r => r.label).join(' / ');
}

/**
 * Only the reasons that justify stopping the reader. What the `beforeunload`
 * dialog and `confirmIfBusy` read — asking "are you sure?" about work that
 * survives the tab is a control reporting a state nobody is in.
 */
export function describeBlocking(): string | null {
  const labels = Array.from(reasons.values()).filter(r => r.blocking).map(r => r.label);
  return labels.length > 0 ? labels.join(' / ') : null;
}

// ───────────────────────────────────────────────────────────────────────────
// In-app guard (the same question, asked inside the app)
//
// `beforeunload` only covers leaving the PAGE. Inside the app, anything that
// moves away from the current conversation is just as destructive: ChatArea
// remounts and the streaming reply — deliberately not written to disk until it
// finishes — is gone with no trace. So those actions ask first, off the same
// registry, and the reader sees the same label they would see in the tab.
//
// The gate lives here and not in NexusApp for the reason the registry itself
// is here: the call sites are in different components (NexusApp owns the
// selection; Sidebar owns import / restore / folder actions), and the de-dupe
// window below has to be SHARED or a single intent prompts twice.
// ───────────────────────────────────────────────────────────────────────────

/** How long one answered confirm keeps covering follow-up navigation. */
const ANSWER_TTL_MS = 500;
let answeredAt = 0;

/**
 * Ask before an action that would destroy work in progress.
 *
 * @param render builds the dialog text from the busy label. The caller owns
 *               the wording and its translation; this file owns the gate.
 * @returns true to proceed — idle, already answered, or the reader said yes.
 */
export function confirmIfBusy(render: (busy: string) => string): boolean {
  // BLOCKING only. A server-side SPU run shows a `●` and must not make
  // switching conversations ask a question.
  const busy = describeBlocking();
  if (!busy) return true;
  // One intent can navigate through two setters back-to-back (creating a being
  // calls setActiveFolderId then onSelectConvo in the same tick), so a confirm
  // answered a moment ago counts as answered for what follows it.
  if (Date.now() - answeredAt < ANSWER_TTL_MS) return true;
  if (typeof window === 'undefined') return true;
  const ok = window.confirm(render(busy));
  if (ok) answeredAt = Date.now();
  return ok;
}

/**
 * Re-open the "already answered" window.
 *
 * For actions that ask FIRST and navigate LATER: an import or a backup restore
 * spends seconds of awaited disk work between the confirm and its
 * `onSelectConvo`, far past ANSWER_TTL_MS, and that switch then runs through
 * the guarded setter and would ask again about the same intent. Call this
 * immediately before the navigation.
 *
 * Deliberately a re-stamp and not a held lock: forgetting it costs one
 * redundant dialog, while a lock leaked on an error path would silently
 * disable the guard for the rest of the session. The cheaper failure wins.
 */
export function markBusyConfirmAnswered(): void {
  answeredAt = Date.now();
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
