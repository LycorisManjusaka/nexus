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
 *  user-chosen and frequently CJK; a stray `(` or `+` must not become syntax. */
function escapeForRegExp(s: string): string {
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
 * Rename half of the same convention: if `title` belongs to `oldName`, hand
 * back the same number under `newName`. Anything else comes back untouched —
 * a hand-picked title survives an identity rename unchanged.
 */
export function retitleForRenamedIdentity(title: string, oldName: string, newName: string): string {
  const m = new RegExp(`^${escapeForRegExp(oldName)}_(\\d+)$`).exec((title || '').trim());
  return m ? `${newName}_${m[1]}` : title;
}
