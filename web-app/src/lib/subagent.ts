// ── Subagent runners for the non-OAuth paths ─────────────────────────────────
// A "subagent" is the tool loop calling itself with a FRESH context: a child
// agent does an investigation and returns ONLY a distilled text result, so the
// parent's context stays clean (the "context firewall"). On the OAuth path this
// is a child query() (see route.ts); here we provide minimal read-only agent
// loops for the OpenAI-compatible, Anthropic API-key, and Gemini paths.
//
// The child is READ-ONLY (Read / Glob / Grep only) and capped at MAX_TURNS so a
// runaway child can't loop forever. It inherits the parent's workspace folder
// and sandbox/full-access scope. It cannot spawn further subagents (it simply
// isn't given the tool).
//
// IMAGE READS: when Read targets an image file, we don't dump raw bytes as text
// (the model can't see that). Instead each runner injects the actual image as
// vision content in the child's own message format — exactly like the parent
// loops do — so a vision-capable child model SEES the picture. (The default
// child models — Claude Haiku, Gemini Flash-Lite — are vision-capable.)

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { readWorkspaceFile, readWorkspaceFileBinary, isImageFilename, globWorkspaceFiles, grepWorkspaceFiles } from './fsStorage';
import { webSearch as runWebSearch, webFetch as runWebFetch } from './webTools';
import { deepseekWireModel } from './deepseekModels';

export interface SubagentUsage { input: number; output: number; cacheRead: number; cacheCreate: number }
// `via` records WHERE the request actually went: the provider label, the exact
// endpoint URL we POSTed to, and the model the PROVIDER echoed back in its
// response. This is hard proof of which API served the subagent — independent
// of whatever the model claims about itself.
export interface SubagentVia { label: string; endpoint: string; echoedModel?: string }
export interface SubagentResult { text: string; usage: SubagentUsage; via?: SubagentVia }

const MAX_TURNS = 16;

export function buildSubagentSystem(returnContract?: string, webSearch?: boolean): string {
  // IMPORTANT: keep this identity-neutral. It must NOT bias the model's sense of
  // who it is. Earlier wording ("You are a focused sub-investigator" + the tool
  // names Read/Glob/Grep, which are Claude Code's signature tools) caused
  // distilled models (MiMo/GLM/DeepSeek) to claim they were "Claude". No persona
  // assignment, no Claude-flavored phrasing, generic tool names.
  return (
    'Use the available read-only tools to investigate and answer the task below. ' +
    'read_file can also open image files (you will see them as images). ' +
    (webSearch
      ? 'You can also search the live web and read specific pages for up-to-date information; cite the URLs you rely on. '
      : '') +
    'When done, reply with ONLY the final result — no preamble, no narration of your steps.' +
    (returnContract ? `\n\nReturn format: ${returnContract}` : '')
  );
}

// Rich read result: either plain text, or an image to inject as vision content.
type ReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; base64: string; note: string };

async function dispatchTool(name: string, args: any, folderName: string, fullAccess: boolean): Promise<ReadResult> {
  try {
    // Generic, provider-neutral tool names (NOT Claude Code's Read/Glob/Grep,
    // which biased distilled models into claiming they were Claude). Legacy
    // Read/Glob/Grep names are still accepted for safety.
    if (name === 'read_file' || name === 'Read') {
      const p = String(args?.path || '');
      if (isImageFilename(p)) {
        const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess });
        if (!bin) return { kind: 'text', text: `Error: image not found or outside workspace: ${p}` };
        return { kind: 'image', mimeType: bin.mimeType, base64: bin.data.toString('base64'), note: `Image "${p}" (${bin.mimeType}, ${bin.data.length} bytes) follows:` };
      }
      const t = await readWorkspaceFile(folderName, p, { fullAccess });
      return { kind: 'text', text: t == null ? `Error: file not found or outside workspace: ${p}` : t };
    }
    if (name === 'list_files' || name === 'Glob') {
      const matches = await globWorkspaceFiles(folderName, String(args?.pattern || '**'));
      return { kind: 'text', text: matches.length ? matches.join('\n') : `(no files match \`${args?.pattern}\`)` };
    }
    if (name === 'search_files' || name === 'Grep') {
      const gr = await grepWorkspaceFiles(folderName, String(args?.pattern || ''), {
        filePattern: args?.file_pattern ? String(args.file_pattern) : undefined,
        flags: args?.flags ? String(args.flags) : undefined,
      });
      if (!gr.ok) return { kind: 'text', text: `Error: ${gr.error}` };
      return { kind: 'text', text: gr.matches?.length ? gr.matches.map((m: any) => `${m.path}:${m.line}: ${m.text}`).join('\n') : '(no matches)' };
    }
    // Universal web tools (only exposed to the OpenAI-compatible child when web
    // search is enabled — Claude/Gemini children use their provider-NATIVE
    // search instead, executed server-side, so they never route through here).
    if (name === 'web_search') {
      const q = String(args?.query || args?.q || '').trim();
      if (!q) return { kind: 'text', text: 'Error: web_search requires a non-empty "query".' };
      const hits = await runWebSearch(q, { maxResults: 6 });
      return {
        kind: 'text',
        text: hits.length === 0
          ? `(no results for "${q}")`
          : hits.map((h: any, i: number) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n\n') +
            '\n\n(To read a full page, call web_fetch with one of the URLs above.)',
      };
    }
    if (name === 'web_fetch') {
      const u = String(args?.url || args?.URL || '').trim();
      if (!u) return { kind: 'text', text: 'Error: web_fetch requires an absolute "url".' };
      const page = await runWebFetch(u, { maxChars: 8000 });
      return {
        kind: 'text',
        text: `URL: ${page.url}\n${page.title ? `Title: ${page.title}\n` : ''}\n${page.text}${page.truncated ? '\n\n[...content truncated...]' : ''}`,
      };
    }
    return { kind: 'text', text: `Error: tool "${name}" is not available.` };
  } catch (e: any) {
    return { kind: 'text', text: `Error: ${e?.message || 'tool execution failed'}` };
  }
}

const emptyUsage = (): SubagentUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

// ── Tool schemas, one per provider shape ─────────────────────────────────────
const OPENAI_TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file (read-only). Image files come back as inline images you can see.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path within the workspace.' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files matching a glob pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'search_files', description: 'Regex-search file contents.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, file_pattern: { type: 'string' }, flags: { type: 'string' } }, required: ['pattern'] } } },
];

const ANTHROPIC_TOOLS = [
  { name: 'read_file', description: 'Read a file (read-only). Image files come back as inline images you can see.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_files', description: 'List files matching a glob pattern.', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  { name: 'search_files', description: 'Regex-search file contents.', input_schema: { type: 'object', properties: { pattern: { type: 'string' }, file_pattern: { type: 'string' }, flags: { type: 'string' } }, required: ['pattern'] } },
];

const GEMINI_TOOLS = [{
  functionDeclarations: [
    { name: 'read_file', description: 'Read a file (read-only). Image files come back as inline images you can see.', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] } },
    { name: 'list_files', description: 'List files matching a glob pattern.', parameters: { type: 'OBJECT', properties: { pattern: { type: 'STRING' } }, required: ['pattern'] } },
    { name: 'search_files', description: 'Regex-search file contents.', parameters: { type: 'OBJECT', properties: { pattern: { type: 'STRING' }, file_pattern: { type: 'STRING' }, flags: { type: 'STRING' } }, required: ['pattern'] } },
  ],
}];

// ── Web-search tool schemas (added only when web search is enabled) ───────────
// OpenAI-compatible: NEXUS's universal DuckDuckGo tools (client-executed here).
const OPENAI_WEB_TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the live web. Returns a numbered list of results (title, URL, snippet). Then call web_fetch to read a promising URL. Cite the URLs you use.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query.' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Open ONE http(s) URL and return its readable text content.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'The absolute http(s) URL to open.' } }, required: ['url'] } } },
];
// Claude (API-key): Anthropic's NATIVE server-side web search — runs during
// generation, no client execution needed. Same tool version as the main path.
const ANTHROPIC_WEB_TOOL = { type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] };
// Gemini: Google Search grounding — also server-side (needs the
// includeServerSideToolInvocations flag the runner already sets).
const GEMINI_WEB_TOOL = { googleSearch: {} };

// ── OpenAI-compatible (GLM / Kimi / DeepSeek / Grok / Cohere / MiniMax / ChatGPT / MiMo / local) ──
export async function runOpenAISubagent(opts: {
  url: string; headers: Record<string, string>; model: string; task: string; returnContract?: string; folderName: string; fullAccess: boolean; webSearch?: boolean;
}): Promise<SubagentResult> {
  const usage = emptyUsage();
  let echoedModel = '';
  const via = (): SubagentVia => ({ label: 'OpenAI-compatible', endpoint: opts.url, echoedModel });
  // eslint-disable-next-line no-console
  console.log(`[subagent] OpenAI-compatible → endpoint=${opts.url} model=${opts.model} web=${!!opts.webSearch}`);
  const tools = opts.webSearch ? [...OPENAI_TOOLS, ...OPENAI_WEB_TOOLS] : OPENAI_TOOLS;
  const msgs: any[] = [
    { role: 'system', content: buildSubagentSystem(opts.returnContract, opts.webSearch) },
    { role: 'user', content: opts.task },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      // No temperature: GPT-5 and Kimi reject any value but their default (1),
      // and an investigation task doesn't need it. Each provider uses its own.
      body: JSON.stringify({ model: opts.model, messages: msgs, tools, stream: false }),
    });
    const data = await resp.json().catch(() => null);
    if (!data) return { text: `Subagent error: provider returned non-JSON (HTTP ${resp.status}).`, usage, via: via() };
    if (data.error) return { text: `Subagent error: ${data.error?.message || JSON.stringify(data.error)}`, usage, via: via() };
    // The provider echoes the model it actually served in `data.model`.
    if (data.model) echoedModel = String(data.model);
    if (data.usage) { usage.input += Number(data.usage.prompt_tokens || 0); usage.output += Number(data.usage.completion_tokens || 0); }
    const m = data?.choices?.[0]?.message;
    const toolCalls = m?.tool_calls;
    if (!toolCalls?.length) return { text: String(m?.content || ''), usage, via: via() };
    msgs.push({ role: 'assistant', content: m.content || '', tool_calls: toolCalls });
    // The OpenAI `tool` role can't carry images, so images read this turn are
    // queued and injected as a follow-up user message after the tool results.
    const imageInjects: { name: string; dataUrl: string }[] = [];
    for (const tc of toolCalls) {
      let args: any = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      const r = await dispatchTool(tc.function?.name, args, opts.folderName, opts.fullAccess);
      if (r.kind === 'image') {
        imageInjects.push({ name: String(args?.path || 'image'), dataUrl: `data:${r.mimeType};base64,${r.base64}` });
        msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: `${r.note} (shown in the next message)` });
      } else {
        msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: r.text });
      }
    }
    if (imageInjects.length) {
      const parts: any[] = [{ type: 'text', text: 'Images from Read this turn:' }];
      for (const img of imageInjects) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
      msgs.push({ role: 'user', content: parts });
    }
  }
  return { text: '(subagent reached its turn limit without a final answer)', usage, via: via() };
}

// ── Anthropic API-key (token-paid Claude) ────────────────────────────────────
export async function runAnthropicSubagent(opts: {
  anthropic: any; model: string; task: string; returnContract?: string; folderName: string; fullAccess: boolean; webSearch?: boolean;
}): Promise<SubagentResult> {
  const usage = emptyUsage();
  // eslint-disable-next-line no-console
  console.log(`[subagent] Anthropic (token-paid Claude) → model=${opts.model} web=${!!opts.webSearch}`);
  const messages: any[] = [{ role: 'user', content: opts.task }];
  const system = buildSubagentSystem(opts.returnContract, opts.webSearch);
  // Claude's native web_search is a SERVER tool: it runs during generation and
  // returns result blocks + text in one response, so the client loop below never
  // has to execute it (it only handles the read-only client tools).
  const tools = opts.webSearch ? [...ANTHROPIC_TOOLS, ANTHROPIC_WEB_TOOL] : ANTHROPIC_TOOLS;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp: any;
    try {
      resp = await opts.anthropic.messages.create({ model: opts.model, max_tokens: 4096, system, messages, tools });
    } catch (e: any) {
      return { text: `Subagent error: ${e?.message || 'Anthropic call failed'}`, usage };
    }
    if (resp.usage) {
      usage.input += Number(resp.usage.input_tokens || 0);
      usage.output += Number(resp.usage.output_tokens || 0);
      usage.cacheRead += Number(resp.usage.cache_read_input_tokens || 0);
      usage.cacheCreate += Number(resp.usage.cache_creation_input_tokens || 0);
    }
    const content = resp.content || [];
    const toolUses = content.filter((b: any) => b.type === 'tool_use');
    if (!toolUses.length) {
      return { text: content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''), usage };
    }
    messages.push({ role: 'assistant', content });
    const toolResults: any[] = [];
    for (const tu of toolUses) {
      const r = await dispatchTool(tu.name, tu.input, opts.folderName, opts.fullAccess);
      if (r.kind === 'image') {
        // Anthropic tool_result accepts a content array incl. an image block.
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: [
          { type: 'text', text: r.note },
          { type: 'image', source: { type: 'base64', media_type: r.mimeType, data: r.base64 } },
        ] });
      } else {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: r.text });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { text: '(subagent reached its turn limit without a final answer)', usage };
}

// ── Gemini ───────────────────────────────────────────────────────────────────
export async function runGeminiSubagent(opts: {
  ai: any; model: string; task: string; returnContract?: string; folderName: string; fullAccess: boolean; webSearch?: boolean;
}): Promise<SubagentResult> {
  const usage = emptyUsage();
  // eslint-disable-next-line no-console
  console.log(`[subagent] Gemini → model=${opts.model} web=${!!opts.webSearch}`);
  const contents: any[] = [{ role: 'user', parts: [{ text: opts.task }] }];
  // googleSearch grounding is server-side; mixing it with the read-only function
  // declarations is allowed because includeServerSideToolInvocations is set.
  const geminiTools = opts.webSearch ? [...GEMINI_TOOLS, GEMINI_WEB_TOOL] : GEMINI_TOOLS;
  const config: any = { systemInstruction: buildSubagentSystem(opts.returnContract, opts.webSearch), tools: geminiTools, toolConfig: { includeServerSideToolInvocations: true } };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let resp: any;
    // Retry transient Google outages (503 / UNAVAILABLE / 429) a few times with
    // backoff before giving up — these are intermittent, not real failures.
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await opts.ai.models.generateContent({ model: opts.model, contents, config });
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        const transient = /503|UNAVAILABLE|429|overloaded|temporarily/i.test(msg);
        if (!transient || attempt === 2) break;
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (lastErr) {
      return { text: `Subagent error: ${lastErr?.message || 'Gemini call failed'}`, usage };
    }
    const um = resp.usageMetadata;
    if (um) { usage.input += Number(um.promptTokenCount || 0); usage.output += Number(um.candidatesTokenCount || 0); usage.cacheRead += Number(um.cachedContentTokenCount || 0); }
    const parts = resp.candidates?.[0]?.content?.parts || [];
    const fcalls = parts.filter((p: any) => p.functionCall);
    if (!fcalls.length) {
      return { text: parts.filter((p: any) => p.text).map((p: any) => p.text).join(''), usage };
    }
    contents.push({ role: 'model', parts });
    // functionResponse can't carry an image, so images read this turn are added
    // as extra inlineData parts in the same follow-up user turn.
    const respParts: any[] = [];
    const inlineParts: any[] = [];
    for (const p of fcalls) {
      const r = await dispatchTool(p.functionCall.name, p.functionCall.args || {}, opts.folderName, opts.fullAccess);
      if (r.kind === 'image') {
        respParts.push({ functionResponse: { name: p.functionCall.name, response: { result: `${r.note} (image follows in this message)` } } });
        inlineParts.push({ inlineData: { mimeType: r.mimeType, data: r.base64 } });
      } else {
        respParts.push({ functionResponse: { name: p.functionCall.name, response: { result: r.text } } });
      }
    }
    contents.push({ role: 'user', parts: [...respParts, ...inlineParts] });
  }
  return { text: '(subagent reached its turn limit without a final answer)', usage };
}

// ── Provider-correct dispatcher ──────────────────────────────────────────────
// Routes the subagent to the provider that OWNS the chosen model, using that
// provider's own endpoint + API key — NOT the parent conversation's endpoint.
// This is what makes "any model from the dropdown" actually work (e.g. a Grok
// subagent under a MiMo parent goes to xAI, not to MiMo's endpoint).

const bearer = (key: string | undefined): Record<string, string> =>
  key ? { Authorization: `Bearer ${key}` } : {};

// OpenAI-compatible family → { endpoint, auth header, model } using `keys`.
function resolveOpenAIRoute(family: string, model: string, keys: any): { url: string; headers: Record<string, string>; model: string; label: string } | null {
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
  if (f.includes('local'))   return { url: `${process.env.LOCAL_LLM_BASE || 'http://localhost:1234'}/v1/chat/completions`, headers: {}, model, label: 'Local' };
  return null;
}

export async function runSubagent(opts: {
  family: string; model: string; keys: any;
  task: string; returnContract?: string; folderName: string; fullAccess: boolean; webSearch?: boolean;
}): Promise<SubagentResult> {
  const fam = (opts.family || '').toLowerCase();
  // Claude family → Anthropic API (token-paid key).
  if (fam.includes('claude') || fam.includes('fable') || fam.includes('mythos')) {
    if (!opts.keys?.claude) return { text: 'Subagent error: a Claude subagent needs the Anthropic API key in Preferences.', usage: emptyUsage() };
    const anthropic = new Anthropic({ apiKey: opts.keys.claude });
    const r = await runAnthropicSubagent({ anthropic, model: opts.model, task: opts.task, returnContract: opts.returnContract, folderName: opts.folderName, fullAccess: opts.fullAccess, webSearch: opts.webSearch });
    r.via = { label: 'Anthropic', endpoint: 'https://api.anthropic.com/v1/messages', echoedModel: opts.model };
    return r;
  }
  // Gemini family → Google.
  if (fam.includes('gemini')) {
    if (!opts.keys?.gemini) return { text: 'Subagent error: a Gemini subagent needs the Google API key in Preferences.', usage: emptyUsage() };
    const ai = new GoogleGenAI({ apiKey: opts.keys.gemini });
    const r = await runGeminiSubagent({ ai, model: opts.model, task: opts.task, returnContract: opts.returnContract, folderName: opts.folderName, fullAccess: opts.fullAccess, webSearch: opts.webSearch });
    r.via = { label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com', echoedModel: opts.model };
    return r;
  }
  // Everything else → that family's OpenAI-compatible endpoint.
  const route = resolveOpenAIRoute(opts.family, opts.model, opts.keys);
  if (!route) return { text: `Subagent error: unknown provider family "${opts.family}".`, usage: emptyUsage() };
  if (route.label !== 'Local' && !route.headers.Authorization) {
    return { text: `Subagent error: the ${route.label} subagent needs its API key set in Preferences.`, usage: emptyUsage() };
  }
  // eslint-disable-next-line no-console
  console.log(`[subagent] family="${opts.family}" → ${route.label} endpoint=${route.url} model=${route.model} web=${!!opts.webSearch}`);
  const r = await runOpenAISubagent({ url: route.url, headers: route.headers, model: route.model, task: opts.task, returnContract: opts.returnContract, folderName: opts.folderName, fullAccess: opts.fullAccess, webSearch: opts.webSearch });
  // Authoritative label/endpoint from the route; keep the provider-echoed model.
  r.via = { label: route.label, endpoint: route.url, echoedModel: r.via?.echoedModel };
  return r;
}
