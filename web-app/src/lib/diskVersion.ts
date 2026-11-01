/**
 * "Has someone else changed this conversation on disk?"
 *
 * ── WHY THIS IS A LIB AND NOT A BOOLEAN IN THE POLL ───────────────────────
 *
 * The rule lives where a test and a mutation can reach it. The last time a
 * rule of this shape stayed inside a handler, the handler moved (browser send
 * -> server runner) and the rule did not come with it: the "next message is
 * the first original" promotion vanished and every cloned conversation read as
 * all-past (F76, 2026-10-31). A predicate in a lib cannot be left behind by a
 * caller that moves.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DECIDE ────────────────────────────────
 *
 * WHAT to re-read. The answer is MESSAGES ONLY, and that is the caller's
 * business (ChatArea.reloadMessagesFromDisk replaces `messages` and the
 * version, nothing else). Settings are deliberately NOT mirrored across tabs:
 * swapping a panel a person is in the middle of using is the shape this house
 * refuses, and the real hazard there — one tab's save erasing another's — is
 * already answered by the 409 in saveLog. See nexus-overhaul-plan.md §15.
 */

export interface DiskVersionInput {
  /**
   * `updatedAt` as it is on disk right now, or null/undefined when the server
   * could not tell (field outside the 4 KB header window, file absent, read
   * failed). fsStorage.readHeaderWindow documents null as "cannot tell" and
   * NEVER as "unchanged" — this function honours that.
   */
  diskUpdatedAt: number | null | undefined;
  /** The version this tab is working from (ChatArea's baseUpdatedAtRef). */
  baseUpdatedAt: number | null;
  /** Every version this tab has written (ChatArea's ownWritesRef). */
  ownWrites: readonly number[];
}

/**
 * True when the version on disk is newer than this tab's and was not written
 * by this tab.
 *
 * Each rule below, with what would look different if it were missing:
 *
 *   diskUpdatedAt not finite  →  false
 *     Without it, `undefined` comparisons are falsy by accident rather than
 *     by decision, and a server that stops sending the field would read as
 *     "nothing ever changes" — a silent, permanent false negative.
 *
 *   baseUpdatedAt null  →  false
 *     A tab that has not loaded a conversation yet has nothing to compare and
 *     nothing on screen to correct. Without it, the first poll after mount
 *     would always reload.
 *
 *   diskUpdatedAt <= baseUpdatedAt  →  false
 *     Equal is the normal case and must not reload (that is a full-log fetch
 *     every ten seconds, forever). Older means this tab is AHEAD of the file,
 *     which happens between a local edit and its save; reloading there would
 *     throw away the edit.
 *
 *   ownWrites includes diskUpdatedAt  →  false
 *     Normally redundant: a successful save sets baseUpdatedAt to the version
 *     it wrote, so rule three already covers it. Kept because the two fail in
 *     different places — baseUpdatedAt is a single slot that a reload or a
 *     conversation switch can move, while ownWrites is the last sixteen and
 *     survives that. The same pairing already guards the 409 path
 *     (ownWritesRef alongside lib/lastWriter).
 */
export function shouldReloadFromDisk(input: DiskVersionInput): boolean {
  const { diskUpdatedAt, baseUpdatedAt, ownWrites } = input;
  if (typeof diskUpdatedAt !== 'number' || !Number.isFinite(diskUpdatedAt)) return false;
  if (typeof baseUpdatedAt !== 'number') return false;
  if (diskUpdatedAt <= baseUpdatedAt) return false;
  if (ownWrites.includes(diskUpdatedAt)) return false;
  return true;
}
