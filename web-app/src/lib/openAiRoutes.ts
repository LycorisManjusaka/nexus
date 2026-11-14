// OpenAI-compatible family -> { endpoint, auth header, model } (single source).
//
// Moved out of subagent.ts on 2026-11-14 so the eyes bridge can reach every
// family through the same table the subagent already uses (つよ: "全部必要").
// A second copy of these URLs is exactly what 式's "do not repeat yourself"
// forbids, and the copy is the one nothing checks.

import { deepseekWireModel } from './deepseekModels';

export type OpenAIRoute = { url: string; headers: Record<string, string>; model: string; label: string };

const bearer = (key: string | undefined): Record<string, string> =>
  key ? { Authorization: `Bearer ${key}` } : {};

// OpenAI-compatible family → { endpoint, auth header, model } using `keys`.
export function resolveOpenAIRoute(family: string, model: string, keys: any): OpenAIRoute | null {
  const f = (family || '').toLowerCase();
  if (f.includes('qwen'))    return { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', headers: bearer(keys.qwen), model, label: 'Qwen (DashScope)' };
  if (f.includes('deepseek')) {
    // deepseek-v3.2 is only served via DashScope (keys.qwen); others go direct.
    if (model === 'deepseek-v3.2') return { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', headers: bearer(keys.qwen), model, label: 'DeepSeek (DashScope)' };
    // Retired Flash ids (deepseek-v4-flash-0731 and friends) now hard-400 on
    // api.deepseek.com — normalise via the single table in ./deepseekModels.
    return { url: 'https://api.deepseek.com/v1/chat/completions', headers: bearer(keys.deepseek), model: deepseekWireModel(model), label: 'DeepSeek' };
  }
  if (f.includes('glm')) {
    // `digitalocean/` prefix routes GLM open weights through DigitalOcean
    // Inference (US-hosted, ~half Z.ai price) instead of api.z.ai.
    if (model.startsWith('digitalocean/')) {
      return { url: 'https://inference.do-ai.run/v1/chat/completions', headers: bearer(keys.digitalocean), model: model.slice('digitalocean/'.length), label: 'GLM (DigitalOcean)' };
    }
    return { url: 'https://api.z.ai/api/paas/v4/chat/completions', headers: bearer(keys.glm), model, label: 'GLM (Z.AI)' };
  }
  if (f.includes('grok'))    return { url: 'https://api.x.ai/v1/chat/completions', headers: bearer(keys.grok), model, label: 'Grok (xAI)' };
  if (f.includes('kimi'))    return { url: 'https://api.moonshot.ai/v1/chat/completions', headers: bearer(keys.kimi), model: model.replace(/^moonshotai\//i, '').toLowerCase(), label: 'Kimi (Moonshot)' };
  if (f.includes('cohere'))  return { url: 'https://api.cohere.ai/compatibility/v1/chat/completions', headers: bearer(keys.cohere), model, label: 'Cohere' };
  if (f.includes('minimax')) return { url: 'https://api.minimax.io/v1/chat/completions', headers: bearer(keys.minimax), model, label: 'MiniMax' };
  if (f.includes('chatgpt') || f.includes('openai') || f.includes('gpt')) return { url: 'https://api.openai.com/v1/chat/completions', headers: bearer(keys.openai), model, label: 'OpenAI' };
  if (f.includes('mimo'))    return { url: 'https://api.xiaomimimo.com/v1/chat/completions', headers: bearer(keys.mimo), model, label: 'MiMo' };
  if (f.includes('bytedance')) return { url: 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions', headers: bearer(keys.bytedance), model, label: 'ByteDance' };
  // Meta Model API, OpenAI-compatible surface. No reasoning_effort is pinned
  // here on purpose: a subagent sends no max_tokens cap at all, and the server
  // default is generous. (A capped call MUST ask for 'minimal' or Muse Spark
  // spends the whole budget thinking and returns null — that was measured on
  // the auto-select preflight, deleted 2026-10-08, and still applies to any
  // future small-budget call.) — measured 2026-10-05: 8,686 output tokens with
  // finish_reason 'stop', nothing truncated. A subagent is doing real work, so
  // the model's default depth is the right default.
  if (f.includes('meta'))    return { url: 'https://api.meta.ai/v1/chat/completions', headers: bearer(keys.meta), model, label: 'Meta (Muse Spark)' };
  if (f.includes('local'))   return { url: `${process.env.LOCAL_LLM_BASE || 'http://localhost:1234'}/v1/chat/completions`, headers: {}, model, label: 'Local' };
  return null;
}
