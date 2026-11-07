// The soul-updater billing ledger (2026-11-07, Lizard-kun's design).
//
// WHY THIS EXISTS. An SPU run (a soul update, redistribute, index, genesis, or
// summary) calls a provider up to seven times and costs real money. Measured
// 2026-11-06: that money was shown live in the panel (SystemPromptUpdater's
// `setRunUsage`) and then thrown away — it was written to no log, and the stats
// scanner only reads saved conversation logs, so SPU spend was never counted.
// "Before it was counted" turned out to be a memory mismatch: git history held
// no such mechanism, only the live display.
//
// The ledger stores RAW usage, not a priced figure, and lets the stats route
// price it through the SAME messageCost() a chat message goes through. One
// pricing source: if a rate changes, re-running stats reprices the ledger too,
// and the "Claude (OAuth)" exclusion / long-context tiers / reportedUsd all
// behave identically to a normal turn.
//
// A stopped or errored run is billed for whatever usage it accumulated before
// it ended — the provider calls happened, so the money was spent. Local runs
// are free and never written (billingToStatRecord also drops them, so the
// decision lives in one place even if a Local entry ever reaches disk).

import type { TurnCacheUsage } from '@/lib/turnEvents';
import { familyFromModelId, splitClaudeByAuth, type StatRecord } from '@/lib/modelFamily';
import { messageCost, resolvePrice } from '@/lib/modelPricing';

export interface SpuBillingEntry {
  runId: string;
  /** 'update' | 'reorganize' | 'redistribute' | 'index' | 'genesis' | 'summary' */
  action: string;
  /** Generation label the run wrote toward (soulGeneration.ts form). */
  label: string;
  /** The conversation whose log fed the run ('' for no-conversation modes). */
  convoId: string;
  /** The model id the run ran on — the pricing key. */
  model: string;
  /** For the Claude OAuth/API split. 'api-key' when the run did not say. */
  authMode: 'oauth' | 'api-key';
  /** When the run began (ms). The billing timestamp — selects the month bucket
   *  and peak/off-peak rates. */
  startedAt: number;
  /** How many provider calls the run actually made. */
  attempts: number;
  /** done | stopped | error. Never 'running' — the ledger is written at the end. */
  status: 'done' | 'stopped' | 'error';
  /** SUMMED across every round of the run. */
  usage: TurnCacheUsage;
}

/**
 * Add one call's usage into a running total. Returns a fresh object; a null
 * operand is the identity. `reportedUsd` and `serverToolCalls` are summed and
 * then omitted-when-zero, matching normaliseCacheUsage's convention — a stored
 * 0 would read as "the provider said it cost nothing" rather than "absent".
 */
export function addCacheUsage(
  a: TurnCacheUsage | null,
  b: TurnCacheUsage | null,
): TurnCacheUsage | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const reportedUsd = (a.reportedUsd || 0) + (b.reportedUsd || 0);
  const serverToolCalls = (a.serverToolCalls || 0) + (b.serverToolCalls || 0);
  return {
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    totalInputTokens: a.totalInputTokens + b.totalInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    providerHint: a.providerHint || b.providerHint,
    ...(reportedUsd > 0 ? { reportedUsd } : {}),
    ...(serverToolCalls > 0 ? { serverToolCalls } : {}),
  };
}

/**
 * Is there anything to bill? True when any token bucket or a reported cost is
 * non-zero. A run that produced no usage (died before its first call returned)
 * writes no ledger entry — an all-zero record is noise the stats walk would
 * have to price to $0 anyway.
 */
export function billableUsage(u: TurnCacheUsage | null): u is TurnCacheUsage {
  if (!u) return false;
  const tokens =
    u.totalInputTokens + u.uncachedInputTokens + u.cachedInputTokens +
    u.cacheCreationTokens + u.outputTokens;
  return tokens > 0 || (u.reportedUsd ?? 0) > 0;
}

/**
 * Turn one ledger entry into the flat StatRecord the client aggregates.
 *
 * Returns null for a Local run (free — never counted), matching the stats log
 * walk which skips `family === 'Local'`. `estimated: false` always: the ledger
 * holds real usage, so the "include estimated" option never drops it and the
 * "exclude OAuth" option keys on the split family string.
 */
export function billingToStatRecord(
  entry: SpuBillingEntry,
  entity: string,
): StatRecord | null {
  let family = familyFromModelId(entry.model);
  if (family === 'Local') return null;
  family = splitClaudeByAuth(family, entry.authMode);

  const price = resolvePrice(entry.model);
  const mc = messageCost(entry.usage, entry.model, entry.usage.outputTokens, entry.startedAt);
  let usd = 0;
  let unpriced = false;
  if (mc) usd = mc.usd;
  else unpriced = !price; // no price row AND no reportedUsd → genuinely unpriced

  return {
    entity,
    // Entity-scoped so the by-conversation report keeps one "Soul update" line
    // per being, instead of merging soul spend into a real conversation's turns
    // or scattering one row per run.
    convoId: `soul-update:${entity}`,
    convoTitle: 'Soul update',
    ts: entry.startedAt,
    family,
    model: entry.model,
    usd,
    estimated: false,
    unpriced,
  };
}
