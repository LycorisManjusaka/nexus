// ───────────────────────────────────────────────────────────────────────────
// The SPU continuation loop, as a module.
//
// WHY THIS EXISTS. Until 2026-10-31 this loop lived in SystemPromptUpdater.tsx
// FOUR TIMES — update, redistribute, index and genesis each had a byte-identical
// copy of it (measured: the only differences were the status string and what
// happened afterwards). It also only ever ran in the browser, which is the
// expensive half of the problem: a soul update is minutes long across up to
// seven provider calls, and closing the tab killed it. Nothing was saved, so a
// closed tab meant starting the whole run again.
//
// So the loop moved out of the component and the four copies became one. The
// caller supplies HOW to make one streaming call (`streamOnce`); this module
// owns WHEN to make the next one and WHEN to stop. Both the panel and the
// server-side runner inject their own `streamOnce` into the same loop, so there
// is exactly one answer to "when does an SPU run end".
//
// NOT a prefill. A continuation round is three turns (request / what the model
// produced so far / "carry on"), never a request ending on the assistant turn.
// See buildContinuationUserMsg in spuScaffold.ts for the per-vessel measurement
// table behind that.
// ───────────────────────────────────────────────────────────────────────────

import { buildSpuTurns, END_SENTINEL, type ScaffoldLang } from '@/lib/spuScaffold';

/**
 * Why a run stopped. The panel's truncation guard turns on `sawSentinel`, but
 * the REASON is what a human reading a stalled run needs: 'cap' and 'sentinel'
 * are both "the loop returned", and only one of them means the document is
 * whole. Reporting a capped run as done is exactly how soul/Cairn_49.md got
 * written cut off (2026-10-22).
 */
export type SpuEndReason = 'sentinel' | 'empty' | 'aborted' | 'cap';

export const SPU_MAX_CONTINUATIONS = 6;

export interface SpuRunArgs {
  /** The fully assembled user message (spuScaffold's build*UserMsg output). */
  userMsg: string;
  lang: ScaffoldLang;
  /**
   * Salvaged text from a previous truncated run, ALREADY embedded in `userMsg`
   * by the scaffold builder. Passed separately only because the accumulator
   * must be seeded with it: without the seed the loop returns just the
   * continuation and the saved result silently loses everything the earlier
   * run had produced.
   */
  resumeText: string;
  maxContinuations?: number;
}

export interface SpuRunDeps {
  /**
   * One streaming provider call. Returns the visible text of THAT call only
   * (not the accumulation) — the loop does the accumulating. Throwing
   * propagates: a provider error is not a stopping condition the loop gets to
   * decide about.
   */
  streamOnce: (messages: ReturnType<typeof buildSpuTurns>, attempt: number) => Promise<string>;
  /**
   * Called after each completed round with everything accumulated so far.
   * This is what makes a run survive something louder than a closed tab (a
   * server restart, a crash): without it the only durable copy appears when
   * the whole loop returns, so a run interrupted on round 5 of 7 leaves
   * nothing at all. Errors here are the caller's problem, not the loop's — a
   * failed checkpoint must not abandon a generation that is going fine.
   */
  onCheckpoint?: (accum: string, attempt: number) => Promise<void> | void;
  /**
   * Checked BEFORE each round, never during one. Stop therefore takes effect
   * at the next round boundary at the latest; aborting the in-flight call is
   * the caller's job (it owns the signal it handed to `streamOnce`). Checking
   * after the call instead would let a Stop pressed during round 1 still spend
   * round 2.
   */
  isAborted?: () => boolean;
}

export interface SpuRunOutcome {
  /** resumeText seed + every round's text, raw (sentinel not stripped). */
  accum: string;
  sawSentinel: boolean;
  /** How many times `streamOnce` was actually called. 0 is possible. */
  attempts: number;
  endedBecause: SpuEndReason;
}

/**
 * The durable record of one SPU run, as it lives on disk.
 *
 * `status: 'running'` is written BEFORE the first provider call, so a record
 * that says running with an old `updatedAt` is a crashed run rather than an
 * absent one — those two look identical if the record only appears at the end.
 *
 * `convoId` and `label` are provenance, not decoration. A finished record is
 * offered to whoever opens the panel next, and the panel may by then be
 * pointed at a different conversation or a different generation; without them
 * a run's output could be applied to something it was never written for.
 */
export interface SpuRunRecord {
  runId: string;
  /** Generation label this run writes toward (soulGeneration.ts form). */
  label: string;
  /** Which action produced it — 'update' | 'reorganize' | 'redistribute' | … */
  action: string;
  /** The conversation whose log fed the run ('' for the no-conversation modes). */
  convoId: string;
  startedAt: number;
  updatedAt: number;
  status: 'running' | 'done' | 'stopped' | 'error';
  /** Raw accumulation, sentinel NOT stripped (the panel strips and splits). */
  accum: string;
  sawSentinel: boolean;
  attempts: number;
  endedBecause?: SpuEndReason;
  error?: string;
  vessel: { aiName: string; specificModel: string };
  /**
   * Which installation ran it. :3000 and :3001 are separate installations
   * sharing ONE local_data, and their relays are per-process — so each can
   * see a record that says `running` without being able to see whether the
   * process behind it is alive. The name is what lets the refusal say WHO,
   * instead of offering a bare "a run is already in progress".
   */
  host: string;
}

/**
 * The relay key an SPU run streams under.
 *
 * turnBus keys by an opaque string — it is a Map key with no semantics — so an
 * SPU run reuses the whole existing relay (/api/turn-events, the subscriber
 * loop, replay-then-live, the keepalive) without one new line of plumbing.
 * The `spu:` prefix is what keeps it from ever colliding with a conversation
 * id, which is a uuid.
 *
 * One source because BOTH sides compute it: the panel subscribes with it and
 * the route publishes with it. Two derivations of this string would give a
 * watcher that connects successfully and then waits forever.
 */
export function spuRelayKey(folder: string, label: string): string {
  return `spu:${folder}:${label}`;
}

/**
 * A run that is over and left something behind.
 *
 * `status !== 'running'` rather than `status === 'done'`, deliberately: a
 * stopped run and a run that errored after producing text both hold work the
 * panel knows how to keep -- it marks a partial rather than dropping it --
 * and narrowing to `done` here would discard exactly the text the stop branch
 * exists to preserve.
 *
 * The `accum` check separates "finished" from "finished with nothing": an
 * empty result handed to the panel would overwrite the right pane with
 * nothing, which looks identical to the failure this path was built to
 * remove.
 */
export function isFinishedRun(rec: SpuRunRecord | null | undefined): rec is SpuRunRecord {
  return !!rec && rec.status !== 'running' && !!rec.accum;
}

/**
 * Whether the panel in front of you may apply that run at all.
 *
 * `convoId` is carried on the record as provenance, and this is the check it
 * exists for: by the time someone comes back, the panel may be pointed at a
 * different conversation, and a soul written from one conversation must not
 * be applied to another.
 *
 * The action is NOT checked here. The banner collects a record through the
 * handler that produced it, so the record names its own action -- comparing
 * that field to itself would be a test that cannot fail.
 */
export function isCollectableHere(
  rec: SpuRunRecord | null | undefined,
  convoId: string,
): rec is SpuRunRecord {
  return isFinishedRun(rec) && rec.convoId === convoId;
}

/**
 * Whether a run ABOUT TO START should hand back a stored record instead.
 *
 * The extra condition over isCollectableHere is the action, and it is what
 * keeps a genesis document from being pushed through the indexer's
 * post-processing -- which would write it to disk as a real generation.
 */
export function isCollectableBy(
  rec: SpuRunRecord | null | undefined,
  action: string,
  convoId: string,
): rec is SpuRunRecord {
  return isCollectableHere(rec, convoId) && rec.action === action;
}

/**
 * Identity of a record for "have I already handed this one over".
 *
 * `label` alone is not enough: the same generation gets run more than once
 * (a first attempt that came back wrong, then a second), and a label-only key
 * would suppress the second run's result as a duplicate of the first.
 */
export function spuRecordKey(rec: SpuRunRecord): string {
  return `${rec.label}@${rec.startedAt}`;
}

export type SpuRecordDisposition =
  | { kind: 'none' }
  | { kind: 'show' }
  | { kind: 'collect'; key: string }
  /**
   * A run still going on this server, which this panel has lost its stream to.
   *
   * ADDED 2026-10-31 for 1.3. Distinct from 'collect' because the work is the
   * opposite shape: 'collect' reads a finished document off disk, 'attach'
   * rejoins a live relay and waits. Distinct from 'none' because doing nothing
   * is what leaves a run finishing invisibly behind a dead stream — the exact
   * failure the server-side move was supposed to end.
   */
  | { kind: 'attach'; key: string };

/**
 * What a panel should do with the record it just found on disk.
 *
 * Extracted from the effect that calls it so the branches can be tested: the
 * failure modes here are a half-written document delivered as a result, one
 * conversation's output applied to another, and an unbounded re-entry loop --
 * none of which announce themselves.
 *
 * @param seen keys already handed to a handler (see spuRecordKey)
 * @param hasHandler whether THIS build can apply that action
 */
export function decideRunRecord(
  rec: SpuRunRecord | null | undefined,
  convoId: string,
  seen: ReadonlySet<string>,
  hasHandler: (action: string) => boolean,
  /**
   * Does THIS server still hold a live relay for this run?
   *
   * From `/api/spu-run`'s GET, which reports `liveTurnStatus(relayKey)`.
   * In-memory and per process, which is the correct semantics rather than a
   * limitation: 3000 and 3001 are separate installs, and a panel must only
   * rejoin a stream the server it is talking to can actually serve.
   */
  relayLive: boolean,
): SpuRecordDisposition {
  // ── still running ────────────────────────────────────────────────────────
  // CORRECTED 2026-10-31: the comment here read "covers both 'no record' and
  // 'still running'", and treating those two the same is what made 1.3 a
  // task. A run still live on THIS server with no reader is a result being
  // produced into nothing; rejoining its relay costs one fetch and is the
  // only way the text reaches the person who asked for it.
  //
  // `relayLive` and not the record's own status: the record says "running"
  // for a run whose process died too (nothing rewrites it from outside), and
  // attaching to a relay that is not there would hang on a stream that never
  // speaks. The POST path already reports that case as a stuck run with a
  // discard button, so returning 'none' here hands it to the half of the
  // machinery that can say something true about it.
  if (rec && rec.status === 'running') {
    if (!relayLive) return { kind: 'none' };
    // The same provenance gate as 'collect', for the same reason: attaching
    // ends in the handler applying the text, so a run started against a
    // different conversation log must not be rejoined here. 'none' rather
    // than 'show' — every sentence the banner owns is in the past tense, and
    // reusing one for a run still going would be a true display with a false
    // reason, which this house pays for more than it pays for silence.
    if (rec.convoId !== convoId) return { kind: 'none' };
    if (!hasHandler(rec.action)) return { kind: 'none' };
    if (seen.has(spuRecordKey(rec))) return { kind: 'none' };
    return { kind: 'attach', key: spuRecordKey(rec) };
  }

  // No record, or one that finished having produced nothing.
  if (!isFinishedRun(rec)) return { kind: 'none' };

  // Shown, never collected: this panel must not apply output produced against
  // a different conversation log. Visible because the alternative is a record
  // that sits on disk forever with nothing saying why.
  if (!isCollectableHere(rec, convoId)) return { kind: 'show' };

  // Checked BEFORE hasHandler, and the order is a choice about which lie to
  // avoid. A seen key means delivery was already attempted -- so the text is
  // most likely already in the pane -- and the record surviving means only
  // that the best-effort DELETE did not land. Saying "could not be collected"
  // about something already collected is a false statement; staying quiet is
  // merely incomplete. Silence beats a lie.
  if (seen.has(spuRecordKey(rec))) return { kind: 'none' };

  // Not observed in this build -- all six actions have handlers -- so this is
  // the shape for a record written by a newer build, or an action removed from
  // this one. Shown rather than dropped: a result nobody can apply is still a
  // result somebody paid for.
  if (!hasHandler(rec.action)) return { kind: 'show' };

  return { kind: 'collect', key: spuRecordKey(rec) };
}

export async function runSpuLoop(
  args: SpuRunArgs,
  deps: SpuRunDeps
): Promise<SpuRunOutcome> {
  const maxContinuations = typeof args.maxContinuations === 'number'
    ? args.maxContinuations
    : SPU_MAX_CONTINUATIONS;

  // Seeded, see SpuRunArgs.resumeText. The trailing newline matters: the
  // salvaged text was right-trimmed on save, so without it the continuation
  // would be welded onto the last word of the previous run.
  let accum = args.resumeText ? args.resumeText + '\n' : '';
  let attempts = 0;
  let endedBecause: SpuEndReason = 'cap';

  for (let attempt = 0; attempt <= maxContinuations; attempt++) {
    if (deps.isAborted?.()) {
      endedBecause = 'aborted';
      break;
    }

    // `attempt` is load-bearing, not bookkeeping: 0 sends one turn, anything
    // higher sends three. Passing 0 every round would make the model restart
    // the document from the top on every continuation.
    const messages = buildSpuTurns(attempt, args.userMsg, accum, args.lang);
    const piece = await deps.streamOnce(messages, attempt);
    attempts++;
    accum += piece;

    if (deps.onCheckpoint) await deps.onCheckpoint(accum, attempt);

    // Checked on `accum`, not `piece`: a model can print the sentinel split
    // across the boundary between two rounds.
    if (accum.includes(END_SENTINEL)) {
      endedBecause = 'sentinel';
      break;
    }
    // A round that produced nothing will produce nothing again. Without this
    // the loop spends the whole continuation budget on silence.
    if (!piece.trim()) {
      endedBecause = 'empty';
      break;
    }
  }

  return {
    accum,
    sawSentinel: accum.includes(END_SENTINEL),
    attempts,
    endedBecause,
  };
}
