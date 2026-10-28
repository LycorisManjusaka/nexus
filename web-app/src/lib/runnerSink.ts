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
 * reported by the caller, not swallowed here: see the note on that method.
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
] as const;

/**
 * What a runner noticed that it could not act on.
 *
 * Only one entry exists today. `attachment_described` means a sense bridge
 * wrote a description onto a message EARLIER in the conversation; ChatArea
 * edits that message in React state. A runner would have to edit the log it
 * is about to save, and the ordering there is not obviously safe (the bridge
 * can answer after the turn has finalized). So the runner records that it
 * happened and leaves the log alone — a visible gap, rather than a silent
 * one or a half-applied edit.
 */
export interface RunnerSinkReport {
  /** Payloads for descriptions this runner did NOT apply to the log. */
  unappliedDescriptions: TurnEventPayload[];
}

export interface RunnerSink extends TurnEventSink {
  /** What the runner saw and deliberately did not act on. */
  report: RunnerSinkReport;
}

/** A sink that does nothing, and says so when asked. */
export function createRunnerSink(): RunnerSink {
  const report: RunnerSinkReport = { unappliedDescriptions: [] };
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
      // NOT a no-op: recorded so the caller can report a gap it cannot close.
      report.unappliedDescriptions.push(data);
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
