import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { parseUpstreamError } from './bridgeErrorParse';
import { resolveGeminiMinThinkingLevel } from './modelVision';

// Disk cache for audio descriptions, keyed by SHA-256 of
// (audio bytes ‖ ears prompt ‖ ears model). Survives server restarts.
const EARS_CACHE_DIR = path.resolve(process.cwd(), '..', 'local_data', 'ears_cache');

async function ensureCacheDir(): Promise<void> {
  try { await fs.mkdir(EARS_CACHE_DIR, { recursive: true }); } catch {}
}

function cacheKey(bytes: Buffer, prompt: string, model: string): string {
  const h = crypto.createHash('sha256');
  h.update(bytes);
  h.update('\0');
  h.update(prompt);
  h.update('\0');
  h.update(model);
  return h.digest('hex');
}

export interface BridgeResult {
  description: string;
  fromCache: boolean;
  error?: string;
}

// Map common audio mime subtypes to the short format string DashScope/Qwen-Omni
// expects in `input_audio.format`. Falls back to 'mp3' for unknown subtypes —
// the upstream model usually tolerates the mismatch.
function audioFormatOf(mime: string): string {
  const sub = (mime.split('/')[1] || '').toLowerCase().replace(/^x-/, '');
  if (sub === 'mpeg') return 'mp3';
  if (sub === '3gpp') return '3gp';
  return sub || 'mp3';
}

async function callQwenOmni(params: {
  audioBase64: string;
  audioMimeType: string;
  earsPrompt: string;
  earsModel: string;
  qwenKey: string;
}): Promise<BridgeResult> {
  const { audioBase64, audioMimeType, earsPrompt, earsModel, qwenKey } = params;
  const dataUrl = `data:${audioMimeType};base64,${audioBase64}`;

  const body = {
    model: earsModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: earsPrompt },
          { type: 'input_audio', input_audio: { data: dataUrl, format: audioFormatOf(audioMimeType) } },
        ],
      },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
    // Force text-only output — Omni can return audio modality by default.
    modalities: ['text'],
  };

  const res = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${qwenKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[ears/qwen] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[audio — ${earsModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }

  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[audio — ears returned an empty description]', fromCache: false, error: 'empty' };
  }
  return { description, fromCache: false };
}

async function callMimoAudio(params: {
  audioBase64: string;
  audioMimeType: string;
  earsPrompt: string;
  earsModel: string;
  mimoKey: string;
}): Promise<BridgeResult> {
  const { audioBase64, audioMimeType, earsPrompt, earsModel, mimoKey } = params;
  const dataUrl = `data:${audioMimeType};base64,${audioBase64}`;
  // Xiaomi MiMo hosted API is OpenAI-compatible with native audio understanding.
  // Uses the OpenAI `input_audio` content part. No thinking toggle.
  const body = {
    model: earsModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: earsPrompt },
          { type: 'input_audio', input_audio: { data: dataUrl, format: audioFormatOf(audioMimeType) } },
        ],
      },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
  };
  const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${mimoKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[ears/mimo] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[audio — ${earsModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }
  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[audio — ears returned an empty description]', fromCache: false, error: 'empty' };
  }
  return { description, fromCache: false };
}

async function callGeminiAudio(params: {
  audioBase64: string;
  audioMimeType: string;
  earsPrompt: string;
  earsModel: string;
  geminiKey: string;
}): Promise<BridgeResult> {
  const { audioBase64, audioMimeType, earsPrompt, earsModel, geminiKey } = params;

  // Some Gemini models reject `thinkingLevel: 'minimal'` outright (the API
  // replies with "Thinking level MINIMAL is not supported for this model") —
  // all Pro variants, and as of launch, Gemini 3.7 Flash too. Resolve to the
  // lowest level this specific model actually accepts.
  const bridgeThinkLevel = resolveGeminiMinThinkingLevel(earsModel);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: earsPrompt },
          { inlineData: { mimeType: audioMimeType, data: audioBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      // Gemini 3.x always thinks — pick the lowest level the model accepts.
      thinkingConfig: { thinkingLevel: bridgeThinkLevel, includeThoughts: false },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(earsModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[ears/gemini] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[audio — ${earsModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }

  const data = await res.json();
  const description = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p?.text || '')
    .join('')
    .trim();
  if (!description) {
    return { description: '[audio — ears returned an empty description]', fromCache: false, error: 'empty' };
  }
  return { description, fromCache: false };
}

/**
 * Describe an audio file by sending it to a multimodal model. Bridges audio
 * content to non-audio primary models: NEXUS calls describeAudio() on each
 * incoming audio attachment, then substitutes the raw bytes with the text
 * description.
 *
 * Provider routing is based on the model name prefix:
 *   • starts with "qwen"   → DashScope international (uses qwenKey)
 *   • starts with "gemini" → Google Generative Language API (uses geminiKey)
 *   • starts with "mimo"   → Xiaomi MiMo hosted API (uses mimoKey)
 *
 * Cached on disk under local_data/ears_cache/<sha256>.txt — same image-cache
 * pattern as the eyes feature.
 */
async function callSeedAudio(params: {
  audioBase64: string;
  audioMimeType: string;
  earsPrompt: string;
  earsModel: string;
  bytedanceKey: string;
}): Promise<BridgeResult> {
  const { audioBase64, audioMimeType, earsPrompt, earsModel, bytedanceKey } = params;
  // ByteDance Seed 2.0 Lite (omni-modal) via BytePlus ModelArk. Ark's supported
  // content types are exactly: text, image_url, video_url, input_audio, file — so
  // audio uses OpenAI's `input_audio` part. The catch: Ark schema-validates
  // `input_audio.data` as PURE base64 (no `data:<mime>;base64,` prefix) with a
  // separate short `format`. Qwen/MiMo tolerate the full data URL, but Ark
  // rejects the prefixed string and nulls the whole message ("messages[i] …
  // expected an object, but got null"). Send raw base64 here. No thinking toggle.
  const body = {
    model: earsModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: earsPrompt },
          { type: 'input_audio', input_audio: { data: audioBase64, format: audioFormatOf(audioMimeType) } },
        ],
      },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
  };
  const res = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bytedanceKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[ears/seed] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[audio — ${earsModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }
  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[audio — ears returned an empty description]', fromCache: false, error: 'empty' };
  }
  return { description, fromCache: false };
}

export async function describeAudio(params: {
  audioBase64: string;
  audioMimeType: string;
  earsPrompt: string;
  earsModel: string;
  qwenKey: string;
  geminiKey: string;
  mimoKey?: string;
  bytedanceKey?: string;
}): Promise<BridgeResult> {
  const { audioBase64, audioMimeType, earsPrompt, earsModel, qwenKey, geminiKey, mimoKey, bytedanceKey } = params;

  if (!earsPrompt || !earsPrompt.trim()) {
    return { description: '[audio — ears prompt is empty]', fromCache: false, error: 'no_prompt' };
  }
  if (!audioBase64) {
    return { description: '[audio — empty audio data]', fromCache: false, error: 'no_audio' };
  }

  // Cache lookup.
  const bytes = Buffer.from(audioBase64, 'base64');
  const key = cacheKey(bytes, earsPrompt, earsModel);
  await ensureCacheDir();
  const cachePath = path.join(EARS_CACHE_DIR, key + '.txt');
  try {
    const cached = await fs.readFile(cachePath, 'utf8');
    if (cached && cached.trim()) return { description: cached, fromCache: true };
  } catch { /* miss — fall through */ }

  // Route by model prefix.
  const lower = earsModel.toLowerCase();
  let result: BridgeResult;
  try {
    if (lower.startsWith('qwen')) {
      if (!qwenKey) return { description: '[audio — ears needs Qwen API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callQwenOmni({ audioBase64, audioMimeType, earsPrompt, earsModel, qwenKey });
    } else if (lower.startsWith('gemini')) {
      if (!geminiKey) return { description: '[audio — ears needs Google API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callGeminiAudio({ audioBase64, audioMimeType, earsPrompt, earsModel, geminiKey });
    } else if (lower.startsWith('mimo')) {
      if (!mimoKey) return { description: '[audio — ears needs MiMo API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callMimoAudio({ audioBase64, audioMimeType, earsPrompt, earsModel, mimoKey });
    } else if (lower.startsWith('seed')) {
      if (!bytedanceKey) return { description: '[audio — ears needs ByteDance API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callSeedAudio({ audioBase64, audioMimeType, earsPrompt, earsModel, bytedanceKey });
    } else {
      return {
        description: `[audio — ears model "${earsModel}" not recognised (must start with "qwen", "gemini", "mimo", or "seed")]`,
        fromCache: false, error: 'bad_model',
      };
    }
  } catch (e: any) {
    return {
      description: `[audio — ears exception: ${e?.message || 'unknown error'}]`,
      fromCache: false, error: 'exception',
    };
  }

  // Cache successful descriptions only (don't cache error placeholders).
  if (!result.error) {
    try { await fs.writeFile(cachePath, result.description, 'utf8'); } catch {}
  }
  return result;
}
