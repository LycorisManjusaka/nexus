import fs from 'fs/promises';
import { resolveOpenAIRoute, type OpenAIRoute } from './openAiRoutes';
import { familyFromModelId } from './modelFamily';
import path from 'path';
import crypto from 'crypto';
import { parseUpstreamError } from './bridgeErrorParse';
import { usageFromOpenAi, usageFromGemini, usageFromAnthropic } from './auxBilling';
import { recordAuxBilling, type AuxBillTarget } from './auxBillingStore';
import type { TurnCacheUsage } from './turnEvents';
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
  /** Provider-reported usage of the call that produced this (absent on a
   *  cache hit or a failed call). Billed by describe*() — see auxBilling.ts. */
  usage?: TurnCacheUsage | null;
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
  const usage = usageFromOpenAi(data?.usage);
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty', usage };
  }
  return { description, fromCache: false, usage };
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
  // V2.6 tiers all accept image input (measured 2026-09-22, image_tokens=256).
  // The old V2.5 split — only the standard tier could see, `-pro` was text-only
  // and 404d on an image — is gone, and both V2.5 ids were withdrawn by Xiaomi
  // on 2026-10-21 and removed from the Eyes picker.
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
  const usage = usageFromOpenAi(data?.usage);
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty', usage };
  }
  return { description, fromCache: false, usage };
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
  const usage = usageFromGemini(data?.usageMetadata);
  const description = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => p?.text || '')
    .join('')
    .trim();
  if (!description) {
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty', usage };
  }
  return { description, fromCache: false, usage };
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
  const usage = usageFromOpenAi(data?.usage);
  const description = (data?.choices?.[0]?.message?.content || '').trim();
  if (!description) {
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty', usage };
  }
  return { description, fromCache: false, usage };
}

// Every other family (2026-11-14, つよ: the eyes seat must offer every family
// that can see). The endpoint, key and wire model come from resolveOpenAIRoute
// — the SAME table the subagent uses — so a new family is wired once.
// No temperature / top_p / max_tokens on purpose: several of these vessels
// reject non-default sampling (reasoning GPTs, Kimi K3), and a capped call on
// Meta spends the whole budget thinking and returns null (see openAiRoutes.ts).
async function callOpenAiCompatVision(params: {
  imageBase64: string;
  imageMimeType: string;
  eyesPrompt: string;
  route: OpenAIRoute;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, route } = params;
  const dataUrl = `data:${imageMimeType};base64,${imageBase64}`;
  const body = {
    model: route.model,
    messages: [
      { role: 'user', content: [
        { type: 'text', text: eyesPrompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] },
    ],
    stream: false,
  };
  const res = await fetch(route.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...route.headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[eyes/${route.label}] HTTP ${res.status} · FULL BODY:\n${errText}`);
    const cleanMsg = parseUpstreamError(errText, res.status);
    return { description: `[image — ${route.label} ${route.model} could not describe it: ${cleanMsg}]`, fromCache: false, error: cleanMsg };
  }
  const data = await res.json();
  const usage = usageFromOpenAi(data?.usage);
  const content = data?.choices?.[0]?.message?.content;
  const description = (Array.isArray(content)
    ? content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
    : (content || '')).trim();
  if (!description) {
    return { description: '[image — eyes returned an empty description]', fromCache: false, error: 'empty', usage };
  }
  return { description, fromCache: false, usage };
}

/**
 * Which family the eyes bridge sends a non-native id to, or null when one of
 * the native branches (local / claude / gemini / mimo / Z.AI GLM) owns it.
 * `digitalocean/glm-…` is GLM on DigitalOcean; familyFromModelId would call it
 * Local because of the slash.
 */
export function eyesCompatFamily(eyesModel: string): string | null {
  const lower = (eyesModel || '').toLowerCase();
  if (lower.startsWith('digitalocean/')) return 'GLM';
  const fam = familyFromModelId(lower);
  return EYES_COMPAT_FAMILIES.has(fam) ? fam : null;
}
const EYES_COMPAT_FAMILIES = new Set(['ChatGPT', 'Grok', 'Qwen', 'DeepSeek', 'Kimi', 'MiniMax', 'Cohere', 'ByteDance', 'Meta']);

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
  allowHostAnthropicEnv?: boolean;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, oauthToken, allowHostAnthropicEnv } = params;
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
    // The SDK's result message carries the subscription call's usage. Recorded
    // with authMode 'oauth', so stats files it under Claude (OAuth) — real
    // tokens, no per-token charge.
    let usage: TurnCacheUsage | null = null;
    for await (const m of query({
      prompt: prompt(),
      options: {
        // Inherited environment + token — see claudeAgentEnv(). The SDK's
        // `env` replaces rather than merges, so a bare {TOKEN} object would
        // strip the child's Windows environment.
        env: claudeAgentEnv(oauthToken, !!allowHostAnthropicEnv),
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
        usage = usageFromAnthropic(r.usage);
        break;
      }
    }
    text = text.trim();
    if (!text) {
      return { description: '[image — OAuth Claude returned an empty description]', fromCache: false, error: 'empty', usage };
    }
    return { description: text, fromCache: false, usage };
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
 *   • ChatGPT / Grok / Qwen / DeepSeek / Kimi / MiniMax / Cohere /
 *     ByteDance / Meta / digitalocean/ GLM → that family's OpenAI-compatible
 *     endpoint via resolveOpenAIRoute (uses `keys`)
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
  allowHostAnthropicEnv?: boolean;
  /** The whole key file, for families reached through resolveOpenAIRoute. */
  keys?: any;
  /** Who this call is for. When given, the call is written to that
   *  being's auxiliary billing ledger. */
  bill?: AuxBillTarget;
}): Promise<EyesResult> {
  const { imageBase64, imageMimeType, eyesPrompt, eyesModel, zaiKey, geminiKey, mimoKey, oauthToken, allowHostAnthropicEnv } = params;

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
  const compatFamily = eyesCompatFamily(eyesModel);
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
      result = await callOAuthClaudeVision({ imageBase64, imageMimeType, eyesPrompt, eyesModel, oauthToken, allowHostAnthropicEnv });
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
    } else if (compatFamily) {
      const route = resolveOpenAIRoute(compatFamily, eyesModel, params.keys || {});
      if (!route || !route.headers.Authorization) {
        return {
          description: `[image — eyes via ${route?.label || compatFamily} needs its API key in Settings]`,
          fromCache: false,
          error: 'no_key',
        };
      }
      result = await callOpenAiCompatVision({ imageBase64, imageMimeType, eyesPrompt, route });
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

  // Billed whether or not the description was usable: the provider call
  // happened. A cache hit returned above and never reaches here.
  await recordAuxBilling(params.bill, { kind: 'eyes', model: eyesModel, authMode: lower.startsWith('claude') ? 'oauth' : 'api-key', usage: result.usage });

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
