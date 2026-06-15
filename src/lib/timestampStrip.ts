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
