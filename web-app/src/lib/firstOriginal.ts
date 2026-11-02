// ───────────────────────────────────────────────────────────────────────────
// "Is this message ORIGINAL, or COPIED carry-over?" — the single source.
//
// A conversation cloned through "Go to Next" / the Soul Updater carries its
// pre-clone history forward as copied context. The boundary is recorded on the
// log as `firstOriginalMessageId`; between the clone and the next message
// being added it is pending instead, recorded as `firstOriginalIsNext`.
//
//   - `firstOriginalIsNext` and no marker → the marker is PENDING on the next
//     message added. Everything currently in the log is carry-over, so
//     NOTHING is original yet (the post-clone state) — UNLESS the caller can
//     name the message it is going to land on, which a tab mid-turn can and a
//     server walking a stored log cannot (`optimisticMarkerIndex`). Then the
//     boundary applies from that message, before it reaches disk.
//   - no marker and not pending → EVERY message is original. This is the
//     safest default: hand-built conversations, and everything that predates
//     the marker, never went through the clone workflow. **The absence of the
//     marker must never read as `false`** — reading it that way is the defect
//     that made handover restore return nothing on 2026-10-23.
//   - marker set → messages BEFORE the marker index are copied; the marker
//     and everything after it are original. A marker id that is not in the
//     list (its message was deleted) falls back to "everything original",
//     the same default as no marker at all.
//
// This rule was derived FOUR times before 2026-10-27 — `ChatArea`,
// `api/stats`, `conversationSearch`, and the since-deleted `addTimestamps`
// action, whose own comment said *"Mirrors ChatArea.tsx's
// isMessageOriginal()"*. The stats copy said *"Replicates
// ChatArea.isMessageOriginal"*. Self-documented second derivations: the
// comment names the original, and the code still drifts independently.
//
// Callers differ only in what they hold — an index (the server, walking a
// static log) or a message id (the client, holding live state). Both adapters
// below go through ONE implementation.
// ───────────────────────────────────────────────────────────────────────────

/** The two fields on a log that record the copied/original boundary. */
export interface FirstOriginalMarker {
  firstOriginalMessageId?: string | null;
  firstOriginalIsNext?: boolean;
}

/**
 * `isOriginal(idx)` over a message list — for callers that already have an
 * index (server-side walks of a stored log).
 *
 * The marker index is resolved ONCE, when the predicate is built, so calling
 * it per message does not re-scan the list.
 */
export function makeIsOriginalIndex(
  marker: FirstOriginalMarker,
  messages: Array<{ id?: string }>,
  optimisticMarkerIdx = -1,
): (idx: number) => boolean {
  const markerId = marker.firstOriginalMessageId || null;
  const isNext = marker.firstOriginalIsNext === true;
  if (isNext && !markerId) {
    // The boundary is PENDING, and a caller that is holding the message it
    // will land on can be answered now: `promotePendingMarker` already says
    // the next user message added becomes the marker, so this is that rule's
    // consequence and not a guess about the future. Only the tab mid-turn can
    // supply it (see `optimisticMarkerIndex`); a server walking a stored log
    // has no such message and passes nothing.
    //
    // -1 keeps the pre-2026-11-02 answer: NOTHING is original yet. That is
    // the OPPOSITE default from a resolved-but-missing marker below, for a
    // different reason — an absent marker id was DELETED (the conversation
    // outlived its boundary, so everything is original), while an absent
    // landing message has not been ADDED yet (the clone is still waiting).
    if (optimisticMarkerIdx < 0) return () => false;
    return (idx: number) => idx >= optimisticMarkerIdx;
  }
  if (!markerId) return () => true;
  const markerIdx = messages.findIndex((m) => m.id === markerId);
  if (markerIdx < 0) return () => true;
  return (idx: number) => idx >= markerIdx;
}

/**
 * `isOriginal(id)` — same rule, keyed by message id, for the client, which
 * holds the marker in component state and asks about one message at a time.
 *
 * An id that is not in the list resolves to index -1, which lands on the same
 * answer the index form gives for -1. That matches the behaviour of the
 * client's previous inline copy exactly, including that case.
 */
export function makeIsOriginalId(
  marker: FirstOriginalMarker,
  messages: Array<{ id?: string }>,
  optimisticMarkerIdx = -1,
): (id: string) => boolean {
  const byIndex = makeIsOriginalIndex(marker, messages, optimisticMarkerIdx);
  return (id: string) => byIndex(messages.findIndex((m) => m.id === id));
}

/** Is the boundary PENDING — the clone happened, nothing has consumed it yet? */
export function isMarkerPending(marker: FirstOriginalMarker): boolean {
  return marker.firstOriginalIsNext === true && !marker.firstOriginalMessageId;
}

/**
 * Where a PENDING boundary is going to land, read off a tab's own optimistic
 * bubbles — the index to hand `makeIsOriginal*` while a turn is in flight.
 *
 * ⚠ WHY THIS EXISTS. The runner mints the user message the marker names, so
 * the boundary only reaches disk when the turn is saved. Between send and save
 * the tab holds its own copy of the sent text, and `isNext && !markerId` read
 * that copy — and the reply growing under it — as carry-over. REPORTED by
 * Lizard-kun 2026-11-02: 「メッセージを送ると、僕のメッセージも相手の返事も
 * 灰色のままだ。僕のメッセージに、フラグがつかない。でも、それはそのターンが
 * 終わってないときだけ。ターンが終わったら、あるべき姿になる」.
 *
 * The answer is NOT to move the marker optimistically into state: a save
 * during the turn would write that guess to disk, and a failed turn would
 * leave a marker naming a message the runner never wrote. This is render-time
 * only, so nothing it says can be persisted.
 *
 * The FIRST optimistic user message, in list order, not the last: the pending
 * marker lands on the next user message ADDED, and if a batch contributes
 * several, the boundary belongs at the earliest of them. List order decides
 * (the id array's push order agrees today; the list is the one that is true).
 */
export function optimisticMarkerIndex(
  marker: FirstOriginalMarker,
  messages: Array<{ id?: string; role?: string }>,
  optimisticIds: readonly string[],
): number {
  if (!isMarkerPending(marker)) return -1;
  // No early return for an empty id list: the loop already answers -1 for it,
  // and a guard that cannot change any answer is a line no mutation can test.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && m.id && optimisticIds.includes(m.id)) return i;
  }
  return -1;
}

/** The two fields a consumer writes back once the boundary is resolved. */
export interface ResolvedMarker {
  firstOriginalMessageId: string;
  firstOriginalIsNext: false;
}

/**
 * The SECOND HALF of the clone workflow: "Go to Next" sets the pending flag,
 * and the next user message added becomes the marker.
 *
 * ⚠ WHY THIS IS A LIB AND NOT A LINE IN A HANDLER. Until 2026-10-31 this rule
 * lived inside `ChatArea.handleSend`, which minted the user message itself. It
 * does not any more: the server-side runner mints it (composeBatch → its own
 * id) and writes the log. The handler's three lines went away with the browser
 * turn and NOTHING took over, so `firstOriginalIsNext` stayed true forever —
 * and `makeIsOriginalIndex` reads pending-with-no-marker as "NOTHING is
 * original". Every message in every cloned conversation read as carry-over,
 * permanently. REPORTED by ふわふわ 2026-10-31: "Next = First Original が
 * 3000 Dev では動かなくなった。次のメッセージは新規にならず、すべて過去のまま".
 *
 * My own comment at the first-message branch called this "the SAME gap every
 * runner send has today, not a new regression". It was a regression: `main`
 * had a consumer and `dev` had none. A gap that is documented is still a gap,
 * and writing down that it is not new does not measure whether it is.
 *
 * Returns null when there is nothing to promote, so a caller can spread the
 * result unconditionally and a non-fresh turn (rerun/continue, which add no
 * user message) cannot move the boundary.
 */
export function promotePendingMarker(
  marker: FirstOriginalMarker,
  newUserMessageId: string,
): ResolvedMarker | null {
  if (!isMarkerPending(marker)) return null;
  if (!newUserMessageId) return null;
  return { firstOriginalMessageId: newUserMessageId, firstOriginalIsNext: false };
}

/**
 * Let a tab learn a boundary that something ELSE resolved — specifically the
 * runner, which now owns the id of the user message the marker lands on.
 *
 * ⚠ WHY A CLIENT RULE IS NEEDED AT ALL once the runner writes the log: the
 * tab keeps these two fields in component state, and `buildLogData` writes
 * state back on every save. So the runner's promotion lands on disk and the
 * tab's NEXT save — any settings change, any later message — reverts it, with
 * no error and no diff anyone would look at. The reload at the end of a watch
 * replaces `messages` ONLY (measured), so without this the tab never learns.
 *
 * MONOTONE BY CONSTRUCTION: it can only consume a pending flag, never create
 * one, and never overwrite a marker the state already holds. That is what
 * makes it safe to run on every reload — a human holding a pending flag has
 * no marker to lose, and a human who has set a marker is never overruled.
 */
export function adoptResolvedMarker(
  state: FirstOriginalMarker,
  disk: FirstOriginalMarker,
): ResolvedMarker | null {
  if (!isMarkerPending(state)) return null;
  const diskId = disk.firstOriginalMessageId;
  if (typeof diskId !== 'string' || !diskId) return null;
  return { firstOriginalMessageId: diskId, firstOriginalIsNext: false };
}
