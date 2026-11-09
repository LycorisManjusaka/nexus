/**
 * modelPriceLabel — the dropdown's prices, read from the table instead of
 * written by hand.
 *
 * NEW TEST, written 2026-11-09 with the feature (津代's request: "make the
 * money objective, not subjective").
 *
 * WHAT CARRIES WEIGHT HERE, in order:
 *
 * 1. `shortPriceTag` returns null for a model with no price row.
 *    14 values in the dropdown have no row today (glm-4.6, glm-5,
 *    grok-code-fast-1, qwen3.5-omni-flash, deepseek-v3.2, command-a-*). The
 *    tempting shapes are "$0/$0" and "$?" — both of which READ as a measured
 *    price. An absent tag is the only honest output, and it's one `return null`
 *    away from being a lie.
 *
 * 2. `cacheWrite: 0` becomes null, not "$0".
 *    Zero in that column means "this provider doesn't bill cache creation
 *    separately" — 66 of 84 rows. Printing "$0" claims a measured free write.
 *    That exact confusion cost this house real money last week: Kimi's
 *    `cacheWrite: 0` silently under-reported a bill 18x, because a zero that
 *    means "absent" was treated as a zero that means "free".
 *
 * 3. Trailing zeros come off.
 *    A native <option> cannot wrap (the OS draws it), so every character in a
 *    tag competes with the model's name. "$0.60" and "$0.6" say the same
 *    thing about a rate; one is shorter.
 *
 * 4. Long-context and peak tiers survive into the detail panel.
 *    These are the "the fields differ per model" case 津代 flagged. They can't
 *    go in the <option>, so if they're dropped here they're not shown anywhere.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtRate,
  shortPriceTag,
  priceTiers,
  tagPriceOptions,
  fmtPeakHours,
  fmtThreshold,
} from '../../src/lib/modelPriceLabel';

describe('fmtRate', () => {
  it('prints whole dollars without decimals', () => {
    assert.equal(fmtRate(5), '$5');
    assert.equal(fmtRate(25), '$25');
  });

  it('strips trailing zeros — every character competes with the model name', () => {
    assert.equal(fmtRate(0.6), '$0.6');
    assert.equal(fmtRate(3.75), '$3.75');
    assert.equal(fmtRate(0.05), '$0.05');
  });

  it('keeps the cheapest real rate in the table', () => {
    // deepseek-chat cachedInput — the smallest non-zero value present.
    assert.equal(fmtRate(0.003), '$0.003');
  });

  it('prints an exact zero as $0 and refuses nonsense', () => {
    assert.equal(fmtRate(0), '$0');
    assert.equal(fmtRate(-1), '');
    assert.equal(fmtRate(NaN), '');
  });
});

describe('shortPriceTag', () => {
  it('reads the real table for a known model', () => {
    // claude-opus-5: input 5, cachedInput 0.5, output 25.
    assert.equal(shortPriceTag('claude-opus-5'), '$5/$0.5/$25');
  });

  it('includes the cache-read rate, not just input and output', () => {
    // 津代 asked for this explicitly (2026-11-09) after the first version
    // shipped as $in/$out. On a conversation that has been running a while,
    // cache reads are MOST of the bill (50-71% hit rate measured across 1,205
    // Gemini turns here), so a tag without it prices a turn nobody has.
    // Guarding it because the obvious "make the row shorter" edit is to drop
    // the middle number.
    const tag = shortPriceTag('claude-opus-5')!;
    assert.equal(tag.split('/').length, 3, 'three rates: input / cache read / output');
    assert.ok(tag.includes('$0.5'), 'the middle number is the cache-read rate');
  });

  it('normalizes the moonshotai/ prefix like the biller does', () => {
    // The dropdown value carries the prefix; the JSON key does not. If these
    // ever disagree, every Kimi row loses its price while looking fine.
    assert.equal(
      shortPriceTag('moonshotai/Kimi-K3.1-Pro'),
      shortPriceTag('kimi-k3.1-pro'),
    );
    assert.ok(shortPriceTag('moonshotai/Kimi-K3.1-Pro'));
  });

  it('returns null for a model with no row, rather than inventing one', () => {
    for (const id of ['glm-4.6', 'glm-5', 'grok-code-fast-1', 'qwen3.5-omni-flash']) {
      assert.equal(shortPriceTag(id), null, `${id} has no price row today`);
    }
  });

  it('returns null for non-model select values', () => {
    // The wrapper is applied to selects that hold effort levels and providers
    // too; those must come out untouched.
    for (const v of ['none', 'low', 'high', 'zai', 'digitalocean', '']) {
      assert.equal(shortPriceTag(v), null);
    }
  });
});

describe('priceTiers', () => {
  it('gives one band for an ordinary model', () => {
    const t = priceTiers('claude-opus-5');
    assert.ok(t);
    assert.equal(t!.length, 1);
    assert.equal(t![0].kind, 'base');
    assert.equal(t![0].input, '$5');
    assert.equal(t![0].output, '$25');
    // Anthropic DOES bill cache creation — this one must not be null.
    assert.equal(t![0].cacheWrite, '$6.25');
  });

  it('reports an absent cacheWrite as null, not $0', () => {
    const t = priceTiers('gemini-3.8-flash');
    assert.ok(t);
    assert.equal(t![0].cacheWrite, null);
  });

  it('adds the long-context band with its threshold', () => {
    const t = priceTiers('gpt-6.1-terra');
    assert.ok(t);
    assert.equal(t!.length, 2);
    const long = t!.find(x => x.kind === 'longContext');
    assert.ok(long);
    assert.equal(long!.threshold, 272000);
    assert.equal(long!.input, '$2');
    assert.equal(long!.output, '$7.5');
  });

  it('inherits base rates into a tier that does not override them', () => {
    // Only claude-haiku-5-5 overrides cacheWrite in its long-context tier;
    // everyone else must inherit rather than show a hole.
    const t = priceTiers('gpt-6.1-terra');
    const long = t!.find(x => x.kind === 'longContext')!;
    assert.equal(long.cacheWrite, t![0].cacheWrite);
  });

  it('adds the peak band with its UTC windows', () => {
    const t = priceTiers('deepseek-chat');
    assert.ok(t);
    const peak = t!.find(x => x.kind === 'peak');
    assert.ok(peak);
    assert.ok(Array.isArray(peak!.peakHoursUtc));
    // Peak input must be dearer than off-peak, or the bands are swapped.
    assert.ok(parseFloat(peak!.input.slice(1)) > parseFloat(t![0].input.slice(1)));
  });

  it('returns null for an unpriced model', () => {
    assert.equal(priceTiers('glm-4.6'), null);
    assert.equal(priceTiers(''), null);
  });
});

describe('tagPriceOptions', () => {
  it('tags priced rows and leaves unpriced ones exactly as they were', () => {
    const input = [
      { value: 'seed-2-0-pro-260328', label: 'Seed 2.0 Pro (text + image)' },
      { value: 'seed-2-0-mini-260428', label: 'Seed 2.0 Mini' },
    ];
    const out = tagPriceOptions(input);
    assert.ok(out[0].label.includes('$'), 'priced row gets a tag');
    assert.equal(out[1].label, 'Seed 2.0 Mini', 'unpriced row is untouched');
  });

  it('is idempotent — a double pass must not print the tag twice', () => {
    const once = tagPriceOptions([{ value: 'claude-opus-5', label: 'Opus 5' }]);
    const twice = tagPriceOptions(once);
    assert.equal(once[0].label, twice[0].label);
  });
});

describe('formatters for the detail panel', () => {
  it('renders thresholds the way a reader says them', () => {
    assert.equal(fmtThreshold(272000), '272K');
    assert.equal(fmtThreshold(100000), '100K');
    assert.equal(fmtThreshold(1000000), '1M');
    assert.equal(fmtThreshold(undefined), '');
  });

  it('renders peak windows compactly', () => {
    assert.equal(fmtPeakHours([[1, 4], [6, 10]]), '1–4, 6–10');
    assert.equal(fmtPeakHours([]), '');
    assert.equal(fmtPeakHours(undefined), '');
  });
});
