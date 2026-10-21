// Model API pricing → per-message / per-conversation cost estimates.
//
// Prices live in ./modelPricing.json (editable by hand). This module resolves a
// model id to its price row and turns a message's token usage into a USD figure.
//
// The token buckets come from the same `cacheUsage` object the meta bar already
// shows (normalizeCacheUsage in the chat route): uncached input, cached input,
// cache-write (Anthropic), and output. Cost is a straight per-bucket multiply.
//
// Peak/off-peak (DeepSeek V4): a model whose row carries `peakHoursUtc` is
// billed at the peak* rates while a message's timestamp falls inside a peak
// window (Mon–Fri, [start,end) UTC hours); every other time — including
// weekends, and any message priced WITHOUT a timestamp — it is billed at the
// base (off-peak) rates.
//
// Long-context tiers (added 2026-10-21): several providers now charge a HIGHER
// rate once the prompt crosses a size threshold, which the flat four-field row
// could not express at all. Measured from the providers' own price pages:
//   • OpenAI gpt-5.4 / 5.5 / 5.6-* / every gpt-6-*: >272K input tokens doubles
//     input and raises output ~1.5x. ("Short context: <=272K input tokens.
//     Long context: >272K input tokens." — developers.openai.com/api/docs/pricing)
//   • Anthropic Claude Haiku 5.5: >100K prompt tokens is 5x on every bucket.
// This house routinely crosses both thresholds (one soul file is ~145 KB), so
// short-context-only numbers under-report the models most used for long work.
//
// The mechanism is deliberately the SAME SHAPE as peak/off-peak: optional
// fields, absent on every row that has no tier, and absence is a no-op. That is
// what makes this safe to add to a live table — no existing row changes
// behaviour because no existing row carries the fields.
//
// NOTE: no row carries BOTH a peak schedule and a long-context tier today
// (DeepSeek has peak; OpenAI/Anthropic have long). If one ever does, peak wins
// below — and that precedence is NOT verified against any provider's rules.
// Measure it before relying on it.
//
// OAuth Claude is priced exactly like the Claude API (same model ids, no
// separation) — the user pays real subscription/credit value either way and
// wants to see it. Local models are never priced (caller skips them).

import PRICING from './modelPricing.json';

export interface ModelPrice {
  input: number;       // USD per 1M uncached input tokens (cache MISS) — OFF-PEAK
  cachedInput: number; // USD per 1M cache-hit input tokens — OFF-PEAK
  cacheWrite: number;  // USD per 1M cache-creation tokens (Anthropic; 0 elsewhere)
  output: number;      // USD per 1M output tokens — OFF-PEAK
  // Optional peak/off-peak (DeepSeek V4). Absent on every other provider.
  peakInput?: number;
  peakCachedInput?: number;
  peakOutput?: number;
  peakHoursUtc?: [number, number][]; // [startHour, endHour) UTC ranges; weekends off-peak
  // Optional long-context tier (OpenAI GPT-5.4+ / GPT-6: 272000; Claude Haiku
  // 5.5: 100000). The base fields above are the SHORT-context rates; these
  // replace them once the prompt exceeds `longContextThreshold` INPUT tokens.
  // Absent → no tier → the base rates always apply.
  longContextThreshold?: number;
  longContextInput?: number;
  longContextCachedInput?: number;
  longContextCacheWrite?: number;
  longContextOutput?: number;
}

export interface CacheUsageLike {
  totalInputTokens?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  // The provider's OWN total for the request, in USD, when it reports one.
  // Today only xAI's /v1/responses does (`cost_in_usd_ticks`). When present it
  // WINS over the token-table arithmetic below, because it includes charges the
  // token buckets cannot represent — server-side search calls, which on a real
  // 6-search turn were 29% of the bill.
  reportedUsd?: number;
  serverToolCalls?: number;
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

/** True when a UTC timestamp falls inside a model's peak-pricing window. */
export function isPeakTime(timestamp: number | null | undefined, peakHoursUtc?: [number, number][]): boolean {
  if (!timestamp || !peakHoursUtc || peakHoursUtc.length === 0) return false;
  const d = new Date(timestamp);
  const day = d.getUTCDay(); // 0 = Sun … 6 = Sat
  if (day === 0 || day === 6) return false; // weekends are always off-peak
  const h = d.getUTCHours();
  return peakHoursUtc.some(([start, end]) => h >= start && h < end);
}

/** True when a prompt is large enough to be billed at a model's long-context
 *  rates. False whenever the model has no tier or the prompt size is unknown —
 *  an unknown size must not silently pick the EXPENSIVE row. */
export function isLongContext(price: ModelPrice, promptTokens?: number | null): boolean {
  const threshold = price.longContextThreshold;
  if (!threshold || !promptTokens || promptTokens <= 0) return false;
  return promptTokens > threshold;
}

/** The effective rate row for a timestamp and prompt size: peak rates inside a
 *  peak window, long-context rates above the threshold, base rates otherwise.
 *  Returns the same object when neither applies. */
export function effectivePrice(
  price: ModelPrice,
  timestamp?: number | null,
  promptTokens?: number | null,
): ModelPrice {
  const peak = isPeakTime(timestamp, price.peakHoursUtc);
  const long = isLongContext(price, promptTokens);
  if (!peak && !long) return price;
  if (peak) {
    // See the header note: no row carries both tiers today, and peak winning
    // here is a choice, not a measured provider rule.
    return {
      input: price.peakInput ?? price.input,
      cachedInput: price.peakCachedInput ?? price.cachedInput,
      cacheWrite: price.cacheWrite,
      output: price.peakOutput ?? price.output,
    };
  }
  return {
    input: price.longContextInput ?? price.input,
    cachedInput: price.longContextCachedInput ?? price.cachedInput,
    cacheWrite: price.longContextCacheWrite ?? price.cacheWrite,
    output: price.longContextOutput ?? price.output,
  };
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
 * `timestamp` (ms) selects peak vs off-peak rates for peak/off-peak models.
 */
export function messageCost(
  cu: CacheUsageLike | undefined | null,
  modelId?: string | null,
  fallbackOutput?: number,
  timestamp?: number | null,
): { usd: number; breakdown: string } | null {
  const resolved = resolvePrice(modelId);
  if (!cu) return null;
  if (!resolved) {
    // No price row — but if the provider told us what it charged, that figure
    // is better than showing nothing.
    if (!(cu.reportedUsd && cu.reportedUsd > 0)) return null;
    return {
      usd: cu.reportedUsd,
      breakdown: `Cost reported by the provider: ${fmtUSD(cu.reportedUsd)}  (${normalizeId(modelId)})`,
    };
  }

  // Buckets FIRST: the long-context tier is selected by prompt size, so the
  // rate row cannot be chosen before the tokens are known.
  const cached = cu.cachedInputTokens ?? 0;
  const uncached =
    cu.uncachedInputTokens ??
    Math.max(0, (cu.totalInputTokens ?? 0) - cached);
  const cacheWrite = cu.cacheCreationTokens ?? 0;
  const output = cu.outputTokens || fallbackOutput || 0;

  if (uncached + cached + cacheWrite + output === 0) return null;

  // Every input token the provider counted toward this prompt. Anthropic's
  // threshold is stated over the prompt, and cache-read/cache-write tokens are
  // part of the prompt — billing them at the short rate while the uncached
  // remainder crossed the line would split one request across two tiers.
  const promptTokens = uncached + cached + cacheWrite;

  const hasPeak = !!resolved.peakHoursUtc?.length;
  const peak = hasPeak && isPeakTime(timestamp, resolved.peakHoursUtc);
  const long = isLongContext(resolved, promptTokens);
  const price = peak || long ? effectivePrice(resolved, timestamp, promptTokens) : resolved;

  const cIn = (uncached * price.input) / M;
  const cCached = (cached * price.cachedInput) / M;
  const cWrite = (cacheWrite * price.cacheWrite) / M;
  const cOut = (output * price.output) / M;
  const usd = cIn + cCached + cWrite + cOut;

  // Name the tier that was actually used. A long-context turn costs 2–5x the
  // headline number, so a figure with no label invites "that can't be right".
  const rateTag =
    (hasPeak ? (peak ? ' · PEAK rate' : ' · off-peak rate') : '') +
    (resolved.longContextThreshold
      ? long
        ? ` · long-context rate (>${resolved.longContextThreshold.toLocaleString()} prompt tokens)`
        : ' · short-context rate'
      : '');
  // When the provider reported its own total, that is the number to show and
  // the number to sum — the token lines below then explain only the part the
  // price table can account for, and the remainder is named as what it is.
  const reported = cu.reportedUsd && cu.reportedUsd > 0 ? cu.reportedUsd : null;
  const extra = reported !== null ? reported - usd : 0;
  const head =
    reported !== null
      ? `Cost reported by the provider: ${fmtUSD(reported)}  (${normalizeId(modelId)}${rateTag})\n`
      : `Estimated cost: ${fmtUSD(usd)}  (${normalizeId(modelId)}${rateTag})\n`;
  const breakdown =
    head +
    `  input uncached: ${uncached.toLocaleString()} × $${price.input}/M = ${fmtUSD(cIn)}\n` +
    (cached ? `  input cached:   ${cached.toLocaleString()} × $${price.cachedInput}/M = ${fmtUSD(cCached)}\n` : '') +
    (cacheWrite ? `  cache write:    ${cacheWrite.toLocaleString()} × $${price.cacheWrite}/M = ${fmtUSD(cWrite)}\n` : '') +
    `  output:         ${output.toLocaleString()} × $${price.output}/M = ${fmtUSD(cOut)}` +
    (reported !== null && Math.abs(extra) >= 0.000001
      ? `\n  server-side tools${cu.serverToolCalls ? ` (${cu.serverToolCalls} search call${cu.serverToolCalls === 1 ? '' : 's'})` : ''}: ${fmtUSD(extra)}`
      : '');

  return { usd: reported !== null ? reported : usd, breakdown };
}
