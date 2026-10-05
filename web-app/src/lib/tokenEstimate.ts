// ─────────────────────────────────────────────────────────────────────────────
// Offline token estimate — the fallback used when no exact counter is reachable.
//
// WHY THIS FILE EXISTS
// The exact counters (Anthropic `/v1/messages/count_tokens`, Gemini
// `countTokens`) are free, exact, and fast — measured 2026-10-05: a 2,000,000
// char payload counted in 1.1 s, and `count_tokens` returned EXACTLY the
// `usage.input_tokens` of a real request (151 and 96 on two model generations,
// byte-identical). So they stay the primary path. This file is only for when
// they cannot be reached: no key, no network, or the provider is down.
//
// WHAT WAS WRONG BEFORE
// The previous fallback was `ascii/4 + cjk + other/2`, family-blind. Measured
// against the exact counter on 70 real messages from this house's logs plus 14
// synthetic stress kinds:
//
//                        aggregate   mean |err|   badly-under (<0.9x)
//   old, on Claude 5        0.765x      27.6%        71 of 84
//   old, on Gemini          1.091x      19.8%        17 of 84
//
// Two independent causes:
//
//  1. `ascii/4` encodes ~4 chars/token, which was true for the Claude 4.5
//     generation and is NOT true for Claude 5. Measured on one identical
//     360-char English string, 2026-10-05:
//         claude-sonnet-5   151 tokens   (2.38 ch/tok)
//         claude-opus-5     150 tokens   (2.40 ch/tok)
//         claude-sonnet-4-5  96 tokens   (3.81 ch/tok)   <- the old assumption
//     Claude 5 emits ~1.57x more tokens for English than Claude 4.5. Nothing
//     about the text changed; the tokenizer generation did.
//
//  2. One coefficient set cannot serve two families. Measured English
//     chars/token: Claude 5 2.42, Gemini 4.46, DeepSeek 4.29, Kimi 4.17,
//     MiMo 4.17, Qwen 2.80. Applying the Claude weights to Gemini reads
//     1.500x — 50% over.
//
// THE `other` BUCKET WAS TOO COARSE
// Per-script cost measured by marginal slope (count(unit*40) - count(unit*20),
// which cancels the per-call envelope), 2026-10-05, tokens per character:
//
//     script       Claude 5   Gemini        script       Claude 5   Gemini
//     cyrillic        0.333    0.333        hiragana        1.000    0.571
//     greek           1.000    0.667        kanji           1.000    0.500
//     latin-ext       1.000    1.000        fullwidth       1.833    1.000
//     emoji           2.750    1.000        arabic          0.800    0.400
//     symbols         1.500    1.000        hebrew          1.000    0.500
//
// A single `other/2` weight is 1.5x OVER for Cyrillic and 5.5x UNDER for
// emoji. Cyrillic is split out because this house has a Russian-reading
// collaborator and Russian source documents; emoji/symbols are split out
// because under-estimating is the expensive direction. Fullwidth was inside
// the CJK bucket at 1.0 but measures 1.833 on Claude 5.
//
// RESULT (same 84 cases: 70 real messages + 14 stress kinds)
//                        aggregate   mean |err|   badly-under (<0.9x)   worst under
//   old, family-blind       0.765x      27.6%        71 of 84              0.193x
//   new, on Claude 5        1.043x      14.9%         8 of 84              0.408x
//   new, on Gemini          1.041x      13.0%         8 of 84              0.529x
//
// The remaining `badly-under` cases on Claude are base64 and JSON-blob text;
// see "WHERE THIS STOPS" below.
//
// WHERE THIS STOPS — and it does stop
// The worst remaining case is base64/hash-like ASCII: 1,080 chars of base64
// counts 1,086 tokens on Claude 5 (1.0 token per character) while English
// prose of the same length counts ~450. Both are pure ASCII, so NO
// character-class model can tell them apart. A "long alphanumeric run"
// feature was measured and rejected: it flags base64 correctly (1.006
// tok/char) but also flags 1,000 digits (0.340 tok/char) and long URLs
// (0.395), because density tracks entropy, not run length. Separating them
// needs an entropy pass, which is a new class of fragility for content that
// reaches message TEXT rarely (real base64 travels the attachment path, which
// is accounted separately). So base64-heavy text reads ~0.41x here, and that
// is the documented floor rather than a hidden one.
//
// DO NOT "improve" these numbers from memory or from a provider's docs page.
// They were produced by sending real text to the real counters. If a tokenizer
// generation changes again, the symptom is a drifting aggregate ratio, and the
// fix is to re-measure, not to re-reason.
// ─────────────────────────────────────────────────────────────────────────────

export type TokenFamily = 'claude' | 'gemini' | 'other';

type Weights = {
  /** per ASCII character (<0x80) that is not a digit */
  ascii: number;
  /**
   * Per ASCII digit (0-9). Split out because the ASCII bucket hides a large
   * spread, measured by marginal slope 2026-10-05 (tokens per character):
   *
   *                digits   letters
   *     Claude 5    0.335     0.625
   *     Gemini      1.000     0.188
   *
   * Gemini spends a whole token per digit — 5.3x what it spends on a letter.
   * Before the split, 1,000 digits read 278 against a true 1,000 (0.28x, the
   * worst case in the whole set); after, 1,000 (1.00x). On Claude the slope
   * is close to its prose rate so the aggregate does not move, but digit-heavy
   * text goes from 1.47x to 0.99x, and this house writes measurement tables.
   *
   * The `letters` slopes above are NOT used as weights: the probe string was
   * `abcdefghijklmnop`, which is not a word and therefore does not merge the
   * way real prose does. Prose rates come from the 70-real-sample fit.
   */
  digit: number;
  /** per CJK ideograph / kana / hangul / CJK punctuation character */
  cjk: number;
  /** per fullwidth form (U+FF00–FFEF) */
  fullwidth: number;
  /** per Cyrillic character (U+0400–052F) */
  cyrillic: number;
  /** per arrow / symbol / emoji character */
  symbol: number;
  /** everything else: Greek, Latin-Extended, Arabic, Hebrew, Devanagari, … */
  other: number;
};

const WEIGHTS: Record<TokenFamily, Weights> = {
  // Validated on 70 real messages from this house + 14 stress kinds against
  // `/v1/messages/count_tokens` (2026-10-05).
  claude: { ascii: 1 / 2.4, digit: 0.335, cjk: 1.00, fullwidth: 1.80, cyrillic: 0.45, symbol: 2.50, other: 1.00 },
  // Validated on the SAME 70 real messages against Gemini `countTokens`
  // (free), 2026-10-05.
  gemini: { ascii: 1 / 3.6, digit: 1.000, cjk: 0.65, fullwidth: 1.00, cyrillic: 0.40, symbol: 1.00, other: 1.00 },
  // NOT validated on real text — anchored only on four synthetic probes
  // (en/ja/code/ru) per family, so it is a deliberate compromise, not a fit.
  // Measured spread it has to cover (tokens per character, envelope removed):
  //       ascii            cjk              cyrillic
  //   DeepSeek 0.220    DeepSeek 0.531    DeepSeek 0.304
  //   Kimi     0.227    Kimi     0.812    Kimi     0.362
  //   MiMo     0.227    MiMo     0.696    MiMo     0.388
  //   Grok     0.211    Grok     0.400    Grok     0.216
  //   Qwen     0.344    Qwen     0.635    Qwen     0.349
  // Picking the max of each range would read 2x high for Grok and make the
  // bar useless; picking the min would under-report. These are mid-range.
  // A per-family profile is NOT offered on purpose: four synthetic probes
  // would look far more precise than they are.
  // `digit` deliberately equals `ascii` here: the digit slope was only
  // measured for Claude and Gemini, and inventing a third value would make
  // this profile look measured where it is not. Equal weights means these
  // families behave exactly as they did before the split.
  other: { ascii: 1 / 3.7, digit: 1 / 3.7, cjk: 0.65, fullwidth: 1.00, cyrillic: 0.35, symbol: 1.50, other: 1.00 },
};

/**
 * Map a model id or a folder's `aiName` to a tokenizer family.
 *
 * Local models resolve to `gemini`: the previous code did the same (it is the
 * closest free public tokenizer), and the local-model path has no counter of
 * its own.
 *
 * Claude 4.x deliberately resolves to `claude` even though its tokenizer is
 * ~1.57x less dense for English. `/api/tokens` is called with the FOLDER's
 * `aiName` ("Claude"), never a model id, so the generation is not knowable
 * here — and over-estimating on an older vessel costs headroom, while
 * under-estimating costs a rejected request.
 */
export function tokenFamilyFor(model?: string | null): TokenFamily {
  const m = (model || '').toLowerCase();
  if (!m) return 'other';
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) return 'claude';
  if (m.includes('gemini') || m.includes('gemma') || m.includes('local')) return 'gemini';
  return 'other';
}

/**
 * Estimate token count for `text`. Single pass over the string, no regex, no
 * allocation — measured under 2 ms for 6,000 characters.
 *
 * This is an ESTIMATE and is named as one. Callers that can reach an exact
 * counter must prefer it; see the header for why.
 */
export function estimateTokens(text: string, family: TokenFamily = 'other'): number {
  if (!text) return 0;
  const w = WEIGHTS[family] || WEIGHTS.other;
  let ascii = 0, dig = 0, cjk = 0, full = 0, cyr = 0, sym = 0, oth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) { if (c >= 0x30 && c <= 0x39) dig++; else ascii++; continue; }
    if (c >= 0x0400 && c <= 0x052F) { cyr++; continue; }
    if (c >= 0xFF00 && c <= 0xFFEF) { full++; continue; }
    if ((c >= 0x3000 && c <= 0x303F) || (c >= 0x3040 && c <= 0x9FFF)
      || (c >= 0xAC00 && c <= 0xD7AF)) { cjk++; continue; }
    // Arrows / shapes / dingbats, then astral-plane emoji.
    //
    // The surrogate pair is collapsed to ONE unit on purpose. The weights were
    // measured with a pass that iterates CODE POINTS, so counting a single
    // emoji as two units would silently double its weight: the emoji stress
    // case reads 0.87x counting code points and 1.43x counting UTF-16 units.
    // `charCodeAt` is kept (it is the fast path) and the low surrogate is
    // skipped explicitly instead.
    if (c >= 0xD800 && c <= 0xDBFF) {
      sym++;
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) i++;
      continue;
    }
    if ((c >= 0x2190 && c <= 0x2BFF) || (c >= 0xDC00 && c <= 0xDFFF)) { sym++; continue; }
    oth++;
  }
  return Math.ceil(ascii * w.ascii + dig * w.digit + cjk * w.cjk + full * w.fullwidth
    + cyr * w.cyrillic + sym * w.symbol + oth * w.other);
}

/** Convenience: resolve the family from a model name and estimate in one call. */
export function estimateTokensForModel(text: string, model?: string | null): number {
  return estimateTokens(text, tokenFamilyFor(model));
}
