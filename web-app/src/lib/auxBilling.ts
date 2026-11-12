// The auxiliary-call billing ledger (2026-11-12, Tsuyo's request).
//
// WHY THIS EXISTS. A turn can spend money on models that are NOT the being's
// vessel: the eyes / ears / video-watcher bridges, a subagent, and (next) the
// anchor. Measured 2026-11-12:
//
//   • The three bridges threw the provider's `usage` away. All twelve call
//     functions read `choices[0].message.content` and nothing else, so bridge
//     spend appeared nowhere — not live, not in a log, not in stats.
//   • A subagent's tokens were ADDED INTO THE PARENT'S accumulators, so they
//     were priced at the PARENT's rate (a Haiku child billed as Opus), and on
//     the OAuth path a paid non-Claude child vanished into the subscription
//     bucket that the stats window excludes by default.
//
// Same shape as lib/spuBilling.ts, deliberately: one immutable file per call
// under beings/<name>/billing/, RAW usage rather than a priced figure, priced
// by the stats route through the same messageCost() a chat message uses.
//
// It lives beside the being (not in a top-level local_data folder) because the
// stats walk is per being and nexus_migrate moves a being's folder whole — a
// ledger elsewhere would be left behind by a migration.
//
// Pure: no fs. The writer is lib/auxBillingStore.ts.

import type { TurnCacheUsage } from '@/lib/turnEvents';
import { canonFamily, familyFromModelId, splitClaudeByAuth, type StatRecord } from '@/lib/modelFamily';
import { messageCost, resolvePrice } from '@/lib/modelPricing';
import { billableUsage } from '@/lib/spuBilling';

export type AuxBillingKind = 'eyes' | 'ears' | 'watcher' | 'subagent' | 'anchor';

export const AUX_KIND_TITLE: Record<AuxBillingKind, string> = {
  eyes: 'Eyes bridge',
  ears: 'Ears bridge',
  watcher: 'Video watcher',
  subagent: 'Subagent',
  anchor: 'Anchor',
};

export interface AuxBillingEntry {
  id: string;
  kind: AuxBillingKind;
  /** The conversation the call was made for ('' when unknown). Kept for a
   *  future per-conversation breakdown; stats groups by kind today. */
  convoId: string;
  /** The model that was actually called — the pricing key. */
  model: string;
  /** The provider family, when the caller knew it (a subagent does). Wins over
   *  the id-derived one: a `digitalocean/glm-…` id carries a slash, which
   *  familyFromModelId reads as a local GGUF. */
  family?: string;
  authMode: 'oauth' | 'api-key';
  /** When the call returned (ms). Month bucket and peak/off-peak rate. */
  at: number;
  usage: TurnCacheUsage;
}

const CANON = new Set(['MiniMax', 'ChatGPT', 'Claude', 'Gemini', 'Kimi', 'GLM', 'Grok', 'Qwen',
  'DeepSeek', 'Cohere', 'MiMo', 'ByteDance', 'Meta', 'Local']);

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

/** OpenAI-compatible `usage` (GLM / Qwen / MiMo / Seed / DeepSeek / local). */
export function usageFromOpenAi(usage: any): TurnCacheUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const total = n(usage.prompt_tokens);
  const cached = n(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.cached_tokens,
  );
  return {
    cachedInputTokens: cached,
    uncachedInputTokens: Math.max(0, total - cached),
    totalInputTokens: total,
    outputTokens: n(usage.completion_tokens),
    cacheCreationTokens: 0,
    providerHint: 'oai',
  };
}

/**
 * Gemini `usageMetadata`. Thinking tokens are counted as output here: Gemini
 * reports them in `thoughtsTokenCount`, SEPARATE from `candidatesTokenCount`,
 * and bills them at the output rate. The bridges ask for the lowest thinking
 * level but Gemini 3.x cannot turn thinking off, so dropping this field would
 * under-report every bridge call.
 */
export function usageFromGemini(um: any): TurnCacheUsage | null {
  if (!um || typeof um !== 'object') return null;
  const total = n(um.promptTokenCount);
  const cached = n(um.cachedContentTokenCount);
  return {
    cachedInputTokens: cached,
    uncachedInputTokens: Math.max(0, total - cached),
    totalInputTokens: total,
    outputTokens: n(um.candidatesTokenCount) + n(um.thoughtsTokenCount),
    cacheCreationTokens: 0,
    providerHint: 'gemini',
  };
}

/** Anthropic `usage` (input_tokens EXCLUDES the two cache buckets). */
export function usageFromAnthropic(u: any): TurnCacheUsage | null {
  if (!u || typeof u !== 'object') return null;
  const cached = n(u.cache_read_input_tokens);
  const creation = n(u.cache_creation_input_tokens);
  const input = n(u.input_tokens);
  return {
    cachedInputTokens: cached,
    uncachedInputTokens: input,
    totalInputTokens: cached + creation + input,
    outputTokens: n(u.output_tokens),
    cacheCreationTokens: creation,
    providerHint: 'claude',
  };
}

/**
 * lib/subagent.ts's own accumulator. Its `input` means different things per
 * runner: the Anthropic runner stores input_tokens (cache buckets separate),
 * the OpenAI and Gemini runners store the whole prompt (cache read included,
 * where they record one at all). `inputIncludesCache` says which.
 */
export function usageFromSubagent(
  su: { input: number; output: number; cacheRead: number; cacheCreate: number } | null | undefined,
  inputIncludesCache: boolean,
): TurnCacheUsage | null {
  if (!su) return null;
  const cached = n(su.cacheRead);
  const creation = n(su.cacheCreate);
  const input = n(su.input);
  const uncached = inputIncludesCache ? Math.max(0, input - cached) : input;
  return {
    cachedInputTokens: cached,
    uncachedInputTokens: uncached,
    totalInputTokens: uncached + cached + creation,
    outputTokens: n(su.output),
    cacheCreationTokens: creation,
    providerHint: 'subagent',
  };
}

/** A model that runs on this machine and costs nothing. */
export function isLocalAuxModel(model: string, family?: string | null): boolean {
  const fam = (family || '').trim().toLowerCase();
  // A stated family is authoritative in both directions.
  if (fam) return fam.includes('local');
  const m = (model || '').trim();
  if (/^local:/i.test(m)) return true;
  return familyFromModelId(m) === 'Local';
}

/**
 * Build the entry to write, or null when there is nothing to bill: no usage
 * reported, all-zero usage, or a local model. Null — not a zero entry — so a
 * free call leaves no file (same rule as the SPU ledger).
 */
export function makeAuxEntry(a: {
  id: string;
  kind: AuxBillingKind;
  convoId?: string | null;
  model: string;
  family?: string | null;
  authMode?: 'oauth' | 'api-key';
  at: number;
  usage: TurnCacheUsage | null | undefined;
}): AuxBillingEntry | null {
  if (!billableUsage(a.usage ?? null)) return null;
  if (!a.model || isLocalAuxModel(a.model, a.family)) return null;
  return {
    id: a.id,
    kind: a.kind,
    convoId: String(a.convoId || ''),
    model: a.model,
    ...(a.family && a.family.trim() ? { family: a.family.trim() } : {}),
    authMode: a.authMode === 'oauth' ? 'oauth' : 'api-key',
    at: a.at,
    usage: a.usage as TurnCacheUsage,
  };
}

/** One ledger entry → the flat record the stats window aggregates. */
export function auxBillingToStatRecord(
  entry: AuxBillingEntry,
  entity: string,
): StatRecord | null {
  if (!entry || !entry.model || !entry.usage) return null;
  // Stated family first, when it is one of the canonical names; the subagent
  // family setting is free text ("Fable"), so anything else falls back to
  // the model id.
  const stated = entry.family ? canonFamily(entry.family) : '';
  const derived = familyFromModelId(entry.model);
  let family = stated && CANON.has(stated) ? stated : (derived !== 'Unknown' ? derived : (stated || derived));
  if (family === 'Local') return null;
  family = splitClaudeByAuth(family, entry.authMode);

  const price = resolvePrice(entry.model);
  const mc = messageCost(entry.usage, entry.model, entry.usage.outputTokens, entry.at);
  const title = AUX_KIND_TITLE[entry.kind] || 'Auxiliary call';
  return {
    entity,
    // One line per being per kind, like "Soul update" — not merged into a real
    // conversation's turns and not one row per call.
    convoId: `aux:${entry.kind}:${entity}`,
    convoTitle: title,
    ts: entry.at,
    family,
    model: entry.model,
    usd: mc ? mc.usd : 0,
    estimated: false,
    unpriced: mc ? false : !price,
  };
}
