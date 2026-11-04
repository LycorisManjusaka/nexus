/**
 * Stop latency: the four moments a tab can actually see.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Stop was "fixed" three times and the wait stayed (MEASURED by つよ, three
 * rounds). Each fix was aimed from a guess at tab-side plumbing — a pre-send
 * check, minting the turn id locally, harvesting `turn_saved` during the drain
 * — and each one was real but none of them was THE wait. The reason is visible
 * in ChatArea: `abortControllerRef` is declared and aborted but never
 * ASSIGNED, so the abort in `handleStop` is a no-op left over from the browser
 * engine deleted on 2026-10-30. A runner turn does not hang from it. The tab
 * keeps reading the relay until the SERVER closes it, so the whole visible
 * wait is the server's unwind, and no tab-side change can shorten it.
 *
 * What a tab CAN time is where the server spent it, because the relay delivers
 * the two server milestones in order:
 *
 *   press ──────────> error frame arrives ──────> relay closes ──────> applied
 *         the stop reached        the runner finalized      this tab's own
 *         the route and it        and saved, and the        patch-or-reload
 *         aborted the stream      route called endTurn
 *
 * So one of three spans owns the seconds, and they point at different files:
 *   reach   big → the press is not arriving promptly (turnStop / postStop)
 *   save    big → finalize + saveLog (runTurnForQueue, atomicWrite)
 *   apply   big → the reload fell back here instead of patching (turnSaved)
 *
 * This module is the gauge only: it holds no policy and changes no behaviour.
 * Timing lives here rather than inline so the arithmetic can be tested without
 * a browser — the measurement I could not take myself, because driving a real
 * turn needs `/api/runner/tick`, which sits behind the admin gate this house
 * decided to stand up. The numbers come back from whoever presses the button.
 */

export type StopStage = 'press' | 'post' | 'reach' | 'close' | 'apply';

export interface StopTrace {
  /** Wall-clock ms at each milestone, in the order they can occur. */
  at: Partial<Record<StopStage, number>>;
  /** How the screen was brought up to date, once known. */
  how?: 'patch' | 'reload';
}

export function beginStopTrace(now: number): StopTrace {
  return { at: { press: now } };
}

/**
 * Record a milestone. Later marks never overwrite earlier ones for the same
 * stage: the drain can hand back `close` more than once in a retry, and the
 * FIRST sighting is the one that answers "when did the server get there".
 */
export function markStop(trace: StopTrace, stage: StopStage, now: number): StopTrace {
  if (trace.at[stage] !== undefined) return trace;
  return { ...trace, at: { ...trace.at, [stage]: now } };
}

export function noteStopHow(trace: StopTrace, how: 'patch' | 'reload'): StopTrace {
  return { ...trace, how };
}

/**
 * Spans when the stop POST was timed (the ordinary press). `reach` is split so
 * "the press took a while to get there" and "the server took a while to let go
 * of the stream" cannot hide inside one number — MEASURED 2026-11-04 on 謡_13,
 * two presses under identical conditions: reach 1.17s then 7.14s, while save
 * held at 42ms and apply at 0ms both times. A span that swings 6x while its
 * neighbours do not move is two different things added together.
 */
const SPANS_POSTED: ReadonlyArray<{ from: StopStage; to: StopStage; key: string }> = [
  { from: 'press', to: 'post', key: 'send' },
  { from: 'post', to: 'reach', key: 'abort' },
  { from: 'reach', to: 'close', key: 'save' },
  { from: 'close', to: 'apply', key: 'apply' },
];

/**
 * Spans when there was no POST to time — the press arrived before the turn had
 * a name, so `pendingStop` carried it and the fetch happened elsewhere. Keeping
 * the undivided `reach` here is the point: an absent measurement must not read
 * as a fast one.
 */
const SPANS_PENDING: ReadonlyArray<{ from: StopStage; to: StopStage; key: string }> = [
  { from: 'press', to: 'reach', key: 'reach' },
  { from: 'reach', to: 'close', key: 'save' },
  { from: 'close', to: 'apply', key: 'apply' },
];

export interface StopSpan {
  key: string;
  ms: number;
}

/**
 * The spans that are fully bracketed by two marks. A span whose far end never
 * arrived is LEFT OUT rather than shown as zero — "the relay never closed" and
 * "the relay closed instantly" are opposite facts and must not print alike.
 */
export function stopSpans(trace: StopTrace): StopSpan[] {
  const out: StopSpan[] = [];
  const spans = trace.at.post === undefined ? SPANS_PENDING : SPANS_POSTED;
  for (const s of spans) {
    const a = trace.at[s.from];
    const b = trace.at[s.to];
    if (a === undefined || b === undefined) continue;
    out.push({ key: s.key, ms: Math.max(0, b - a) });
  }
  return out;
}

/** Total only when both ends exist, so a stuck stop reports no total at all. */
export function stopTotalMs(trace: StopTrace): number | null {
  const a = trace.at.press;
  const b = trace.at.apply;
  if (a === undefined || b === undefined) return null;
  return Math.max(0, b - a);
}

function secs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * One line, readable by the person who pressed the button — the only
 * instrument this measurement has. Names the spans in the order they happen
 * and says how the screen caught up, because "patch" and "reload" differ by
 * two orders of magnitude in bytes (p50 7,891 B vs 438,368 B, measured
 * 2026-11-01) and that difference is the whole point of the apply span.
 */
export function formatStopTrace(trace: StopTrace, labels: Record<string, string>): string {
  const parts = stopSpans(trace).map((s) => `${labels[s.key] ?? s.key} ${secs(s.ms)}`);
  const total = stopTotalMs(trace);
  const head = total === null ? labels.incomplete ?? '(incomplete)' : secs(total);
  const how = trace.how ? ` [${labels[trace.how] ?? trace.how}]` : '';
  return parts.length ? `${head} — ${parts.join(' · ')}${how}` : `${head}${how}`;
}
