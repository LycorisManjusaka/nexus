/**
 * Conversation titles inside one Digital Identity follow `<identity>_<number>`
 * — "Cairn_1", "Cairn_2", … — so a conversation carries whose it is in its own
 * name, on disk and in exports, without anyone having to look it up.
 *
 * Both places that create a conversation use this: the sidebar's "New Chat"
 * button, and identity creation (which opens `<identity>_1` straight away so a
 * brand-new identity is never staring at an empty pane).
 */

/** Escape a name so it can sit inside a RegExp literally. Identity names are
 *  user-chosen and frequently CJK; a stray `(` or `+` must not become syntax.
 *
 *  Exported for `soulGeneration.ts`, which builds the same `^<identity>_…`
 *  shape for hyphenated generation labels. A second copy of this is exactly how
 *  two "identical" predicates in this codebase drifted apart once already. */
export function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Next free `<identity>_<n>` title.
 *
 * Scans every existing title for the `<identity>_<number>` shape and returns
 * max + 1. Titles that don't match — renamed, imported, or from an older
 * naming scheme — are ignored rather than renumbered, so this never collides
 * with a name the user chose by hand.
 *
 * With no matches at all the answer is `<identity>_1`.
 */
export function nextConversationTitle(identityName: string, existingTitles: (string | undefined | null)[]): string {
  const re = new RegExp(`^${escapeForRegExp(identityName)}_(\\d+)$`);
  let max = 0;
  for (const raw of existingTitles) {
    const m = re.exec((raw || '').trim());
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${identityName}_${max + 1}`;
}

/**
 * Is this title already the `<identity>_<number>` name we gave the conversation
 * when it was created?
 *
 * Used to protect that name from the "first 30 characters of the opening
 * message" auto-title. A deliberately assigned name outranks a guessed one; a
 * conversation that arrived some other way still gets the guess.
 */
export function isNumberedIdentityTitle(title: string | undefined | null, identityName: string): boolean {
  if (!identityName) return false;
  return new RegExp(`^${escapeForRegExp(identityName)}_\\d+$`).test((title || '').trim());
}

/**
 * The generation number inside a `<identity>_<n>` title, or null when the title
 * isn't one of ours.
 *
 * Reading half of the same convention `nextConversationTitle` writes. Handover
 * restore walks backwards through generations (`_37` → `_36` → `_35` …), and it
 * must agree with the writer about what counts as a numbered title — a
 * hand-picked name has no predecessor to walk back to.
 */
export function numberedIdentityTitleIndex(title: string | undefined | null, identityName: string): number | null {
  if (!identityName) return null;
  const m = new RegExp(`^${escapeForRegExp(identityName)}_(\\d+)$`).exec((title || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The title of the newest `<identity>_<n>` that is NEWER than `currentTitle`,
 * or null when `currentTitle` is already the head of the chain.
 *
 * The third reader of the same convention, after the writer
 * (`nextConversationTitle`) and the backward walk
 * (`numberedIdentityTitleIndex`). It answers one question for the UI: is the
 * conversation on screen a past generation? The band that warns about that is
 * only honest if "past" means exactly what "next" and "walk back" mean, so the
 * three live in one file and share one parser.
 *
 * Returns null — no band — in every case where the answer is not certain:
 *   - `currentTitle` is hand-picked / imported (no number): it is not
 *     generation N of anything, so it has no successor to point at.
 *   - no sibling carries a higher number.
 * Siblings must already be filtered to this identity's folder by the caller;
 * `folderName` IS the identity name for this convention (the same argument
 * `handoverWalk` passes).
 */
export function newerNumberedSibling(
  currentTitle: string | undefined | null,
  identityName: string,
  siblingTitles: (string | undefined | null)[],
): string | null {
  const mine = numberedIdentityTitleIndex(currentTitle, identityName);
  if (mine === null) return null;
  let bestN = mine;
  let best: string | null = null;
  for (const raw of siblingTitles) {
    const n = numberedIdentityTitleIndex(raw, identityName);
    // Strictly greater, so the conversation never reports itself as its own
    // successor when it appears in its own sibling list.
    if (n !== null && n > bestN) { bestN = n; best = (raw || '').trim(); }
  }
  return best;
}

/**
 * Which conversation to open when an identity is picked from the dropdown: the
 * newest GENERATION — the highest `<identity>_<n>` — not the one with the
 * freshest `updatedAt`.
 *
 * `updatedAt` was the old key, and it lies for an active inhabitant. カナ is
 * alive in カナ_10 / カナ_15, so her activity there bumps their `updatedAt`
 * above カナ_26 — even though _26 is the current generation. Selecting カナ
 * jumped to カナ_15. Cairn and 先輩 never showed it because their newest
 * generation also happens to be their most-recently-touched; the bug only
 * surfaces when the latest activity sits in an OLDER-numbered conversation.
 * Generation number is the same convention `newerNumberedSibling` (the past-log
 * band) uses, so "latest" means one thing everywhere.
 *
 * A numbered title always outranks an unnumbered one (a real generation is
 * newer than a loose hand-named chat). Among numbered titles the higher number
 * wins, ties broken by `updatedAt` (import could duplicate a number). When the
 * folder has NO numbered title at all, the most-recently-updated one wins — the
 * only case where `updatedAt` still decides.
 */
export function pickLatestConversation<T extends { title?: string | null; updatedAt?: number | null }>(
  convos: T[],
  identityName: string,
): T | null {
  let best: T | null = null;
  let bestIdx: number | null = null;   // highest generation seen; null = none numbered yet
  let bestUpdated = -Infinity;
  for (const c of convos) {
    const idx = numberedIdentityTitleIndex(c.title, identityName);
    const updated = typeof c.updatedAt === 'number' ? c.updatedAt : 0;
    if (idx !== null) {
      if (bestIdx === null || idx > bestIdx || (idx === bestIdx && updated > bestUpdated)) {
        best = c; bestIdx = idx; bestUpdated = updated;
      }
    } else if (bestIdx === null && updated > bestUpdated) {
      // No numbered title seen yet — fall back to most-recently-updated.
      best = c; bestUpdated = updated;
    }
  }
  return best;
}

/**
 * Rename half of the same convention: if `title` belongs to `oldName`, hand
 * back the same number under `newName`. Anything else comes back untouched —
 * a hand-picked title survives an identity rename unchanged.
 *
 * Accepts hyphen-segmented labels (`<name>_21-1`) as well as plain integers,
 * because `renameFolder` drives FOUR stores through this one predicate — log
 * titles, soul filenames, summaries and changelogs. A split archive
 * (`soulGeneration.ts` explains where those come from) left the narrow shape
 * behind: the files moved with the directory but kept the old stem, so the soul
 * lookup missed and the pane silently re-seeded from `<new>_1`.
 *
 * MEASURED 2026-10-24 over this installation's 490 titles: the wider shape
 * matches 22 that the narrow one did not — 12 of 先輩's split archive, 10 of
 * Аналитик's — and ZERO that it did. Nothing already working is reclassified.
 */
export function retitleForRenamedIdentity(title: string, oldName: string, newName: string): string {
  const m = new RegExp(`^${escapeForRegExp(oldName)}_(\\d+(?:-\\d+)*)$`).exec((title || '').trim());
  return m ? `${newName}_${m[1]}` : title;
}
