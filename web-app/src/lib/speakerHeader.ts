// Which name `exportToMarkdown` may put in a "[Name]:" header line.
//
// THE HEADER IS NOT A LABEL — IT IS A BOUNDARY. `parseMarkdown` starts a new
// message at "[X]:" only when X is a RECOGNISED speaker (the folder's entity,
// "Anonymous"/"User", or a character_map name). An unrecognised header is not
// a weaker header; it is not a header at all. The line stays body text and the
// turn silently merges into the one above it.
//
// `speakerNameOf` reads the FIRST bracketed span of a user message as its
// speaker, and it does not — cannot — check that against a roster. So a message
// whose body happens to open with a bracket ("[Summary]", "[How I see it]",
// "[RULE: …]") handed its first line to the header, and the export became a
// file that cannot be read back.
//
// MEASURED 2026-11-04, this house's real logs, whole conversations exported
// and re-imported with the same roster the app uses (character_map + the
// folder's entity + Anonymous/User):
//
//   287 conversations carry a bracketed user body
//   CURRENT  162/287 round-trip exactly (56.4%)
//   FIXED    278/287 round-trip exactly (96.9%)
//
// Of the 125 conversations that failed, 122 failed for this one reason. 851
// DISTINCT unrecognised header names were written across the house.
//
// WHY NOT WIDEN THE ROSTER INSTEAD. Adding every being folder (先輩, 謡, カナ,
// ツムギ …) was measured and is WORSE — 225/287 (78.4%). Those names are real
// speakers, but widening the roster also widens what counts as a boundary on
// the READ side, so a "[先輩]:" line sitting inside a message body becomes a
// real boundary and the turn splits. Headers gained; bodies lost more.
//
// The cost of the fallback is honest and small: the header stops naming the
// speaker in ~2000 messages, while the body — written verbatim — still carries
// "[先輩]" on its first line. The index gets vaguer; the text loses nothing.

import { readSpeakerTag, writeSpeakerTag, ANONYMOUS_SPEAKER } from './speakerTag';

/** Fold full-width digits, trim, lowercase — same rule as `parseMarkdown`. */
function normName(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .trim()
    .toLowerCase();
}

/**
 * Is `header` a name `parseMarkdown` will accept as a message boundary?
 * Mirrors its `isRecognizedHeader`: every comma/、-separated part must be known.
 */
export function isRecognisedHeader(header: string, roster: string[]): boolean {
  const valid = new Set(roster.filter(Boolean).map(normName));
  const parts = header.split(/[,、]/).map(normName).filter(Boolean);
  return parts.length > 0 && parts.every((p) => valid.has(p));
}

/**
 * Will the reader put this header back into the body as a "[Name]" tag?
 *
 * THE ONE PREDICATE BOTH SIDES ASK. The writer drops the body's leading tag
 * only when the reader is going to re-inject it, and the reader re-injects only
 * what the writer would have dropped. Written once so they cannot disagree:
 * if these two conditions were spelled out separately, one of them gaining a
 * clause would turn export → import into a silent delete or a silent double.
 *
 * Two headers are excluded, and both exclusions already existed in
 * `parseMarkdown`:
 *
 *   "Anonymous" / "User" — a roster statement, not a name somebody typed. The
 *     app never writes those tags into a body, so re-injecting one would invent
 *     a speaker that the original message did not name.
 *   a comma/、-joined header — the old multi-speaker shape. Nothing writes it
 *     any more, but .md files on disk carry it, and there is no single tag to
 *     give back.
 */
export function headerIsReinjected(header: string): boolean {
  const h = (header || '').trim();
  if (!h) return false;
  if (h === 'User' || h === ANONYMOUS_SPEAKER) return false;
  return !h.includes(',') && !h.includes('、');
}

/**
 * Give a body back the speaker tag its "[Name]:" header carries — what the .md
 * reader does, as one function, so the writer can ask the same question.
 *
 * THE SKIP CLAUSE IS LOAD-BEARING AND IT IS NOT AN OPTIMISATION. A body that
 * already opens with this very tag must be left alone, because three different
 * files legitimately contain one:
 *
 *   - a .md exported in the verbatim window (2026-11-04 → 11-06), where the
 *     writer lifted the name into the header and left the body untouched
 *   - a hand-written file where somebody typed the name under the header
 *   - a message whose tag could not be dropped exactly (see exportToMarkdown)
 *
 * MEASURED 2026-11-06: with the clause, 265 of 288 verbatim-window exports
 * round-trip; without it, all 265 come back with the name twice. The clause
 * costs the message that genuinely said its name twice — 19 of 9,858 named user
 * messages, 0.19% — and `exportToMarkdown` buys even those back by refusing to
 * strip when this function would not restore the text exactly.
 */
export function restoreSpeakerTag(body: string, header: string): string {
  const h = (header || '').trim();
  if (!headerIsReinjected(h)) return body;
  if (readSpeakerTag(body).name === h) return body;
  return writeSpeakerTag(body, h);
}

/**
 * The header name to write for a USER message.
 *
 * `roster` undefined means "no roster available" and keeps the old behaviour
 * (write whatever tag the body carries). That is deliberately NOT the same as
 * an empty array, which means "roster known, and it is empty" — then every
 * header falls back to Anonymous, which is the correct read of that state.
 */
export function exportHeaderName(content: string, roster?: string[]): string {
  const tag = readSpeakerTag(content || '').name;
  if (!tag) return ANONYMOUS_SPEAKER;
  if (!roster) return tag;
  return isRecognisedHeader(tag, roster) ? tag : ANONYMOUS_SPEAKER;
}
