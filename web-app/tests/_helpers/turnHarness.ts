/**
 * Shared fixtures for the turn-reading chain (sink / flags / acc / deps).
 *
 * WHY THIS EXISTS. `TurnEventSink` names THIRTEEN methods. Any test that
 * drives the chain has to supply all of them, and the second copy of that
 * list arrived the moment turnStreamLoop got a test. A second copy is not
 * dangerous here — TypeScript refuses a sink that is missing a method, so a
 * fourteenth notification breaks both copies loudly rather than silently —
 * but it is still a list of names kept in step by hand, which is the shape
 * this whole phase has been removing from src/.
 *
 * Not run as a test: package.json's --test glob matches only files ending in
 * `.test.ts`, so this file is import-only. The `_` prefix follows
 * `tests/_loader.mjs`.
 *
 * Transcribed verbatim from tests/lib/turnEventReducer.test.ts (2026-10-28),
 * which is now the second caller rather than the owner.
 */
import { createTurnAccState, type TurnAccState } from '@/lib/turnAccState';
import type {
  TurnEventFlags,
  TurnEventSink,
  TurnEventDeps,
} from '@/lib/turnEventReducer';

/** Records every sink call in order, so "was this notified" is checkable. */
export function recordingSink() {
  const calls: { m: string; a: unknown }[] = [];
  const log = (m: string) => (a?: unknown) => { calls.push({ m, a }); };
  const sink: TurnEventSink = {
    modelSelected: log('modelSelected'),
    sessionId: log('sessionId'),
    phaseThinkingUnlessReplying: log('phaseThinkingUnlessReplying'),
    phaseReplying: log('phaseReplying'),
    requestFlush: log('requestFlush'),
    askOpened: log('askOpened'),
    askResolved: log('askResolved'),
    subagentStarted: log('subagentStarted'),
    subagentFinished: log('subagentFinished'),
    injectionDelivered: log('injectionDelivered'),
    toolActivity: log('toolActivity'),
    stallIdleSeconds: log('stallIdleSeconds'),
    attachmentDescribed: log('attachmentDescribed'),
    turnPlan: log('turnPlan'),
  };
  return { sink, calls, names: () => calls.map(c => c.m) };
}

export function freshFlags(): TurnEventFlags {
  return { pendingHandoff: null, betrayalRedacted: false, sawOutput: false, toolAttachments: [] };
}

export function freshAcc(seed?: Partial<{ text: string; thought: string }>): TurnAccState {
  return createTurnAccState({
    continuedSeed: seed?.text ?? '',
    continuedThought: seed?.thought ?? '',
    continuedBlocks: [],
    notices: [],
  });
}

/** `t` returns the key unchanged, so a key appearing in output is visible. */
export const deps: TurnEventDeps = {
  t: (k) => k,
  settings: null,
  newAttachmentId: () => 'fixed-id',
};
