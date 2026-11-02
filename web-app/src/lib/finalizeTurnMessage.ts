// The finalized assistant message, built in ONE place.
//
// Two callers need the identical shape today: the setState that commits the
// visible message, and the vessel-handoff re-POST that has to send this same
// message as history. A third caller is coming — the server-side runner — and
// it must not build its own.
//
// Why this is a module and not a local closure: the handoff USED to hand-build
// its own copy of this object, and that copy silently dropped cacheUsage,
// generationMs, textTokens, thinkingTokens, toolCalls and notices — i.e. the
// entire billing record of the vessel that had just handed over. MEASURED on a
// real handoff: the handing-over message landed on disk with tokens=0 and no
// cacheUsage, while the receiving one was complete. Per-message billing only
// works if every message is finalized the same way, so the shape lives where
// every caller can reach it instead of where one caller happens to be.
//
// Extracted from ChatArea.tsx's `buildFinalizedMessage` 2026-10-28, byte-for-
// byte: same expressions, same field order, same conditional spreads. The one
// interface change is `nowMs`, below.

import { estimateTokensForModel } from '@/lib/tokenEstimate';

/** Prompt-cache / billing record for one turn. `null` until usage arrives. */
export interface FinalizeCacheUsage {
  cachedInputTokens: number;
  uncachedInputTokens: number;
  totalInputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  providerHint: string;
  // Only xAI's Responses API sends these: its own total for the request, and
  // the count of billed server-side search calls (which no token table can
  // express). Absent everywhere else.
  reportedUsd?: number;
  serverToolCalls?: number;
}

/**
 * Everything the streaming loop accumulates that ends up ON the saved message.
 *
 * This interface IS the contract: it is the complete list of accumulator state
 * that survives the turn. Anything the loop accumulates and is not named here
 * is display-only or already committed elsewhere. A runner that fills this in
 * produces the same message the browser does — that is the whole point.
 */
export interface FinalizeAccumulator {
  currentText: string;
  currentThought: string;
  claudeThinkingBlocks: { thinking: string; signature: string }[];
  continuationCount: number;
  chosenModelFamily: string;
  chosenModelSpecific: string;
  chosenModelThinking: boolean;
  chosenModelLabel: string;
  cacheUsage: FinalizeCacheUsage | null;
  webSources: { url: string; title?: string }[] | null;
  notices: string[];
  toolCalls: unknown[];
  askedQuestions: unknown[];
  subagentRuns: unknown[];
}

/** Turn context that is not accumulated — known before the stream opens. */
export interface FinalizeContext {
  /** Date.now() captured when the turn started. */
  genStartTime: number;
  /**
   * Date.now() at the moment of finalizing. Passed in rather than read here so
   * this function is deterministic and testable. The value is identical to
   * reading the clock inside: the caller evaluates `Date.now()` in the argument
   * list, immediately before the call. This is the ONLY interface difference
   * from the closure this was extracted from.
   */
  nowMs: number;
  /** `autoPlay` on the saved message — VRChat mode in the browser. */
  autoPlay: boolean;
  /** Model family used for the fallback token estimate. */
  tokenModel: string;
}

/**
 * Commit everything the streaming loop accumulated onto `base`.
 *
 * `base` is the message being finalized — either the streaming placeholder
 * pulled out of the visible list, or a freshly built shell (the handoff path).
 * Its fields win where they do not collide, because the spread comes first.
 */
export function finalizeTurnMessage(
  base: Record<string, unknown>,
  acc: FinalizeAccumulator,
  ctx: FinalizeContext,
): Record<string, unknown> {
  const finalText = acc.currentText;
  // Both were `length / 4` (0.377x measured on this house's text). This is the
  // stored per-message count for a turn whose usage never arrived — a stopped
  // or aborted stream — so an under-count here is written to disk and then
  // summed forever by the conversation-log cap.
  const fallbackTokens = estimateTokensForModel(finalText || '', ctx.tokenModel);
  const thinkingTokens = acc.currentThought
    ? estimateTokensForModel(acc.currentThought, ctx.tokenModel)
    : 0;
  return {
    ...base,
    content: finalText,
    tokens: fallbackTokens,
    textTokens: fallbackTokens,
    // Store the ACTUAL thinking-token count (not zeroed when the reuse toggle
    // happens to be off at generation time) so flipping "Save & reuse thinking
    // process" on later recomputes correctly.
    thinkingTokens,
    // Total generation time (ms) for this turn — shown in the meta bar, saved
    // to the log, hidden from the entity.
    generationMs: ctx.nowMs - ctx.genStartTime,
    autoPlay: ctx.autoPlay,
    streaming: false,
    ...(acc.continuationCount > 0 ? { continuationCount: acc.continuationCount } : {}),
    ...(acc.claudeThinkingBlocks.length > 0
      ? { claudeThinkingBlocks: acc.claudeThinkingBlocks }
      : {}),
    ...(acc.chosenModelFamily
      ? {
          modelFamily: acc.chosenModelFamily,
          modelSpecific: acc.chosenModelSpecific,
          modelThinking: acc.chosenModelThinking,
          modelLabel: acc.chosenModelLabel,
        }
      : {}),
    ...(acc.cacheUsage ? { cacheUsage: acc.cacheUsage } : {}),
    ...(acc.webSources ? { webSources: acc.webSources } : {}),
    ...(acc.notices.length > 0 ? { notices: acc.notices } : {}),
    ...(acc.toolCalls.length > 0 ? { toolCalls: acc.toolCalls } : {}),
    ...(acc.askedQuestions.length > 0 ? { askedQuestions: acc.askedQuestions } : {}),
    ...(acc.subagentRuns.length > 0 ? { subagentRuns: acc.subagentRuns } : {}),
  };
}
