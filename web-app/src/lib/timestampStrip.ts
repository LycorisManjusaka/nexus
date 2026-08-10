// Shared helpers for handling the "[YYYY-MM-DD HH:MM:SS]" timestamp tags that
// the dateTimeVisibility feature injects into prompts. Models frequently echo
// them back — sometimes a whole STACK of them — at the very start of a reply.
// We keep them visible in the chat bubble, but we must not read them aloud
// (TTS) and we offer a cleanup pass to strip them from stored logs.
//
// A single timestamp tag looks like: [2026-05-30 00:36:54]  (seconds optional).

// One leading timestamp + its surrounding whitespace, repeated one-or-more
// times, anchored to the start of the string. This collapses a stack like:
//   [2026-05-30 00:36:54]
//   [2026-05-30 00:36:54]
//   Hello there
// down to "Hello there".
//
// The leading whitespace class is `\s*` (not `[ \t]*`) on purpose: some models
// now emit one or more blank lines BEFORE the timestamp stack (e.g.
// "\n[2026-05-31 16:44:20]\n…"). Anchoring with `^[ \t]*` missed those, leaving
// the timestamp both visible in the bubble and audible in TTS. `\s*` only ever
// consumes whitespace that immediately precedes a real timestamp tag, so plain
// text (with or without leading newlines) is never touched.
const LEADING_STACK_RE =
  /^(?:\s*\[\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\][ \t]*\r?\n?)+/;

// A string that is ENTIRELY one-or-more timestamp tags (plus whitespace) and
// nothing else — i.e. there is nothing left to speak / keep.
const ONLY_TIMESTAMPS_RE =
  /^(?:\s*\[\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*)+$/;

/**
 * Remove one or more stacked timestamp tags from the very beginning of `text`.
 * Only strips at the start — timestamps appearing mid-text are left untouched.
 */
export function stripLeadingTimestamps(text: string): string {
  if (!text) return text;
  return text.replace(LEADING_STACK_RE, '');
}

/**
 * True when the (trimmed) string consists solely of timestamp tags, so it
 * should never be queued for TTS.
 */
export function isOnlyTimestamps(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  return ONLY_TIMESTAMPS_RE.test(t);
}

/**
 * Remove EVERY timestamp tag anywhere in the string — leading, trailing, or in
 * the middle — not just a leading stack. Needed because reasoning/agentic models
 * (e.g. Kimi K3) tend to emit a fresh "[YYYY-MM-DD HH:MM:SS]" at the start of
 * each output segment, including the continuation AFTER a tool call, which lands
 * mid-message and slips past `stripLeadingTimestamps`. Over many turns these pile
 * up and bloat the context window.
 *
 * Applied to the assistant's finalized message text (what gets saved to the log
 * and replayed to the model) and to TTS input — NOT to tool-call arguments, so
 * a model can still deliberately write a timestamp into a file it edits.
 *
 * Whole-line timestamps take their line with them; inline tags are removed in
 * place. Leftover blank-line runs and a leading gap are tidied so the text reads
 * naturally.
 */
export function stripAllTimestamps(text: string): string {
  if (!text) return text;
  return text
    // A line that is nothing but a timestamp (optionally indented) → drop the
    // whole line, newline included.
    .replace(/^[ \t]*\[\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\][ \t]*(?:\r?\n|$)/gm, '')
    // Any remaining inline timestamp tag → remove it plus trailing spaces.
    .replace(/\[\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\][ \t]*/g, '')
    // Tidy up: collapse 3+ newlines to a single blank line; trim a leading gap.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '');
}
