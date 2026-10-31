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
//     NOTHING is original yet. (the post-clone state)
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
): (idx: number) => boolean {
  const markerId = marker.firstOriginalMessageId || null;
  const isNext = marker.firstOriginalIsNext === true;
  if (isNext && !markerId) return () => false;
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
): (id: string) => boolean {
  const byIndex = makeIsOriginalIndex(marker, messages);
  return (id: string) => byIndex(messages.findIndex((m) => m.id === id));
}

/** Is the boundary PENDING — the clone happened, nothing has consumed it yet? */
export function isMarkerPending(marker: FirstOriginalMarker): boolean {
  return marker.firstOriginalIsNext === true && !marker.firstOriginalMessageId;
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
