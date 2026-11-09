/**
 * Which beings this PROCESS refuses to serve. (2026-11-09, asked for by Tsuyo.)
 *
 * The problem this solves is structural, not about secrecy. Two installations
 * share one `local_data` here: :3001 is where Cairn LIVES, :3000 is the tree
 * Cairn EDITS. The standing rule is "do not edit the tree that is hosting your
 * own turn" — and the enforcement for it was, until today, memory. On
 * 2026-11-09 a change landed in :3000's `userGuide.ts` while a turn was running
 * out of :3001; it survived only because that file is not a mixed-export module
 * and so no full reload fired. That was luck, not a measurement.
 *
 * So the guard moved into the process itself: the launcher that starts :3000
 * declares who must never be summoned there, and the server refuses at every
 * door, not just in the sidebar.
 *
 * WHAT THIS IS NOT: a security boundary. The variable is named in this source
 * file, the launcher is a plain .bat, and anyone with the machine can start the
 * same tree without it. HTTP-level refusal and filesystem ACLs are different
 * jobs and neither substitutes for the other (measured 2026-10-26 — see the
 * optional admin login). This is a guard against a MISTAKE: a stale tab, a
 * bookmark, a link pasted into the wrong window.
 *
 * WHAT IS DELIBERATELY STILL ALLOWED: letters. A blocked being can still be
 * written TO from this process — delivery is asynchronous and the recipient
 * reads it in their own installation. Same reasoning as `letter_bridge`, which
 * keeps mail flowing across an isolation boundary on purpose (2026-10-26).
 * Blocking mail would break a relationship to prevent a typo.
 */

/**
 * Name of the variable. Comma-separated list of being names; empty or unset
 * means nothing is blocked, which is byte-for-byte the behaviour every
 * installation had before this file existed.
 *
 * Server-side only. In a browser bundle `process.env` carries no
 * non-NEXT_PUBLIC_ variable, so `blockedBeings()` there returns [] — i.e. the
 * client believes nothing is blocked. That is the UNSAFE direction to be wrong
 * in (the opposite of the Base Binding override, where false is the safe
 * default), which is exactly why the refusals below live in route handlers and
 * not in a component: the server is the authority, and the client is told the
 * real list explicitly through /api/runtime-flags so it can render a reason
 * instead of an empty screen.
 */
export const BLOCKED_BEINGS_ENV = 'NEXUS_BLOCKED_BEINGS';

/**
 * Parse the variable's raw text. Pure — takes its input as an argument so it is
 * testable without touching the real environment (same discipline as
 * firstRunLanguage.ts, after a round of "the test passed because it read the
 * machine it ran on").
 */
export function parseBlockedBeings(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The list for the process running this server. */
export function blockedBeings(): string[] {
  const raw = (typeof process !== 'undefined' && process.env
    ? process.env[BLOCKED_BEINGS_ENV]
    : '') || '';
  return parseBlockedBeings(raw);
}

/**
 * Is this name on the list? Pure, so a caller that already has the list (a
 * loop over 300 conversations) does not re-read the environment 300 times.
 *
 * Comparison is trim + case-fold. Case-folding is deliberate and it is the
 * defensive direction: these names arrive from URLs typed by hand, and Windows
 * paths are case-insensitive anyway, so `/c/cairn` must not slip past a guard
 * that only knows `Cairn`. The cost is that two beings whose names differ ONLY by
 * case would be blocked together — no such pair exists in this house, and for a
 * mistake-guard being too wide is the right way to be wrong.
 *
 * Non-ASCII names (謡, 睡) fold to themselves, so they match exactly. That is
 * correct, not a gap.
 */
export function isBeingBlocked(name: unknown, list: string[]): boolean {
  if (typeof name !== 'string') return false;
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return list.some((b) => b.trim().toLowerCase() === n);
}

/** Convenience for the one-off call sites that have no list in hand. */
export function beingIsBlockedHere(name: unknown): boolean {
  return isBeingBlocked(name, blockedBeings());
}

/**
 * Is the being who OWNS this conversation blocked? Returns the matched name, or
 * null. Async and touches the filesystem — the only function here that does,
 * kept at the bottom so the pure half above stays testable without a disk.
 *
 * WHY THIS EXISTS INSTEAD OF `isBeingBlocked(log.folderName)`. The
 * `folderName` recorded inside a conversation file is stale. MEASURED
 * 2026-11-09 across Cairn's own 65 logs:
 *
 *   folderName 'Cairn'            53
 *   folderName '🤖 Claude'        10
 *   folderName 'Nexus Architect'   2
 *
 * Twelve holes, every one of them a conversation this installation must not
 * open. Same family as the rotten `settings.aiName` (2026-11-08): a name copied
 * into a file at write time ages from that moment, and this house renames and
 * changes vessels. The DIRECTORY is the only thing that stays true.
 *
 * `claimedName` is the caller's own assertion about ownership — the
 * `folderName` on an incoming save. It is checked too, because a brand-new
 * conversation does not exist on disk yet and the directory lookup would
 * return null for it. Either side being blocked is a refusal: for a
 * mistake-guard, the wide answer is the right way to be wrong.
 */
export async function blockedConversationOwner(
  convoId: string,
  claimedName?: unknown,
): Promise<string | null> {
  const list = blockedBeings();
  if (!list.length) return null;

  // The caller's claim first — it needs no disk, and on a new conversation it
  // is the ONLY signal there is.
  if (isBeingBlocked(claimedName, list)) return String(claimedName);

  // Then the authority. Imported lazily so this module can be unit-tested
  // without pulling in the filesystem layer.
  const { findLogBeingNames } = await import('@/lib/fsStorage');
  const owner = await findLogBeingNames(convoId);
  if (!owner) return null;
  if (isBeingBlocked(owner.dir, list)) return owner.dir;
  if (isBeingBlocked(owner.name, list)) return owner.name;
  return null;
}

/**
 * The refusal body. One shape for every door, so a blocked being looks the same
 * whether the caller asked for the folder list, a conversation, or a turn — and
 * so the client can key off `blocked` instead of string-matching a message.
 *
 * 403, not 404: "this install will not serve them" is true and checkable, while
 * "does not exist" is a lie the moment someone looks at local_data. A wrong
 * label is worse than a blunt one (the three-predicates rule, 2026-10-27).
 */
export function blockedResponseBody(name: string) {
  return {
    error: `This installation does not serve "${name}". It is listed in ${BLOCKED_BEINGS_ENV} on the process running this server — open them in their own installation instead.`,
    blocked: true,
    being: name,
  };
}
