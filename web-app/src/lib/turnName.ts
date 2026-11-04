// ── Who gets to NAME a turn ─────────────────────────────────────────────────
//
// A turn's name (`turnId`) is the address Stop uses. `turnStop.ts` is keyed by
// (convoId, turnId) and deliberately has "no wildcard record and no 'stop
// whatever runs next'" — so a press that does not know the name cannot be
// delivered at all. That is not a gap in turnStop; it is the reason it is safe.
//
// ⚠ WHY THIS MODULE EXISTS (MEASURED 2026-11-04).
//
// Tsuyo reported: press Stop immediately after sending and the 5-hour window
// stays at 0% — so nothing was billed — but the screen takes SECONDS to settle,
// where before the server-side runner it settled at once.
//
// I guessed the prelude (load log → slim history → build body) was the wait and
// measured it on this house's largest log: 4,564 KB, 151 messages, **19.6 ms
// total**. Wrong by two orders of magnitude. The actual evidence was in the log
// all along — the stopped turn carried `generationMs: 8949` and the
// stream-level notice ("as far as it got"), NOT the pre-send one I had added
// the day before. So:
//
//   * the press did NOT arrive before the POST — it arrived during the stream;
//   * 0% billed because the abort landed before the model emitted a token,
//     which is luck about timing, not a guarantee;
//   * ~8.9 s is how long it took the press to reach a channel at all.
//
// WHY IT WAS LATE: the tab learns the name from the relay's `X-Turn-Id`, which
// it reads only AFTER two awaits (kick /api/runner/tick, then subscribe).
// `pendingStop.ts` holds the press until then — correct, and still too slow,
// because the runner's prelude is 19.6 ms and the two round-trips are not.
// The fastest press is the one with the furthest to travel.
//
// THE FIX IS NOT A WILDCARD. The tab mints the name BEFORE it sends and hands
// it over, exactly as it already does for the assistant message id
// (`proposedAssistantId`, same route, same reason: whoever has to point at the
// thing first should name it). Then Stop is addressable from the first
// millisecond, and `requestStop`'s existing rendezvous — "both orders work" —
// covers a press that beats the runner's own listener registration.
//
// `pendingStop.ts` STAYS. A proposal can be declined (see below), and then the
// tab's key is wrong until the relay corrects it; that window is precisely what
// pendingStop was written for. Belt and braces, not one replacing the other.

/**
 * The shape both minters produce: `turn_<base36 ms>_<6 chars>`.
 *
 * Validated rather than trusted because this string becomes a Map key in
 * `turnStop` and is echoed to clients in a header. An unbounded client-supplied
 * key is how a map grows without limit; a client-supplied header value is how a
 * response gets split. Neither is reachable through this gate.
 */
export const TURN_ID_RE = /^turn_[a-z0-9]{1,12}_[a-zA-Z0-9]{4,12}$/;

export function isWellFormedTurnId(s: unknown): s is string {
  return typeof s === 'string' && TURN_ID_RE.test(s);
}

/**
 * Mint a name. ONE implementation, usable from both sides of the wire — the
 * tick route minted its own with the comment "same shape ChatArea uses for a
 * turn it POSTs itself", which is a duplicated derivation wearing a note that
 * says so. Now the tab and the route genuinely share it, and `TURN_ID_RE`
 * above is the shape both honour.
 */
export function mintTurnId(): string {
  return `turn_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
}

/** Where the name this turn will answer to came from. */
export type TurnNameSource =
  /** A turn is already live on this conversation; its name wins. */
  | 'live'
  /** The caller proposed a well-formed name and nothing was live. */
  | 'proposed'
  /** No live turn, no usable proposal — minted here. */
  | 'minted';

export interface TurnNameDecision {
  turnId: string;
  source: TurnNameSource;
  /** True when this call is the one that has to open the relay. */
  isNew: boolean;
}

/**
 * Decide the name, in ONE place.
 *
 * `liveTurnId` wins over any proposal and that order is load-bearing: the relay
 * is the single source of a running turn's id, a watching tab has already read
 * it from there, and minting or adopting a second name would leave Stop
 * pointing at a turn that does not exist. (That sentence is the tick route's
 * own comment; this function is where it is now enforced rather than restated.)
 *
 * A malformed proposal is DECLINED, not rejected: the turn starts under a
 * minted name. Refusing to start would turn a cosmetic client bug into a
 * conversation that cannot run — the exact hazard turnRegistry warns about.
 */
export function resolveTurnName(
  liveTurnId: string | null | undefined,
  proposed: unknown,
  mint: () => string,
): TurnNameDecision {
  if (typeof liveTurnId === 'string' && liveTurnId) {
    return { turnId: liveTurnId, source: 'live', isNew: false };
  }
  if (isWellFormedTurnId(proposed)) {
    return { turnId: proposed, source: 'proposed', isNew: true };
  }
  return { turnId: mint(), source: 'minted', isNew: true };
}
