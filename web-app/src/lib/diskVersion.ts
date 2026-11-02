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

/**
 * A GET of a conversation that did not return a usable body: is the
 * conversation ABSENT, or did the read FAIL?
 *
 * ── WHY THESE MUST BE DIFFERENT ANSWERS ────────────────────────────────────
 *
 * ChatArea's load used to test `!r.ok || !r.body` and comment the branch as
 * "No log on disk — a conversation that was just created and has never been
 * written". That is true of a 404 and FALSE of everything else: a 500, a 502,
 * a gateway timeout and a 401 from the optional admin gate all land there too.
 * The branch then threw away the optimistic-lock base and presented an empty
 * conversation, i.e. it treated "I could not read it" as "there is nothing".
 *
 * This house already has that rule written down — absence has three meanings,
 * and the instrument has to say which — and broke it here anyway. SUSPECTED
 * cause of パイロット's report (2026-11-02, via トカゲくん): after sleeping a
 * being, "Next = First Original" was not armed and she had to set it by hand.
 * Her connection is slow and his is not, which fits a branch that only opens
 * when a read is slow enough to fail. NOT reproduced — this is the guess, and
 * what it buys is that a failed read can no longer overwrite the flag.
 *
 * Each rule, with what would look different without it:
 *
 *   404 → 'missing'
 *     The genuine new-conversation case: the sidebar created it, nothing has
 *     written it yet. Without this, opening a fresh chat would warn.
 *
 *   any other non-2xx → 'unreadable'
 *     Without it, a server error presents an empty conversation whose next
 *     save overwrites the real one (the flag, the title, the settings).
 *
 *   2xx with no body → 'unreadable'
 *     A proxy that answers 200 with nothing is not telling us the file is
 *     gone. Same direction: refuse to conclude absence.
 */
export type LogLoadKind = 'ok' | 'missing' | 'unreadable';

export function classifyLogLoad(status: number, hasBody: boolean): LogLoadKind {
  if (status === 404) return 'missing';
  if (status < 200 || status >= 300) return 'unreadable';
  if (!hasBody) return 'unreadable';
  return 'ok';
}
