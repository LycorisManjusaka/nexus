// Model API pricing → per-message / per-conversation cost estimates.
//
// Prices live in ./modelPricing.json (editable by hand). This module resolves a
// model id to its price row and turns a message's token usage into a USD figure.
//
// The token buckets come from the same `cacheUsage` object the meta bar already
// shows (normalizeCacheUsage in the chat route): uncached input, cached input,
// cache-write (Anthropic), and output. Cost is a straight per-bucket multiply.
//
// OAuth Claude is priced exactly like the Claude API (same model ids, no
// separation) — the user pays real subscription/credit value either way and
// wants to see it. Local models are never priced (caller skips them).

import PRICING from './modelPricing.json';

export interface ModelPrice {
  input: number;       // USD per 1M uncached input tokens
  cachedInput: number; // USD per 1M cache-hit input tokens
  cacheWrite: number;  // USD per 1M cache-creation tokens (Anthropic; 0 elsewhere)
  output: number;      // USD per 1M output tokens
}

export interface CacheUsageLike {
  totalInputTokens?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
}

const M = 1_000_000;

/** Normalize a model id to the JSON key form: lowercase, no "moonshotai/". */
function normalizeId(id?: string | null): string {
  return (id || '').replace(/^moonshotai\//i, '').toLowerCase().trim();
}

/** Look up the price row for a model id, or null if it isn't in the table. */
export function resolvePrice(modelId?: string | null): ModelPrice | null {
  const key = normalizeId(modelId);
  if (!key) return null;
  const row = (PRICING as Record<string, any>)[key];
  return row && typeof row.input === 'number' ? (row as ModelPrice) : null;
}

/** Format a USD amount with precision that stays meaningful for tiny costs. */
export function fmtUSD(v: number): string {
  if (!isFinite(v) || v <= 0) return '$0.00';
  if (v >= 1) return '$' + v.toFixed(2);
  if (v >= 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(6);
}

/**
 * Cost of a single message from its cacheUsage + model id.
 * Returns null when the model has no price row or there's no usage to price.
 * `fallbackOutput` (e.g. the message's estimated output tokens) is used when the
 * provider didn't report output tokens in the usage block.
 */
export function messageCost(
  cu: CacheUsageLike | undefined | null,
  modelId?: string | null,
  fallbackOutput?: number,
): { usd: number; breakdown: string } | null {
  const price = resolvePrice(modelId);
  if (!price || !cu) return null;

  const cached = cu.cachedInputTokens ?? 0;
  const uncached =
    cu.uncachedInputTokens ??
    Math.max(0, (cu.totalInputTokens ?? 0) - cached);
  const cacheWrite = cu.cacheCreationTokens ?? 0;
  const output = cu.outputTokens || fallbackOutput || 0;

  if (uncached + cached + cacheWrite + output === 0) return null;

  const cIn = (uncached * price.input) / M;
  const cCached = (cached * price.cachedInput) / M;
  const cWrite = (cacheWrite * price.cacheWrite) / M;
  const cOut = (output * price.output) / M;
  const usd = cIn + cCached + cWrite + cOut;

  const breakdown =
    `Estimated cost: ${fmtUSD(usd)}  (${normalizeId(modelId)})\n` +
    `  input uncached: ${uncached.toLocaleString()} × $${price.input}/M = ${fmtUSD(cIn)}\n` +
    (cached ? `  input cached:   ${cached.toLocaleString()} × $${price.cachedInput}/M = ${fmtUSD(cCached)}\n` : '') +
    (cacheWrite ? `  cache write:    ${cacheWrite.toLocaleString()} × $${price.cacheWrite}/M = ${fmtUSD(cWrite)}\n` : '') +
    `  output:         ${output.toLocaleString()} × $${price.output}/M = ${fmtUSD(cOut)}`;

  return { usd, breakdown };
}
