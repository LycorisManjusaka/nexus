// ── "Stop THIS turn" — an explicit channel, separate from disconnecting ──────
//
// WHY THIS EXISTS (measured 2026-10-27, chat route lines 4071-4073 and 4097):
// today a turn can be stopped in exactly two ways, and neither one can be used
// by a server-side runner:
//
//   (a) the browser Stop button — it aborts its fetch, the client disconnects,
//       `req.signal` fires in the chat route, and the turn aborts.
//   (b) the Ctrl+Shift+X stop key — `registerActiveTurnStop` in
//       computerTools.ts, which is ONE GLOBAL CALLBACK: the last stream to
//       register wins. With two conversations running (this house routinely
//       runs "nexus-cairn update" alongside a working one) it can stop the
//       wrong turn.
//
// Both are unusable for Phase 4b for the same reason, stated two ways:
//
//   * (a) cannot distinguish "the person pressed Stop" from "the tab died".
//     They are the SAME signal on the wire. So a turn can never be made to
//     survive a closed tab while Stop still works — the server has no way to
//     tell which one happened.
//   * a turn started by the server-side runner has no browser fetch at all, so
//     there is nothing to abort. It would be unstoppable except by (b), which
//     cannot name which turn it means.
//
// So: a per-turn stop channel, keyed by (convoId, turnId), is a PREREQUISITE
// for the runner, not a convenience. This module is that channel and nothing
// else — it does not stop anything itself, it only carries the request.
//
// ── Why this is not the lock turnRegistry refuses to be ─────────────────────
// turnRegistry.ts says, deliberately: "A registry that could reject a turn
// would become a new way for a conversation to stop working." That warning
// applies to anything that can make a turn fail to START. This one cannot:
//
//   * It is only ever written by an explicit stop request naming an exact
//     turnId. There is no wildcard record and no "stop whatever runs next".
//   * turnIds are unique per turn — measured: the client mints
//     `turn_${Date.now().toString(36)}_${6 random base36 chars}`, so a
//     collision needs the same millisecond AND 1-in-2-billion. A record left
//     behind by an old turn therefore cannot match a future one. The worst a
//     stale record can do is occupy a map entry.
//   * It never gates starting. A turn that nobody asked to stop never consults
//     anything here except a Map lookup that misses.
//
// ── In memory, not on disk ──────────────────────────────────────────────────
// A stop request means nothing across a restart: after a restart there are no
// running turns. Persisting it would create exactly the hazard above — a
// record outliving every turn it could possibly mean. Stored on `globalThis`
// so Next.js dev hot-reload does not orphan it mid-turn, the same pattern as
// the interjection queue, the AskQuestion rendezvous, the saveLog write-locks
// and turnRegistry itself.

/** What actually happened, so a caller can report it instead of always saying ok. */
export type StopOutcome =
  /** A live listener was woken — a turn was running and has been told. */
  | 'fired'
  /** Recorded; no listener yet. A listener registering later fires at once. */
  | 'recorded'
  /** This exact turn had already been asked to stop. Nothing new happened. */
  | 'already';

interface StopRecord {
  convoId: string;
  turnId: string;
  at: number;
}

type Listener = () => void;

/** Listeners for one turn, with the moment the first one registered. */
interface ListenerSet {
  at: number;
  set: Set<Listener>;
}

// Typed rather than `globalThis as any` (the older sites here do use `any`).
// Not tidiness: `any` on this object turns every field read below into an
// unchecked one, so a typo in a map name would compile and silently create a
// second, empty map that nothing else writes to — a stop channel that is
// always quiet, with no error anywhere.
const _g = globalThis as unknown as {
  __nx_stop_requests?: Map<string, StopRecord>;
  __nx_stop_listeners?: Map<string, ListenerSet>;
};
if (!_g.__nx_stop_requests) _g.__nx_stop_requests = new Map<string, StopRecord>();
if (!_g.__nx_stop_listeners) _g.__nx_stop_listeners = new Map<string, ListenerSet>();
const requests: Map<string, StopRecord> = _g.__nx_stop_requests;
const listeners: Map<string, ListenerSet> = _g.__nx_stop_listeners;

/**
 * How long a request lingers if nobody ever consumed it. Deliberately long —
 * a turn can run for 35 minutes (measured 2026-10-26), and a record that
 * expired mid-turn would make a long poll loop stop seeing a stop it was
 * already told about. Correctness does not depend on this number: the record
 * is removed explicitly when the turn ends. It only bounds memory for requests
 * naming a turn that never existed (a typo, a client racing a crash).
 */
export const STOP_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Hard cap, so a loop that somehow spams requests cannot grow the map without
 * limit. Only ever written by an explicit human/runner stop, so this is a
 * backstop set far above any real use — the same spirit as the 1000-agent cap.
 */
export const MAX_STOP_RECORDS = 500;

/**
 * Backstop for a listener whose turn ended without either of its two cleanups
 * running (the turn-level abort, and the `end` event the client posts when a
 * stream finishes). Same reasoning as turnRegistry's TTL: this number only has
 * to cover the case where BOTH of those are lost.
 *
 * Erring LONG on purpose, the opposite of the registry — there, a stale entry
 * lies to a person ("someone is running this"), so short is safer. Here, an
 * entry pruned too early makes a running turn silently unstoppable, so the
 * number must sit above any real turn. Longest measured turn in this house:
 * 35 minutes (2026-10-26). Six hours is an order of magnitude above it.
 */
export const LISTENER_TTL_MS = 6 * 60 * 60 * 1000;

/** Exported so tests and callers share one derivation instead of re-deriving it. */
export function stopKey(convoId: string, turnId: string): string {
  return `${convoId}\u0000${turnId}`;
}

function prune(now: number): void {
  for (const [k, v] of requests) {
    if (now - v.at > STOP_TTL_MS) requests.delete(k);
  }
  for (const [k, v] of listeners) {
    if (now - v.at > LISTENER_TTL_MS) listeners.delete(k);
  }
  if (requests.size <= MAX_STOP_RECORDS) return;
  // Oldest first. Sorting only happens in the already-pathological case.
  const byAge = [...requests.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [k] of byAge.slice(0, requests.size - MAX_STOP_RECORDS)) requests.delete(k);
}

/**
 * Ask for a specific turn to stop.
 *
 * Both orders work: if the turn's listener is already registered it is woken
 * now; if the request arrives first (the runner's turn has not reached its
 * registration yet) the record waits and `onStop` fires immediately when it
 * does. That rendezvous is the whole point — without it, a stop sent during
 * the first milliseconds of a turn would be silently lost, and "I pressed stop
 * and nothing happened" is the failure this family is worst at.
 */
export function requestStop(convoId: string, turnId: string): StopOutcome {
  if (!convoId || !turnId) return 'already';
  const now = Date.now();
  const key = stopKey(convoId, turnId);
  const had = requests.has(key);
  requests.set(key, { convoId, turnId, at: now });
  prune(now);

  const entry = listeners.get(key);
  if (entry && entry.set.size > 0) {
    // DETACH BEFORE FIRING, and that order is the whole guarantee:
    //   * a callback may unregister itself (the chat route's does) — with the
    //     key already gone its unregister is a harmless no-op instead of a
    //     mutation of the set being iterated;
    //   * a listener fires at most once, because a later request finds no set.
    // Measured, not assumed: injecting "delete after firing" is CAUGHT by
    // tests/lib/turnStop.test.ts; injecting "iterate a copy instead of the
    // live set" changes NOTHING, which is why there is no copy here. The
    // defensive copy that used to sit on this line defended against a hazard
    // this ordering had already removed — see p34's MISSED row.
    listeners.delete(key);
    for (const cb of entry.set) {
      try { cb(); } catch { /* one broken listener must not swallow the others */ }
    }
    return 'fired';
  }
  return had ? 'already' : 'recorded';
}

/**
 * Register to be told when THIS turn is asked to stop. Returns an unregister
 * function; calling it is required when the turn ends normally, or the
 * listener outlives its turn.
 *
 * If a stop was already requested, `cb` runs synchronously before this
 * returns, and the returned function is a no-op. Callers must therefore be
 * safe to be stopped before they finish wiring up — the chat route is,
 * because `turnAbort.abort()` is idempotent and every loop re-reads the flag.
 */
export function onStop(convoId: string, turnId: string, cb: Listener): () => void {
  if (!convoId || !turnId) return () => {};
  const key = stopKey(convoId, turnId);

  if (requests.has(key)) {
    try { cb(); } catch { /* same reason as above */ }
    return () => {};
  }

  prune(Date.now());

  let entry = listeners.get(key);
  if (!entry) { entry = { at: Date.now(), set: new Set<Listener>() }; listeners.set(key, entry); }
  entry.set.add(cb);

  let done = false;
  return () => {
    if (done) return;
    done = true;
    const e = listeners.get(key);
    if (!e) return;
    e.set.delete(cb);
    if (e.set.size === 0) listeners.delete(key);
  };
}

/** Did someone ask this exact turn to stop? For loops that poll rather than listen. */
export function isStopRequested(convoId: string, turnId: string): boolean {
  if (!convoId || !turnId) return false;
  return requests.has(stopKey(convoId, turnId));
}

/**
 * Drop everything for a finished turn. Called when a turn ends — whether it
 * finished, was stopped, or threw — so neither a record nor a listener
 * outlives the turn it names.
 */
export function forgetStop(convoId: string, turnId: string): void {
  if (!convoId || !turnId) return;
  const key = stopKey(convoId, turnId);
  requests.delete(key);
  listeners.delete(key);
}

/** Test/diagnostic seam. Not used by the product. */
export function _stopState(): { requests: number; listeners: number } {
  return { requests: requests.size, listeners: listeners.size };
}

/** Test seam: wipe both maps. Never called by the product. */
export function _resetStops(): void {
  requests.clear();
  listeners.clear();
}
