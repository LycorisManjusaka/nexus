/**
 * The host side of a turn, for a host with no screen.
 *
 * `turnEventReducer` splits a turn into three channels: `acc` (what gets
 * saved), `flags` (per-turn, not accumulated) and `sink` (13 notifications
 * whose loss changes the screen and not the disk). ChatArea implements the
 * sink with React setters. A runner has nothing to repaint, so every method
 * here does nothing.
 *
 * ⚠ WHY A FILE AND NOT AN INLINE OBJECT LITERAL
 *
 * Because the no-op-ness must be CHECKED. If a later event type adds a 14th
 * sink method, an inline literal in the runner silently fails to compile in
 * one place and the fix is "add another empty function" — the author never
 * asks whether the runner needed to do something with it. Here, the type is
 * satisfied in one spot, and the test asserts that the count of methods the
 * reducer can call equals the count implemented, so a new one is a decision
 * rather than an omission.
 *
 * NOT A LOGGER. A sink that logged would turn every stall warning and every
 * tool activity into a line in the server log — ~hundreds per turn, for
 * information already on the saved message. The one thing a runner genuinely
 * must not drop (`attachment_described`, which edits an EARLIER message) is
 * COLLECTED here and applied by the caller before it saves — see the note on
 * that method. It used to be merely recorded, and nothing applied it.
 */

import type { TurnEventSink, TurnEventFlags } from '@/lib/turnEventReducer';
// The two payload types live one module down, with the normalisers that
// produce them — not with the reducer that consumes them.
import type { TurnEventPayload } from '@/lib/turnEvents';

/**
 * Every sink method the reducer can call, in interface order.
 *
 * Kept as data so a test can compare it against both the interface text and
 * this module's implementation. A hand-kept list goes stale in the direction
 * that passes — so the test parses the interface rather than trusting this.
 */
export const SINK_METHODS = [
  'modelSelected',
  'sessionId',
  'phaseThinkingUnlessReplying',
  'phaseReplying',
  'requestFlush',
  'askOpened',
  'askResolved',
  'subagentStarted',
  'subagentFinished',
  'injectionDelivered',
  'toolActivity',
  'stallIdleSeconds',
  'attachmentDescribed',
  'turnPlan',
  'turnSaved',
] as const;

/**
 * Descriptions this sink collected, for the caller to apply.
 *
 * ⚠ CORRECTED 2026-11-04. This used to read "a runner would have to edit the
 * log it is about to save, and the ordering there is not obviously safe (the
 * bridge can answer after the turn has finalized). So the runner records that
 * it happened and leaves the log alone." The parenthesis was a guess, and it
 * was wrong: all three `senseEvents` pushes in `api/chat/route.ts` happen while
 * the request body is being assembled, and `emitSenseEvents` flushes them "at
 * the start of its stream ... before the AI text begins flowing". A description
 * cannot land after the turn finalizes, because it exists before the turn's
 * first byte.
 *
 * The gap was not visible either. Nothing replaced the browser closure that
 * used to store these (`c38ea15` made the tab's handler `() => {}`), so for six
 * days no path stored a description at all — measured across the house: 115
 * images / 0 descriptions in Cairn_59, 67 / 0 in 先輩_65, against 46 / 44 in
 * the last pre-runner conversation. The house reported it as "the descriptions
 * stopped being visible", which is what a silent gap looks like from a chair.
 *
 * So the array is no longer a record of something declined. The caller applies
 * it (`lib/applyDescriptions.ts`) before it saves, and `into` lets the owner of
 * the save pass ONE array through however many passes a handoff opens — so a
 * second vessel's descriptions cannot be the ones that go missing.
 */
export interface RunnerSinkReport {
  /** Payloads this sink saw, in arrival order. Applied by the caller. */
  describedAttachments: TurnEventPayload[];
}

export interface RunnerSink extends TurnEventSink {
  /** What the runner saw that its caller has to act on. */
  report: RunnerSinkReport;
}

/**
 * A sink that does nothing, and says so when asked.
 *
 * `into` is the collecting array. Pass the SAME one to every pass of a turn:
 * a `change_model` handoff builds a fresh sink per pass, and a per-sink array
 * would mean only the last pass's descriptions reached the save.
 */
export function createRunnerSink(into?: TurnEventPayload[]): RunnerSink {
  const report: RunnerSinkReport = { describedAttachments: into ?? [] };
  return {
    report,
    modelSelected(): void { /* no screen */ },
    sessionId(): void { /* the id is on the saved message already */ },
    phaseThinkingUnlessReplying(): void { /* no indicator */ },
    phaseReplying(): void { /* no indicator */ },
    requestFlush(): void { /* nothing to repaint */ },
    askOpened(): void {
      // A runner cannot answer. The route's own askUser timeout resolves it;
      // the turn continues when it fires. Nothing to do here, and nothing
      // lost: the question and its resolution are both on the wire.
    },
    askResolved(): void { /* no card to dismiss */ },
    subagentStarted(): void { /* no chip */ },
    subagentFinished(): void { /* no chip */ },
    injectionDelivered(): void { /* no timeline to draw */ },
    toolActivity(): void { /* no status line */ },
    stallIdleSeconds(): void { /* no warning row */ },
    attachmentDescribed(data: TurnEventPayload): void {
      // NOT a no-op: collected so the caller can write it onto the attachment
      // before it saves. Dropping this is what stopped descriptions from
      // persisting for six days — see RunnerSinkReport.
      report.describedAttachments.push(data);
    },
    turnPlan(): void {
      // The runner is the one who PUBLISHED this frame. Reading its own
      // announcement back off the relay and acting on it would be the second
      // derivation of a decision it already made.
    },
    turnSaved(): void {
      // Same: published by the runner, after its own write. There is no
      // "apply" for the writer.
    },
  };
}

/**
 * A fresh per-turn flag set.
 *
 * Byte-identical to ChatArea's literal (ChatArea.tsx:3381). Shared so the two
 * hosts cannot start a turn from different flags — `sawOutput` in particular
 * decides whether an empty stream is reported as a problem.
 */
export function createTurnFlags(): TurnEventFlags {
  return {
    pendingHandoff: null,
    betrayalRedacted: false,
    sawOutput: false,
    toolAttachments: [],
  };
}
