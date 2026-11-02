// The state one turn accumulates while its stream is open, as ONE object.
//
// Until now these were 14 separate `let`/`const` locals inside ChatArea's
// `generateAiResponse`, and the only place their full list appeared was the
// 14-field object literal passed to finalizeTurnMessage(). That literal is the
// failure mode this module removes: accumulate a 15th thing, forget to add it
// to the literal, and the field never reaches disk — with no error anywhere.
// That is not hypothetical. finalizeTurnMessage's header carries the measured
// version of it (a handoff hand-built its own copy and silently dropped six
// fields, landing a real message on disk with tokens=0).
//
// With the state in one object the finalize call passes `acc` and the list
// cannot drift from what is accumulated: adding a field to the state puts it
// in the saved message by construction.
//
// The server-side runner is the reason this is a module. It reads the same SSE
// frames (lib/sseFrames.ts), normalises the same payloads (lib/turnEvents.ts),
// and must end with the same message (lib/finalizeTurnMessage.ts). The state
// in between was the one link still trapped in a React closure.
//
// Extracted from ChatArea.tsx 2026-10-28. Field order, initial values and the
// spread/copy decisions below are the closure's, transcribed rather than
// improved — the two places I "improved" a transcription in step 1 are in the
// lessons file.

import type { FinalizeAccumulator } from '@/lib/finalizeTurnMessage';

/**
 * One interactive AskUserQuestion exchange. `answers` is null until the user
 * picks, and is written through a reference found with `.find()` — so this is
 * named rather than left as `unknown`, which cannot be assigned into.
 */
export interface TurnAskedQuestion {
  askId: string;
  questions: unknown;
  answers: unknown;
  timedOut: boolean;
}

/**
 * One subagent dispatch. `result` is null while the run is open; that null IS
 * the open/closed flag `findOpenSubagentRun` matches on, and the result is
 * written back through the returned reference.
 */
export interface TurnSubagentRun {
  task: string;
  result: unknown;
  via?: unknown;
}

/**
 * Everything one turn accumulates.
 *
 * Deliberately defined as `FinalizeAccumulator` with three arrays narrowed,
 * NOT as its own list of fields: the other eleven must never be stated twice.
 * The narrowing is for the live accumulation sites only — `unknown[]` cannot be
 * passed to `findOpenSubagentRun` (its type parameter needs `task`/`result`)
 * and cannot have properties written back through a found element. Narrowed
 * arrays stay assignable to the wider ones, so this type remains usable
 * wherever `FinalizeAccumulator` is required; `assertFinalizable` below is the
 * compile-time proof, so the direction that matters (the finalizer's contract
 * growing a field) cannot drift silently.
 */
export type TurnAccState =
  Omit<FinalizeAccumulator, 'toolCalls' | 'askedQuestions' | 'subagentRuns'> & {
    toolCalls: Record<string, unknown>[];
    askedQuestions: TurnAskedQuestion[];
    subagentRuns: TurnSubagentRun[];
  };

/**
 * What a turn already has before its stream opens.
 *
 * `notices` is passed IN rather than created here, and is kept BY REFERENCE —
 * see createTurnAccState. Everything else is read-only input.
 */
export interface TurnAccSeed {
  /**
   * Text the message already holds when continuing. Streamed chunks append to
   * it rather than replacing it, joined with no separator: the model was told
   * its text attaches directly onto the previous part, so it may legitimately
   * resume mid-word or mid-code-block.
   */
  continuedSeed: string;
  /** Thinking text the message already holds when continuing. */
  continuedThought: string;
  /** Claude thinking blocks the message already holds when continuing. */
  continuedBlocks: readonly { thinking: string; signature: string }[];
  /**
   * The turn's notice array, SHARED not copied. It is created before the
   * stream opens and is still read after the stream's scope ends (the error
   * path pushes to it, and the catch reads it onto the message), so the state
   * must hold the same array the outer scope holds, not a snapshot of it.
   */
  notices: string[];
}

/**
 * Build the accumulator for one turn.
 *
 * Two array fields are treated differently ON PURPOSE:
 *
 *   claudeThinkingBlocks  COPIED from the seed. The seed array belongs to the
 *                         message being continued; pushing into it would
 *                         mutate an already-saved message.
 *   notices               SHARED with the caller, for the reason in TurnAccSeed.
 *
 * Getting either backwards is silent: a copied `notices` loses every notice
 * pushed during the stream, and a shared `continuedBlocks` corrupts the
 * previous message. Both are pinned by tests.
 */
export function createTurnAccState(seed: TurnAccSeed): TurnAccState {
  return {
    currentText: seed.continuedSeed,
    currentThought: seed.continuedThought,
    claudeThinkingBlocks: [...seed.continuedBlocks],
    continuationCount: 0,
    // The model_selected event arrives at the very start of every stream, so
    // these four are filled on every real turn. Empty means "the stream never
    // said" — which is why the streaming flush spreads them conditionally on
    // chosenModelFamily rather than writing empty strings onto the message.
    chosenModelFamily: '',
    chosenModelSpecific: '',
    chosenModelThinking: false,
    chosenModelLabel: '',
    // Prompt-cache usage from the backend's `cache_usage` SSE event. Always
    // populated when the provider returns usage; null for legacy logs.
    cacheUsage: null,
    // Web-search citations from the backend's `web_sources` SSE event.
    webSources: null,
    notices: seed.notices,
    // Every tool the model actually dispatched this turn, with its arguments:
    // the evidence behind the 🔧 report button. Display-only — slimHistory is
    // an allowlist and never names these, so they cost no context tokens.
    toolCalls: [],
    askedQuestions: [],
    subagentRuns: [],
  };
}

// TOOL_ATTACHMENTS_ARE_NOT_HERE — what this state deliberately does not hold.
//
// `toolAttachments` is accumulated by the same event chain but is NOT part of
// the finalized message's shape: it reaches the message through
// flushStreamingMessage (`attachments: toolAttachments.length ? [...] :
// (m.attachments || [])`), and finalizeTurnMessage only preserves whatever
// `base` already carries. In the browser that is invisible, because a flush
// always ran before finalize.
//
// A runner has no flush. One that reads the stream and calls only
// finalizeTurnMessage produces a message with NO attachments — tool-produced
// files vanish with no error. Measured 2026-10-28; recorded rather than fixed,
// because moving attachments into the finalizer changes what today's two
// callers write.
//
// This is a comment and not an exported constant on purpose: an exported
// symbol nothing reads is code that describes behaviour without having any,
// which is worse than no code at all. The grep anchor is the name above.

/**
 * Compile-time proof that TurnAccState satisfies FinalizeAccumulator.
 *
 * A runtime test cannot check this — the fields are typed, not enumerated at
 * runtime. If the finalizer's contract gains a field, this stops compiling,
 * which is the whole point: the alternative is a state object that is missing
 * a field the finalizer reads, and `undefined` landing on disk.
 */
export function assertFinalizable(state: TurnAccState): FinalizeAccumulator {
  return state;
}
