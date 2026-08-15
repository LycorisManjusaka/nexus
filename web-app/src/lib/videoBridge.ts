import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { parseUpstreamError } from './bridgeErrorParse';
import { resolveGeminiMinThinkingLevel } from './modelVision';

// Disk cache for video descriptions. One file per (video bytes ‖ prompt ‖ model)
// tuple, keyed by SHA-256. Video descriptions are typically the most expensive
// bridge call (largest payload + slowest model latency), so caching matters most
// here.
const WATCHER_CACHE_DIR = path.resolve(process.cwd(), '..', 'local_data', 'watcher_cache');

async function ensureCacheDir(): Promise<void> {
  try { await fs.mkdir(WATCHER_CACHE_DIR, { recursive: true }); } catch {}
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

async function callQwenOmniVideo(params: {
  videoBase64: string;
  videoMimeType: string;
  watcherPrompt: string;
  watcherModel: string;
  qwenKey: string;
  attachmentName?: string;
}): Promise<BridgeResult> {
  const { videoBase64, videoMimeType, watcherPrompt, watcherModel, qwenKey, attachmentName } = params;
  const tag = `[watcher/qwen ${attachmentName || '(unnamed)'}]`;
  const decodedBytes = Math.floor(videoBase64.length * 0.75);
  const sizeMiB = (decodedBytes / 1024 / 1024).toFixed(2);
  console.log(`${tag} POST → DashScope · model=${watcherModel} · mime=${videoMimeType} · decoded≈${sizeMiB} MiB · base64=${(videoBase64.length / 1024 / 1024).toFixed(2)} MiB`);
  const dataUrl = `data:${videoMimeType};base64,${videoBase64}`;

  const body = {
    model: watcherModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: watcherPrompt },
          { type: 'video_url', video_url: { url: dataUrl } },
        ],
      },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
    modalities: ['text'],
  };

  const t0 = Date.now();
  const res = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${qwenKey}`,
    },
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - t0;

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`${tag} HTTP ${res.status} after ${elapsedMs} ms · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[video "${attachmentName || 'unnamed'}" — ${watcherModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }

  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    console.error(`${tag} HTTP 200 but empty content. Raw body: ${JSON.stringify(data).slice(0, 500)}`);
    return { description: '[video — watcher returned an empty description]', fromCache: false, error: 'empty' };
  }
  console.log(`${tag} OK in ${elapsedMs} ms · ${description.length} chars described`);
  return { description, fromCache: false };
}

async function callMimoVideo(params: {
  videoBase64: string;
  videoMimeType: string;
  watcherPrompt: string;
  watcherModel: string;
  mimoKey: string;
  attachmentName?: string;
}): Promise<BridgeResult> {
  const { videoBase64, videoMimeType, watcherPrompt, watcherModel, mimoKey, attachmentName } = params;
  const tag = `[watcher/mimo ${attachmentName || '(unnamed)'}]`;
  const decodedBytes = Math.floor(videoBase64.length * 0.75);
  console.log(`${tag} POST → MiMo · model=${watcherModel} · mime=${videoMimeType} · decoded≈${(decodedBytes / 1024 / 1024).toFixed(2)} MiB`);
  const dataUrl = `data:${videoMimeType};base64,${videoBase64}`;
  // Xiaomi MiMo hosted API is OpenAI-compatible with native video understanding.
  // Uses the `video_url` content part (same convention as DashScope). No
  // thinking toggle (reasoning is built in).
  const body = {
    model: watcherModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: watcherPrompt },
          { type: 'video_url', video_url: { url: dataUrl } },
        ],
      },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
  };
  const t0 = Date.now();
  const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${mimoKey}`,
    },
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`${tag} HTTP ${res.status} after ${elapsedMs} ms · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[video "${attachmentName || 'unnamed'}" — ${watcherModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }
  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    console.error(`${tag} HTTP 200 but empty content. Raw body: ${JSON.stringify(data).slice(0, 500)}`);
    return { description: '[video — watcher returned an empty description]', fromCache: false, error: 'empty' };
  }
  console.log(`${tag} OK in ${elapsedMs} ms · ${description.length} chars described`);
  return { description, fromCache: false };
}

async function callGeminiVideo(params: {
  videoBase64: string;
  videoMimeType: string;
  watcherPrompt: string;
  watcherModel: string;
  geminiKey: string;
  attachmentName?: string;
}): Promise<BridgeResult> {
  const { videoBase64, videoMimeType, watcherPrompt, watcherModel, geminiKey, attachmentName } = params;
  const tag = `[watcher/gemini ${attachmentName || '(unnamed)'}]`;
  const decodedBytes = Math.floor(videoBase64.length * 0.75);
  console.log(`${tag} POST → Gemini · model=${watcherModel} · mime=${videoMimeType} · decoded≈${(decodedBytes / 1024 / 1024).toFixed(2)} MiB`);

  // Some Gemini models reject `thinkingLevel: 'minimal'` outright (the API
  // replies with "Thinking level MINIMAL is not supported for this model") —
  // all Pro variants, and as of launch, Gemini 3.7 Flash too. Resolve to the
  // lowest level this specific model actually accepts.
  const bridgeThinkLevel = resolveGeminiMinThinkingLevel(watcherModel);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: watcherPrompt },
          { inlineData: { mimeType: videoMimeType, data: videoBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.3,
      topP: 0.9,
      thinkingConfig: { thinkingLevel: bridgeThinkLevel, includeThoughts: false },
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(watcherModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`${tag} HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[video "${attachmentName || 'unnamed'}" — ${watcherModel} could not describe it: ${cleanMsg}]`,
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
    console.error(`${tag} HTTP 200 but empty content. Raw body: ${JSON.stringify(data).slice(0, 500)}`);
    return { description: '[video — watcher returned an empty description]', fromCache: false, error: 'empty' };
  }
  console.log(`${tag} OK · ${description.length} chars described`);
  return { description, fromCache: false };
}

/**
 * Describe a video by sending it to a multimodal model. Bridges video content
 * to non-video primary models. Used for both user-attached video files and
 * (eventually) tool-read video files in the agent workspace.
 *
 * Provider routing by model name prefix:
 *   • starts with "qwen"   → DashScope international (uses qwenKey)
 *   • starts with "gemini" → Google Generative Language API (uses geminiKey)
 *   • starts with "mimo"   → Xiaomi MiMo hosted API (uses mimoKey)
 *
 * Cached on disk under local_data/watcher_cache/<sha256>.txt — same pattern as
 * eyes/ears. Video descriptions are slow to generate (5-30 s typical), so the
 * cache hit on subsequent turns is a significant UX improvement.
 */
async function callSeedVideo(params: {
  videoBase64: string;
  videoMimeType: string;
  watcherPrompt: string;
  watcherModel: string;
  bytedanceKey: string;
  attachmentName?: string;
}): Promise<BridgeResult> {
  const { videoBase64, videoMimeType, watcherPrompt, watcherModel, bytedanceKey, attachmentName } = params;
  const tag = `[watcher/seed ${attachmentName || '(unnamed)'}]`;
  const decodedBytes = Math.floor(videoBase64.length * 0.75);
  console.log(`${tag} POST → ByteDance ModelArk · model=${watcherModel} · mime=${videoMimeType} · decoded≈${(decodedBytes / 1024 / 1024).toFixed(2)} MiB`);
  const dataUrl = `data:${videoMimeType};base64,${videoBase64}`;
  // ByteDance Seed 2.0 Lite (omni-modal) via BytePlus ModelArk's OpenAI-compatible
  // endpoint. Uses the `video_url` content part (same convention as DashScope /
  // MiMo). Reasoning is built in; no thinking toggle.
  const body = {
    model: watcherModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: watcherPrompt },
          { type: 'video_url', video_url: { url: dataUrl } },
        ],
      },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
  };
  const t0 = Date.now();
  const res = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${bytedanceKey}`,
    },
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`${tag} HTTP ${res.status} after ${elapsedMs} ms · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[video "${attachmentName || 'unnamed'}" — ${watcherModel} could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }
  const data = await res.json();
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    console.error(`${tag} HTTP 200 but empty content. Raw body: ${JSON.stringify(data).slice(0, 500)}`);
    return { description: '[video — watcher returned an empty description]', fromCache: false, error: 'empty' };
  }
  console.log(`${tag} OK in ${elapsedMs} ms · ${description.length} chars described`);
  return { description, fromCache: false };
}

export async function describeVideo(params: {
  videoBase64: string;
  videoMimeType: string;
  watcherPrompt: string;
  watcherModel: string;
  qwenKey: string;
  geminiKey: string;
  mimoKey?: string;
  bytedanceKey?: string;
  attachmentName?: string;
}): Promise<BridgeResult> {
  const { videoBase64, videoMimeType, watcherPrompt, watcherModel, qwenKey, geminiKey, mimoKey, bytedanceKey, attachmentName } = params;
  const logName = attachmentName || '(unnamed)';

  if (!watcherPrompt || !watcherPrompt.trim()) {
    return { description: '[video — watcher prompt is empty]', fromCache: false, error: 'no_prompt' };
  }
  if (!videoBase64) {
    return { description: '[video — empty video data]', fromCache: false, error: 'no_video' };
  }

  const bytes = Buffer.from(videoBase64, 'base64');
  const sizeMiB = (bytes.length / 1024 / 1024).toFixed(2);
  const key = cacheKey(bytes, watcherPrompt, watcherModel);
  await ensureCacheDir();
  const cachePath = path.join(WATCHER_CACHE_DIR, key + '.txt');
  try {
    const cached = await fs.readFile(cachePath, 'utf8');
    if (cached && cached.trim()) {
      console.log(`[watcher ${logName}] DISK-CACHE hit · ${sizeMiB} MiB · skipping API call`);
      return { description: cached, fromCache: true };
    }
  } catch { /* miss */ }

  console.log(`[watcher ${logName}] cache miss · ${sizeMiB} MiB · routing to ${watcherModel}`);
  const lower = watcherModel.toLowerCase();
  let result: BridgeResult;
  try {
    if (lower.startsWith('qwen')) {
      if (!qwenKey) return { description: '[video — watcher needs Qwen API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callQwenOmniVideo({ videoBase64, videoMimeType, watcherPrompt, watcherModel, qwenKey, attachmentName });
    } else if (lower.startsWith('gemini')) {
      if (!geminiKey) return { description: '[video — watcher needs Google API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callGeminiVideo({ videoBase64, videoMimeType, watcherPrompt, watcherModel, geminiKey, attachmentName });
    } else if (lower.startsWith('mimo')) {
      if (!mimoKey) return { description: '[video — watcher needs MiMo API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callMimoVideo({ videoBase64, videoMimeType, watcherPrompt, watcherModel, mimoKey, attachmentName });
    } else if (lower.startsWith('seed')) {
      if (!bytedanceKey) return { description: '[video — watcher needs ByteDance API key in Settings]', fromCache: false, error: 'no_key' };
      result = await callSeedVideo({ videoBase64, videoMimeType, watcherPrompt, watcherModel, bytedanceKey, attachmentName });
    } else {
      return {
        description: `[video — watcher model "${watcherModel}" not recognised (must start with "qwen", "gemini", "mimo", or "seed")]`,
        fromCache: false, error: 'bad_model',
      };
    }
  } catch (e: any) {
    return {
      description: `[video — watcher exception: ${e?.message || 'unknown error'}]`,
      fromCache: false, error: 'exception',
    };
  }

  if (!result.error) {
    try { await fs.writeFile(cachePath, result.description, 'utf8'); } catch {}
  }
  return result;
}
