/**
 * Handover restore — putting back the carried-over messages auto-trim removed.
 *
 * WHAT GETS LOST, AND WHERE IT STILL IS
 * -------------------------------------
 * "Next conversation" (Soul Updater) clones the whole log: `<name>_<N+1>` opens
 * with every message of `<name>_<N>` already in it, carrying the same message
 * ids. Everything before the `first-original` marker is handover context.
 *
 * Auto-trim (ChatArea) then deletes handover messages from the TOP whenever the
 * text context passes the per-being ceiling. Those messages are gone from the
 * current log — but the generation they came from still holds them on disk.
 * Nothing is ever actually destroyed; the pointer to it is.
 *
 * So restore walks backwards: `_37` → `_36` → `_35` …, taking messages the
 * current conversation no longer has, newest first, until the ceiling is met.
 *
 * WHY IDS AND NOT TIMESTAMPS
 * --------------------------
 * Measured 2026-10-02 across every log in this installation: 19,900 messages,
 * 0 without an id, 10,798 without a timestamp (NEXUS stopped inventing clock
 * values for imported messages — a missing time is written as a missing key,
 * not a guess). Ids survive cloning unchanged, so they identify a message
 * across generations exactly. Timestamps cannot: a third of them don't exist.
 * `messageIdentityKey` falls back to a timestamp+role+prefix composite only for
 * messages that have no id at all, which in this corpus is none of them.
 *
 * WHY A CONTIGUOUS TAIL, NEVER A CHERRY-PICK
 * ------------------------------------------
 * When the next message doesn't fit, we stop — we do NOT skip it to reach
 * smaller ones further back. Auto-trim deletes a contiguous run from the top;
 * restore puts back a contiguous run at the top. Picking around a large message
 * would open a hole in the middle of a conversation, and the reader (model or
 * person) has no way to see that a hole is there.
 */

/** Ceiling, in text tokens, for a being whose folder has no explicit setting. */
export const DEFAULT_MAX_RECOMMENDED_CONTEXT = 100000;

/** The context ceiling is edited in units of 10k tokens: 1 → 10k, 100 → 1M. */
export const CONTEXT_UNIT = 10000;
export const CONTEXT_MIN_UNITS = 1;
export const CONTEXT_MAX_UNITS = 100;

/** Hard stop on how many older generations one restore call will read. Far above
 *  any real chain (the longest here is 37). A run that hits this reports it —
 *  see `truncated` in the route's reply — because a cap that stays quiet reads
 *  as "there was nothing more". */
export const MAX_GENERATIONS_SCANNED = 200;

/** Clamp a 10k-unit value coming from the number input. Non-numbers fall to the
 *  default rather than to a bound, so a cleared field doesn't mean "10k". */
export function clampContextUnits(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_RECOMMENDED_CONTEXT / CONTEXT_UNIT;
  return Math.min(CONTEXT_MAX_UNITS, Math.max(CONTEXT_MIN_UNITS, Math.round(n)));
}

/**
 * Text tokens of one message — the single definition shared by the auto-trimmer,
 * the restorer, and the header counter.
 *
 * `textTokens` is the stored per-message count; `tokens` is the older field that
 * meant the same thing before attachments were split out. Attachment and
 * thinking tokens are deliberately NOT here: they don't count toward the
 * auto-trim threshold, so they must not count toward the restore budget either,
 * or the two would disagree about what "full" means.
 */
export function messageTextTokens(m: any): number {
  if (!m) return 0;
  return m.textTokens !== undefined ? (m.textTokens || 0) : (m.tokens || 0);
}

/**
 * A key that identifies the same message across generations.
 *
 * Prefixed by kind so an id can never collide with a composite: a message whose
 * id happens to be "1790297034998" and one whose timestamp is that number are
 * different messages, and `i:` vs `t:` keeps them apart.
 */
export function messageIdentityKey(m: any): string {
  const id = m?.id;
  if (id !== undefined && id !== null && id !== '') return `i:${String(id)}`;
  const body = typeof m?.content === 'string' ? m.content.slice(0, 64) : '';
  return `t:${m?.timestamp ?? ''}:${m?.role ?? ''}:${body}`;
}

export interface GenerationPick {
  /** Messages to restore, in their original order (oldest first). */
  picked: any[];
  /** Text tokens the picked messages add. */
  tokens: number;
  /**
   * Tokens the NEXT message back would have needed, when the budget stopped us.
   * null means this generation was consumed completely (nothing was left out).
   *
   * The caller remembers this so it can stop asking: with a budget below
   * `nextNeeded`, a repeat call is guaranteed to restore nothing. Without it, an
   * effect that runs "whenever there is room" would re-scan every generation on
   * every render for the rest of the conversation's life.
   */
  nextNeeded: number | null;
}

/**
 * Take as much of one older generation's tail as `budget` allows.
 *
 * `excluded` holds the identity keys the caller already has (the current
 * conversation's messages, plus everything picked from newer generations).
 * Messages still present in the current conversation are therefore skipped
 * rather than duplicated — which is also why a generation can yield nothing at
 * all: `_36` is a full clone of what `_37` still holds.
 */
export function pickFromGeneration(
  messages: any[],
  excluded: Set<string>,
  budget: number,
): GenerationPick {
  const available = (messages || []).filter((m) => m && !excluded.has(messageIdentityKey(m)));
  const picked: any[] = [];
  let tokens = 0;
  let nextNeeded: number | null = null;
  // Walk from the newest end backwards: the message closest to what we already
  // have is the one that reconnects the history.
  for (let i = available.length - 1; i >= 0; i--) {
    const need = messageTextTokens(available[i]);
    if (tokens + need > budget) {
      nextNeeded = need;
      break;
    }
    tokens += need;
    picked.unshift(available[i]);
  }
  return { picked, tokens, nextNeeded };
}

export interface RestorePlanReply {
  /** Messages to prepend, oldest first across all generations. */
  messages: any[];
  /** Text tokens the restored messages add. */
  tokens: number;
  /** Per-generation breakdown, oldest generation first. */
  generations: { title: string; count: number; tokens: number }[];
  /**
   * Budget needed to restore the next message, or null when every older
   * generation has been read to the end and nothing remains.
   */
  nextNeeded: number | null;
  /** True when MAX_GENERATIONS_SCANNED stopped the walk early. */
  truncated: boolean;
  /** Why nothing could be restored, when that's a structural answer and not
   *  just "no room": 'not-numbered' (hand-picked title has no predecessor),
   *  'no-older' (this is generation 1), 'not-found'. */
  reason?: 'not-numbered' | 'no-older' | 'not-found';
}
