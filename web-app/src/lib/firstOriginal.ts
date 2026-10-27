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
