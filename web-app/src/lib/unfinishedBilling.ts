// Billing report for a turn that did NOT finish cleanly (Stop, network error,
// provider failure).
//
// WHY THIS EXISTS
// Every provider path in `api/chat/route.ts` emits its `cache_usage` frame on
// the success path only — a few lines before `[DONE]`. A Stop throws, so it
// lands in the catch instead and the usage counters, which by then already
// hold whatever the provider actually charged, were dropped on the floor.
//
// MEASURED 2026-11-04 (つよ, OAuth path): pressing Stop right after send moved
// the 5-hour window 46 → 48 → 50 → 52 % across four presses while NEXUS showed
// no tokens and no cost for any of them. The information was never missing —
// it was computed and discarded.
//
// Two shapes of silence are NOT the same thing and must not look the same:
//   - a stop that reached no model at all  → genuinely free
//   - a stop that billed                   → money spent, nothing shown
// The absence of a token row cannot be read as "free", so the words are part
// of the report, not decoration.
//
// Single source so the four provider paths cannot drift: each one normalizes
// its own vendor-specific usage object first (that part is irreducibly
// per-provider), then hands the normalized frame here.

/** The normalized shape `normalizeCacheUsage()` produces. */
export interface NormalizedUsageFrame {
  type: 'cache_usage';
  cachedInputTokens: number;
  uncachedInputTokens: number;
  totalInputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  providerHint?: string;
  [k: string]: unknown;
}

/**
 * Total tokens the provider charged for, as read off a normalized frame.
 *
 * `totalInputTokens` already includes the cached and cache-creation buckets
 * (that is what the normalizer guarantees), so adding those again would
 * double-count. Only output is separate.
 */
export function billedTokens(frame: NormalizedUsageFrame | null | undefined): number {
  if (!frame) return 0;
  const input = Number(frame.totalInputTokens) || 0;
  const output = Number(frame.outputTokens) || 0;
  return input + output;
}

/**
 * Frames to emit from a catch block: the usage record (only when something was
 * actually billed) followed by a sentence saying which of the two happened.
 *
 * Returns plain objects — the caller enqueues them, guarded, because after a
 * Stop the controller may already be closed.
 */
export function unfinishedBillingFrames(
  frame: NormalizedUsageFrame | null | undefined,
  ja: boolean,
  /**
   * Did the model demonstrably emit thought/text this turn?
   * (`betrayalSend.sawOutput()` — see lib/betrayalGuard.ts.)
   *
   * MEASURED 2026-11-12 (つよ, 先輩/Gemini, betrayal defence ON): the guard
   * aborts the turn the moment it blanks it, and Gemini carries usage on its
   * FINAL chunk only — so the abort lands in the catch with an empty usage
   * accumulator and this reported "課金なし: モデルは一度も呼ばれていません"
   * over a turn that had just produced a full betrayal reply. A lie, and
   * exactly the failure this module's header forbids: absence of a token row
   * read as proof of free.
   *
   * The real count is NOT recoverable here (the provider never sent it), so
   * the third state says the amount is unknown rather than inventing one.
   * Omitted/false keeps the old two-state wording, which the user guide
   * documents for a Stop pressed before the request goes out.
   */
  modelProducedOutput?: boolean,
): Array<Record<string, unknown>> {
  const billed = billedTokens(frame);
  const out: Array<Record<string, unknown>> = [];
  if (billed > 0 && frame) out.push(frame as unknown as Record<string, unknown>);
  let content: string;
  if (billed > 0) {
    content = ja
      ? `課金あり: このターンで ${billed.toLocaleString()} トークン（モデルは走りました）`
      : `Billed: ${billed.toLocaleString()} tokens this turn (the model did run)`;
  } else if (modelProducedOutput) {
    content = ja
      ? '課金額は不明: モデルは走って出力しましたが、使用量が届く前にターンが中断されました（課金はゼロではありません）'
      : 'Amount unknown: the model ran and produced output, but the turn was cut off'
        + ' before its usage arrived (this was NOT free)';
  } else {
    content = ja
      ? '課金なし: モデルは一度も呼ばれていません'
      : 'Not billed: no model call was reached';
  }
  out.push({ type: 'notice', content });
  return out;
}

/** One-line server log, so the same fact is in the terminal too. */
export function unfinishedBillingLog(
  tag: string,
  frame: NormalizedUsageFrame | null | undefined,
): string {
  const billed = billedTokens(frame);
  // "no usage frame arrived", not "no model call reached": the terminal must
  // not make the claim the screen notice was corrected for (see above).
  return billed === 0
    ? `${tag} unfinished turn: no usage frame arrived (cost unknown, not necessarily zero)`
    : `${tag} unfinished turn: billed ${billed} tokens`
      + ` (in=${frame?.totalInputTokens ?? 0} out=${frame?.outputTokens ?? 0}`
      + ` cacheRead=${frame?.cachedInputTokens ?? 0})`;
}
