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

// How long an entry survives without a heartbeat. The client beats every
// HEARTBEAT_MS while it reads the stream; the server also drops the entry when
// the request aborts, so this TTL only has to cover the case where BOTH of
// those fail (tab killed at the OS level, laptop lid closed mid-turn).
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

/** The live turn for this conversation, or null. Expired entries never surface. */
export function getActiveTurn(convoId: string): ActiveTurn | null {
  if (!convoId) return null;
  const now = Date.now();
  prune(now);
  const t = active.get(convoId);
  return t && isFresh(t, now) ? t : null;
}
