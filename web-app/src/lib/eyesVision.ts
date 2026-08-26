import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { parseUpstreamError } from './bridgeErrorParse';
import { resolveGeminiMinThinkingLevel } from './modelVision';
import { claudeAgentEnv } from './agentEnv';

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
  // Some Gemini models reject `thinkingLevel: 'minimal'` outright — same
  // constraint as the ears/watcher Gemini paths. Resolve to the lowest level
  // this specific model actually accepts.
  const bridgeThinkLevel = resolveGeminiMinThinkingLevel(eyesModel);
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

// Local (LM Studio / llama.cpp) vision. OpenAI-compatible, NO API key — the
// only requirement is a vision-capable model loaded in LM Studio (JIT loading
// on). The eyes model value carries a "local:" sentinel prefix (e.g.
// "local:qwen2-vl-7b-instruct") so it's unambiguously routed here regardless
// of the model's own name; the prefix is stripped before the request. Base URL
// follows the same env override the main chat path uses (LOCAL_LLM_BASE).
async function callLocalVision(params: {
  imageBase64: string;
  imageMimeType: string;
  eyesPrompt: string;
  eyesModel: string;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel } = params;
  const dataUrl = `data:${imageMimeType};base64,${imageBase64}`;
  const model = eyesModel.replace(/^local:/i, '').trim();
  if (!model) {
    return { description: '[image — eyes via Local needs a model id, e.g. local:qwen2-vl-7b]', fromCache: false, error: 'no_model' };
  }
  const base = (process.env.LOCAL_LLM_BASE || 'http://localhost:1234').replace(/\/+$/, '');
  const body = {
    model,
    messages: [
      { role: 'user', content: [
        { type: 'text', text: eyesPrompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
    stream: false,
    temperature: 0.3,
    top_p: 0.9,
  };
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[eyes/local] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return {
      description: `[image — local model ${model} could not describe it: ${cleanMsg}]`,
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

// OAuth Claude vision. Describes the image using the Pro/Max SUBSCRIPTION token
// via the Agent SDK (same sanctioned Claude Code client the main OAuth chat
// path uses — NOT the raw Messages API), so it needs NO API key. This is the
// eyes provider to pick when the only credential available is OAuth Claude.
// The eyes model value is a Claude id (default claude-haiku-4-5 = cheapest
// vision-capable). One short, tool-less, single-turn query per image; results
// are cached like every other provider, so an image is described only once.
async function callOAuthClaudeVision(params: {
  imageBase64: string;
  imageMimeType: string;
  eyesPrompt: string;
  eyesModel: string;
  oauthToken: string;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, oauthToken } = params;
  const model = /claude/i.test(eyesModel) ? eyesModel : 'claude-haiku-4-5';
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { query } = sdk;
    async function* prompt() {
      yield {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [
            { type: 'text', text: eyesPrompt },
            { type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBase64 } },
          ],
        },
        parent_tool_use_id: null,
      };
    }
    let text = '';
    for await (const m of query({
      prompt: prompt(),
      options: {
        // Inherited environment + token — see claudeAgentEnv(). The SDK's
        // `env` replaces rather than merges, so a bare {TOKEN} object would
        // strip the child's Windows environment.
        env: claudeAgentEnv(oauthToken),
        model,
        systemPrompt: 'You describe images. Output ONLY the description, no preamble, no follow-up.',
        // Pure single-turn description — block every tool so the SDK can't
        // wander into the filesystem/web, and load no project settings.
        disallowedTools: [
          'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep',
          'Bash', 'BashOutput', 'KillShell', 'WebSearch', 'WebFetch',
          'Task', 'TodoWrite', 'SlashCommand', 'Skill', 'AskUserQuestion',
        ],
        settingSources: [],
        permissionMode: 'default',
        maxTurns: 1,
      } as any,
    } as any)) {
      if ((m as any).type === 'assistant') {
        const content = (m as any).message?.content;
        if (Array.isArray(content)) {
          for (const b of content) if (b?.type === 'text' && b.text) text += b.text;
        }
      } else if ((m as any).type === 'result') {
        const r: any = m;
        if (!text && typeof r.result === 'string') text = r.result;
        break;
      }
    }
    text = text.trim();
    if (!text) {
      return { description: '[image — OAuth Claude returned an empty description]', fromCache: false, error: 'empty' };
    }
    return { description: text, fromCache: false };
  } catch (e: any) {
    const cleanMsg = e?.message || 'unknown error';
    console.error(`[eyes/oauth-claude] ${cleanMsg}`);
    return {
      description: `[image — OAuth Claude could not describe it: ${cleanMsg}]`,
      fromCache: false,
      error: cleanMsg,
    };
  }
}

/**
 * Describe an image by sending it to a multimodal model. Used to bridge
 * vision content to text-only models: NEXUS calls describeImage() on each
 * incoming image, then substitutes the image with the returned description
 * in the message that gets sent to the text-only model.
 *
 * Provider routing by model name prefix:
 *   • starts with "local:" → Local LM Studio, OpenAI-compatible (NO key)
 *   • starts with "claude" → OAuth Claude via Agent SDK subscription (NO key,
 *                            needs oauthToken)
 *   • starts with "gemini" → Google Generative Language API (uses geminiKey)
 *   • starts with "mimo"   → Xiaomi MiMo hosted API (uses mimoKey)
 *   • anything else        → defaults to Z.AI GLM (uses zaiKey)
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
  oauthToken?: string;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, zaiKey, geminiKey, mimoKey, oauthToken } = params;

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
    if (lower.startsWith('local:')) {
      // Local LM Studio — no key needed, just a loaded vision model.
      result = await callLocalVision({ imageBase64, imageMimeType, eyesPrompt, eyesModel });
    } else if (lower.startsWith('claude')) {
      // OAuth Claude subscription — no API key, uses the OAuth token.
      if (!oauthToken) {
        return {
          description: '[image — eyes via OAuth Claude needs the OAuth token set in Preferences → Anthropic]',
          fromCache: false,
          error: 'no_oauth',
        };
      }
      result = await callOAuthClaudeVision({ imageBase64, imageMimeType, eyesPrompt, eyesModel, oauthToken });
    } else if (lower.startsWith('gemini')) {
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
