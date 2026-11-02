// ── "Who wrote the version that is on disk?" ────────────────────────────────
//
// WHY THIS EXISTS (measured 2026-10-28 from both dev-server logs):
// the optimistic-concurrency guard in `saveLog` refuses a save whose base has
// moved, and the client then has to answer one question before it can warn the
// partner: was the "other" writer somebody else, or was it us?
//
// Today that question is answered entirely in the BROWSER, by `ownWritesRef`
// in ChatArea: every updatedAt this tab successfully wrote is remembered, and a
// refusal whose disk value is in that list is adopted silently instead of
// raising the banner. Measured in the logs:
//
//   port 3000   50 refusals   port 3001   52 refusals
//   of the 3001 ones, 17 of 21 "never adopted" rows have a gap of 0.2s
//   between base and disk — far too small for a human operating a second tab,
//   so those are this tab racing ITSELF (`savesInFlightRef` is a counter, not
//   a mutex, so several saves are legitimately in flight at once).
//
// `ownWritesRef` has two holes, and the second one is why this module exists:
//
//   (1) It is filled only when a save's 200 response has been READ. If two of
//       our own saves race and the 409 arrives before the 200, the value is not
//       in the list yet and the banner fires on our own write. That matches the
//       one case つよ reported twice and could not reproduce — response arrival
//       order is a race, so it is intermittent by construction.
//
//   (2) ⚠ It lives in one tab's memory, so it can NEVER recognise a write made
//       by anything else that is legitimately ours — and Phase 4b introduces
//       exactly that: a server-side runner saving the turn it just ran. After
//       the runner ships, today's ~100 harmless refusals per day all become
//       banners, because no browser tab wrote any of them.
//
// So the server records who wrote each version, and tells the client that when
// it refuses one. The client can then say "that was me" (adopt), "that was the
// runner" (a true statement, not "another tab"), or fall back to today's
// wording when the answer is unknown.
//
// ── Default is UNKNOWN, and unknown behaves exactly like today ──────────────
// Same asymmetry as runnerHost: the two directions of "safe" are not equal.
// Answering "unknown" costs one banner that the partner can dismiss. Answering
// the WRONG clientId makes the client adopt a version somebody else wrote and
// overwrite their work — the measured failure the guard was built to prevent
// (see the comment above the guard in fsStorage.ts). So every path that cannot
// prove the answer returns null.
//
// ── Memory only, on purpose ────────────────────────────────────────────────
// A record that survived a restart would be a claim about a tab that no longer
// exists. After a restart there is no turn running and no save in flight, so
// the first refusal falls back to "unknown" — which is today's behaviour, i.e.
// the thing that already works.

/** How many recent versions to remember per conversation. */
const PER_CONVO = 16;
/** How many conversations to track at once. */
const MAX_CONVOS = 64;

interface WriteRecord {
  updatedAt: number;
  clientId: string;
}

interface Store {
  /** convoId -> most recent writes, oldest first. */
  byConvo: Map<string, WriteRecord[]>;
}

// Same `globalThis` pattern as turnStop/turnRegistry: Next's dev server
// re-evaluates modules on hot reload, and a module-level `const` would hand
// back an empty store mid-turn.
const g = globalThis as unknown as { __nexusLastWriter?: Store };
function store(): Store {
  if (!g.__nexusLastWriter) g.__nexusLastWriter = { byConvo: new Map() };
  return g.__nexusLastWriter;
}

/**
 * Record that `clientId` successfully wrote version `updatedAt` of `convoId`.
 *
 * Called only AFTER the bytes are on disk. Recording an attempt would let a
 * failed save claim a version it never wrote, and the next refusal would then
 * be adopted against a file that does not contain it.
 *
 * A write with no clientId is NOT recorded: a null entry would be
 * indistinguishable from "we know nobody wrote this", and the callers that
 * save without an id (backup restore, import, duplicate) genuinely have no
 * tab to name.
 */
export function recordWrite(convoId: string, updatedAt: number, clientId: unknown): void {
  if (!convoId || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return;
  if (typeof clientId !== 'string' || !clientId) return;
  const s = store();
  let list = s.byConvo.get(convoId);
  if (!list) {
    // Evict before inserting, so the map never exceeds the cap even for one
    // tick. Oldest insertion order first — Map preserves it.
    if (s.byConvo.size >= MAX_CONVOS) {
      const oldest = s.byConvo.keys().next();
      if (!oldest.done) s.byConvo.delete(oldest.value);
    }
    list = [];
    s.byConvo.set(convoId, list);
  }
  // Re-recording the same version replaces rather than appends: two saves can
  // land on the same millisecond, and the second one is the one on disk.
  const existing = list.findIndex(r => r.updatedAt === updatedAt);
  if (existing >= 0) {
    list[existing] = { updatedAt, clientId };
    return;
  }
  list.push({ updatedAt, clientId });
  if (list.length > PER_CONVO) list.splice(0, list.length - PER_CONVO);
}

/**
 * Who wrote version `updatedAt` of `convoId`, or null if we cannot prove it.
 *
 * Null is returned for: a conversation we have no records for (fresh restart),
 * a version older than the window, and a version written by a caller that sent
 * no clientId. All three mean "fall back to today's wording".
 */
export function whoWrote(convoId: string, updatedAt: unknown): string | null {
  if (!convoId || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  const list = store().byConvo.get(convoId);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].updatedAt === updatedAt) return list[i].clientId;
  }
  return null;
}

/** Drop everything. Tests only — a running server has no reason to forget. */
export function resetLastWriterForTests(): void {
  g.__nexusLastWriter = { byConvo: new Map() };
}

/** Inspect the store. Tests and diagnostics only. */
export function lastWriterSizeForTests(): { convos: number; records: number } {
  const s = store();
  let records = 0;
  for (const list of s.byConvo.values()) records += list.length;
  return { convos: s.byConvo.size, records };
}
