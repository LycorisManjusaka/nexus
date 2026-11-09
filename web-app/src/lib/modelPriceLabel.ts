/**
 * Objective price labels for the model dropdown — single source.
 *
 * WHY THIS EXISTS (2026-11-09, requested by 津代):
 * The dropdown used to carry hand-written comparative wording ("cheaper",
 * "~2x cheaper", "12.5x cheaper"). Those are three separate problems:
 *   1. They are claims about OTHER rows, so they go stale silently when a
 *      sibling model's price moves. Nothing checks them.
 *   2. They answer "cheaper than what?" only for a reader who already knows
 *      the sibling's price.
 *   3. They cost characters in a <option>, which cannot wrap (see below).
 * `modelPricing.json` already holds the real numbers, so the label can just
 * read them. A number is checkable; "cheaper" is not.
 *
 * ⚠ A NATIVE <option> CANNOT WRAP OR BE TALLER.
 * The OS renders the dropdown list, not the browser — no HTML, no newline,
 * no CSS line-height inside an <option>. So 津代's idea of letting a long row
 * take two lines is not available here; it would need replacing <select> with
 * a custom div-based listbox (10 families, 127 options). The split below is
 * the answer instead:
 *   - `shortPriceTag()` → the three rates that decide a bill, for the <option>.
 *   - `priceTiers()`    → every rate, for a panel UNDER the select, where
 *                         height is ours and wrapping works.
 * That also fixes 津代's "the fields differ per model": the <option> now
 * always carries exactly two numbers, and the per-model variation (cache
 * rates, long-context tiers, peak windows) lives where it has room.
 *
 * Rates are USD per 1M tokens, straight out of modelPricing.json.
 */

import { resolvePrice, type ModelPrice } from './modelPricing';

/**
 * Shortest honest form of a per-1M rate: "$5", "$0.75", "$0.003".
 *
 * NOT `fmtUSD` — that one formats a BILL (always 2/4/6 decimals: "$5.00",
 * "$0.0750"). A dropdown row is paying for every character, and trailing
 * zeros carry no information about a rate, so they come off. The value is
 * never rounded, only trimmed.
 */
export function fmtRate(v: number): string {
  if (!isFinite(v) || v < 0) return '';
  if (v === 0) return '$0';
  // 6 decimals covers the cheapest row in the table (deepseek cachedInput
  // 0.003) with room to spare; trailing zeros are then stripped.
  let s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + s;
}

/**
 * The compact `$in/$cacheRead/$out` tag for a dropdown row, or null when the
 * model has no price row at all.
 *
 * WHY CACHE-READ IS IN HERE AND NOT ONLY IN THE PANEL (津代, 2026-11-09):
 * it was `$in/$out` for about an hour, until she said cacheRead matters too
 * much to hide. She's right, and the house has the measurement: across 1,205
 * Gemini turns the implicit-cache hit rate ran 50–71%, so on any conversation
 * that has been going a while, the cache-read column — not the input column —
 * is most of the bill. A tag that omits it describes a cost nobody pays.
 * Three numbers cost ~5 characters more in a row that cannot wrap; that is
 * the trade she asked for, deliberately.
 *
 * `cacheWrite` is NOT here: it's 0 on all but the 17 Anthropic rows, so it
 * would be a blank column for most families. It's in the panel instead.
 *
 * Returning null (rather than "$0/$0/$0" or "?") is deliberate: 14 of the 92
 * priced-looking dropdown values are NOT in modelPricing.json today
 * (glm-4.6, glm-5, grok-code-fast-1, qwen3.5-omni-flash, deepseek-v3.2,
 * command-a-*, …). Printing a zero or a guess for those would be inventing a
 * price. An absent tag says "not in the table", which is true.
 */
export function shortPriceTag(modelId?: string | null): string | null {
  const p = resolvePrice(modelId);
  if (!p) return null;
  return `${fmtRate(p.input)}/${fmtRate(p.cachedInput)}/${fmtRate(p.output)}`;
}

/**
 * Append `$in/$out` to the labels of an `EditableCombo`-style options array.
 *
 * Not every model picker is a <select>: the ByteDance family uses
 * `EditableCombo`, which takes `{value, label}[]` instead of children, so
 * `ModelPriceSelect` can't reach it. Same contract as the wrapper — rows with
 * no pricing row are returned untouched, and an already-tagged label is left
 * alone — so the two paths can't disagree about what a tag looks like.
 */
export function tagPriceOptions<T extends { value: string; label: string }>(
  options: T[],
): T[] {
  return options.map((o) => {
    const tag = shortPriceTag(o.value);
    if (!tag || o.label.includes(tag)) return o;
    return { ...o, label: `${o.label} · ${tag}` };
  });
}

/** One rate band of a model: the base rates, or a long-context / peak tier. */
export interface PriceTier {
  kind: 'base' | 'longContext' | 'peak';
  /** longContext only: input tokens above which this tier replaces the base. */
  threshold?: number;
  /** peak only: [startHour, endHour) UTC ranges; weekends are always off-peak. */
  peakHoursUtc?: [number, number][];
  input: string;
  cachedInput: string;
  /** null when the provider doesn't bill cache creation separately (0 in the
   *  table). Printing "$0" there reads as a measured zero; it is an absence. */
  cacheWrite: string | null;
  output: string;
}

/**
 * Every rate band a model has, formatted, in the order a reader wants them:
 * base first, then whichever tiers exist. Returns null for an unpriced model.
 *
 * The table has exactly four row shapes (measured 2026-11-09 over 84 rows):
 *   base only ....................... 66
 *   base + longContext{,CacheWrite} .. 11
 *   base + peak ...................... 7
 * so this never needs more than two tiers.
 */
export function priceTiers(modelId?: string | null): PriceTier[] | null {
  const p = resolvePrice(modelId);
  if (!p) return null;

  const band = (
    kind: PriceTier['kind'],
    input: number,
    cachedInput: number,
    cacheWrite: number,
    output: number,
    extra?: Partial<PriceTier>,
  ): PriceTier => ({
    kind,
    input: fmtRate(input),
    cachedInput: fmtRate(cachedInput),
    cacheWrite: cacheWrite > 0 ? fmtRate(cacheWrite) : null,
    output: fmtRate(output),
    ...extra,
  });

  const tiers: PriceTier[] = [
    band('base', p.input, p.cachedInput, p.cacheWrite, p.output),
  ];

  if (p.longContextThreshold && p.longContextInput != null) {
    tiers.push(
      band(
        'longContext',
        p.longContextInput,
        p.longContextCachedInput ?? p.cachedInput,
        // Only claude-haiku-5-5 has a long-context cacheWrite; everyone else
        // keeps the base one (which is 0 outside Anthropic anyway).
        p.longContextCacheWrite ?? p.cacheWrite,
        p.longContextOutput ?? p.output,
        { threshold: p.longContextThreshold },
      ),
    );
  }

  if (p.peakInput != null) {
    tiers.push(
      band(
        'peak',
        p.peakInput,
        p.peakCachedInput ?? p.cachedInput,
        p.cacheWrite,
        p.peakOutput ?? p.output,
        { peakHoursUtc: p.peakHoursUtc },
      ),
    );
  }

  return tiers;
}

/** "1-4, 6-10" for a peak-hours spec — compact enough for one UI line. */
export function fmtPeakHours(ranges?: [number, number][]): string {
  if (!ranges || ranges.length === 0) return '';
  return ranges.map(([a, b]) => `${a}–${b}`).join(', ');
}

/** "272K" / "100K" / "1M" for a long-context threshold. */
export function fmtThreshold(n?: number): string {
  if (!n || n <= 0) return '';
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1000 === 0) return `${n / 1000}K`;
  return String(n);
}

export type { ModelPrice };
