import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import { loadKeys } from '@/lib/fsStorage';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';

let serverWarned = false;
// The optional local Python tokenizer at :50035 is usually NOT running. Probing
// it on every token count was the bottleneck: a dropped (non-refused) connection
// would hang the request for the full timeout, and the updater fires several
// counts on open. Fix: short timeout, and a cooldown so that once a probe fails
// we skip the server entirely for a while and go straight to the heuristic.
const PROBE_TIMEOUT_MS = 1200;
const PROBE_COOLDOWN_MS = 60_000;
let pythonUnavailableUntil = 0;

// ── Model ids used purely as tokenizer oracles ──────────────────────────────
// The counter only ever learns the FAMILY: `model` here is the folder's
// `aiName` ("Claude", "Gemini", …), never the id the conversation actually
// runs on. So one current id per family is pinned, and it must be an UNDATED
// alias — a dated id (this was `claude-3-5-sonnet-20241022`) eventually retires
// and then every single count 404s and silently degrades to the heuristic,
// which is exactly how it was found: one line repeating forever in the console.
// Measured 2026-09-14 on the same text: sonnet-5 38, opus-5 38, haiku-4-5 36,
// fable-5-1 40. So counts are NOT identical across the family, but the spread
// is a couple of tokens of per-message overhead — irrelevant to a context bar
// reading tens of thousands, and far smaller than the heuristic's error.
const TOKENIZER_MODEL_CLAUDE = 'claude-sonnet-5';
const TOKENIZER_MODEL_GEMINI = 'gemini-3.5-flash';

// If a pinned id ever retires again, the log must say so ONCE and then stop.
// A counter that cries the same wolf on every keystroke trains you to ignore
// the console, which is worse than no console.
const COUNT_TOKENS_COOLDOWN_MS = 10 * 60_000;
const providerCounterDownUntil: Record<string, number> = {};

function counterDown(family: string): boolean {
  return Date.now() < (providerCounterDownUntil[family] || 0);
}

function markCounterDown(family: string, err: any): void {
  const first = !counterDown(family);
  providerCounterDownUntil[family] = Date.now() + COUNT_TOKENS_COOLDOWN_MS;
  if (first) {
    console.warn(
      `[tokens] ${family} countTokens unavailable — falling back to the unicode-aware heuristic `
      + `for the next ${COUNT_TOKENS_COOLDOWN_MS / 60_000} min. `
      + `If this repeats, the pinned tokenizer id may have been retired. Reason: ${err?.message || err}`
    );
  }
}

const attemptFetch = async (text: string, model: string) => {
  // Skip the probe entirely while in the cooldown window after a recent failure.
  if (Date.now() < pythonUnavailableUntil) {
    throw new Error('python tokenizer in cooldown');
  }
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetch('http://127.0.0.1:50035', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model }),
      signal: controller.signal
    });
    clearTimeout(id);
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  } catch(e) {
    clearTimeout(id);
    // Remember it's down so subsequent counts don't pay the timeout again.
    pythonUnavailableUntil = Date.now() + PROBE_COOLDOWN_MS;
    throw e;
  }
};

// Smarter fallback than `length / 4`. The naive heuristic is fine for English
// (~4 chars/token in SentencePiece/BPE) but underestimates CJK text by 3-4×
// because each Japanese/Chinese/Korean character is roughly 1 token on its own.
// Bucket the string by Unicode range and weight accordingly.
const fallbackEstimate = (text: string): number => {
  let cjk = 0, ascii = 0, other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) ascii++;
    else if (
      // CJK Unified Ideographs (incl. Extension A) + Hiragana + Katakana +
      // Hangul + CJK punctuation/symbols. Covers the bulk of JP/ZH/KO text.
      (code >= 0x3040 && code <= 0x9FFF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF)
    ) cjk++;
    else other++;
  }
  // ASCII: ~4 chars/token, CJK: ~1 char/token, other (emoji/cyrillic/etc): ~2.
  return Math.ceil(ascii / 4 + cjk + other / 2);
};

export async function POST(req: Request) {
  try {
    const body = await req.json();
    let { text, model } = body;

    if (typeof text !== 'string') {
      return NextResponse.json({ error: 'Text must be a string' }, { status: 400 });
    }

    if (!text) {
      // Empty string — return 0 immediately, no API call needed.
      return NextResponse.json({ tokens: 0 });
    }

    const modelLower = typeof model === 'string' ? model.toLowerCase() : '';
    // For local models, treat them as Gemini-family for tokenizer purposes
    // (Gemini is the closest free public tokenizer we can hit reliably).
    if (modelLower.includes('local')) model = 'Gemini';

    // ── Primary: use the model family's own count_tokens endpoint ───────────
    // These are FREE on the official APIs (Gemini and Anthropic both expose
    // a no-charge counter) and give the EXACT token count the model will see.
    // The old Python server was using a generic BPE tokenizer that severely
    // undercounted CJK text — exactly matching the user-reported 2.45×
    // discrepancy on mixed Japanese/English content.
    const family = modelLower.includes('gemini') ? 'gemini'
      : modelLower.includes('claude') ? 'claude'
      : '';
    if (family && !counterDown(family)) {
      try {
        const keys = await loadKeys();
        if (family === 'gemini' && keys.gemini) {
          const ai = new GoogleGenAI({ apiKey: keys.gemini });
          const resp = await ai.models.countTokens({
            model: TOKENIZER_MODEL_GEMINI,
            contents: text,
          });
          const tokens = (resp as any).totalTokens ?? 0;
          if (tokens > 0) return NextResponse.json({ tokens });
        } else if (family === 'claude' && keys.claude) {
          const anthropic = new Anthropic({ apiKey: keys.claude });
          const result = await anthropic.messages.countTokens({
            model: TOKENIZER_MODEL_CLAUDE,
            messages: [{ role: 'user', content: text }],
          });
          const tokens = (result as any).input_tokens ?? 0;
          if (tokens > 0) return NextResponse.json({ tokens });
        }
        // Qwen/DeepSeek don't expose a free countTokens — fall through to
        // the local Python server (if running) or the unicode-aware heuristic.
      } catch (e: any) {
        markCounterDown(family, e);
      }
    }

    // ── Secondary: optional local Python tokenizer server at :50035 ─────────
    // Only used if the user has set one up out-of-tree. We don't try to spawn
    // it anymore (the bundled script was removed) — just probe and move on.
    try {
      const data = await attemptFetch(text, model);
      return NextResponse.json(data);
    } catch (e: any) {
      if (!serverWarned) {
        serverWarned = true;
        console.warn('[tokens] local Python tokenizer not reachable — using unicode-aware heuristic. Set up secure_token_counter/token_server.py to enable exact counts for Qwen/DeepSeek/etc.');
      }
    }

    // ── Tertiary: unicode-aware fallback ────────────────────────────────────
    return NextResponse.json({ tokens: fallbackEstimate(text) });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
