// ── "Who is running this conversation right now" ─────────────────────────────
// NEXUS keeps the truth of a conversation in the BROWSER: each tab holds the
// message array in memory and POSTs the whole thing to /api/logs. Two tabs on
// the same conversation therefore each hold their own copy, and the loser of
// any race silently loses work. The save guard in fsStorage.saveLog is the last
// line of defence — it REFUSES a stale write. This registry is the earlier,
// gentler one: it lets a tab find out that a turn is already running elsewhere
// BEFORE the human sends a second one into the same log.
//
// Deliberately NOT a lock. It never blocks a request, and the chat route never
// consults it. A registry that could reject a turn would become a new way for a
// conversation to stop working (a crashed tab holding a lease, a clock skew),
// and the failure it prevents is already prevented downstream, with data. This
// only ever answers a question.
//
// Stored on globalThis so Next.js dev hot-reload doesn't orphan the map
// mid-turn — same pattern as the interjection queue, the AskQuestion
// rendezvous, and the saveLog write-locks.

export interface ActiveTurn {
  convoId: string;
  /** The turnId the frontend generated for this turn (also the interjection key). */
  turnId: string;
  /** Identifies the TAB that started it, so a tab can recognize its own turn. */
  clientId: string;
  /** Human-facing hint of what is running, e.g. a model label. Display only. */
  label?: string;
  startedAt: number;
  lastSeen: number;
}

const _g = globalThis as any;
if (!_g.__nx_active_turns) _g.__nx_active_turns = new Map<string, ActiveTurn>();
const active: Map<string, ActiveTurn> = _g.__nx_active_turns;

// How long an entry survives without a heartbeat.
//
// ⚠ CORRECTED 2026-10-31. This used to read "The client beats every
// HEARTBEAT_MS while it reads the stream" as a statement of fact. NOTHING
// BEATS. The only sender of POST { event: 'beat' } was
// `beginTurnRegistration` in the browser turn engine, deleted 2026-10-30;
// grep 'beat' across src/ and the POST branch below is the only hit. So this
// TTL is not a backstop for a double failure — for a SERVER-RUN turn it is
// the normal path, and the entry disappears 25 seconds into a turn that may
// run for minutes.
//
// That made GET /api/chat/active answer "nothing is running here" to a tab
// trying to rejoin a live turn after a network blip (MEASURED by Lizard-kun
// with airplane mode). That GET now asks the relay as a second source, which
// has no TTL. This comment is left wrong-and-corrected rather than rewritten,
// because the false sentence is what made the hole invisible.
//
// The 'beat' branch is kept — it costs nothing and a future browser-run turn
// would want it. It has ZERO callers today.
//
// The server also drops the entry when the request aborts, and the runner's
// tick route drops it when the turn ends.
//
// Erring short on purpose: a stale "someone is running this" that outlives the
// turn would block sending with a claim that is no longer true, and a false
// warning teaches people to ignore the real one.
export const TURN_TTL_MS = 25_000;
/** Cadence the client should beat at — exported so both sides share one number. */
export const HEARTBEAT_MS = 8_000;

function isFresh(t: ActiveTurn, now: number): boolean {
  return now - t.lastSeen <= TURN_TTL_MS;
}

/** Drop expired entries. Called on every read and write, so the map stays bounded. */
function prune(now: number): void {
  for (const [k, v] of active) {
    if (!isFresh(v, now)) active.delete(k);
  }
}

/** Record that a turn has started for this conversation. Overwrites any stale entry. */
export function markTurnActive(convoId: string, turnId: string, clientId: string, label?: string): void {
  if (!convoId || !turnId) return;
  const now = Date.now();
  prune(now);
  active.set(convoId, { convoId, turnId, clientId: clientId || '', label, startedAt: now, lastSeen: now });
}

/**
 * Keep an entry alive. Returns false if there was nothing to touch, or if the
 * entry belongs to a DIFFERENT turn — a heartbeat must never resurrect or hijack
 * someone else's turn.
 */
export function touchTurn(convoId: string, turnId: string): boolean {
  const now = Date.now();
  prune(now);
  const t = active.get(convoId);
  if (!t || t.turnId !== turnId) return false;
  t.lastSeen = now;
  return true;
}

/**
 * Clear a turn. Only the turn that owns the entry may clear it, so a late
 * "my turn ended" from a previous turn can't erase the one running now.
 */
export function endTurn(convoId: string, turnId: string): void {
  if (!convoId || !turnId) return;
  const t = active.get(convoId);
  if (t && t.turnId === turnId) active.delete(convoId);
  prune(Date.now());
}

/** What GET /api/chat/active answers, before it is dressed as JSON. */
export interface ActiveAnswer {
  active: boolean;
  /** True only when the caller's own clientId owns the registry entry. */
  mine: boolean;
  /** Display-only hint. Only a registry entry carries one. */
  label?: string;
  startedAt?: number;
  /** Which source decided. Returned to callers so a future diagnosis is cheap. */
  source: 'registry' | 'relay' | 'none';
}

/**
 * Decide whether a turn is running for a conversation, from BOTH sources.
 *
 * ── Why there are two ──────────────────────────────────────────────────────
 * The registry entry is dropped TURN_TTL_MS after its last heartbeat, and
 * NOTHING BEATS for a turn the server runs (see the TTL correction above).
 * The chat route marks the turn when the runner POSTs, so the entry is real
 * for 25 seconds and then gone while the turn is still generating.
 *
 * MEASURED 2026-10-31 (Lizard-kun, airplane mode on a phone): a tab whose
 * watch died with the connection asks this question again when the network
 * returns, is told "nothing is running here", and never gets its view back.
 * The turn finishes on the server and lands on disk; only the screen is lost.
 *
 * The relay has no TTL: it is opened by beginTurn and closed by endTurn, both
 * by the code that runs the turn, in the same process, and `live` is literally
 * `!done`.
 *
 * ── The one rule ───────────────────────────────────────────────────────────
 * The relay may only turn `active` ON. It may never turn it OFF.
 *
 * A missing relay means "no relay record", NOT "no turn": an SPU run POSTs
 * /api/chat as well, and keys its relay by being and generation, so the
 * conversation map is empty for it while its registry entry is real. Letting
 * absence subtract would make this answer "nothing is running" in the middle
 * of a soul update.
 *
 * `mine` is false for a relay-derived answer, and that is not a guess:
 * conversation relays are opened in exactly one place, the runner's tick
 * route, so such an answer always describes a turn that no tab owns.
 */
export function resolveActiveTurn(
  entry: { clientId: string; label?: string; startedAt: number } | null,
  relay: { live: boolean; startedAt: number } | null,
  clientId: string,
): ActiveAnswer {
  if (entry) {
    return {
      active: true,
      // The server decides this, not the caller — so "is it me?" is answered
      // the same way everywhere instead of being re-derived per call site.
      mine: !!clientId && entry.clientId === clientId,
      label: entry.label,
      startedAt: entry.startedAt,
      source: 'registry',
    };
  }
  if (relay && relay.live) {
    return { active: true, mine: false, startedAt: relay.startedAt, source: 'relay' };
  }
  return { active: false, mine: false, source: 'none' };
}

/** The live turn for this conversation, or null. Expired entries never surface. */
export function getActiveTurn(convoId: string): ActiveTurn | null {
  if (!convoId) return null;
  const now = Date.now();
  prune(now);
  const t = active.get(convoId);
  return t && isFresh(t, now) ? t : null;
}
