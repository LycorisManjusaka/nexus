import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { parseUpstreamError } from './bridgeErrorParse';

// Cache root. One file per (image, eyes prompt, eyes model) tuple, keyed by
// SHA-256. Easy to inspect (cat the .txt) or clear (delete the file or the
// whole directory). Survives server restarts.
const EYES_CACHE_DIR = path.resolve(process.cwd(), '..', 'local_data', 'eyes_cache');

async function ensureCacheDir(): Promise<void> {
  try {
    await fs.mkdir(EYES_CACHE_DIR, { recursive: true });
  } catch {
    // Directory may already exist or path may be unwritable — caller falls
    // back to no-cache behavior on read failure below.
  }
}

function cacheKey(imageBytes: Buffer, eyesPrompt: string, eyesModel: string): string {
  const h = crypto.createHash('sha256');
  h.update(imageBytes);
  h.update('\0');
  h.update(eyesPrompt);
  h.update('\0');
  h.update(eyesModel);
  return h.digest('hex');
}

export interface EyesResult {
  description: string;
  fromCache: boolean;
  error?: string;
}

// ── Provider implementations ───────────────────────────────────────────────

async function callZaiVision(params: {
  imageBase64: string;
  imageMimeType: string;
  eyesPrompt: string;
  eyesModel: string;
  zaiKey: string;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, zaiKey } = params;
  const dataUrl = `data:${imageMimeType};base64,${imageBase64}`;
  const body = {
    model: eyesModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: eyesPrompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
    thinking: { type: 'disabled' },
  };
  const res = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${zaiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[eyes/zai] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[image — ${eyesModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }
  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty' };
  }
  return { description, fromCache: false };
}

async function callMimoVision(params: {
  imageBase64: string;
  imageMimeType: string;
  eyesPrompt: string;
  eyesModel: string;
  mimoKey: string;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, mimoKey } = params;
  const dataUrl = `data:${imageMimeType};base64,${imageBase64}`;
  // Xiaomi MiMo hosted API is OpenAI-compatible. Reasoning is built in (no
  // thinking toggle), so we send a plain chat-completions request. Only the
  // `mimo-v2.5` tier accepts image input — `mimo-v2.5-pro` is text-only.
  const body = {
    model: eyesModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: eyesPrompt },
          { type: 'image_url', image_url: { url: dataUrl } },
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
    console.error(`[eyes/mimo] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[image — ${eyesModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }
  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty' };
  }
  return { description, fromCache: false };
}

async function callGeminiVision(params: {
  imageBase64: string;
  imageMimeType: string;
  eyesPrompt: string;
  eyesModel: string;
  geminiKey: string;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, geminiKey } = params;
  // Pro variants reject `thinkingLevel: 'minimal'` — same constraint as the
  // ears/watcher Gemini paths. 'low' is the lowest Pro accepts.
  const bridgeThinkLevel = eyesModel.toLowerCase().includes('pro') ? 'low' : 'minimal';
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: eyesPrompt },
          { inlineData: { mimeType: imageMimeType, data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      thinkingConfig: { thinkingLevel: bridgeThinkLevel, includeThoughts: false },
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(eyesModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[eyes/gemini] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[image — ${eyesModel} could not describe it: ${cleanMsg}]`,
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
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty' };
  }
  return { description, fromCache: false };
}

/**
 * Describe an image by sending it to a multimodal model. Used to bridge
 * vision content to text-only models: NEXUS calls describeImage() on each
 * incoming image, then substitutes the image with the returned description
 * in the message that gets sent to the text-only model.
 *
 * Provider routing by model name prefix:
 *   • starts with "glm"    → Z.AI GLM family (uses zaiKey)
 *   • starts with "gemini" → Google Generative Language API (uses geminiKey)
 *   • starts with "mimo"   → Xiaomi MiMo hosted API (uses mimoKey)
 *   • anything else        → defaults to Z.AI (legacy behavior; assumes the
 *                            user typed a GLM model name without the prefix)
 *
 * Results are cached on disk by (imageBytes, eyesPrompt, eyesModel) so the
 * same image isn't described twice across turns or conversations. The cache
 * lives at local_data/eyes_cache/<sha256>.txt — inspect or clear it freely.
 */
export async function describeImage(params: {
  imageBase64: string;
  imageMimeType: string;
  eyesPrompt: string;
  eyesModel: string;
  zaiKey: string;
  geminiKey?: string;
  mimoKey?: string;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, zaiKey, geminiKey, mimoKey } = params;

  if (!eyesPrompt || !eyesPrompt.trim()) {
    return {
      description: '[image — eyes prompt is empty; configure it in Conversation Settings]',
      fromCache: false,
      error: 'no_prompt',
    };
  }
  if (!imageBase64) {
    return { description: '[image — empty image data]', fromCache: false, error: 'no_image' };
  }

  // Cache lookup.
  const bytes = Buffer.from(imageBase64, 'base64');
  const key = cacheKey(bytes, eyesPrompt, eyesModel);
  await ensureCacheDir();
  const cachePath = path.join(EYES_CACHE_DIR, key + '.txt');
  try {
    const cached = await fs.readFile(cachePath, 'utf8');
    if (cached && cached.trim()) {
      return { description: cached, fromCache: true };
    }
  } catch {
    // Cache miss — fall through to API call.
  }

  // Route by model prefix.
  const lower = eyesModel.toLowerCase();
  let result: EyesResult;
  try {
    if (lower.startsWith('gemini')) {
      if (!geminiKey) {
        return {
          description: '[image — eyes via Gemini needs a Google API key in Settings]',
          fromCache: false,
          error: 'no_key',
        };
      }
      result = await callGeminiVision({ imageBase64, imageMimeType, eyesPrompt, eyesModel, geminiKey });
    } else if (lower.startsWith('mimo')) {
      if (!mimoKey) {
        return {
          description: '[image — eyes via MiMo needs a MiMo API key in Settings]',
          fromCache: false,
          error: 'no_key',
        };
      }
      result = await callMimoVision({ imageBase64, imageMimeType, eyesPrompt, eyesModel, mimoKey });
    } else {
      // GLM family (or unrecognized — assume GLM for backward compat).
      if (!zaiKey) {
        return {
          description: '[image — eyes via GLM needs a Z.AI API key in Settings]',
          fromCache: false,
          error: 'no_key',
        };
      }
      result = await callZaiVision({ imageBase64, imageMimeType, eyesPrompt, eyesModel, zaiKey });
    }
  } catch (e: any) {
    return {
      description: `[image — eyes exception: ${e?.message || 'unknown error'}]`,
      fromCache: false,
      error: 'exception',
    };
  }

  // Best-effort cache write — only successful descriptions, never error placeholders.
  if (!result.error) {
    try {
      await fs.writeFile(cachePath, result.description, 'utf8');
    } catch {
      // ignore
    }
  }
  return result;
}
