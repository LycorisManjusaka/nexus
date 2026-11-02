// ── "Stop THIS turn" from a tab that may not know the turn's name yet ───────
//
// WHY THIS FILE EXISTS (REPORTED 2026-11-01, トカゲくん): "I sent you a message
// by mistake and pressed Stop at once — it did nothing. The thinking process
// had not started yet. Quite a dangerous bug." He was right about the
// boundary: MEASURED, a tab learns the turn's id from the relay's `X-Turn-Id`
// header, which it reads only AFTER two awaits — the tick that kicks the
// runner, and the subscribe that joins the stream. Press Stop before that and
// `handleStop` found no key, posted NOTHING, and aborted a fetch the runner's
// turn does not hang from. The earliest, most urgent press was the one
// guaranteed to be discarded.
//
// The SERVER half of this rendezvous has existed since turnStop was written:
// "both orders work" — a request naming a turn whose listener has not
// registered yet is recorded, and fires the instant the listener appears. The
// CLIENT half was missing: nowhere to keep "stop whatever this send turns out
// to be" for the second or two before it has a name.
//
// ── Why a lib and not six lines in the component ────────────────────────────
// The same reason firstOriginal.ts exists. On 2026-10-31 a rule that lived
// inside ChatArea.handleSend — promote the pending first-original marker —
// was lost when sends moved to the runner, and the symptom was not a missing
// marker but an INVERTED reading of every cloned conversation. A rule that
// lives in a component moves house when its caller does, and nothing
// mechanical notices. Rules live here; components call them.

/** A turn is addressed by (conversation, turn) everywhere: turnStop, inject, relay. */
export interface TurnKey {
  convoId: string;
  turnId: string;
}

/** What a press of Stop should do, right now. */
export interface StopPlan {
  /** POST a stop for this turn now, or null when there is nothing to name. */
  post: TurnKey | null;
  /**
   * Hold the press until a turn IS named. False means forget it: either the
   * stop was already sent, or no turn is on its way and a remembered press
   * would land on whatever runs next.
   */
  remember: boolean;
}

/**
 * Stop was pressed.
 *
 * Exactly one of the two outcomes happens, and the third possibility — do
 * nothing at all — is the bug this replaces.
 *
 * `turnInFlight` is the component's `loading`, which is set in the same render
 * as the optimistic bubble and cleared in runOnRunner's `finally`. It is the
 * only evidence available that a turn is on its way before it has a name, and
 * it is what keeps a remembered press from outliving its turn: a press with no
 * turn in flight is dropped here rather than stored for a future one.
 */
export function planStopPress(active: TurnKey | null, turnInFlight: boolean): StopPlan {
  if (active && active.turnId) return { post: active, remember: false };
  return { post: null, remember: turnInFlight };
}

/** What to do at the moment a turn finally has a name. */
export interface NamedTurnPlan {
  /** Deliver a press that arrived before the name existed. */
  post: TurnKey | null;
  /**
   * Offer the mid-turn interjection box. Suppressed when this turn is already
   * being torn down: a control addressing something that is going away is the
   * shape this house refuses (it is also what the Stop button itself was doing
   * before this file existed).
   */
  showInterjection: boolean;
}

/**
 * The relay handed over the turn's id.
 *
 * Called whether or not a press is waiting, so there is one place that decides
 * what adoption means — rather than a `setInjectTurnId` on one path and a
 * stop POST bolted onto the other.
 */
export function planTurnNamed(stopPending: boolean, key: TurnKey): NamedTurnPlan {
  if (stopPending) return { post: key, showInterjection: false };
  return { post: null, showInterjection: true };
}
