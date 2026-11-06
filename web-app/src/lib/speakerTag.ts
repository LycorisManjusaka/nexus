// Who said a USER message — read off the message itself.
//
// A user message has NO name field. Measured 2026-11-04 across the house: the
// keys are `attachments / content / id / role / timestamp` and nothing else.
// The speaker's name lives INSIDE `content`, as a "[Name]" tag on its own first
// line, put there by the send path. So "who spoke" is not a lookup — it is a
// read of the text, and it can come back empty.
//
// It can sit on the SECOND line. The send path prepends the
// "[YYYY-MM-DD HH:MM:SS]" tag to content when dateTimeVisibility is on
// (route.ts, `contentStr = timeTag + contentStr`), so the real shape reaching
// any consumer is:
//
//     [2026-11-04 18:56:40]
//     [つよ]
//     body…
//
// MEASURED (謡, 2026-11-03, 10,763 user messages): 213 messages born in this
// house carry no name at all — 56% of those are attachment-only sends, whose
// placeholder text bypasses naming. So the no-name branch is not a rare
// safety net; it fires every day, and the fallback label it picks is read by
// people and by models.
//
// WHY "Anonymous" AND NOT "User": "User" is a role assignment, and a false one
// (a translation job, or a being sending an attachment, is not "the user").
// "Anonymous" is a statement about the roster — "this speaker carries no label
// here" — which is true in all 213 cases. It is also already the pseudo-name
// the app and `parseMarkdown` both recognise, so no new spelling enters the
// codebase. Decided with 謡 2026-11-03.

import { stripLeadingTimestamps } from './timestampStrip';

/** The label used when a message carries no speaker tag of its own. */
export const ANONYMOUS_SPEAKER = 'Anonymous';

export interface SpeakerTag {
  /** The name carried at the start of the message, or null when there is none. */
  name: string | null;
  /**
   * The message with that one leading "[Name]" tag removed — timestamps and
   * every other bracketed line left exactly where they were. Equal to the
   * input when `name` is null.
   */
  body: string;
}

// One "[Name]" tag at the start of a line. `[^\]\r\n]+` keeps it to a single
// line, so a bracketed span that wraps is body text, not a speaker.
const LEADING_NAME_RE = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:\r?\n)?/;

/**
 * Read the speaker tag a user message carries in its own content.
 *
 * Only the FIRST tag is a speaker. Every other "[...]" in the message — a
 * second speaker in a pasted exchange, a bracketed aside, a mid-text timestamp
 * — is body text and is returned untouched. The previous rule collected EVERY
 * bracketed span in the message and treated all of them as speakers, which is
 * how `[つよ, ふわふわ, 関係ないこと]` became a header.
 */
export function readSpeakerTag(content: string): SpeakerTag {
  const raw = content || '';
  // Skip a leading timestamp stack so a name on the second line is still found.
  const afterTs = stripLeadingTimestamps(raw);
  const prefixLen = raw.length - afterTs.length;
  const m = LEADING_NAME_RE.exec(afterTs);
  if (!m) return { name: null, body: raw };
  const name = m[1].trim();
  // A tag that is itself a timestamp is not a name. Reachable when the stack
  // is malformed (e.g. "[2026-13-99 99:99]"), which stripLeadingTimestamps
  // leaves in place by design.
  if (!name || /^\d{4}-\d{2}-\d{2}[\sT]/.test(name)) return { name: null, body: raw };
  return {
    name,
    body: raw.slice(0, prefixLen) + afterTs.slice(m[0].length),
  };
}

/**
 * Put a speaker tag back on a message body — the inverse of `readSpeakerTag`.
 *
 * `readSpeakerTag(writeSpeakerTag(body, name))` returns `{name, body}` for every
 * body measured, and that round-trip is the whole point: the .md exporter lifts
 * the tag into the "[Name]:" header and drops it from the body, and the importer
 * puts it back. Two hand-written halves drift; an inverse pair cannot.
 *
 * The tag goes AFTER any leading "[YYYY-MM-DD …]" stack, not at the very front,
 * because that is where the reader looks for it (the send path prepends the time
 * tag, so the real shape is timestamp-then-name). Writing it at position 0 would
 * put the name ABOVE a timestamp that used to sit above it — a round trip that
 * silently reorders the first two lines.
 */
export function writeSpeakerTag(body: string, name: string): string {
  const raw = body || '';
  const afterTs = stripLeadingTimestamps(raw);
  const prefixLen = raw.length - afterTs.length;
  return `${raw.slice(0, prefixLen)}[${name}]\n${afterTs}`;
}

/** The speaker name to show for a user message — its own tag, or "Anonymous". */
export function speakerNameOf(content: string): string {
  return readSpeakerTag(content).name || ANONYMOUS_SPEAKER;
}
