// ── Is a conflicting write on disk one we may safely build on? ──────────────
//
// REPORTED 2026-11-04 (津代): "my message and Cairn's reply both vanished the
// instant he finished writing. The files he changed are still there; the
// messages are not." MEASURED the same night: Cairn_60 was open in TWO
// installations at once (3000 and 3001, one store by junction). Both tabs
// mirror the log from disk and both save it back, so each one bumps
// `updatedAt` while a turn is in flight.
//
// The runner guards its save against the version it read when the turn
// STARTED (runTurnForQueue's `guardVersion`). A long turn — this house has
// measured one at seventy minutes — gives any other tab a wide window to
// write. When it does, fsStorage refuses the runner's save, and the refusal
// is total: the reply is dropped, the batch stays unconsumed, and the screen
// reloads to the state before the message was sent.
//
// The lock is RIGHT and stays. Its comment says why merging is not attempted:
// "nothing here can know whether two divergent message arrays are an append
// or a deletion." That is true of fsStorage, which sees two arrays and no
// history. The RUNNER does know: it is holding the array it last wrote. So
// the question it can answer, and fsStorage cannot, is narrower —
//
//     did the other writer change the conversation, or only re-save it?
//
// Only the second is safe to build on. This module is that one question, kept
// pure so the answer is testable without a store, and kept OUT of
// runTurnForQueue for the reason every rule in this tree is pulled out of its
// caller: a condition inside a function is a condition no test reaches.
// ───────────────────────────────────────────────────────────────────────────

/** Only the fields that decide identity. Everything else is metadata. */
type SpineMessage = {
  id?: unknown;
  role?: unknown;
  content?: unknown;
};

/**
 * The part of a message that another writer may NOT have changed under us.
 *
 * `content` is compared through JSON because it is a string for most messages
 * and an array of blocks for some; one derivation for both beats a `typeof`
 * ladder that would be wrong for exactly one shape.
 */
function spineOf(m: SpineMessage): string {
  return JSON.stringify([m?.id ?? null, m?.role ?? null, m?.content ?? null]);
}

/**
 * Do these two message arrays say the same thing?
 *
 * Compared on id, role and content ONLY — deliberately not on the whole
 * message. A tab that mirrors a turn also writes back `tokens`, `autoPlay`
 * and the rest of the per-message metadata, and refusing to rebase over a
 * changed token count would throw the turn away for a field nobody is reading.
 * Content is the thing a person would notice losing, so content is the thing
 * that blocks the rebase.
 *
 * Length first, so the common "someone appended a message" case costs one
 * comparison and never stringifies anything.
 */
export function sameMessageSpine(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (spineOf(a[i] as SpineMessage) !== spineOf(b[i] as SpineMessage)) return false;
  }
  return true;
}

/** What `planRebase` decided, and why — the reason is for a person to read. */
export type RebasePlan =
  /** Disk is unchanged in substance: save again, guarded against `onto`. */
  | { retry: true; onto: number | undefined }
  /** Do not retry. `why` is reported as the save failure's reason. */
  | { retry: false; why: string };

/**
 * Decide whether a refused save may be repeated against the version now on
 * disk.
 *
 * `mine` is the array THIS turn last put on disk (or the array it loaded, if
 * it has not saved yet) — not the array it is trying to write. That is the
 * whole premise: the runner compares disk against its own last word, so
 * "unchanged" means "the other writer added nothing of mine and removed
 * nothing of mine".
 *
 * Returns the version to guard the retry against rather than a bare boolean,
 * because a retry guarded against the OLD version would be refused again for
 * the same reason, and a retry guarded against NOTHING would be an unguarded
 * write — the lock deleted at exactly the moment it is being tested.
 */
export function planRebase(
  freshLog: Record<string, unknown> | null,
  mine: unknown,
): RebasePlan {
  if (!freshLog) {
    return { retry: false, why: 'the conversation could not be re-read after the refusal' };
  }
  if (!sameMessageSpine(freshLog.messages, mine)) {
    return { retry: false, why: 'the conversation changed on disk while this turn ran' };
  }
  const v = freshLog.updatedAt;
  // A fresh log with no readable version cannot be guarded against, and this
  // is not the place to start writing unguarded. Refusing here costs the turn;
  // writing would cost whatever the other tab just saved.
  if (typeof v !== 'number') {
    return { retry: false, why: 'the conversation on disk carries no version to build on' };
  }
  return { retry: true, onto: v };
}
