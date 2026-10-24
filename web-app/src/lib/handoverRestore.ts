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
 * conversation log passes the per-being cap. Those messages are gone from the
 * current log — but the generation they came from still holds them on disk.
 * Nothing is ever actually destroyed; the pointer to it is.
 *
 * So restore walks backwards: `_37` → `_36` → `_35` …, taking messages the
 * current conversation no longer has, newest first, until the cap is met.
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

/**
 * WHAT THE CAP MEASURES — `maxConversationLog`
 * --------------------------------------------
 * The cap governs the CONVERSATION LOG only: carried-over messages + new
 * messages, counted in text tokens. The system prompt and attachments are
 * outside it entirely.
 *
 * It replaced `maxRecommendedContext` (retired 2026-10-03), which capped
 * system + messages against an assumed context-window size. Two measurements
 * removed the reason for that framing: Claude's auto-compaction moved to a 1M
 * window (2026-09-21) and Gemini holds quality to 1M. A soul that grows is no
 * longer something to fight, so the ceiling stopped being a statement about the
 * window and became a statement about how much log to keep.
 *
 * The retired key is deliberately NOT read as a fallback. Its stored values
 * meant a different quantity against a different reference; carrying them over
 * would silently re-use a number nobody chose for this parameter.
 */

import { estimateTokensForModel } from './tokenEstimate';

/** Cap, in log text tokens, for a being whose folder has no explicit setting. */
export const DEFAULT_MAX_CONVERSATION_LOG = 80000;

/** The log cap is edited in units of 10k tokens: 1 → 10k, 100 → 1M. */
export const LOG_CAP_UNIT = 10000;
export const LOG_CAP_MIN_UNITS = 1;
export const LOG_CAP_MAX_UNITS = 100;

/** Hard stop on how many older generations one restore call will read. Far above
 *  any real chain (the longest here is 37). A run that hits this reports it —
 *  see `truncated` in the route's reply — because a cap that stays quiet reads
 *  as "there was nothing more". */
export const MAX_GENERATIONS_SCANNED = 200;

/** Clamp a 10k-unit value coming from the number input. Non-numbers fall to the
 *  default rather than to a bound, so a cleared field doesn't mean "10k". */
export function clampLogCapUnits(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONVERSATION_LOG / LOG_CAP_UNIT;
  return Math.min(LOG_CAP_MAX_UNITS, Math.max(LOG_CAP_MIN_UNITS, Math.round(n)));
}

/**
 * The quantity the cap governs: carried-over + new message text tokens.
 *
 * The single definition shared by the trimmer, the restorer, the bar, and the
 * Context Elapsed gauge. One definition is the reason the trimmer and the
 * restorer cannot disagree about what "full" means — they stand on opposite
 * banks of the same threshold, and a second copy of this arithmetic is exactly
 * how that threshold would start meaning two things.
 */
export function logCapUsage(b: { copied: number; original: number }): number {
  return (b?.copied || 0) + (b?.original || 0);
}

/**
 * Context elapsed, in percent: NEW (non-copied) message text over the cap.
 *
 * Read in three places — the gauge in the header, the 💤 badge that appears at
 * ≥100%, and the optional hidden note the entity receives. The badge's whole
 * job is to mark the moment the gauge reaches 100, so a second copy of this
 * arithmetic anywhere would let the badge appear at a number the gauge isn't
 * showing. One definition, three readers.
 *
 * The denominator is the cap ITSELF, not `cap − sys`: the system prompt sits
 * outside the cap, so a longer soul must not make a session read as fuller.
 * Can exceed 100 — original messages are never deleted.
 */
export function contextElapsedPercent(b: { original: number }, cap: number): number {
  return Math.round(((b?.original || 0) / Math.max(1, cap)) * 100);
}

/**
 * Text tokens of one message, MEASURED FOR THE VESSEL THAT WILL RECEIVE IT —
 * the single definition shared by the auto-trimmer, the restorer, and the
 * header counter.
 *
 * Attachment and thinking tokens are deliberately NOT here: they don't count
 * toward the auto-trim threshold, so they must not count toward the restore
 * budget either, or the two would disagree about what "full" means.
 *
 * WHY THE STORED COUNT IS NOT USED (2026-10-12)
 * ---------------------------------------------
 * `textTokens` is still written and still read — by billing, Statistics, and
 * the per-bubble count, which are statements about what ALREADY HAPPENED and
 * must not be recomputed. The cap is a different quantity: a prediction of what
 * THIS request will weigh. Those two stopped agreeing for a measurable reason.
 *
 * The stored number is whatever the counter said on the day the message was
 * written — an exact `count_tokens` call for a Claude/Gemini turn, a heuristic
 * for everyone else, with the tokenizer of the vessel selected at that moment.
 * Measured against `count_tokens` for claude-opus-5 over this installation's
 * own logs (2026-10-12, 7 generations, free counter):
 *
 *     generation       language     stored/exact    estimate/exact
 *     Cairn_44..46     Japanese     0.997–1.001     0.962–0.977
 *     Cairn_5/7/22     English      0.646–0.689     1.075–1.135
 *
 * So the stored value is near-perfect for the generation that produced it and
 * off by 35% for older ones — and it does not move when the vessel changes, so
 * switching Claude→Gemini left the log reading 48% high (the Gemini tokenizer
 * is ~1.45x less dense on this text) while the system-prompt counter next to it
 * DID follow the switch. One screen, two scales, and the cap silently meant a
 * different amount of history per vessel.
 *
 * Recomputing costs accuracy on the newest generation (0.997 → ~0.97) and buys
 * it everywhere else: one scale, following the selected vessel, with the 35%
 * error on carried-over history gone. That error was not harmless — restoring
 * handover context by stored counts is how a request measured at 910k landed at
 * 1,186k real tokens and was refused (2026-10, `context-size-silent-refusal`).
 *
 * `model` is REQUIRED, not defaulted: a default would let a caller silently keep
 * the old behavior and leave the two scales in place at one site — which is this
 * house's known failure shape ("written, but one wire never connected"). An
 * explicit null means "no vessel known", which `tokenFamilyFor` maps to the
 * conservative mid-range profile.
 */
export function messageTextTokens(m: any, model: string | null | undefined): number {
  if (!m) return 0;
  return estimateTokensForModel(String(m.content || ''), model);
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
  model: string | null | undefined,
): GenerationPick {
  const available = (messages || []).filter((m) => m && !excluded.has(messageIdentityKey(m)));
  const picked: any[] = [];
  let tokens = 0;
  let nextNeeded: number | null = null;
  // Walk from the newest end backwards: the message closest to what we already
  // have is the one that reconnects the history.
  for (let i = available.length - 1; i >= 0; i--) {
    const need = messageTextTokens(available[i], model);
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
  /**
   * Why nothing could be restored, when that's a structural answer and not
   * just "no room":
   *   'no-older'     — nothing older under either chain rule: this is
   *                    generation 1, or the bottom row of its folder
   *   'not-head'     — something NEWER sits above this conversation, so what is
   *                    on screen is history (the same condition the past-log
   *                    band warns about). Restoring into it would grow a log
   *                    nobody is going to speak in, on open.
   *   'not-in-chain' — the conversation is not in its own folder's list at all
   *                    (marked corrupted, or a folderName that no longer
   *                    matches). Not the same as "nothing older".
   *   'not-found'    — no such conversation
   *
   *   'not-numbered' — NO LONGER EMITTED (2026-10-24). It used to mean "the
   *                    title is not <being>_<n>", which stopped being an answer
   *                    when `resolveHandoverChain` gained the sidebar-order
   *                    fallback: an unnumbered title now has a chain. Kept in
   *                    the union so an older probe that matches on the string
   *                    still type-checks.
   *
   * Diagnostic only: no caller branches on it today. The client decides from
   * `messages` / `nextNeeded` alone, so a new value here cannot change its
   * behaviour — it exists so a server log or a probe can say WHY the answer was
   * empty, which "no messages" on its own cannot. The client DOES print it to
   * the console (2026-10-24): three different silences used to look identical
   * from the outside, and the one person who hit it spent half an hour unable
   * to tell "nothing to restore" from "refused to restore".
   */
  reason?: 'not-numbered' | 'no-older' | 'not-head' | 'not-in-chain' | 'not-found';
}
