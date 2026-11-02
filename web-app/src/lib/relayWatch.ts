// ───────────────────────────────────────────────────────────────────────────
// How long a relay watcher waits before deciding the connection is dead, and
// what it does with what it finds once it stops waiting.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Reported 2026-11-02 (Lizard-kun, from a phone on :3000). He started a soul
// update, saw the shikigami begin thinking, closed the tab, and came back
// minutes later to: nothing in the right pane, red text at the top of the
// panel, and — on trying to navigate away — a confirm saying the soul was
// still being updated.
//
// Four symptoms, ONE defect: the watch stream had no way to give up.
//
//   reader.read() never settles  (a phone's socket can die with the browser
//   never reporting an error — half-open TCP after a network change, or a tab
//   frozen across the moment the connection went away)
//     → `running` stays set in the panel, and everything else is downstream:
//         · the silence strip renders red, and ONLY while running  ← his
//           "connection error"-ish red text
//         · the right pane is never painted                        ← "the
//           soul was not written"
//         · the recovery sweep opens with `if (running !== null) return`, so
//           it never attaches to the live run and never collects the finished
//           record
//         · the unload guard is keyed on `running`, so the confirm stays armed
//
// The RUN was never in danger. It is detached (see runSpuAction) and
// checkpointed to disk after every round. What was lost was the way back to
// it — so that is what this module restores.
// ───────────────────────────────────────────────────────────────────────────

import { isFinishedRun, type SpuRunRecord } from '@/lib/spuRun';

/**
 * How often /api/turn-events emits a comment frame on an otherwise silent
 * connection.
 *
 * Exported from here, and imported BY the route, because this period is one
 * half of a two-sided contract: the producer promises a frame this often, and
 * the bound below is the consumer's patience derived from that promise. Two
 * copies would let someone widen the keepalive and leave every watcher
 * declaring healthy connections dead. Same reasoning as spuRelayKey, which
 * both sides also compute from one function.
 */
export const RELAY_KEEPALIVE_MS = 20_000;

/**
 * No BYTES at all for this long ⇒ the connection is gone.
 *
 * Derived, not chosen: the server guarantees a frame every RELAY_KEEPALIVE_MS,
 * so silence longer than that is not a quiet model — it is a dead socket. The
 * factor of 3 means two keepalives in a row went missing, which is the
 * smallest bound that does not fire on one lost packet.
 *
 * NOT the same clock as the panel's silence indicator. That one counts PARSED
 * frames, because what it reports is "the model has said nothing for N
 * seconds" — and a keepalive carries no `data:` field, so sseFrames yields
 * nothing for it and it correctly does not reset that counter. This bound must
 * count keepalives, because its question is the opposite one: is anything at
 * all still arriving.
 */
export const RELAY_IDLE_TIMEOUT_MS = 3 * RELAY_KEEPALIVE_MS;

/** Returned by withIdleBound when the bound expired before the promise settled. */
export const IDLE: unique symbol = Symbol('relay-idle');

/**
 * Resolve with `p`, or with IDLE if it has not settled within `idleMs`.
 *
 * Per-call, and the caller is expected to re-arm it on every chunk — the
 * OPPOSITE of drainStreamToEnd, whose comment warns that a fresh timer per
 * read would let a producer that talks forever never time out. Both are right
 * for their own question: a drain is bounded in total, an idle watchdog is
 * bounded between signs of life. Re-arming here is the whole point, since a
 * healthy run can stream for many minutes.
 *
 * The timer is cleared when `p` wins. Without that a chatty stream leaves one
 * pending timer per chunk for up to the bound — harmless but unbounded, and
 * the kind of thing that makes a later reader distrust the whole mechanism.
 */
export async function withIdleBound<T>(
  p: Promise<T>,
  idleMs: number,
): Promise<T | typeof IDLE> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), idleMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * What the panel should do with the record it finds after its watch stream
 * ended — however it ended.
 *
 * Three of these four branches are a transcription of rules the panel already
 * had inline; the fourth ('running') is the one that was missing and the
 * reason this is now a function with tests.
 */
export type WatchAftermath =
  /** Finished and left something: post-process it, then clear the record. */
  | { kind: 'result'; record: SpuRunRecord }
  /**
   * STILL GOING on the server. This tab merely lost its view.
   *
   * The branch that did not exist. Before it, a watch that ended early —
   * `watch.ok === false`, or the idle bound above — fell through to the
   * `result` path, which DELETED the record of a live run and handed its empty
   * `accum` to the post-processing, which reported "the model returned no
   * text". So a dropped connection destroyed the only durable copy of a run
   * that was still producing, and said something false about it on the way.
   */
  | { kind: 'running'; record: SpuRunRecord }
  /**
   * Died with nothing to show. The record is KEPT (the reason and the attempt
   * count survive on it for whoever looks next) and reported.
   */
  | { kind: 'failed'; reason: string; record: SpuRunRecord }
  /** No record at all — the run never got as far as writing one. */
  | { kind: 'missing' };

export function decideAfterWatch(
  rec: SpuRunRecord | null | undefined,
): WatchAftermath {
  // Nothing was ever written. Reading `.accum` off this is the crash the
  // panel's `if (!record) throw` already guarded; kept here so every caller
  // gets the guard from one place.
  if (!rec) return { kind: 'missing' };

  // FIRST, and the order is the whole fix. `running` means the detached run is
  // still between rounds or inside a provider call; everything below would
  // treat that as an outcome.
  if (rec.status === 'running') return { kind: 'running', record: rec };

  // Exactly isFinishedRun: a stopped run and an errored run that produced text
  // both hold work worth keeping, and only "no text at all" is a failure with
  // nothing to deliver. Reusing the predicate rather than restating it —
  // isCollectableHere and isCollectableBy are built on the same one, and a
  // second spelling here is how two answers to "did this run produce
  // anything" would drift apart.
  //
  // Annotated `boolean` on purpose, the same way the panel's `recoverableHere`
  // is. isFinishedRun is a type predicate (`rec is SpuRunRecord`), which is
  // true and useful in the POSITIVE direction and a lie in the negative one:
  // a record that is not finished is still a record. Called bare, the else
  // branch below narrows `rec` to `never` and cannot read `rec.error` — which
  // is the one field that branch exists to carry.
  const finished: boolean = isFinishedRun(rec);
  if (finished) return { kind: 'result', record: rec };

  // `rec.error` may be empty: a run can finish having printed nothing, with no
  // error to name. The caller keeps its existing empty-text message for that,
  // so the reason is passed through rather than invented here.
  return { kind: 'failed', reason: rec.error || '', record: rec };
}
