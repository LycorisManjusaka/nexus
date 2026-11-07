/**
 * PRICING PROPERTY: a provider that reports cache CREATION must have a
 * non-zero `cacheWrite` rate, or NEXUS bills that half of the turn at $0.
 *
 * REGRESSION, reported by Fuwafuwa 2026-11-07. One kimi-k3.1-pro turn in Kana's
 * house came back with
 *
 *   input_tokens: 67        cache_creation_input_tokens: 287,232
 *   output_tokens: 3,384    cache_read_input_tokens: 0
 *
 * and NEXUS printed "Estimated cost: $0.0340 … cache write: 287,232 × $0/M".
 * Moonshot's own console reported $0.60962 for the day; subtracting ~$0.012 of
 * probe traffic leaves ~$0.597, and pricing cache writes at the ordinary input
 * rate predicts $0.6084. A ~2% match against the real invoice, versus an 18x
 * under-report at cacheWrite:0.
 *
 * WHY THE DEFECT WAS INVISIBLE. `cacheWrite: 0` is CORRECT for 66 of the rows
 * in this table: OpenAI-compatible providers never return a cache-creation
 * count, so the field multiplies by zero tokens and the value is unobservable.
 * Only Claude's own rows carried a real premium (1.25x) — because only Claude
 * ran on the Anthropic surface when those rows were written. Kimi and MiMo were
 * later routed to `…/anthropic/v1/messages` *because their hands are weak*, and
 * on that surface the response carries cache_creation_input_tokens. The zero
 * stopped being a no-op and became a silent 18x discount, on a field nobody
 * re-reads, with a reassuring number printed next to it.
 *
 * I ADDED THE NEWEST ONE MYSELF, one day earlier, copying the shape of the row
 * above it. That is what this test is for: the next Kimi model will be added
 * the same way.
 *
 * SCOPE. Kimi only. MiMo rides the same surface with cacheWrite:0 and is NOT
 * asserted here: no MiMo turn in this house has ever reported a non-zero
 * cache-creation count, so its rate is unmeasured and guessing it would trade a
 * measured zero for an unmeasured number. If a MiMo turn ever reports one, this
 * is the test to widen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import prices from '../../src/lib/modelPricing.json';
import { resolvePrice } from '../../src/lib/modelPricing';

type Row = { input: number; cachedInput?: number; cacheWrite?: number; output: number };

const kimiRows = Object.entries(prices as Record<string, unknown>)
  .filter(([k, v]) => k.startsWith('kimi-') && v && typeof v === 'object')
  .map(([k, v]) => [k, v as Row] as const);

describe('Kimi pricing — cache writes are billed, not free', () => {
  it('has rows to check at all', () => {
    assert.ok(kimiRows.length >= 6, `found ${kimiRows.length} kimi rows`);
  });

  for (const [id, row] of kimiRows) {
    it(`${id}: cacheWrite equals the input rate`, () => {
      assert.ok(row.input > 0, 'an input rate is required to derive the write rate');
      assert.notEqual(row.cacheWrite, 0, 'a $0 write rate silently discounts this provider ~18x');
      assert.equal(
        row.cacheWrite, row.input,
        'measured against a real Moonshot invoice: a cache WRITE costs the ordinary '
        + 'input rate on this provider (1.0x, unlike Anthropic\'s own 1.25x premium)',
      );
    });
  }

  it('reads back through the real resolver, moonshotai/ prefix and casing included', () => {
    // The id stored in a log is the vendor-qualified, mixed-case form. A scan
    // that lowercases without stripping the prefix finds nothing and reports a
    // clean bill — which is how I first mis-measured this.
    const p = resolvePrice('moonshotai/Kimi-K3.1-Pro');
    assert.ok(p, 'the stored id must resolve');
    assert.equal(p!.cacheWrite, p!.input);
  });

  it('leaves the OpenAI-compatible rows alone — zero is right where no count is reported', () => {
    const gpt = resolvePrice('gpt-6-sol');
    assert.ok(gpt, 'control row must exist');
    assert.equal(gpt!.cacheWrite, 0, 'this is not a blanket "cacheWrite must be non-zero" rule');
  });
});
