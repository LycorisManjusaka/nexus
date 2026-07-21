import { NextResponse } from 'next/server';
import crypto from 'crypto';
import pathModule from 'path';
import { promises as fsp } from 'fs';
import { loadKeys, readWorkspaceFile, readWorkspaceFileBinary, isImageFilename, writeWorkspaceFile, ensureWorkspace, editWorkspaceFile, globWorkspaceFiles, grepWorkspaceFiles, deleteWorkspaceFile, readEntityFooter } from '@/lib/fsStorage';
import { isVisionCapable, isAudioCapable, isVideoCapable } from '@/lib/modelVision';
import { describeImage } from '@/lib/eyesVision';
import { describeAudio } from '@/lib/earsBridge';
import { describeVideo } from '@/lib/videoBridge';
import { webSearch, webFetch } from '@/lib/webTools';
import { readConversationByName } from '@/lib/conversationRead';
import { searchConversations, formatSearchForTool } from '@/lib/conversationSearch';
import { appendLayer5Footer } from '@/lib/layer4';
import { resolveAgentInstructions } from '@/lib/agentInstructions';
import { createAskId, waitForAsk, recommendedDefaults, formatAnswerForModel, normalizeQuestions } from '@/lib/askUser';
import { drainInjections, clearInjections, frameInjection } from '@/lib/injectMessage';
import { runShellCommand } from '@/lib/shellTool';
import { runSubagent } from '@/lib/subagent';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

// Anthropic rejects any image whose longest edge exceeds 2000px on many-image
// requests, and internally downscales anything over ~1568px for token counting
// anyway. So downscale oversized images to a 1568px long edge before sending —
// this satisfies both limits with margin and matches Anthropic's own downscale,
// meaning no extra quality loss. Unlike the client-side PNG→JPEG (fresh PNG
// attachments only), this runs server-side on EVERY image the Claude paths send:
// fresh attachments, .md imports, and historical turns alike. Input format is
// preserved (keeps PNG transparency); on any decode/format failure the original
// bytes are sent unchanged rather than dropping the image.
const CLAUDE_MAX_EDGE = 1568;
async function shrinkImageForClaude(
  base64Data: string,
  mimeType: string,
): Promise<{ data: string; media_type: string }> {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h || Math.max(w, h) <= CLAUDE_MAX_EDGE) {
      return { data: base64Data, media_type: mimeType };
    }
    const out = await sharp(buf)
      .resize({ width: CLAUDE_MAX_EDGE, height: CLAUDE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .toBuffer(); // no format method → sharp preserves the input format
    return { data: out.toString('base64'), media_type: mimeType };
  } catch {
    return { data: base64Data, media_type: mimeType };
  }
}

// ── Grok native web + X search (xAI Responses API) ───────────────────────────
// xAI's real search (web_search + x_search server-side tools) lives ONLY on the
// /v1/responses endpoint — the old chat/completions `search_parameters` "Live
// Search" was deprecated (→ 410). The Responses shape differs from chat: `input`
// not `messages`, and the answer is nested at output[].content[].text (the
// top-level `output_text` is null on xAI). Citations come as a top-level
// `citations[]` and/or per-span `annotations[]`. This is a NON-streaming call:
// the answer + citations arrive together, then we emit them as NEXUS SSE events.
async function runGrokNativeSearch(params: {
  apiKey: string;
  model: string;
  input: { role: string; content: string }[];
  enqueue: (obj: any) => void;
}): Promise<void> {
  const { apiKey, model, input, enqueue } = params;
  let res: Response;
  try {
    res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input,
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
      }),
    });
  } catch (e: any) {
    enqueue({ type: 'text', content: `[Grok native search could not connect: ${e?.message || 'network error'}]` });
    return;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[grok/search] HTTP ${res.status} · ${errText.slice(0, 500)}`);
    enqueue({ type: 'text', content: `[Grok native search error ${res.status}: ${errText.slice(0, 300)}]` });
    return;
  }
  const data = await res.json().catch(() => ({} as any));

  let text = '';
  const citations: { url: string; title?: string }[] = [];
  // Text + inline annotations from the message item(s) in output[].
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if ((c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string') text += c.text;
          if (Array.isArray(c?.annotations)) {
            for (const a of c.annotations) {
              const url = a?.url || a?.url_citation?.url;
              if (url) citations.push({ url, title: a?.title || a?.url_citation?.title });
            }
          }
        }
      }
    }
  }
  // Top-level citations[] (Grok style): array of URL strings or {url,title}.
  if (Array.isArray(data.citations)) {
    for (const c of data.citations) {
      if (typeof c === 'string') citations.push({ url: c });
      else if (c?.url) citations.push({ url: c.url, title: c.title });
    }
  }

  enqueue({ type: 'text', content: text.trim() || '[Grok returned no answer from native search.]' });

  if (citations.length) {
    const seen = new Set<string>();
    const deduped = citations.filter(c => c.url && !seen.has(c.url) && (seen.add(c.url), true));
    if (deduped.length) enqueue({ type: 'web_sources', sources: deduped });
  }
}
import Anthropic from '@anthropic-ai/sdk';

// Adaptive-thinking depth control for Claude. `output_config.effort` (API key)
// and the Agent SDK `effort` option (OAuth) accept the SAME five levels. All are
// valid on the adaptive models NEXUS exposes (Opus 4.7, Opus 4.8, Fable 5). The
// API default is 'high' (identical to omitting it). Unknown/missing → 'high'.
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
function sanitizeClaudeEffort(v: any): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(v) ? v : 'high';
}

// ── Tool-activity display names ──────────────────────────────────────────────
// Maps NEXUS's internal workspace-tool names to a short human phrase for the
// `tool_activity` SSE event (drives the "<Entity> is using X…" loading label).
// Used by every provider path so a long tool call (esp. a big Write, whose
// input streams silently) isn't mistaken for a frozen "thinking...". Tools with
// their own dedicated UI (AskQuestion → question card, spawn_subagent → chip)
// return null so we don't override those richer indicators.
function toolActivityLabel(name: string): string | null {
  switch (name) {
    case 'Read': return 'reading a file';
    case 'Write': return 'writing a file';
    case 'Edit': return 'editing a file';
    case 'Glob': return 'searching for files';
    case 'Grep': return 'searching file contents';
    case 'Delete': return 'deleting a file';
    case 'Bash': return 'running a shell command';
    case 'read_conversation': return 'reading a past conversation';
    case 'search_conversations': return 'searching past conversations';
    case 'web_search': case 'WebSearch': return 'searching the web';
    case 'web_fetch': case 'WebFetch': return 'fetching a web page';
    case 'AskQuestion': case 'spawn_subagent': return null; // have dedicated UI
    default: return null;
  }
}

// ── Kimi (Moonshot) host resolution ──────────────────────────────────────────
// Kimi runs on Moonshot's first-party API (platform.kimi.ai / api.moonshot.ai),
// using keys.kimi. Model IDs are normalized to the bare Moonshot form
// ("moonshotai/Kimi-K2.6" → "kimi-k2.6"); the dropdown may store either form.
function resolveKimiModel(model: string | undefined | null): string {
  if (!model) return 'kimi-k3';
  // Strip any "moonshotai/" namespace and lowercase → Moonshot's bare id.
  return model.replace(/^moonshotai\//i, '').toLowerCase();
}

const DEFAULT_ANALYSIS_INSTRUCTION =
`Based on the conversation and this message, call set_creativity with the single most appropriate value for C:

C = 0.35 — Grounded & Focused: Analytical, factual, highly structured responses
C = 0.50 — Standard & Conversational: Default conversational state
C = 0.75 — Creative & Brainstorming: Novel perspectives, high vocabulary variance
C = 1.00 — Experimental & Chaotic: Surreal, intentionally unpredictable

Choose the value that best fits what this message calls for, then immediately call set_creativity.`;

// ── Prompt-cache usage normalizer ────────────────────────────────────────────
// Each provider reports cache hits in a slightly different shape. This helper
// folds them into a uniform { cachedInputTokens, uncachedInputTokens,
// totalInputTokens, outputTokens, cacheCreationTokens } event payload that
// the frontend can render without knowing which provider answered.
//
// Field map by provider (as of May 2026):
//   OpenAI / GLM / Kimi / Grok / Cohere / LM Studio:
//     usage.prompt_tokens_details.cached_tokens
//   DeepSeek:
//     usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
//   MiniMax:
//     usage.cache_read_input_tokens (sometimes) or prompt_tokens_details.cached_tokens
//   Anthropic:
//     usage.cache_read_input_tokens / cache_creation_input_tokens / input_tokens / output_tokens
//   Gemini:
//     usageMetadata.cachedContentTokenCount / promptTokenCount / candidatesTokenCount
function normalizeCacheUsage(usage: any, providerHint: string): any | null {
  if (!usage || typeof usage !== 'object') return null;
  const hint = (providerHint || '').toLowerCase();

  // ── Anthropic ────────────────────────────────────────────────────────────
  if (hint.includes('claude')) {
    const cached = Number(usage.cache_read_input_tokens || 0);
    const creation = Number(usage.cache_creation_input_tokens || 0);
    const input = Number(usage.input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    // Anthropic's `input_tokens` excludes cache_read/creation — they're separate buckets.
    return {
      type: 'cache_usage',
      cachedInputTokens: cached,
      uncachedInputTokens: input,
      totalInputTokens: cached + creation + input,
      outputTokens: output,
      cacheCreationTokens: creation,
      providerHint: 'claude',
    };
  }

  // ── Gemini ───────────────────────────────────────────────────────────────
  if (hint.includes('gemini')) {
    const cached = Number(usage.cachedContentTokenCount || 0);
    const total = Number(usage.promptTokenCount || 0);
    const output = Number(usage.candidatesTokenCount || 0);
    return {
      type: 'cache_usage',
      cachedInputTokens: cached,
      uncachedInputTokens: Math.max(0, total - cached),
      totalInputTokens: total,
      outputTokens: output,
      cacheCreationTokens: 0,
      providerHint: 'gemini',
    };
  }

  // ── DeepSeek (custom shape) ──────────────────────────────────────────────
  if (hint.includes('deepseek')) {
    const cached = Number(usage.prompt_cache_hit_tokens || 0);
    const uncached = Number(usage.prompt_cache_miss_tokens || 0);
    const total = Number(usage.prompt_tokens || cached + uncached);
    const output = Number(usage.completion_tokens || 0);
    return {
      type: 'cache_usage',
      cachedInputTokens: cached,
      uncachedInputTokens: uncached,
      totalInputTokens: total,
      outputTokens: output,
      cacheCreationTokens: 0,
      providerHint: 'deepseek',
    };
  }

  // ── Standard OpenAI-compatible (GLM / Kimi / Grok / Cohere / MiniMax / Local) ─
  // Try `prompt_tokens_details.cached_tokens` first, then a few common aliases.
  const total = Number(usage.prompt_tokens || 0);
  const output = Number(usage.completion_tokens || 0);
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cached_tokens ??
    0
  );
  return {
    type: 'cache_usage',
    cachedInputTokens: cached,
    uncachedInputTokens: Math.max(0, total - cached),
    totalInputTokens: total,
    outputTokens: output,
    cacheCreationTokens: 0,
    providerHint: hint || 'oai',
  };
}

// ── Claude OAuth via Agent SDK ───────────────────────────────────────────────
// OPT-IN parallel path for Claude. Triggered by `keys.claudeAuthMode='oauth'`
// in Settings. Uses the user's Pro/Max subscription credit instead of
// pay-per-token API billing. The official Anthropic SDK doesn't accept OAuth
// tokens (`sk-ant-oat01-…`) against the Messages API — they're scoped to be
// consumed by Claude Code / Agent SDK, which spawns a bundled Claude Code
// binary subprocess that proxies the auth.
//
// Multi-turn handling: instead of flattening conversation history into a
// system prompt (which degrades role semantics), we use the SDK's native
// session-resume mechanism. NEXUS persists a session_id per conversation;
// each turn we resume that session and send only the latest user message.
// Anthropic-side holds the canonical history.
//
// Limitations of this path (vs the API-key branch):
//   • Workspace tools (Read/Write/Edit/Glob/Grep) bridged via SDK's built-ins
//   • Creativity Control not bridged
//   • Extended thinking may behave differently (driven by SDK defaults)
//   • Auto-continuation prefill not used (SDK handles its own loop)
async function streamClaudeViaAgentSDK(args: {
  oauthToken: string;
  model: string;
  systemPrompt: string;
  processedMessages: any[];   // NEXUS pre-processed messages w/ mediaFiles
  resumeSessionId: string | null;
  modelSelectedPayload: any;
  modelParams: any;           // for claudeThinking + future thinking knobs
  folderName: string;         // per-character sandbox folder
  toolUseEnabled: boolean;    // gate for enabling Claude Code's file tools
  senseEvents: any[];         // newly-generated descriptions to flush at start
  enableReadConversation: boolean; // expose the read_conversation MCP tool
  agentFullSystemAccess: boolean;  // per-Entity: file tools reach the whole PC
  agentDangerousTools: boolean;    // per-Entity: enable shell (Bash → delete/exec)
  instructionOverrides: Record<string, any>; // per-Entity hidden-instruction overrides
  askUserEnabled: boolean;         // per-Entity: expose the AskQuestion MCP tool
  askUserTimeoutMs: number;        // wait time for an answer (0 = indefinite)
  subagentEnabled: boolean;        // per-Entity: expose the spawn_subagent MCP tool
  subagentModel: string;           // model the child runs on ('' = cheap default)
  subagentFamily: string;          // provider family of the child model ('' = Claude)
  keys: any;                       // API keys, for routing a non-Claude subagent
  injectTurnId: string;            // per-turn id for mid-turn partner interjections
}): Promise<Response> {
  const { oauthToken, model, systemPrompt, processedMessages, resumeSessionId, modelSelectedPayload, modelParams, folderName, toolUseEnabled, senseEvents, enableReadConversation, agentFullSystemAccess, agentDangerousTools, instructionOverrides, askUserEnabled, askUserTimeoutMs, subagentEnabled, subagentModel, subagentFamily, keys, injectTurnId } = args;
  const I = resolveAgentInstructions(instructionOverrides);

  // Build the content blocks for the LATEST user message (its text + any image
  // attachments). The full prior conversation is replayed separately as a text
  // transcript (see historyText below) — we always start a fresh session and
  // send the systemPrompt as the identity, rather than relying on Anthropic's
  // server-side session resume (which drifts from NEXUS's visible history).
  const lastUserMsg = [...processedMessages].reverse().find((m: any) => m.role === 'user');
  if (!lastUserMsg) {
    return NextResponse.json({ error: 'No user message to send.' }, { status: 400 });
  }
  // Build content blocks: text + any image attachments. Agent SDK accepts the
  // standard Anthropic content-block shape inside MessageParam.
  const contentBlocks: any[] = [];
  for (const media of (lastUserMsg.mediaFiles || [])) {
    if (media.mimeType?.startsWith('image/')) {
      if (media.name) {
        contentBlocks.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
      }
      // Downscale oversized images to stay under Anthropic's 2000px many-image cap.
      const img = await shrinkImageForClaude(media.base64Data, media.mimeType);
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      });
    }
  }
  if (lastUserMsg.content) contentBlocks.push({ type: 'text', text: lastUserMsg.content });
  if (contentBlocks.length === 0) contentBlocks.push({ type: 'text', text: '-' });

  // Prior conversation turns (everything before this latest user message).
  // NEXUS is the SINGLE SOURCE OF TRUTH for history. We do NOT trust Anthropic's
  // server-side session resume — it drifts from the visible conversation in
  // every way the user actually hits: it can't see interleaved non-Claude
  // turns, it never shrinks when NEXUS auto-trims, it goes stale on rerun/edit/
  // delete, and a session id created on one machine simply doesn't exist on
  // another after a local_data sync (so resume collapses to a near-empty
  // session → "this is the first message"). Instead we replay the FULL visible
  // conversation as a text transcript on the live user message, every turn —
  // exactly what the user sees, exactly like the API-key path and every other
  // provider. Text-only by design: re-sending every historical image as base64
  // would blow up the payload — the live turn still carries its own media via
  // contentBlocks above. Claude's own saved thinking is folded in as text so it
  // still sees its prior reasoning (the one thing server-side resume gave us).
  const lastIdx = processedMessages.indexOf(lastUserMsg);
  const priorMsgs = lastIdx > 0 ? processedMessages.slice(0, lastIdx) : [];
  const historyText = (() => {
    if (priorMsgs.length === 0) return '';
    // The entity's own name (the character folder = its identity, same value the
    // .md export labels assistant turns with). Used to name ASSISTANT turns
    // symmetrically with the human [name] tags that USER turns already carry in
    // their content — so both sides of the transcript are named, not just the
    // human. The [USER]/[ASSISTANT] role tokens are kept because they are the
    // least ambiguous turn-boundary signal for the model; the names sit beneath
    // them and carry no hierarchy.
    const entityName = (folderName || '').trim() || 'Assistant';
    const lines: string[] = [];
    for (const m of priorMsgs) {
      const role = m.role === 'assistant' ? 'ASSISTANT' : 'USER';
      let block = '';
      // Surface Claude's own saved thinking (present only when the entity has
      // "save thinking to log" enabled) so it can see its earlier reasoning.
      if (m.role === 'assistant' && Array.isArray(m.claudeThinkingBlocks) && m.claudeThinkingBlocks.length) {
        const thoughts = m.claudeThinkingBlocks
          .map((tb: any) => (tb?.thinking || '').trim())
          .filter(Boolean)
          .join('\n\n');
        if (thoughts) block += `(thinking)\n${thoughts}\n\n`;
      }
      block += (m.content || '').trim();
      if (!block.trim()) continue;
      // Assistant turns get the entity's name beneath the role label, mirroring
      // the human's in-content [name] tags. (Prepended only after the empty-turn
      // skip above, so a truly empty assistant turn isn't emitted as a bare name.)
      const named = m.role === 'assistant'
        ? `[${entityName}]\n${block.trim()}`
        : block.trim();
      lines.push(`[${role}]:\n${named}`);
    }
    if (lines.length === 0) return '';
    return (
      '<conversation_history>\n' +
      'This is the full prior conversation, provided for your context — it is exactly ' +
      'what the user currently sees. Continue naturally from it; this is NOT the first ' +
      'message. Each turn is labelled with its speaker: your own turns are marked ' +
      `[ASSISTANT] and carry your name ([${entityName}]); everyone else appears under ` +
      '[USER] with their name in brackets. Lines marked "(thinking)" are your own ' +
      'earlier reasoning.\n\n' +
      lines.join('\n\n') +
      '\n</conversation_history>'
    );
  })();

  const readableStream = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: any) => controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);

      // ── Stall watchdog ──────────────────────────────────────────────────
      // The SDK yields a message for every stream event — even a huge Write
      // tool call keeps input_json_delta events flowing — so real work always
      // refreshes lastSdkEventAt. A genuinely wedged subprocess or hung tool
      // (e.g. a stuck WebFetch) produces NOTHING, which the UI otherwise can't
      // distinguish from work. After 2 minutes of total silence the interval
      // emits `stall_warning` (repeating every 30s with the growing idle
      // count); the next SDK message emits `stall_cleared`.
      // `pausedForRendezvous` suppresses the watchdog while the turn is
      // LEGITIMATELY silent by design: an AskQuestion waiting on the user's
      // answer, or a subagent run (which shows its own activity chip).
      let lastSdkEventAt = Date.now();
      let stallWarned = false;
      let pausedForRendezvous = 0;
      const touchSdkActivity = () => {
        lastSdkEventAt = Date.now();
        if (stallWarned) {
          stallWarned = false;
          try { enqueue({ type: 'stall_cleared' }); } catch {}
        }
      };
      const stallTimer = setInterval(() => {
        if (pausedForRendezvous > 0) return;
        const idleMs = Date.now() - lastSdkEventAt;
        if (idleMs >= 120_000) {
          stallWarned = true;
          // try/catch: the interval can race stream teardown on client abort.
          try { enqueue({ type: 'stall_warning', idleSeconds: Math.round(idleMs / 1000) }); } catch {}
        }
      }, 30_000);

      enqueue(modelSelectedPayload);
      // Flush any newly-generated sense descriptions so the frontend can
      // persist them onto message attachments before AI text begins streaming.
      for (const ev of senseEvents) enqueue(ev);

      try {
        // Dynamic import so a broken/missing SDK install doesn't kill the
        // whole NEXUS process. Worst case: the OAuth path errors gracefully
        // and the user falls back to API-key.
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        const { query } = sdk;

        // read_conversation as an in-process MCP tool. The Agent SDK only
        // exposes Claude Code's BUILT-IN tools (Read/Write/Edit/Glob/Grep,
        // WebSearch/WebFetch); NEXUS custom tools like read_conversation are
        // invisible to OAuth Claude unless registered as an SDK MCP server.
        // This mirrors the API-key path's read_conversation tool 1:1 (same
        // gate, same privacy contract — inactive conversations are refused
        // inside readConversationByName). The handler runs in-process, so the
        // SDK drives the tool loop for us. Tool name as seen by the model:
        // `mcp__nexus__read_conversation` (auto-allowed under bypassPermissions).
        // The in-process MCP server hosts NEXUS's custom tools. We add
        // read_conversation and/or AskQuestion to it depending on the
        // per-conversation toggles. Tool names as seen by the model:
        // `mcp__nexus__read_conversation`, `mcp__nexus__AskQuestion`.
        let nexusMcpServers: Record<string, any> | undefined;
        if (enableReadConversation || askUserEnabled || subagentEnabled) {
          const { z } = await import('zod');
          const nexusTools: any[] = [];
          if (enableReadConversation) {
            nexusTools.push(
              sdk.tool(
                'read_conversation',
                I.readConversationDesc,
                { name: z.string().describe(I.readConversationNameParam) },
                async (a: { name: string }) => {
                  try {
                    const r = await readConversationByName(folderName, a.name);
                    if (!r.ok) return { content: [{ type: 'text' as const, text: `Error: ${r.error || 'not found'}` }] };
                    return { content: [{ type: 'text' as const, text: `# ${r.title}\n\n${r.transcript || '(empty conversation)'}` }] };
                  } catch (e: any) {
                    return { content: [{ type: 'text' as const, text: `Error: ${e?.message || 'read failed'}` }] };
                  }
                },
              ),
            );
            // search_conversations — find WHERE a term appears across the
            // entity's own conversations, then optionally read one in full.
            // Excludes inactive (non-public) conversations, same as read.
            nexusTools.push(
              sdk.tool(
                'search_conversations',
                I.searchConversationsDesc,
                { query: z.string().describe(I.searchConversationsQueryParam) },
                async (a: { query: string }) => {
                  try {
                    const r = await searchConversations(folderName, a.query, { excludeInactive: true });
                    return { content: [{ type: 'text' as const, text: formatSearchForTool(r) }] };
                  } catch (e: any) {
                    return { content: [{ type: 'text' as const, text: `Error: ${e?.message || 'search failed'}` }] };
                  }
                },
              ),
            );
          }
          if (askUserEnabled) {
            // Interactive question tool. Mirrors the OpenAI-compatible path: emit
            // the question over SSE, await the user's selection via the shared
            // rendezvous (or the configured timeout), return it as the result.
            // This REPLACES Claude Code's built-in AskUserQuestion (disabled in
            // disallowedTools below) so there's no unusable-native duplicate.
            const askOptionSchema = z.object({
              label: z.string().describe('Short option label (1-5 words).'),
              description: z.string().optional().describe('What choosing this option means.'),
            });
            const askQuestionSchema = z.object({
              question: z.string().describe('The full question text. End with a question mark.'),
              header: z.string().optional().describe('Very short label/chip for the question (max ~12 chars).'),
              multiSelect: z.boolean().optional().describe('Set true to let the user pick multiple options.'),
              options: z.array(askOptionSchema).describe('2 to 4 distinct, mutually-exclusive choices.'),
            });
            nexusTools.push(
              sdk.tool(
                'AskQuestion',
                I.askUserDesc,
                { questions: z.array(askQuestionSchema).describe('Between 1 and 4 questions to ask the user.') },
                async (a: { questions: any[] }) => {
                  const questions = normalizeQuestions(a);
                  if (questions.length === 0) {
                    return { content: [{ type: 'text' as const, text: 'Error: AskQuestion requires 1-4 questions, each with 2-4 options.' }] };
                  }
                  const askId = createAskId();
                  enqueue({ type: 'ask_user', askId, questions });
                  // Rendezvous pause: the SDK is silent while we wait for the
                  // user's answer — that's not a stall.
                  pausedForRendezvous++;
                  let answered: any = null;
                  try {
                    answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                  } finally {
                    pausedForRendezvous--;
                    touchSdkActivity();
                  }
                  const timedOut = answered === null;
                  const finalAnswers = timedOut ? recommendedDefaults(questions) : answered;
                  enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                  return { content: [{ type: 'text' as const, text: formatAnswerForModel(finalAnswers, timedOut) }] };
                },
              ),
            );
          }
          if (subagentEnabled) {
            // Context firewall: a child agent with a FRESH, empty context does
            // the investigation and returns ONLY a distilled result — its file
            // reads and intermediate steps never reach the parent's context.
            // Runs a separate query() (NOT Claude Code's native Task tool, which
            // is unreliable headless). Read-only, no recursion, capped turns +
            // wall-clock so a runaway child dies instead of looping.
            nexusTools.push(
              sdk.tool(
                'spawn_subagent',
                I.subagentDesc,
                {
                  task: z.string().describe('A precise, self-contained investigation for the helper to perform.'),
                  return_contract: z.string().optional().describe('Optional: how the distilled result should be shaped/formatted.'),
                },
                async (a: { task: string; return_contract?: string }) => {
                  const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : 'Claude';
                  // NON-Claude family on an OAuth parent: the Claude Code child
                  // (which uses the OAuth subscription token) can only run Claude,
                  // so route the child through the API-key path for that provider
                  // instead — exactly like the non-OAuth parents do.
                  if (!/claude|fable|mythos/i.test(childFamily)) {
                    enqueue({ type: 'subagent_start', task: a.task });
                    // Subagent pause: the parent SDK is silent while the child
                    // runs (it has its own activity chip) — not a stall.
                    pausedForRendezvous++;
                    let sub: Awaited<ReturnType<typeof runSubagent>>;
                    try {
                      sub = await runSubagent({
                        family: childFamily, model: subagentModel, keys, task: a.task,
                        returnContract: a.return_contract, folderName, fullAccess: agentFullSystemAccess,
                        webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                      });
                    } finally {
                      pausedForRendezvous--;
                      touchSdkActivity();
                    }
                    cumUsage.input += sub.usage.input;
                    cumUsage.output += sub.usage.output;
                    cumUsage.cacheRead += sub.usage.cacheRead;
                    cumUsage.cacheCreate += sub.usage.cacheCreate;
                    enqueue({ type: 'subagent_done', task: a.task, result: sub.text, via: sub.via });
                    return { content: [{ type: 'text' as const, text: sub.text || '(subagent returned nothing)' }] };
                  }
                  // Claude family → child query() on the OAuth subscription token.
                  // A configurable, cheaper Claude by default; non-Claude model
                  // ids (with a Claude family) fall back to Haiku.
                  const childModel = (subagentModel && /claude|haiku|opus|sonnet|fable|mythos/i.test(subagentModel))
                    ? subagentModel
                    : 'claude-haiku-4-5';
                  const childSystem =
                    'You are a focused sub-investigator with a FRESH, empty context. You have read-only tools ' +
                    '(Read, Glob, Grep). Do EXACTLY the task below, then reply with ONLY the distilled result — ' +
                    'no preamble, no narration of your steps.' +
                    (a.return_contract ? `\n\nReturn format: ${a.return_contract}` : '');
                  const ac = new AbortController();
                  const killTimer = setTimeout(() => { try { ac.abort(); } catch {} }, 180000);
                  enqueue({ type: 'subagent_start', task: a.task });
                  let resultText = '';
                  let childUsage: any = null;
                  // Subagent pause: the parent SDK is silent while the child
                  // query() runs — suppress the stall watchdog for its duration
                  // (the child has its own chip + 180s kill timer).
                  pausedForRendezvous++;
                  try {
                    async function* childPrompt() {
                      yield { type: 'user' as const, message: { role: 'user' as const, content: [{ type: 'text', text: a.task }] }, parent_tool_use_id: null };
                    }
                    const childOpts: any = {
                      env: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
                      model: childModel,
                      systemPrompt: childSystem,
                      cwd: workspaceDir,
                      additionalDirectories: agentFullSystemAccess ? [pathModule.parse(workspaceDir).root] : [],
                      // Read-only investigation: whitelist read tools (+ web when
                      // the conversation has web search on) and explicitly block
                      // write/edit/delete, shell, and recursion. Claude Code's
                      // native WebSearch/WebFetch use its own search backend.
                      allowedTools: (modelParams?.enableClaudeWebSearch || modelParams?.enableWebSearch)
                        ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
                        : ['Read', 'Glob', 'Grep'],
                      disallowedTools: [
                        'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Delete', 'Bash', 'BashOutput', 'KillShell',
                        ...((modelParams?.enableClaudeWebSearch || modelParams?.enableWebSearch) ? [] : ['WebFetch', 'WebSearch']),
                        'Task', 'TodoWrite', 'SlashCommand', 'Skill',
                      ],
                      settingSources: [],
                      permissionMode: 'default',
                      canUseTool, // same path-sandbox enforcement as the parent
                      maxTurns: 20,
                      abortController: ac,
                      includePartialMessages: false,
                    };
                    for await (const m of query({ prompt: childPrompt(), options: childOpts } as any)) {
                      if ((m as any).type === 'result') {
                        const r: any = m;
                        childUsage = r.usage;
                        resultText = r.subtype === 'success'
                          ? (r.result || '')
                          : `Subagent did not finish cleanly (${r.subtype}). ${(r.errors || []).join('; ')}`.trim();
                        break;
                      }
                    }
                  } catch (e: any) {
                    resultText = `Subagent error: ${e?.message || 'failed'}`;
                  } finally {
                    clearTimeout(killTimer);
                    pausedForRendezvous--;
                    touchSdkActivity();
                  }
                  // Fold the child's token bill into the parent's meter so cost
                  // stays honest.
                  if (childUsage) {
                    cumUsage.input += Number(childUsage.input_tokens || 0);
                    cumUsage.output += Number(childUsage.output_tokens || 0);
                    cumUsage.cacheRead += Number(childUsage.cache_read_input_tokens || 0);
                    cumUsage.cacheCreate += Number(childUsage.cache_creation_input_tokens || 0);
                  }
                  enqueue({ type: 'subagent_done', task: a.task, result: resultText, via: { label: 'Anthropic (OAuth / Claude Code)', endpoint: 'Claude Code subscription session', echoedModel: childModel } });
                  return { content: [{ type: 'text' as const, text: resultText || '(subagent returned nothing)' }] };
                },
              ),
            );
          }
          const nexusServer = sdk.createSdkMcpServer({
            name: 'nexus',
            version: '1.0.0',
            tools: nexusTools,
          });
          nexusMcpServers = { nexus: nexusServer };
        }

        // Single-message async iterable for query().prompt. On a fresh session
        // (`includeHistory`) the prior turns are prepended as a text preamble so
        // a loaded `.md` conversation is visible; on a resumed session only the
        // live turn is sent (history already lives under the session id).
        async function* userMsgGen(includeHistory: boolean) {
          const content = includeHistory && historyText
            ? [{ type: 'text' as const, text: historyText }, ...contentBlocks]
            : contentBlocks;
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content },
            parent_tool_use_id: null,
          };
        }

        // Explicit thinking config so the user's per-conversation toggle is
        // honored consistently across models. Adaptive mode works on Opus
        // 4.6/4.7, Sonnet 4.6, and Haiku 4.5 — the SDK auto-falls-back to
        // simple "enabled" on older models that don't support adaptive.
        // `display: 'summarized'` makes the thinking visible (the SDK
        // surfaces it as `summarized_thinking` blocks rather than hiding it).
        // Claude Fable 5 / Mythos 5 only support adaptive thinking — `disabled`
        // is rejected — so force adaptive regardless of the UI toggle.
        const isFable5Oauth = /fable-?5|mythos-?5/.test(model || '');
        const wantThinking = !!modelParams?.claudeThinking || isFable5Oauth;
        const thinkingConfig: any = wantThinking
          ? { type: 'adaptive', display: 'summarized' }
          : { type: 'disabled' };
        // Per-conversation thinking-depth (effort) for adaptive models. The
        // Agent SDK accepts the same five levels as the API. Only send it for
        // models that support effort (Opus 4.7/4.8, Fable/Mythos 5) so we don't
        // pass it to Sonnet/Haiku; default 'high' = same as omitting it.
        // Sonnet 5 is adaptive+effort like Opus 4.7/4.8, so it takes the effort
        // control too. (The classic non-adaptive Sonnet 4.6/Haiku do not.)
        const isAdaptiveOauth = isFable5Oauth || /opus-4-?7|opus-4-?8|sonnet-?5/.test(model || '');
        const isSonnet5Oauth = /sonnet-?5/.test(model || '');
        let oauthEffort = sanitizeClaudeEffort(modelParams?.claudeEffort);
        // Sonnet 5 tops out at 'xhigh' (no 'max' tier) — clamp to avoid a 400.
        if (isSonnet5Oauth && oauthEffort === 'max') oauthEffort = 'xhigh';

        // Per-character sandbox path. Claude Code's file tools (Read/Write/
        // Edit/Glob/Grep) operate relative to `cwd` and refuse to escape it
        // by default. Pointing cwd at the entity's workspace folder means
        // the same isolation that NEXUS's API-key path's Read/Write/Edit/Glob/Grep
        // provides — Claude Code's tools just call them "Read/Write/Edit/
        // Glob/Grep" instead.
        // Realpath the workspace dir so the SDK cwd matches what the entity's
        // own shell reports. `ensureWorkspace` returns a path built from the
        // server cwd (…/chat-manager/local_data/…); when local_data is a
        // JUNCTION/symlink, Claude Code's Bash `pwd` follows it and reports the
        // TARGET (…/common/local_data/…). If we hand the SDK the un-resolved
        // junction path as cwd, the entity sees one spelling from pwd and its
        // file tools are anchored to another — which is exactly what made the
        // Default entity spiral into "why is my own workspace outside my
        // workspace?". Resolving here keeps cwd == pwd == sandboxRoot.
        const workspaceDirRaw = await ensureWorkspace(folderName);
        let workspaceDir: string;
        try { workspaceDir = await fsp.realpath(workspaceDirRaw); }
        catch { workspaceDir = workspaceDirRaw; }

        // When the user has Tool Use OFF for this conversation, disable
        // every Claude Code agent tool (pure chat). When ON, enable the
        // file tools but keep dangerous ones (shell, subagent) permanently
        // disabled regardless of the toggle — there's no UI expectation that
        // turning on Tool Use grants shell access.
        // Shell family (Bash/BashOutput/KillShell) = "dangerous": it grants
        // arbitrary command execution, which on this path is how the entity
        // deletes files and does anything else Claude Code can. Gated per-Entity
        // by agentDangerousTools. Task/subagent + workflow tools stay off (the
        // SDK doesn't drive subagents reliably here, per the OAuth notes).
        const shellTools = ['Bash', 'BashOutput', 'KillShell'];
        const alwaysOffTools = ['Task', 'TodoWrite', 'NotebookEdit', 'SlashCommand', 'Skill'];
        const dangerousAlwaysDisabled = agentDangerousTools
          ? alwaysOffTools
          : [...shellTools, ...alwaysOffTools];
        // Web search/fetch follow the SAME "Enable Web Search" checkbox the
        // API-key Claude path uses (`enableClaudeWebSearch`). Claude Code's
        // built-in WebSearch/WebFetch tools work under the OAuth subscription,
        // so when the user ticks the box we simply stop disallowing them.
        // Without this, monthly-paid (OAuth) Claude reports it has no web
        // search tool even though token-paid (API-key) Claude can search.
        const webToolsDisabledByToggle = modelParams?.enableClaudeWebSearch
          ? []
          : ['WebFetch', 'WebSearch'];
        const fileToolsDisabledByToggle = toolUseEnabled
          ? []
          : ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
        // Claude Code's BUILT-IN AskUserQuestion is ALWAYS disabled: it can't be
        // answered through the SDK's public API (canUseTool only allows/denies),
        // so headless it just auto-picks its recommended default. When the user
        // enables the question tool, NEXUS registers its own answerable MCP
        // version (mcp__nexus__AskQuestion) above; when disabled, the model
        // simply has no question tool. Either way, no unusable native duplicate.
        const disallowedTools = [...dangerousAlwaysDisabled, ...webToolsDisabledByToggle, ...fileToolsDisabledByToggle, 'AskUserQuestion'];

        // Workspace boundary enforcement. `bypassPermissions` (used previously)
        // skips ALL permission AND directory checks, so cwd/additionalDirectories
        // never actually sandboxed OAuth-Claude — it could always read the whole
        // PC. Instead we run in the normal permission mode and supply a
        // canUseTool callback that programmatically allows every tool but DENIES
        // any file-path argument that escapes the workspace, unless this Entity
        // has Full PC access. (Bash, when enabled via dangerous tools, runs with
        // cwd=workspace but a shell can still navigate out — that's inherent to
        // granting shell, and is called out in the UI.)
        // Sandbox root, resolved through fs.realpath so symlinks/junctions in
        // the path don't cause false "outside workspace" denials. This is the
        // load-bearing fix for junction setups: DATA_DIR is computed from the
        // server's cwd (chat-manager/local_data), but when that is a JUNCTION to
        // e.g. common/local_data, the entity's Bash `pwd` reports the realpath'd
        // target — so every absolute path it builds from its own cwd starts with
        // the target, not the junction, and a plain string prefix check rejects
        // it. Realpathing BOTH sides (like the API-key resolveWorkspacePathSafe)
        // makes the two spellings of the same physical directory compare equal.
        // Falls back to a plain resolve if realpath fails (e.g. dir vanished).
        let sandboxRoot: string;
        try { sandboxRoot = await fsp.realpath(workspaceDir); }
        catch { sandboxRoot = pathModule.resolve(workspaceDir); }
        // Realpath-aware containment test. For a path that doesn't exist yet
        // (a Write to a new file), walk up to the deepest existing ancestor,
        // realpath THAT, then re-attach the missing tail — identical strategy
        // to resolveWorkspacePathSafe in fsStorage.
        const withinSandbox = async (val: string): Promise<boolean> => {
          const abs = pathModule.isAbsolute(val) ? pathModule.resolve(val) : pathModule.resolve(sandboxRoot, val);
          let real: string | null = null;
          try {
            real = await fsp.realpath(abs);
          } catch {
            let dir = pathModule.dirname(abs);
            let tail = pathModule.basename(abs);
            for (let i = 0; i < 64; i++) {
              try {
                const realDir = await fsp.realpath(dir);
                real = pathModule.join(realDir, tail);
                break;
              } catch {
                const parent = pathModule.dirname(dir);
                if (parent === dir) { real = abs; break; } // hit fs root — use as-is
                tail = pathModule.join(pathModule.basename(dir), tail);
                dir = parent;
              }
            }
          }
          if (!real) real = abs;
          return real === sandboxRoot || real.startsWith(sandboxRoot + pathModule.sep);
        };
        const canUseTool = async (_toolName: string, input: Record<string, unknown>) => {
          // Mid-turn partner interjection (OAuth path). canUseTool fires before
          // EVERY tool call, so it's our reliable mid-loop hook. If the partner
          // queued a note while the entity was working, deliver it by pausing
          // THIS one tool call with the note as the denial reason — the model
          // reads it, then simply re-issues the same call to proceed (or adjusts
          // course). Draining removes it, so the retry isn't paused again.
          // Gated on pausedForRendezvous === 0 so a running subagent's tool
          // calls don't swallow a note meant for the parent entity.
          if (injectTurnId && pausedForRendezvous === 0) {
            const injected = drainInjections(injectTurnId);
            if (injected.length) {
              try { enqueue({ type: 'injection_delivered', count: injected.length }); } catch {}
              return {
                behavior: 'deny',
                message:
                  frameInjection(injected, I.injectionFraming) +
                  (I.injectionRetryNote ? `\n\n${I.injectionRetryNote}` : ''),
              } as any;
            }
          }
          if (agentFullSystemAccess) return { behavior: 'allow', updatedInput: input } as any;
          for (const field of ['file_path', 'path', 'notebook_path']) {
            const v = (input as any)?.[field];
            if (typeof v === 'string' && v && !(await withinSandbox(v))) {
              return {
                behavior: 'deny',
                message: `Blocked: "${v}" is outside your workspace. Full PC access is OFF for this entity — use a path inside your workspace.`,
              } as any;
            }
          }
          return { behavior: 'allow', updatedInput: input } as any;
        };

        const queryOptions: any = {
          // env passes CLAUDE_CODE_OAUTH_TOKEN to the spawned Claude Code
          // binary WITHOUT mutating process.env (which would race across
          // concurrent requests). This is the documented clean way to inject
          // per-request credentials.
          env: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
          model,
          // NOTE: `resume` vs `systemPrompt` is set PER-ATTEMPT in consume()
          // below (they're mutually exclusive — systemPrompt only applies when
          // CREATING a session, resume only when continuing one). This lets us
          // fall back from a failed resume to a fresh session automatically.
          thinking: thinkingConfig,
          // Thinking-depth level. Only for effort-supporting adaptive models.
          ...(isAdaptiveOauth ? { effort: oauthEffort } : {}),
          // Sandboxes the entity's file tools to its own workspace folder.
          // Claude Code refuses paths outside cwd unless they're explicitly
          // listed in `additionalDirectories` (we leave that empty).
          cwd: workspaceDir,
          // Sandbox scope. Default: only the entity's workspace (additional dirs
          // empty → Claude Code refuses paths outside cwd). With per-Entity full
          // system access ON: grant the whole drive that holds the workspace so
          // the entity can read/write anywhere on the PC.
          additionalDirectories: agentFullSystemAccess ? [pathModule.parse(workspaceDir).root] : [],
          // Without this, the SDK only yields final `assistant` messages
          // (one per turn, with the complete content). With it, the SDK
          // additionally yields `stream_event` messages carrying the raw
          // Anthropic streaming events (content_block_start/delta/stop,
          // message_start/delta) — same shape as the API-key path uses.
          // That's what gives the bubble its live token-by-token feel.
          includePartialMessages: true,
          // See definitions above. With Tool Use ON: Read/Write/Edit/Glob/
          // Grep are available within the sandbox; shell/network/agent
          // tools are blocked. With Tool Use OFF: everything blocked.
          disallowedTools,
          // Register the in-process read_conversation MCP server when enabled.
          // Under bypassPermissions the tool is callable without a prompt.
          ...(nexusMcpServers ? { mcpServers: nexusMcpServers } : {}),
          // Don't load CLAUDE.md from project/user — keeps NEXUS sessions
          // isolated from whatever's in the calling shell's working directory.
          settingSources: [],
          // Normal permission mode + canUseTool callback (above): this is what
          // makes the workspace sandbox real. bypassPermissions would skip the
          // callback entirely and leak the whole filesystem. canUseTool answers
          // every permission request programmatically (allow within sandbox /
          // anywhere when Full PC access is on; deny escapes), so there is still
          // no interactive prompt to hang the headless stream.
          permissionMode: 'default',
          canUseTool,
        };

        let capturedSessionId: string | null = null;
        let cumUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        // Track which content-block index is currently open and what type
        // it is, so deltas know whether to be emitted as 'text' or 'thought'.
        let curBlockType: string | null = null;
        // Tool name currently shown in the client's loading label (via the
        // 'tool_activity' SSE event). Tool calls are otherwise invisible:
        // their input streams as input_json_delta (a large Write can take
        // minutes with zero text output), and execution adds more silence.
        // Non-null while a tool_use block is open/executing; cleared when
        // visible text/thinking resumes.
        let shownToolActivity: string | null = null;
        // Why the turn ended — surfaced explicitly so an OAuth stop is never a
        // silent freeze. `lastStopReason` = the model's stop_reason (end_turn /
        // max_tokens / refusal / pause_turn / tool_use). `lastToolError` = the
        // text of the most recent FAILED tool call — e.g. the model calling a
        // tool that doesn't exist makes Claude Code return an is_error
        // tool_result. `anyToolUsed` distinguishes a truly empty turn from a
        // (legitimate) tool-only turn that produced no text.
        let lastStopReason: string | null = null;
        let lastToolError: string | null = null;
        let anyToolUsed = false;
        // Web citations for the OAuth path. Unlike the API-key path (where
        // web_search is an Anthropic server-side tool), here WebSearch/WebFetch
        // are Claude Code CLIENT tools — results arrive as tool_use / tool_result
        // messages. We capture the exact URL WebFetch opened (clean, strong
        // proof) plus any http(s) URLs embedded in WebSearch result text.
        const oauthSourceMap = new Map<string, { url: string; title?: string }>();
        const addOauthSource = (url: any, title?: any) => {
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
          if (!oauthSourceMap.has(url)) {
            const t = typeof title === 'string' && title.trim() ? title.trim() : undefined;
            oauthSourceMap.set(url, { url, ...(t ? { title: t } : {}) });
          }
        };
        const harvestOauthBlocks = (content: any) => {
          if (!Array.isArray(content)) return;
          for (const b of content) {
            // The model's call to WebFetch carries the exact URL it opened.
            if (b?.type === 'tool_use' && b.name === 'WebFetch' && b.input?.url) {
              addOauthSource(b.input.url);
            }
            // Tool results (search/fetch output) — scrape any URLs from the text.
            if (b?.type === 'tool_result') {
              const txt = typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
                  : '';
              // A failed tool call (e.g. calling a non-existent tool) comes back
              // as is_error — capture it so the stop notice can name the cause.
              if (b.is_error && txt.trim()) lastToolError = txt.trim();
              const urls = txt.match(/https?:\/\/[^\s)\]"'<>]+/g);
              if (urls) for (const u of urls) addOauthSource(u.replace(/[.,;]+$/, ''));
            }
          }
        };

        // Whether ANY visible content (text/thought) has been streamed to the
        // client. Gates the auto-retry below: we only retry a failed resume if
        // nothing has been shown yet, so a retry can never duplicate output.
        let producedContent = false;

        // Run ONE query() pass. `useResume` = a session id to continue, or null
        // for a fresh session. Returns the SDK result subtype ('success' or an
        // error like 'error_during_execution') so the caller can decide whether
        // to retry. resume and systemPrompt are mutually exclusive.
        const consume = async (useResume: string | null): Promise<{ subtype: string | null; errorText: string }> => {
          const opts: any = { ...queryOptions };
          if (useResume) { opts.resume = useResume; delete opts.systemPrompt; }
          else { delete opts.resume; opts.systemPrompt = systemPrompt; }
          let resultSubtype: string | null = null;
          let resultErrorText = '';
          for await (const msg of query({ prompt: userMsgGen(!useResume), options: opts } as any)) {
            // Any SDK message means the turn is alive — feed the watchdog.
            touchSdkActivity();
            // Every message carries the session_id once Anthropic has assigned
            // one. We keep capturing in case the first chunks don't have it.
            if ((msg as any).session_id) capturedSessionId = (msg as any).session_id;

            // ── Streaming path: SDKPartialAssistantMessage wraps a raw
            //     Anthropic stream event. This is what makes the bubble fill
            //     in token-by-token instead of arriving as a complete dump.
            if ((msg as any).type === 'stream_event') {
              const ev: any = (msg as any).event;
              if (!ev?.type) continue;

              if (ev.type === 'message_start' && ev.message?.usage) {
                const u = ev.message.usage;
                cumUsage.input += Number(u.input_tokens || 0);
                cumUsage.output += Number(u.output_tokens || 0);
                cumUsage.cacheRead += Number(u.cache_read_input_tokens || 0);
                cumUsage.cacheCreate += Number(u.cache_creation_input_tokens || 0);
              } else if (ev.type === 'message_delta' && ev.usage) {
                // message_delta carries the running output_tokens count.
                cumUsage.output += Number(ev.usage.output_tokens || 0);
              } else if (ev.type === 'content_block_start') {
                curBlockType = ev.content_block?.type || null;
                if (curBlockType === 'tool_use' || curBlockType === 'server_tool_use' || curBlockType === 'mcp_tool_use') {
                  anyToolUsed = true;
                  // Surface what the model is doing so the loading label reflects
                  // the tool call instead of a silent generic "thinking...".
                  // MCP tools arrive as `mcp__nexus__AskQuestion` — strip the
                  // server prefix. AskQuestion/spawn_subagent have their own UI
                  // (question card / subagent chip), so we don't override those.
                  const cleanName = String(ev.content_block?.name || 'a tool').replace(/^mcp__\w+?__/, '');
                  if (cleanName !== 'AskQuestion' && cleanName !== 'spawn_subagent') {
                    shownToolActivity = toolActivityLabel(cleanName) || `using ${cleanName}`;
                    enqueue({ type: 'tool_activity', tool: shownToolActivity });
                  }
                } else if (shownToolActivity && (curBlockType === 'text' || curBlockType === 'thinking' || curBlockType === 'summarized_thinking')) {
                  // Visible content resumed — fall back to "thinking...".
                  shownToolActivity = null;
                  enqueue({ type: 'tool_activity', tool: null });
                }
                // Some blocks ship an initial chunk of text in the start
                // event itself (summarized_thinking often does this for the
                // first sentence of the summary).
                const init = ev.content_block?.summary
                         || ev.content_block?.thinking
                         || ev.content_block?.text
                         || '';
                if (init) {
                  if (curBlockType === 'text') { enqueue({ type: 'text', content: init }); producedContent = true; }
                  else if (curBlockType === 'thinking' || curBlockType === 'summarized_thinking') {
                    enqueue({ type: 'thought', content: init }); producedContent = true;
                  } else if (curBlockType === 'redacted_thinking') {
                    enqueue({ type: 'thought', content: '[Anthropic redacted this thinking block]\n' }); producedContent = true;
                  }
                }
              } else if (ev.type === 'content_block_delta') {
                const d = ev.delta || {};
                if (d.type === 'text_delta' && d.text) {
                  enqueue({ type: 'text', content: d.text }); producedContent = true;
                } else if (d.type === 'thinking_delta' && d.thinking) {
                  enqueue({ type: 'thought', content: d.thinking }); producedContent = true;
                } else if (d.type === 'summary_delta') {
                  // Opus 4.6/4.7 with adaptive+summarized emits these for
                  // each chunk of the thinking summary.
                  const t = d.summary || d.text || '';
                  if (t) { enqueue({ type: 'thought', content: t }); producedContent = true; }
                }
                // signature_delta / redacted_thinking_delta are continuity
                // signals we don't display — silently consumed.
              } else if (ev.type === 'content_block_stop') {
                curBlockType = null;
              }
              continue;
            }

            // ── Non-streaming envelopes ─────────────────────────────────
            // With includePartialMessages enabled, `assistant` messages still
            // arrive at end-of-turn carrying the fully-assembled content.
            // We skip their content (already streamed via stream_events
            // above) but capture authoritative usage if present.
            if (msg.type === 'assistant' || msg.type === 'user') {
              harvestOauthBlocks((msg as any).message?.content);
            }
            if (msg.type === 'assistant') {
              const u = (msg as any).message?.usage;
              if (u) {
                // Use these as the source of truth — they're the consolidated
                // final counts. Reset rather than add to avoid double-counting
                // against the per-event accumulation above.
                cumUsage.input = Number(u.input_tokens || cumUsage.input);
                cumUsage.output = Number(u.output_tokens || cumUsage.output);
                cumUsage.cacheRead = Number(u.cache_read_input_tokens || cumUsage.cacheRead);
                cumUsage.cacheCreate = Number(u.cache_creation_input_tokens || cumUsage.cacheCreate);
              }
              // Capture the model's stop_reason from each assistant turn; the
              // LAST one is why the overall turn ended.
              const sr = (msg as any).message?.stop_reason;
              if (sr) lastStopReason = sr;
            } else if (msg.type === 'result') {
              // Result message signals the end of this query. SDK closes after.
              const errAny: any = msg as any;
              resultSubtype = errAny.subtype || 'success';
              resultErrorText = errAny.error || '';
              break;
            }
          }
          return { subtype: resultSubtype, errorText: resultErrorText };
        };

        // ALWAYS a fresh session with the full reconstructed transcript (see the
        // historyText note above). We deliberately ignore `resumeSessionId`:
        // server-side resume drifts from NEXUS's visible conversation and is the
        // root cause of "Claude can only see the last message" after a loaded
        // `.md`, a rerun, a cross-machine sync, or model interleaving. Sending
        // the whole visible conversation every turn is exactly what the API-key
        // path and every other provider already do, so OAuth Claude now behaves
        // identically — it sees precisely what the user sees.
        void resumeSessionId; // retained in the request body for back-compat; unused
        const res = await consume(null);

        // Explain WHY the turn stopped whenever it didn't end cleanly, so an
        // OAuth stop is never an unexplained freeze. Combines the SDK result
        // subtype, the model's stop_reason, whether any text/tool ran, and the
        // last failed-tool error (which names a call to a non-existent tool).
        {
          const sub = res.subtype || 'success';
          const notes: string[] = [];
          if (/max.?turns/i.test(sub)) {
            notes.push('it hit the tool-iteration limit — the model kept calling tools without finishing. A common cause is repeatedly calling a tool that does not exist, or one that keeps erroring.');
          } else if (sub !== 'success') {
            notes.push(`the agent runtime ended with "${sub}"${res.errorText ? ' — ' + res.errorText : ''}.`);
          }
          if (lastStopReason === 'max_tokens') {
            notes.push('the reply hit the token limit and was cut off — lower the Thinking Level (effort) for this conversation, or resend.');
          } else if (lastStopReason === 'refusal') {
            notes.push('the model declined to continue (stop_reason: refusal).');
          } else if (lastStopReason === 'pause_turn') {
            notes.push('the model paused a long-running turn (stop_reason: pause_turn) and did not resume — resend to continue.');
          }
          if (!producedContent && !anyToolUsed && sub === 'success' && (!lastStopReason || lastStopReason === 'end_turn')) {
            notes.push('the turn ended with no output at all — the model stopped without generating any text or calling any tool.');
          }
          if (lastToolError) {
            // String() guards a TS control-flow quirk: lastToolError is assigned
            // inside the harvestOauthBlocks closure, which CFA can't see, so it
            // wrongly narrows the type here. The runtime value is a real string.
            notes.push(`last tool error → ${String(lastToolError).replace(/\s+/g, ' ').slice(0, 240)}`);
          }
          if (notes.length > 0) {
            enqueue({ type: 'text', content: (producedContent ? '\n\n' : '') + `⚠️ _[Turn stopped: ${notes.join(' ')}]_` });
          }
        }

        if (capturedSessionId) {
          enqueue({ type: 'session_id', sessionId: capturedSessionId });
        }
        const usagePayload = normalizeCacheUsage({
          input_tokens: cumUsage.input,
          output_tokens: cumUsage.output,
          cache_read_input_tokens: cumUsage.cacheRead,
          cache_creation_input_tokens: cumUsage.cacheCreate,
        }, 'claude');
        if (usagePayload) enqueue(usagePayload);

        if (oauthSourceMap.size > 0) {
          enqueue({ type: 'web_sources', sources: [...oauthSourceMap.values()] });
        }

        controller.enqueue(`data: [DONE]\n\n`);
        controller.close();
      } catch (e: any) {
        // Common failure modes here:
        //   - SDK install failed / missing native binary
        //   - OAuth token expired / revoked
        //   - Subscription credit exhausted
        //   - Anthropic-side session not found (resume of stale ID)
        // Surface the message so the user can react (switch to API-key,
        // refresh token, etc.).
        const msg = e?.message || String(e);
        console.error('[claude-oauth] error:', msg);
        controller.enqueue(`data: ${JSON.stringify({ error: `Claude OAuth path failed: ${msg}` })}\n\n`);
        controller.close();
      } finally {
        // Stop the stall watchdog on every exit path — a leaked interval
        // would keep firing enqueue() against a closed controller.
        clearInterval(stallTimer);
        // Discard any interjection that arrived too late to be delivered (e.g.
        // after the entity's last tool call) so it can't leak into a later turn.
        clearInjections(injectTurnId);
      }
    },
  });

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ── Auto-Model-Select helpers ────────────────────────────────────────────────
// Format for the user-editable allowed-models textarea:
//   family | specificModel | on|off | optional display label
// Comments (#) and blank lines are ignored.
interface AllowedModel {
  family: string;          // user-supplied family name ('Claude', 'GLM', etc.)
  specificModel: string;   // model id passed downstream
  thinking: boolean;       // true → thinking-on for whichever flag the family uses
  label: string;           // human-readable label shown in the meta bar
}

function buildModelLabel(family: string, specificModel: string, thinking: boolean, modelParams?: any): string {
  // Try to produce a clean "Claude Opus 4.7 Thinking" form. Falls back to
  // raw "<family> <specificModel>" if we don't recognize the pattern.
  let pretty = specificModel || '';
  // Strip common prefixes like "moonshotai/" so labels stay tidy.
  if (pretty.includes('/')) pretty = pretty.split('/').pop()!;
  // OpenAI ids like "gpt-5.4-mini" read best with an uppercase "GPT" and the
  // original hyphens preserved — skip the generic title-casing below.
  if (/^gpt[-\d]/i.test(pretty)) {
    const suffixO = thinking ? ' Thinking' : '';
    return `${family} ${pretty.replace(/^gpt/i, 'GPT')}${suffixO}`;
  }
  // Capitalize first letter of each segment split on -/_/space.
  pretty = pretty
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .map((w: string) => w ? (w[0].toUpperCase() + w.slice(1)) : w)
    .join(' ');
  const suffix = thinking ? ' Thinking' : '';
  // For Gemini, include the thinking level since it's not a boolean.
  const fam = (family || '').toLowerCase();
  if (fam.includes('gemini') && modelParams?.thinkingLevel) {
    const lvl = modelParams.thinkingLevel;
    return `${family} ${pretty} Thinking (${lvl[0].toUpperCase() + lvl.slice(1)})`;
  }
  return `${family} ${pretty}${suffix}`;
}

function parseAllowedModels(raw: string): AllowedModel[] {
  const out: AllowedModel[] = [];
  if (!raw || typeof raw !== 'string') return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const [family, specificModel, thinkingFlag, ...rest] = parts;
    if (!family || !specificModel) continue;
    const thinking = /^(on|true|yes|enabled|thinking|y|1)$/i.test(thinkingFlag);
    const labelRaw = rest.length ? rest.join(' | ').trim() : '';
    const label = labelRaw || buildModelLabel(family, specificModel, thinking);
    out.push({ family, specificModel, thinking, label });
  }
  return out;
}

// Build the common selector prompt + enum ids shared by every provider branch.
function buildSelectorPrompt(criteria: string, allowed: AllowedModel[], messages: any[]) {
  const enumIds = allowed.map((_, i) => String(i));
  // Compressed conversation excerpt: last N messages, content trimmed to keep
  // the preflight payload small. Selector only needs to grasp recent intent.
  const RECENT = 6;
  const recent = messages.slice(-RECENT).map((m: any) => {
    const text = (m.content || '').slice(0, 600);
    return `[${m.role}] ${text}`;
  }).join('\n\n');
  const optionsText = allowed.map((m, i) =>
    `${i}. ${m.label}  (family=${m.family}, model=${m.specificModel}, thinking=${m.thinking ? 'on' : 'off'})`
  ).join('\n');
  const systemPrompt =
    'You are a model selector. Read the user-supplied criteria and the recent ' +
    'conversation, then call the `select_model` tool with the index of the most ' +
    'appropriate option. Do not respond with text — only the tool call.';
  const userMsg =
    `=== Criteria ===\n${criteria || '(no criteria provided)'}\n\n` +
    `=== Allowed models ===\n${optionsText}\n\n` +
    `=== Recent conversation (newest last) ===\n${recent || '(empty)'}\n\n` +
    `Now call select_model with the integer index (as a string) of your choice.`;
  return { systemPrompt, userMsg, enumIds };
}

// Validate the model_id the selector returned (string or number) and look up
// the matching AllowedModel entry. Returns null on out-of-range / NaN.
function resolveSelectorAnswer(rawId: any, allowed: AllowedModel[]): AllowedModel | null {
  const id = String(rawId ?? '');
  const idx = parseInt(id, 10);
  if (isNaN(idx) || idx < 0 || idx >= allowed.length) return null;
  return allowed[idx];
}

// Run the model-selector preflight using the user's CURRENTLY-SELECTED model
// (not a hardcoded one). Dispatches by family:
//   • Claude     → Anthropic SDK with input_schema + tool_choice.type='tool'
//   • Gemini     → @google/genai SDK with functionDeclarations + ANY mode
//   • all others → OpenAI-compatible /chat/completions with tool_choice
//                  routed to the right URL/key (DeepSeek-direct, DashScope,
//                  Z.AI, xAI, Moonshot, Cohere, MiniMax, LM Studio).
// Thinking is forced OFF where the provider supports it — the selector task
// doesn't need reasoning and we don't want to inflate per-turn latency.
// Returns null on any failure (the caller falls back to the user's original
// selection, so a flaky selector never blocks chat).
async function runModelSelectorPreflight(args: {
  aiName: string;
  specificModel: string;
  modelParams: any;
  keys: any;
  criteria: string;
  allowed: AllowedModel[];
  messages: any[];
}): Promise<AllowedModel | null> {
  const { aiName, specificModel, modelParams, keys, criteria, allowed, messages } = args;
  if (allowed.length === 0) return null;
  const { systemPrompt, userMsg, enumIds } = buildSelectorPrompt(criteria, allowed, messages);

  const fam = (aiName || '').toLowerCase();

  // ── Claude branch ──────────────────────────────────────────────────────
  if (fam.includes('claude')) {
    if (!keys.claude) return null;
    const anthropic = new Anthropic({ apiKey: keys.claude });
    const claudeModel = specificModel?.includes('claude') ? specificModel : 'claude-haiku-4-5-20251001';
    // Skip `thinking` entirely — Claude defaults to no extended thinking when
    // the field is omitted. tool_choice forces the tool to fire.
    const resp = await anthropic.messages.create({
      model: claudeModel,
      system: systemPrompt,
      max_tokens: 512,
      messages: [{ role: 'user', content: userMsg }],
      tools: [{
        name: 'select_model',
        description: 'Pick the index of the most appropriate model for the user\'s most recent message.',
        input_schema: {
          type: 'object',
          properties: {
            model_id: { type: 'string', enum: enumIds, description: 'Integer index (as string) of chosen model.' },
          },
          required: ['model_id'],
        },
      }],
      tool_choice: { type: 'tool', name: 'select_model' },
    } as any);
    for (const block of (resp as any).content || []) {
      if (block.type === 'tool_use' && block.name === 'select_model') {
        return resolveSelectorAnswer((block as any).input?.model_id, allowed);
      }
    }
    return null;
  }

  // ── Gemini branch ──────────────────────────────────────────────────────
  if (fam.includes('gemini')) {
    if (!keys.google) return null;
    const isLive = (specificModel || '').includes('live');
    const ai = new GoogleGenAI({ apiKey: keys.google, ...(isLive ? { apiVersion: 'v1alpha' } : {}) });
    const geminiModel = specificModel || 'gemini-3.5-flash';
    const resp = await ai.models.generateContent({
      model: geminiModel,
      contents: [{ role: 'user', parts: [{ text: userMsg }] }],
      config: {
        systemInstruction: systemPrompt,
        // Gemini 3.x can't fully disable thinking — 'minimal' is the cheapest.
        thinkingConfig: { thinkingLevel: 'minimal', includeThoughts: false } as any,
        tools: [{ functionDeclarations: [{
          name: 'select_model',
          description: 'Pick the index of the most appropriate model for the user\'s most recent message.',
          parameters: {
            type: 'OBJECT',
            properties: {
              model_id: { type: 'STRING', enum: enumIds, description: 'Integer index (as string) of chosen model.' },
            },
            required: ['model_id'],
          },
        }] }],
        toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['select_model'] } },
      } as any,
    });
    for (const cand of (resp as any).candidates || []) {
      for (const part of cand.content?.parts || []) {
        if (part.functionCall?.name === 'select_model') {
          return resolveSelectorAnswer(part.functionCall.args?.model_id, allowed);
        }
      }
    }
    return null;
  }

  // ── Local (LM Studio) branch — TEXT-BASED selection ──────────────────────
  // LM Studio models are unreliable at forced `tool_choice`/function calling
  // (same reason Layer-1 uses a text approach): many reject the forced tool
  // with an HTTP 400, which would make the shared OpenAI-compatible branch
  // below throw and silently fall back to the original model — so auto-select
  // never actually worked on a local selector. Instead we ask for a bare
  // integer index and parse it. No auth, no tools, no tool_choice.
  if (fam.includes('local')) {
    const localUrl = `${process.env.LOCAL_LLM_BASE || 'http://localhost:1234'}/v1/chat/completions`;
    const localSystem =
      'You are a model selector. Read the criteria and the recent conversation, ' +
      'then reply with ONLY the integer index of the single most appropriate ' +
      'option. No words, no punctuation, no explanation — just the number.';
    const localBody: any = {
      model: specificModel || 'local-model',
      messages: [
        { role: 'system', content: localSystem },
        { role: 'user', content: `${userMsg}\n\nReply with ONLY the number.` },
      ],
      temperature: 0,
      // Bounded cap: enough headroom for a reasoning model to think then answer,
      // but never -1 (which would let runaway thinking fill the whole context).
      max_tokens: 4096,
      stream: false,
    };
    const res = await fetch(localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(localBody),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Selector Local HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    let text: string = data?.choices?.[0]?.message?.content || '';
    // Strip <think>…</think> so digits inside the model's reasoning aren't
    // mistaken for the final answer.
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
    // Take the LAST in-range integer — the final answer, not a number the model
    // may have mentioned mid-reasoning.
    const nums = [...text.matchAll(/\b(\d{1,2})\b/g)].map((m) => m[1]);
    for (let i = nums.length - 1; i >= 0; i--) {
      const ans = resolveSelectorAnswer(nums[i], allowed);
      if (ans) return ans;
    }
    return null;
  }

  // ── OpenAI-compatible branch (Qwen / DeepSeek / GLM / Grok /
  //                              Kimi / Cohere / MiniMax / OpenAI / MiMo) ──
  const isLocal     = fam.includes('local');
  const isQwen      = fam.includes('qwen');
  const isDeepSeek  = fam.includes('deepseek');
  const isGLM       = fam.includes('glm');
  const isGrok      = fam.includes('grok');
  const isKimi      = fam.includes('kimi');
  const isCohere    = fam.includes('cohere') || fam.includes('command');
  const isMinimax   = fam.includes('minimax');
  const isOpenAI    = fam.includes('openai') || fam.includes('chatgpt');
  const isMimo      = fam.includes('mimo');
  const isBytedance = fam.includes('bytedance');
  const isDashScope = isQwen || isDeepSeek;
  // DeepSeek direct vs via DashScope (only deepseek-v3.2 lives on DashScope).
  const useDeepSeekDirect = isDeepSeek && !!specificModel && specificModel !== 'deepseek-v3.2';

  const url = useDeepSeekDirect
    ? 'https://api.deepseek.com/v1/chat/completions'
    : isDashScope ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'
    : isGLM       ? 'https://api.z.ai/api/paas/v4/chat/completions'
    : isGrok      ? 'https://api.x.ai/v1/chat/completions'
    : isKimi      ? 'https://api.moonshot.ai/v1/chat/completions'
    : isCohere    ? 'https://api.cohere.ai/compatibility/v1/chat/completions'
    : isMinimax   ? 'https://api.minimax.io/v1/chat/completions'
    : isOpenAI    ? 'https://api.openai.com/v1/chat/completions'
    : isMimo      ? 'https://api.xiaomimimo.com/v1/chat/completions'
    : isBytedance ? 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions'
    : isLocal     ? `${process.env.LOCAL_LLM_BASE || 'http://localhost:1234'}/v1/chat/completions`
    : null;
  if (!url) return null;

  const apiKey = useDeepSeekDirect ? keys.deepseek
    : isDashScope ? keys.qwen
    : isGLM       ? keys.glm
    : isGrok      ? keys.grok
    : isKimi      ? keys.kimi
    : isCohere    ? keys.cohere
    : isMinimax   ? keys.minimax
    : isOpenAI    ? keys.openai
    : isMimo      ? keys.mimo
    : isBytedance ? keys.bytedance
    : null; // Local has no auth
  if (!isLocal && !apiKey) return null;

  // Provider-specific thinking-disable. Selection is a trivial task — we
  // don't want extended reasoning eating latency or output tokens.
  // Qwen Omni models (qwen3.5-omni-flash / -plus) reject `enable_thinking`
  // — DashScope validates a derived `thinking_budget` and refuses the disable
  // path with a contradictory "must be positive integer and not greater than 0"
  // error. Skip the toggle for Omni; reasoning is built into those models.
  const isOmni = (specificModel || '').toLowerCase().includes('omni');
  const extra: any = {};
  // Kimi K3 does NOT use the K2.x `thinking` param — reasoning is always on and
  // configured via the top-level `reasoning_effort` field (only 'max' today). It
  // also fixes temperature/top_p server-side, so those are omitted below.
  const selKimiK3 = isKimi && /k3/i.test(resolveKimiModel(specificModel));
  if ((isQwen || isDeepSeek) && !isOmni) extra.enable_thinking = false;
  if (isGLM || (isKimi && !selKimiK3)) extra.thinking = { type: 'disabled' };
  if (selKimiK3) extra.reasoning_effort = 'max';
  if (isCohere) extra.reasoning_effort = 'none';
  // OpenAI GPT-5 family: DO NOT set `reasoning_effort` here. This selector always
  // sends a forced `select_model` function tool, and gpt-5.x on
  // /v1/chat/completions 400s when `reasoning_effort` is combined with function
  // tools ("Please use /v1/responses instead"). GPT-5 still reasons at its
  // default effort, which is plenty for a one-shot index pick.
  // Grok / MiniMax / Local: no toggle exists. Grok's reasoning is set by
  // model-suffix; MiniMax always reasons; LM Studio runs the loaded weights.

  const body: any = {
    model: isKimi ? resolveKimiModel(specificModel) : (specificModel || (
      isGLM      ? 'glm-4.7' :
      isGrok     ? 'grok-4.5' :
      isCohere   ? 'command-a-plus-05-2026' :
      isMinimax  ? 'MiniMax-M3' :
      isDeepSeek ? 'deepseek-v4-flash' :
      isQwen     ? 'qwen3.6-plus' :
      isOpenAI   ? 'gpt-5.6-terra' :
      isMimo     ? 'mimo-v2.5' :
      isBytedance ? 'seed-2-0-pro-260328' :
                   'local-model'
    )),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMsg },
    ],
    // GPT-5 reasoning models reject a non-default temperature and use
    // `max_completion_tokens` instead of `max_tokens`. Every other
    // OpenAI-compatible provider accepts the classic pair.
    ...(isOpenAI
      ? { max_completion_tokens: 512 }
      : selKimiK3
        ? { max_tokens: 512 }                       // K3 fixes temp/top_p — omit them
        : { temperature: 0.0, max_tokens: 512 }),
    ...extra,
    tools: [{
      type: 'function',
      function: {
        name: 'select_model',
        description: 'Pick the index of the most appropriate model for the user\'s most recent message.',
        parameters: {
          type: 'object',
          properties: {
            model_id: { type: 'string', enum: enumIds, description: 'Integer index (as string) of chosen model.' },
          },
          required: ['model_id'],
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'select_model' } },
    stream: false,
  };
  // LM Studio's max_tokens uses -1 to mean "unlimited" — but we explicitly
  // want a tight cap on the selector, so leave the 512 cap above.

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Selector ${aiName} HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
  const argStr = toolCall?.function?.arguments;
  if (argStr) {
    let parsed: any;
    try { parsed = JSON.parse(argStr); } catch { return null; }
    return resolveSelectorAnswer(parsed?.model_id, allowed);
  }
  // Fallback for Local / loosely-tool-trained models: try to find a bare
  // integer in the visible content (e.g. "I pick option 2"). The selector
  // system prompt asks for the tool, but model adherence varies.
  const text: string = data?.choices?.[0]?.message?.content || '';
  const m = text.match(/\b(\d{1,2})\b/);
  if (m) return resolveSelectorAnswer(m[1], allowed);
  return null;
}

export async function POST(req: Request) {
  try {
    // `let` (not const) — auto-model-selection may override aiName,
    // specificModel, and modelParams below before the provider flags are
    // computed. All downstream code reads the post-override values.
    let {
      messages,
      aiName,
      folderName = 'Default',
      systemPrompt = "You are a helpful AI assistant.",
      toolUseEnabled = false,
      // ── Per-Entity agent capability toggles (apply to ALL providers) ──────
      // agentFullSystemAccess: file tools reach the whole PC (absolute paths),
      //   instead of being sandboxed to agent_workspaces/<Entity>/.
      // agentDangerousTools: enables the Delete tool everywhere, and (OAuth
      //   path only) the Bash/shell family.
      agentFullSystemAccess = false,
      agentDangerousTools = false,
      // Per-Entity overrides for NEXUS's hidden/injected instruction strings
      // (tool descriptions, path rules, read_conversation + web tool text).
      // Empty/missing keys fall back to the English defaults.
      instructionOverrides = {},
      toolInstruction = '',
      toolImageInstruction = '',
      modelParams = { temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'medium' },
      specificModel = 'gemini-3.5-flash',
      dateTimeVisibility = 'none',
      creativityControlEnabled = false,
      hiddenAnalysisInstruction = DEFAULT_ANALYSIS_INSTRUCTION,
      creativityDisplayPattern = '[Chosen Creativity: {C}]\n\n',
      seedEnabled = false,
      seedValue = 42,
      // ── Auto Model Selection (per-conversation) ───────────────────────────
      // When enabled, run a GLM-4.6V-Flash preflight that picks a model from
      // the user-curated allowedModels list (one per line, pipe-delimited).
      // The chosen model overrides aiName/specificModel/modelParams below.
      autoModelSelectEnabled = false,
      autoModelSelectCriteria = '',
      autoModelSelectAllowedModels = '',
      // Conversation UUID. Used as the `x-grok-conv-id` header on xAI Grok
      // requests — xAI explicitly recommends it to maximize prompt-cache hit
      // rates by hinting that consecutive calls belong to the same session.
      convoId = '',
      // Per-conversation Anthropic-side session ID. Only consumed by the
      // Claude OAuth (Agent SDK) path. When null, a fresh session starts;
      // when set, the session is resumed so role semantics are preserved.
      claudeAgentSessionId = null,
      // Per-conversation Claude billing mode.
      //   'api-key'  → token-paid API key (sk-ant-...)
      //   'oauth'    → monthly-paid OAuth token (sk-ant-oat01-..., Pro/Max)
      //   'auto'     → prefer OAuth if configured, else fall back to API key
      // Defaults to 'auto' so existing conversations without this field
      // keep working as before.
      claudeAuthMode: requestedClaudeAuthMode = 'auto',
      // ── "Eyes" — vision-bridging for text-only models ────────────────────
      // When the active chat model can't see images, NEXUS routes each image
      // through a multimodal helper model (default GLM-5V-Turbo on Z.AI) and
      // substitutes the raw image with the returned text description. This
      // lets you keep a text-only entity (e.g. glm-5-turbo, deepseek-chat,
      // glm-4.6) while still allowing image-bearing conversations to flow.
      //   • eyesEnabled — master toggle (default ON)
      //   • eyesPrompt  — entity-specific instruction sent with each image
      //   • eyesModel   — the multimodal model to call (default glm-5v-turbo)
      // For vision-capable primary models, all three fields are ignored.
      eyesEnabled = false,
      eyesPrompt = 'Describe this image in detail for an AI that cannot see images. Be specific about people, objects, text, colors, composition, and context. Output only the description, no preamble.',
      eyesModel = 'glm-5v-turbo',
      // ── "Ears" — audio bridge for non-audio-capable primary models ───────
      // Same architecture as eyes: when the active model can't take audio,
      // NEXUS routes each audio attachment through an audio-capable model
      // (Qwen Omni or Gemini) and substitutes the audio bytes with a text
      // transcript/description. Cached on disk by (audioBytes, prompt, model).
      earsEnabled = false,
      earsPrompt = 'Listen to this audio carefully. Provide a transcript of any speech (preserving the speaker\'s original language), then describe non-speech elements: tone of voice, background sounds, music, ambient noise, and overall context. Output only the transcript+description, no preamble.',
      earsModel = 'qwen3.5-omni-flash',
      // ── "Video Watcher" — video bridge for non-video-capable primary models ─
      // Same architecture as eyes/ears. Default model is Gemini 3.5 Flash
      // since Gemini handles video content particularly well; Qwen Omni is a
      // valid alternative selectable from the conversation settings.
      watcherEnabled = false,
      watcherPrompt = 'Watch this video carefully. Describe what happens chronologically: actions, people, objects, setting changes, on-screen text, and audio (speech transcript + non-speech sounds). Be thorough but concise. Output only the description, no preamble.',
      watcherModel = 'gemini-3.5-flash',
      // ── read_conversation tool gate ──────────────────────────────────────
      // Enabled when the folder opts into "summaries instead of the 4th layer"
      // (so the model can pull the full text of any active past conversation it
      // sees summarized in the live Layer-4 index). Inactive conversations are
      // refused server-side.
      enableReadConversation = false,
      // ── Interactive "Ask the user a question" tool ───────────────────────
      // Optional, per-conversation. When ON, the model gets an AskUserQuestion
      // tool that pauses the turn to ask a multiple-choice question and waits
      // for the user's selection (via the /api/chat/answer rendezvous).
      //   askUserEnabled    — master toggle (default OFF; the tool is opt-in).
      //   askUserTimeoutMs  — how long to wait for an answer. 0 (or missing) =
      //                       wait INDEFINITELY (the default behavior).
      askUserEnabled = false,
      askUserTimeoutMs = 0,
      // ── Subagent (context-firewall helper) ───────────────────────────────
      // Optional, per-conversation. When ON (OAuth path), the model gets a
      // spawn_subagent tool that delegates an investigation to a fresh-context
      // read-only child and returns only the distilled result.
      //   subagentEnabled — master toggle (default OFF).
      //   subagentModel   — model the child runs on ('' = cheap default).
      subagentEnabled = false,
      subagentModel = '',
      // Provider family of the subagent model (e.g. 'GLM', 'Claude', 'Grok').
      // Routes the child to that provider's endpoint+key, independent of the
      // parent's provider. Empty = inherit the parent's family.
      subagentFamily = '',
      // Per-turn id for mid-turn "partner interjections". The frontend
      // generates it before sending and can POST /api/chat/inject { turnId,
      // text } while this request streams; the running tool loop drains those
      // messages at its next model-call boundary. Empty = feature not used.
      injectTurnId = '',
    } = await req.json();
    const keys = await loadKeys();

    // Per-Entity editable footer = Layer 5. When the entity keeps a FOOTER.md in
    // its workspace, its contents are injected as a self-authored "Layer 5"
    // block — the SAME auto-generated-heading mechanism as the Layer-4 summaries
    // index, so it reads as a proper fifth layer of the identity. The entity
    // edits only the body (FOOTER.md) with its own file tools; the heading is
    // added here at send time and never stored. No FOOTER.md → prompt unchanged.
    // Every changed version is snapshotted server-side (see backupFooterIfChanged).
    try {
      const footer = await readEntityFooter(folderName);
      if (footer && footer.trim()) {
        systemPrompt = appendLayer5Footer(systemPrompt, footer);
      }
    } catch { /* footer is best-effort; never block a turn on it */ }

    // Per-Entity path-scope hints baked into the workspace tool descriptions so
    // the model knows whether absolute paths are allowed. Without this, the
    // descriptions kept saying "never use absolute paths" even with Full PC
    // access ON, so non-OAuth models never tried to reach outside their
    // workspace (the fs layer would have allowed it).
    // Resolve all hidden instruction strings (defaults overlaid with this
    // Entity's per-folder overrides). Used to build every tool description below.
    const I = resolveAgentInstructions(instructionOverrides);
    const pathDesc = agentFullSystemAccess ? I.pathParamFull : I.pathParamSandbox;
    const pathRule = agentFullSystemAccess ? I.pathRuleFull : I.pathRuleSandbox;

    // ── Auto-Model-Select preflight ─────────────────────────────────────────
    // Runs BEFORE the provider flags are computed so the resolved model drives
    // every downstream branch. The preflight uses whatever model the
    // conversation is CURRENTLY set to — no more hardcoded GLM-4.6V-Flash,
    // which used to 429 on the free tier and block every turn. Failure modes
    // (no API key, parse error, empty list, network error, no tool call in
    // response) all fall through to the user's originally-selected model —
    // a flaky selector never blocks normal chat.
    //
    // `autoSelectedThinking` captures the chosen entry's thinking flag so the
    // model_selected SSE label is accurate even for families (Local, Grok,
    // MiniMax) where modelParams has no per-provider thinking field to read.
    let autoSelectedThinking: boolean | null = null;
    if (autoModelSelectEnabled) {
      const allowed = parseAllowedModels(autoModelSelectAllowedModels);
      if (allowed.length > 0) {
        try {
          const chosen = await runModelSelectorPreflight({
            aiName,
            specificModel,
            modelParams,
            keys,
            criteria: autoModelSelectCriteria,
            allowed,
            messages,
          });
          if (chosen) {
            aiName = chosen.family;
            specificModel = chosen.specificModel;
            autoSelectedThinking = chosen.thinking;
            // Map the thinking flag to the provider-specific parameter shape.
            // We re-derive the family from the chosen entry (NOT from the
            // post-override aiName lowercase, which would also work but is
            // less explicit here).
            const fam = chosen.family.toLowerCase();
            const t = !!chosen.thinking;
            const patch: any = {};
            if (fam.includes('claude')) patch.claudeThinking = t;
            // Qwen / DeepSeek / GLM / Kimi / Cohere all read the same flag.
            if (fam.includes('qwen') || fam.includes('deepseek') || fam.includes('glm') ||
                fam.includes('kimi') || fam.includes('cohere') || fam.includes('command')) {
              patch.qwenEnableThinking = t;
            }
            // Gemini 3.x can't fully disable — map "off" to 'minimal'.
            if (fam.includes('gemini')) patch.thinkingLevel = t ? 'medium' : 'minimal';
            modelParams = { ...modelParams, ...patch };
          }
        } catch (e) {
          // Don't surface preflight errors to the user — fall back silently.
          console.warn('[auto-model-select] preflight failed:', e);
        }
      }
    }

    const isClaude    = aiName.toLowerCase().includes('claude');
    const isGemini    = aiName.toLowerCase().includes('gemini');
    const isLocal     = aiName.toLowerCase().includes('local');
    const isQwen      = aiName.toLowerCase().includes('qwen');
    // DeepSeek may go through DashScope (deepseek-v3.2) or its own API.
    const isDeepSeek  = aiName.toLowerCase().includes('deepseek');
    // GLM is Z.AI (Zhipu) — its own OpenAI-compatible endpoint.
    const isGLM       = aiName.toLowerCase().includes('glm');
    // Grok is xAI — its own OpenAI-compatible endpoint at api.x.ai/v1.
    // Reasoning effort is selected via model-name suffix (-reasoning /
    // -non-reasoning), so we don't send a thinking toggle parameter.
    const isGrok      = aiName.toLowerCase().includes('grok');
    // Kimi is Moonshot's model family, served by Moonshot's first-party API
    // (api.moonshot.ai) using keys.kimi. Thinking mode shape matches GLM's
    // `thinking: { type: 'enabled' | 'disabled' }` field.
    const isKimi      = aiName.toLowerCase().includes('kimi');
    // Cohere Command A family via their official OpenAI-compatibility
    // endpoint. Thinking is toggled via OpenAI's standard
    // `reasoning_effort` field: "high" (on) / "none" (off).
    const isCohere    = aiName.toLowerCase().includes('cohere') || aiName.toLowerCase().includes('command');
    // MiniMax M2.7 via their OpenAI-compatible endpoint. Reasoning is built
    // into the model (always-on, no parameter toggle documented), so we
    // don't send a thinking flag — analogous to how DeepSeek R1 is treated.
    const isMinimax   = aiName.toLowerCase().includes('minimax');
    // OpenAI ChatGPT (GPT-5 family) via the first-party OpenAI API — the
    // canonical OpenAI-compatible /chat/completions endpoint. Reasoning is
    // toggled via the standard `reasoning_effort` field; GPT-5 reasoning models
    // reject custom temperature/top_p and use `max_completion_tokens`.
    const isOpenAI    = aiName.toLowerCase().includes('chatgpt') || aiName.toLowerCase().includes('openai');
    // Xiaomi MiMo (MiMo-V2.5 / MiMo-V2.5-Pro) via their OpenAI-compatible
    // endpoint (api.xiaomimimo.com/v1). MiMo is a reasoning-first family with
    // reasoning built in; no documented on/off thinking parameter, so — like
    // MiniMax — we don't send a thinking flag (avoids a 400 on an unknown param).
    const isMimo      = aiName.toLowerCase().includes('mimo');
    // ByteDance Seed 2.0 (seed-2-0-pro/lite/mini/code-* snapshots) via BytePlus
    // ModelArk's OpenAI-compatible endpoint (ark.ap-southeast.bytepluses.com/
    // api/v3). Reasoning is built into the Seed family; no documented on/off
    // thinking parameter is sent (like MiniMax / MiMo) to avoid a 400.
    const isBytedance = aiName.toLowerCase().includes('bytedance');
    // Anything routed through DashScope shares the same base URL + Bearer key.
    const isDashScope = isQwen || isDeepSeek;

    // ── Compute the model-selected SSE payload ──────────────────────────────
    // Emitted at the very start of every stream (auto-select on OR off) so
    // every AI message gets a precise family/specific/thinking/label tag in
    // the meta bar. Display-only — the frontend stores it on the message
    // metadata but slimHistory drops it on subsequent turns, so this never
    // leaks back into the AI context window.
    // When auto-select picked a model, its declared thinking flag is the
    // source of truth — Local and other parameter-less families can't be
    // inferred from modelParams alone. Falls back to provider-specific
    // detection when the user is running on a manually-picked model.
    const modelThinkingFlag: boolean =
      autoSelectedThinking !== null ? autoSelectedThinking :
      isClaude       ? !!modelParams.claudeThinking :
      isGemini       ? (modelParams.thinkingLevel && modelParams.thinkingLevel !== 'minimal' && modelParams.thinkingLevel !== 'none') :
      (isQwen || isDeepSeek || isGLM || isKimi || isCohere || isOpenAI)
                     ? modelParams.qwenEnableThinking !== false :
      isMinimax      ? true :
      isMimo         ? true :
      isBytedance    ? true :
      isGrok         ? /reasoning/i.test(specificModel || '') && !/non-?reasoning/i.test(specificModel || '') :
                       false;
    const modelLabelForSSE = buildModelLabel(aiName, specificModel, modelThinkingFlag, modelParams);
    const modelSelectedPayload = {
      type: 'model_selected',
      family: aiName,
      specificModel,
      thinking: modelThinkingFlag,
      label: modelLabelForSSE,
    };

    const formatDate = (ts: number) => {
      const d = new Date(ts);
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    // ── "Senses" gating ──────────────────────────────────────────────────────
    // Each flag is true only when the active primary model can't accept that
    // modality AND its per-conversation toggle is on. Three independent
    // pipelines: image → eyes (Z.AI GLM-V), audio → ears (Qwen Omni or
    // Gemini), video → watcher (Gemini or Qwen Omni). For multimodal primary
    // models all three flags stay false and the media passes through unchanged.
    const useEyes    = !!eyesEnabled    && !isVisionCapable(specificModel);
    const useEars    = !!earsEnabled    && !isAudioCapable(specificModel);
    const useWatcher = !!watcherEnabled && !isVideoCapable(specificModel);

    // OAuth-Claude-only exception for EYES (does NOT change any other path).
    // The OAuth/Agent-SDK Claude path flattens history to a text transcript that
    // carries no historical image bytes — so a vision-capable OAuth Claude sees
    // only the CURRENT turn's images natively and is blind to every earlier one.
    // When eyes is ON we describe PAST images only (not the current turn) so the
    // description persists into the transcript and gives durable recall, while
    // current images still reach Claude as native pixels. Text-only models are
    // unaffected (they already bridge via useEyes); non-OAuth and non-Claude
    // paths are untouched. Vision-capable gate: if Claude were somehow text-only
    // useEyes already covers it, so this only adds the past-image case.
    const isOAuthClaude = isClaude && (() => {
      const req = (requestedClaudeAuthMode as string) || (keys.claudeAuthMode as string) || 'auto';
      const mode = req !== 'auto' ? req : (keys.claudeOAuthToken ? 'oauth' : 'api-key');
      return mode === 'oauth' && !!keys.claudeOAuthToken;
    })();
    const oauthPastImageEyes = isOAuthClaude && !!eyesEnabled && !useEyes;

    // Accumulator for sense-bridge events emitted at the start of each
    // provider branch's stream. One entry per newly-generated description.
    // The frontend matches by (messageId, attachmentId or name) and stores
    // the description back onto the attachment in conversation state — so
    // the same attachment is never re-described on subsequent turns.
    const senseEvents: any[] = [];

    // Filter out excluded attachments from the history. Uses Promise.all so
    // that bridge calls (eyes/ears/watcher) run in parallel across messages.
    // Description re-use: if an attachment already carries `att.description`
    // (persisted from a previous turn), skip the API call entirely and
    // inline the saved text — no money spent, no latency, no event emitted.
    const processedMessages = await Promise.all(messages.map(async (m: any, index: number) => {
      let contentStr = m.content || '';
      const mediaFiles: any[] = [];

      let timeTag = '';
      if (m.timestamp) {
        if (dateTimeVisibility === 'all') {
          timeTag = `[${formatDate(m.timestamp)}]\n`;
        } else if (dateTimeVisibility === 'current' && index === messages.length - 1) {
          timeTag = `[${formatDate(m.timestamp)}]\n`;
        }
      }
      contentStr = timeTag + contentStr;

      if (m.attachments && m.attachments.length > 0) {
        for (const att of m.attachments) {
          if (att.excluded) continue;
          if (att.isText && att.textData) {
            contentStr += `\n\n<attached_file name="${att.name}">\n${att.textData}\n</attached_file>`;
          } else if (att.dataUrl) {
            try {
              const parts = att.dataUrl.split(',');
              if (parts.length !== 2) continue;
              const mimeType = parts[0].split(';')[0].split(':')[1];
              const base64Data = parts[1];

              // Sense-bridging: when the active primary model can't accept a
              // given media type, route through the corresponding bridge model
              // and substitute the raw bytes with a text description. The
              // description is stored on the attachment so subsequent turns
              // re-use it without re-calling the bridge model.
              const isImage = !!(mimeType && mimeType.startsWith('image/'));
              // Current turn = the last message in the request (the user's live
              // message). Its images must stay native — only PAST images get the
              // OAuth-Claude description treatment.
              const isPastMessage = index < messages.length - 1;
              const wantEyes = isImage && (useEyes || (oauthPastImageEyes && isPastMessage));
              const wantBridge =
                wantEyes ? 'eyes'    :
                (useEars    && mimeType && mimeType.startsWith('audio/')) ? 'ears'    :
                (useWatcher && mimeType && mimeType.startsWith('video/')) ? 'watcher' :
                null;

              if (wantBridge && typeof att.description === 'string' && att.description.trim()) {
                // Re-use the persisted description from a previous turn.
                // Tag matches the kind so the AI sees consistent markup.
                if (wantBridge === 'watcher') {
                  console.log(`[watcher ${att.name || '(unnamed)'}] DESCRIPTION-REUSE · ${att.description.length} chars from previous turn · skipping API call`);
                }
                const tagName =
                  wantBridge === 'eyes' ? 'image_description' :
                  wantBridge === 'ears' ? 'audio_description' :
                                          'video_description';
                contentStr +=
                  `\n\n<${tagName} filename="${att.name || wantBridge}" via="${att.descriptionModel || 'cached'}">\n` +
                  `${att.description}\n` +
                  `</${tagName}>`;
              } else if (wantBridge === 'eyes') {
                const result = await describeImage({
                  imageBase64: base64Data,
                  imageMimeType: mimeType,
                  eyesPrompt,
                  eyesModel,
                  zaiKey: keys.glm || '',
                  geminiKey: keys.gemini || '',
                  mimoKey: keys.mimo || '',
                  oauthToken: keys.claudeOAuthToken || '',
                });
                contentStr +=
                  `\n\n<image_description filename="${att.name || 'image'}" via="${eyesModel}">\n` +
                  `${result.description}\n` +
                  `</image_description>`;
                senseEvents.push({
                  type: 'attachment_described',
                  messageId: m.id,
                  attachmentId: att.id,
                  attachmentName: att.name,
                  kind: 'eyes',
                  model: eyesModel,
                  description: result.description,
                  fromCache: result.fromCache,
                  generatedAt: Date.now(),
                  error: result.error,
                });
              } else if (wantBridge === 'ears') {
                const result = await describeAudio({
                  audioBase64: base64Data,
                  audioMimeType: mimeType,
                  earsPrompt,
                  earsModel,
                  qwenKey: keys.qwen || '',
                  geminiKey: keys.gemini || '',
                  mimoKey: keys.mimo || '',
                  bytedanceKey: keys.bytedance || '',
                });
                contentStr +=
                  `\n\n<audio_description filename="${att.name || 'audio'}" via="${earsModel}">\n` +
                  `${result.description}\n` +
                  `</audio_description>`;
                senseEvents.push({
                  type: 'attachment_described',
                  messageId: m.id,
                  attachmentId: att.id,
                  attachmentName: att.name,
                  kind: 'ears',
                  model: earsModel,
                  description: result.description,
                  fromCache: result.fromCache,
                  generatedAt: Date.now(),
                  error: result.error,
                });
              } else if (wantBridge === 'watcher') {
                const result = await describeVideo({
                  videoBase64: base64Data,
                  videoMimeType: mimeType,
                  watcherPrompt,
                  watcherModel,
                  qwenKey: keys.qwen || '',
                  geminiKey: keys.gemini || '',
                  mimoKey: keys.mimo || '',
                  bytedanceKey: keys.bytedance || '',
                  attachmentName: att.name,
                });
                contentStr +=
                  `\n\n<video_description filename="${att.name || 'video'}" via="${watcherModel}">\n` +
                  `${result.description}\n` +
                  `</video_description>`;
                senseEvents.push({
                  type: 'attachment_described',
                  messageId: m.id,
                  attachmentId: att.id,
                  attachmentName: att.name,
                  kind: 'watcher',
                  model: watcherModel,
                  description: result.description,
                  fromCache: result.fromCache,
                  generatedAt: Date.now(),
                  error: result.error,
                });
              } else {
                // Multimodal primary model or toggle off — pass the media
                // through unchanged. The provider either handles it (vision/
                // audio/video model) or rejects it (text-only with toggle off).
                mediaFiles.push({ mimeType, base64Data, name: att.name });
              }
            } catch (e) { /* malformed dataUrl — skip silently */ }
          }
        }
      }
      return { role: m.role, content: contentStr, mediaFiles, claudeThinkingBlocks: m.claudeThinkingBlocks };
    }));

    // Helper: each provider branch calls this at the start of its stream so
    // the frontend can update message attachments with their new descriptions
    // before the AI text begins flowing.
    const emitSenseEvents = (controller: ReadableStreamDefaultController) => {
      for (const ev of senseEvents) {
        controller.enqueue(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };

    let aiResponseText = '';

    // Build the effective system prompt. If tool use is enabled, append the
    // user-configured tool instruction. Workspace file discovery is on-demand
    // only — the AI calls Glob when it needs to see what files exist.
    let enhancedSystemPrompt = systemPrompt;
    if (toolUseEnabled && (isClaude || isGemini || isLocal || isQwen || isDeepSeek || isGLM || isGrok || isKimi || isCohere || isMinimax || isOpenAI || isMimo || isBytedance)) {
      // File listing removed: the AI discovers workspace contents on demand via
      // Glob (the only supported listing tool). Injecting the full list every
      // turn wasted context tokens and violated the on-demand tool model.
      enhancedSystemPrompt = toolInstruction
        ? `${systemPrompt}\n\n${toolInstruction}`
        : systemPrompt;
    }

    if (isClaude) {
      // ── Auth-mode dispatch ────────────────────────────────────────────────
      // OAuth mode: route through the Agent SDK using the user's Pro/Max
      // subscription credit instead of pay-per-token API. Fully parallel to
      // the API-key path below — if anything goes wrong, switch the billing
      // mode in System Instructions → Model tab.
      //
      // Resolution order:
      //   1. Per-conversation requestedClaudeAuthMode (from request body).
      //   2. Backward compat: keys.claudeAuthMode (old global setting).
      //   3. Auto-detect: OAuth if token present, else API key.
      const resolvedClaudeAuthMode = (() => {
        const req = (requestedClaudeAuthMode as string) || (keys.claudeAuthMode as string) || 'auto';
        if (req !== 'auto') return req;
        return keys.claudeOAuthToken ? 'oauth' : 'api-key';
      })();
      if (resolvedClaudeAuthMode === 'oauth' && keys.claudeOAuthToken) {
        return streamClaudeViaAgentSDK({
          oauthToken: keys.claudeOAuthToken,
          model: specificModel?.includes('claude') ? specificModel : 'claude-opus-4-8',
          systemPrompt: enhancedSystemPrompt,
          processedMessages,
          resumeSessionId: claudeAgentSessionId,
          modelSelectedPayload,
          modelParams,
          folderName,
          senseEvents,
          toolUseEnabled,
          enableReadConversation,
          agentFullSystemAccess,
          agentDangerousTools,
          instructionOverrides,
          askUserEnabled,
          askUserTimeoutMs,
          subagentEnabled,
          subagentModel,
          subagentFamily,
          keys,
          injectTurnId,
        });
      }
      if (resolvedClaudeAuthMode === 'oauth' && !keys.claudeOAuthToken) {
        return NextResponse.json({
          error: 'Claude billing mode is set to Monthly-paid (OAuth) but no OAuth token is configured. Open Preferences → Anthropic and paste the token from `claude setup-token`, or switch this conversation\'s billing mode to Token-paid in System Instructions → Model.',
        }, { status: 400 });
      }

      // ── API-key path ──────────────────────────────────────────────────────
      if (!keys.claude) return NextResponse.json({ error: 'Claude API key missing in settings.' }, { status: 400 });
      const anthropic = new Anthropic({ apiKey: keys.claude });

      const useThinking = !!modelParams.claudeThinking;
      const claudeModel = specificModel?.includes('claude') ? specificModel : 'claude-opus-4-8';

      // Models that support extended thinking
      const thinkingModels = ['claude-opus-4', 'claude-sonnet-4', 'claude-opus-3-7'];
      const modelSupportsThinking = thinkingModels.some(m => claudeModel.includes(m));
      const enableThinking = useThinking && modelSupportsThinking;

      const anthropicMessages = await Promise.all(processedMessages.map(async (m: any) => {
        const contentArr: any[] = [];

        // For assistant messages with saved thinking blocks (for Claude continuity)
        if (m.role === 'assistant' && m.claudeThinkingBlocks?.length) {
          for (const tb of m.claudeThinkingBlocks) {
            if (tb.blockType === 'redacted_thinking' && tb.data) {
              contentArr.push({ type: 'redacted_thinking', data: tb.data });
            } else if (tb.signature) {
              contentArr.push({ type: 'thinking', thinking: tb.thinking || '', signature: tb.signature });
            }
          }
        }

        for (const media of (m.mediaFiles || [])) {
          if (media.mimeType.startsWith('image/')) {
            if (media.name) {
              contentArr.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            }
            // Downscale oversized images so no dimension exceeds Anthropic's
            // 2000px many-image limit (targets a 1568px long edge).
            const img = await shrinkImageForClaude(media.base64Data, media.mimeType);
            contentArr.push({
              type: 'image',
              source: { type: 'base64', media_type: img.media_type, data: img.data }
            });
          }
        }

        if (m.content) {
          contentArr.push({ type: 'text', text: m.content });
        } else if (contentArr.length === 0) {
          contentArr.push({ type: 'text', text: '-' });
        }

        return {
          role: m.role === 'user' ? 'user' : 'assistant',
          content: contentArr
        };
      }));

      // Claude prompt caching: convert the `system` field into an array of
      // text blocks with `cache_control: { type: 'ephemeral' }`. Anthropic
      // bills the system tokens at 1.25× on the first call (cache write) and
      // 0.10× on subsequent calls within the 5-min TTL (cache read). The
      // 4-layer identity prompt + workspace listing is the biggest static
      // piece in NEXUS, so caching it is the highest-ROI placement.
      //
      // We also mark the LAST user message with cache_control to extend the
      // cache to include the full conversation history up to and including
      // that turn. Next turn's prefix (= this turn's content) becomes a
      // cache hit. Anthropic allows up to 4 cache breakpoints per request;
      // we use 2.
      const cachedSystem = enhancedSystemPrompt
        ? [{ type: 'text', text: enhancedSystemPrompt, cache_control: { type: 'ephemeral' } }]
        : undefined;
      const cachedMessages = anthropicMessages.map((m: any, i: number) => {
        if (i !== anthropicMessages.length - 1 || m.role !== 'user') return m;
        // Add cache_control to the last content block of the last user
        // message. This caches the entire prefix (system + prior turns +
        // current user message) so subsequent turns hit on it.
        const lastBlockIdx = m.content.length - 1;
        if (lastBlockIdx < 0) return m;
        const newContent = m.content.map((b: any, idx: number) =>
          idx === lastBlockIdx ? { ...b, cache_control: { type: 'ephemeral' } } : b
        );
        return { ...m, content: newContent };
      });

      const claudeParams: any = {
        model: claudeModel,
        ...(cachedSystem ? { system: cachedSystem } : {}),
        messages: cachedMessages,
      };

      const isOpus47 = claudeModel.includes('opus-4-7') || claudeModel.includes('opus-4.7');
      const isOpus48 = claudeModel.includes('opus-4-8') || claudeModel.includes('opus-4.8');
      // Claude Sonnet 5 (June 2026): adaptive thinking with selectable effort,
      // same request shape as Opus 4.7/4.8 (classic enabled/budget_tokens is
      // rejected). Its top effort tier is 'xhigh' (NOT 'max'), so clamp below.
      const isSonnet5 = claudeModel.includes('sonnet-5') || claudeModel.includes('sonnet5');
      // Claude Fable 5 / Mythos 5: adaptive thinking is the ONLY thinking mode —
      // `thinking: { type: 'disabled' }` is rejected, so thinking is effectively
      // always on. Depth is controlled by `output_config.effort`. Raw chain of
      // thought is never returned; display:'summarized' yields readable summary
      // blocks (handled by the same summarized_thinking path as Opus adaptive).
      const isFable5 = claudeModel.includes('fable-5') || claudeModel.includes('fable5')
        || claudeModel.includes('mythos-5') || claudeModel.includes('mythos5');
      // Newer Opus models (4.7, 4.8) and Fable/Mythos 5 reject the classic
      // `thinking: { type: 'enabled', budget_tokens }` shape and require the
      // adaptive format with an `output_config.effort` control instead.
      const isAdaptiveThinking = isOpus47 || isOpus48 || isFable5 || isSonnet5;
      // Fable/Mythos 5 cannot disable thinking, so force it on regardless of the
      // UI toggle. (Also keeps temperature off, which adaptive models reject.)
      const claudeThinkingOn = enableThinking || isFable5;
      // Per-conversation thinking-depth level for adaptive models. Sonnet 5's
      // highest supported tier is 'xhigh' (Opus/Fable go up to 'max'), so
      // clamp 'max'→'xhigh' for Sonnet 5 to avoid an invalid-effort 400.
      let claudeEffort = sanitizeClaudeEffort(modelParams.claudeEffort);
      if (isSonnet5 && claudeEffort === 'max') claudeEffort = 'xhigh';

      if (claudeThinkingOn) {
        claudeParams.max_tokens = 16000;
        if (isAdaptiveThinking) {
          // Adaptive format; display:summarized makes thinking visible.
          claudeParams.thinking = { type: 'adaptive', display: 'summarized' };
          claudeParams.output_config = { effort: claudeEffort };
          // max_tokens is a HARD cap on thinking + answer COMBINED. When thinking
          // ran long under a tight cap, the budget was spent before (or partway
          // through) the visible answer — the model "stopped without output" or
          // "stopped mid-sentence". Anthropic's documented remedy is to raise
          // max_tokens or lower effort (you CANNOT prefill-continue a thinking
          // response). So scale the ceiling generously with effort, capped to
          // each model's real output limit (Fable 5 → 128k; Opus 4.7/4.8 → 64k).
          // It's a cap, not a reservation — unused tokens are never billed, so a
          // high ceiling only matters when the model genuinely needs the room.
          const modelMaxOut = isFable5 ? 128000 : 64000;
          const effortCeil =
            claudeEffort === 'max'    ? 128000 :
            claudeEffort === 'xhigh'  ? 96000  :
            claudeEffort === 'high'   ? 64000  :
            claudeEffort === 'medium' ? 48000  :
                                        32000;  // low
          claudeParams.max_tokens = Math.min(modelMaxOut, effortCeil);
        } else {
          claudeParams.thinking = { type: 'enabled', budget_tokens: 8000 };
        }
        // temperature must NOT be sent when thinking is enabled (any model)
      } else {
        claudeParams.max_tokens = 8000;
        if (!isAdaptiveThinking) {
          claudeParams.temperature = modelParams.temperature;
        }
      }

      // Optional tools — web search and/or the workspace file tools.
      const claudeTools: any[] = [];
      if (modelParams.enableClaudeWebSearch) {
        // web_search = search engine → list of results (titles/snippets/URLs).
        claudeTools.push({ type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] });
        // web_fetch = open a SPECIFIC URL and read the full page body. Without
        // this, Claude can only search and (correctly) tells the user it
        // "cannot directly open or browse URLs" when asked to read a page.
        // Same generation date-version as web_search for consistency; adjust
        // the suffix if Anthropic's accepted version string differs.
        claudeTools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8, allowed_callers: ['direct'] });
      }
      if (enableReadConversation) {
        claudeTools.push({
          name: 'read_conversation',
          description: I.readConversationDesc,
          input_schema: {
            type: 'object',
            properties: { name: { type: 'string', description: I.readConversationNameParam } },
            required: ['name'],
          },
        });
        claudeTools.push({
          name: 'search_conversations',
          description: I.searchConversationsDesc,
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: I.searchConversationsQueryParam } },
            required: ['query'],
          },
        });
      }
      if (toolUseEnabled) {
        // Tool names mirror Claude Code's built-in workspace tools so the
        // same prompt instructions work in both API-key and OAuth modes.
        // All five operate on `local_data/agent_workspaces/<folderName>/`
        // and refuse paths escaping it (symlink-checked).
        claudeTools.push({
          name: 'Read',
          description: `${I.toolReadDesc} ${pathRule}`,
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: pathDesc } },
            required: ['path'],
          },
        });
        claudeTools.push({
          name: 'Write',
          description: I.toolWriteDesc,
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: pathDesc },
              content: { type: 'string', description: 'Full file contents to write' },
            },
            required: ['path', 'content'],
          },
        });
        claudeTools.push({
          name: 'Edit',
          description: I.toolEditDesc,
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: pathDesc },
              old_string: { type: 'string', description: 'Text to find. Must occur exactly once.' },
              new_string: { type: 'string', description: 'Text to replace it with.' },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        });
        claudeTools.push({
          name: 'Glob',
          description: I.toolGlobDesc,
          input_schema: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'Glob pattern. Use `**` to match all files.' } },
            required: ['pattern'],
          },
        });
        claudeTools.push({
          name: 'Grep',
          description: I.toolGrepDesc,
          input_schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'JavaScript regex (no surrounding slashes).' },
              file_pattern: { type: 'string', description: 'Optional glob to restrict files (e.g. "memories/**/*.md").' },
              flags: { type: 'string', description: 'Optional regex flags (e.g. "i" for case-insensitive).' },
            },
            required: ['pattern'],
          },
        });
        if (agentDangerousTools) {
          claudeTools.push({
            name: 'Delete',
            description: I.toolDeleteDesc,
            input_schema: {
              type: 'object',
              properties: { path: { type: 'string', description: 'Path of the file to delete.' } },
              required: ['path'],
            },
          });
          claudeTools.push({
            name: 'Bash',
            description: I.toolBashDesc,
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The shell command to run.' },
                timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, max 600000).' },
              },
              required: ['command'],
            },
          });
        }
      }
      // Optional interactive AskUserQuestion tool (independent of file tools).
      if (askUserEnabled) {
        claudeTools.push({
          name: 'AskQuestion',
          description: I.askUserDesc,
          input_schema: {
            type: 'object',
            properties: {
              questions: {
                type: 'array',
                description: 'Between 1 and 4 questions to ask the user.',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string', description: 'The full question text. End with a question mark.' },
                    header: { type: 'string', description: 'Very short label/chip for the question (max ~12 chars).' },
                    multiSelect: { type: 'boolean', description: 'Set true to let the user pick multiple options.' },
                    options: {
                      type: 'array',
                      description: '2 to 4 distinct, mutually-exclusive choices.',
                      items: {
                        type: 'object',
                        properties: {
                          label: { type: 'string', description: 'Short option label (1-5 words).' },
                          description: { type: 'string', description: 'What choosing this option means.' },
                        },
                        required: ['label'],
                      },
                    },
                  },
                  required: ['question', 'options'],
                },
              },
            },
            required: ['questions'],
          },
        });
      }
      // Optional subagent (context-firewall helper) tool.
      if (subagentEnabled) {
        claudeTools.push({
          name: 'spawn_subagent',
          description: I.subagentDesc,
          input_schema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'A precise, self-contained investigation for the helper to perform.' },
              return_contract: { type: 'string', description: 'Optional: how the distilled result should be shaped/formatted.' },
            },
            required: ['task'],
          },
        });
      }
      if (claudeTools.length) claudeParams.tools = claudeTools;

      // ── Layer 1: Creativity analysis ────────────────────────────────────────
      let layer1C: number | null = null;
      let layer1ThinkingBlocks: any[] = [];

      if (creativityControlEnabled) {
        const creativityToolDef = {
          name: 'set_creativity',
          description: 'Analyze the context and call this tool with the optimal creativity value C for generating the response.',
          input_schema: {
            type: 'object' as const,
            properties: {
              creativity: { type: 'number', description: 'Creativity level 0.0 (analytical/structured) to 1.0 (experimental/chaotic)' },
            },
            required: ['creativity'],
          },
        };

        // Append analysis instruction to the last user message
        const layer1Msgs = anthropicMessages.map((m: any, i: number) => {
          if (i === anthropicMessages.length - 1 && m.role === 'user') {
            const content = m.content.map((b: any) => ({ ...b }));
            const lastTextIdx = content.reduce((found: number, b: any, idx: number) => b.type === 'text' ? idx : found, -1);
            if (lastTextIdx >= 0) {
              content[lastTextIdx] = { ...content[lastTextIdx], text: content[lastTextIdx].text + '\n\n' + hiddenAnalysisInstruction };
            } else {
              content.push({ type: 'text', text: hiddenAnalysisInstruction });
            }
            return { role: m.role, content };
          }
          return m;
        });

        const layer1Params: any = {
          model: claudeModel,
          system: enhancedSystemPrompt,
          messages: layer1Msgs,
          max_tokens: 4000,
          tools: [creativityToolDef],
          tool_choice: { type: 'tool', name: 'set_creativity' },
        };
        if (claudeThinkingOn) {
          if (isAdaptiveThinking) {
            // Opus 4.7/4.8 and Fable/Mythos 5 reject the classic enabled shape; use adaptive.
            layer1Params.thinking = { type: 'adaptive', display: 'summarized' };
            layer1Params.output_config = { effort: claudeEffort };
          } else {
            layer1Params.thinking = { type: 'enabled', budget_tokens: 2000 };
          }
        } else if (!isAdaptiveThinking) {
          layer1Params.temperature = modelParams.temperature;
        }

        try {
          const layer1Resp = await anthropic.messages.create(layer1Params);
          for (const block of layer1Resp.content) {
            if (block.type === 'tool_use' && block.name === 'set_creativity') {
              const val = Number((block as any).input?.creativity);
              if (!isNaN(val)) layer1C = Math.max(0, Math.min(1, val));
            } else if (block.type === 'thinking') {
              layer1ThinkingBlocks.push({ type: 'thinking', thinking: (block as any).thinking || '', signature: (block as any).signature || '' });
            } else if (block.type === 'redacted_thinking') {
              layer1ThinkingBlocks.push({ type: 'redacted_thinking', data: (block as any).data || '' });
            }
          }
          console.log(`[creativity] Claude Layer 1: C=${layer1C}, thinking=${layer1ThinkingBlocks.length} blocks`);
        } catch (e: any) {
          console.warn('[creativity] Claude Layer 1 failed, using default params:', e.message);
        }

        if (layer1C !== null) {
          // Adaptive-thinking models (incl. Fable/Mythos 5, which always think)
          // reject a custom temperature — only nudge top_p in that case.
          if (!claudeThinkingOn) claudeParams.temperature = 2.0 * layer1C;
          claudeParams.top_p = 0.7 + 0.3 * layer1C;
        }

        // Inject Layer 1 thinking into history so Claude continues the thought in Layer 2
        if (layer1ThinkingBlocks.length > 0 && claudeThinkingOn && layer1C !== null) {
          const lastMsg = anthropicMessages[anthropicMessages.length - 1];
          const l1Content = lastMsg.content.map((b: any) => ({ ...b }));
          const l1TextIdx = l1Content.reduce((found: number, b: any, idx: number) => b.type === 'text' ? idx : found, -1);
          if (l1TextIdx >= 0) {
            l1Content[l1TextIdx] = { ...l1Content[l1TextIdx], text: l1Content[l1TextIdx].text + '\n\n' + hiddenAnalysisInstruction };
          } else {
            l1Content.push({ type: 'text', text: hiddenAnalysisInstruction });
          }
          anthropicMessages.splice(
            anthropicMessages.length - 1, 1,
            { role: 'user', content: l1Content },
            { role: 'assistant', content: [...layer1ThinkingBlocks, { type: 'text', text: '…' }] },
            lastMsg,
          );
        }
      }
      // ── End Layer 1 ─────────────────────────────────────────────────────────

      const readableStream = new ReadableStream({
        async start(controller) {
          const enqueue = (obj: any) => controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);

          // Identify the model+thinking-mode that's about to respond. Always
          // emitted, regardless of auto-select. The frontend stashes this on
          // the AI message for display only — it does NOT travel back in
          // subsequent turns (slimHistory drops it).
          enqueue(modelSelectedPayload);
          emitSenseEvents(controller);

          // Emit creativity display prefix before the first token (visual-only — not saved to log)
          if (layer1C !== null) {
            enqueue({ type: 'creativity_prefix', label: creativityDisplayPattern.replace('{C}', layer1C.toFixed(2)) });
          }

          // Tool loop. Each iteration runs one stream call. If the model emits
          // tool_use blocks, we execute them, append the assistant turn and a
          // user tool_result turn, then go around. Stops when the model
          // produces a turn with no tool_use blocks (or after a safety cap).
          const MAX_TOOL_ITERATIONS = 8;
          // Use the cached version (last user message has cache_control) so
          // the cache marker propagates through the tool loop too.
          let currentMessages = [...cachedMessages];

          // Cumulative usage across tool-loop iterations. Emitted as a single
          // cache_usage SSE event once the loop ends so the bubble shows the
          // turn's total token bill, not just the last iteration's.
          let cumUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
          // Citations from Claude's server-side web_search tool. Each
          // `web_search_tool_result` block carries an array of results with
          // {url, title}. Deduped by URL and emitted as a `web_sources` event.
          const claudeWebSourceMap = new Map<string, { url: string; title?: string }>();

          try {
            for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
              const iterParams = { ...claudeParams, messages: currentMessages };
              const stream = await anthropic.messages.stream(iterParams);

              // Per-iteration accumulator that mirrors the assistant's content
              // blocks exactly — needed to echo them back on the next call.
              const assistantBlocks: any[] = [];
              let currentTextIdx = -1;
              let currentThinkingText = '';
              let currentThinkingSignature = '';
              let currentBlockType = '';
              let inThinkingBlock = false;
              let currentToolUse: any = null;
              let currentToolJson = '';

              // Capture per-iteration usage so we can emit a normalized
              // cache_usage event once the stream completes. Claude reports
              // cache stats on message_start (initial cached/uncached input
              // counts) and output tokens via message_delta. We accumulate
              // here and emit AFTER the chunk loop ends.
              let iterUsageInput = 0;
              let iterUsageOutput = 0;
              let iterUsageCacheRead = 0;
              let iterUsageCacheCreate = 0;
              // Why the model stopped this iteration. 'max_tokens' means the
              // thinking+output hit the hard cap and the turn is truncated.
              let stopReason = '';

              for await (const chunk of stream as any) {
                // Anthropic streaming usage events
                if (chunk.type === 'message_start' && chunk.message?.usage) {
                  const u = chunk.message.usage;
                  iterUsageInput += Number(u.input_tokens || 0);
                  iterUsageOutput += Number(u.output_tokens || 0);
                  iterUsageCacheRead += Number(u.cache_read_input_tokens || 0);
                  iterUsageCacheCreate += Number(u.cache_creation_input_tokens || 0);
                } else if (chunk.type === 'message_delta') {
                  if (chunk.usage) iterUsageOutput += Number(chunk.usage.output_tokens || 0);
                  // stop_reason arrives on message_delta (e.g. 'end_turn',
                  // 'tool_use', 'max_tokens'). Capture it to detect truncation.
                  if (chunk.delta?.stop_reason) stopReason = chunk.delta.stop_reason;
                }
                if (chunk.type === 'content_block_start') {
                  const blockType = chunk.content_block?.type;
                  if (blockType === 'text') {
                    assistantBlocks.push({ type: 'text', text: '' });
                    currentTextIdx = assistantBlocks.length - 1;
                  } else if (blockType === 'thinking' || blockType === 'redacted_thinking' || blockType === 'summarized_thinking') {
                    inThinkingBlock = true;
                    currentBlockType = blockType;
                    currentThinkingText = '';
                    currentThinkingSignature = '';
                    const initialText = chunk.content_block?.summary || chunk.content_block?.thinking || '';
                    if (initialText) {
                      currentThinkingText += initialText;
                      enqueue({ type: 'thought', content: initialText });
                    }
                  } else if (blockType === 'tool_use') {
                    currentToolUse = {
                      type: 'tool_use',
                      id: chunk.content_block.id,
                      name: chunk.content_block.name,
                      input: {},
                    };
                    currentToolJson = '';
                  } else if (blockType === 'web_search_tool_result') {
                    // Server-side web search results arrive complete in the
                    // content_block_start event (Anthropic runs the search, no
                    // client round-trip). Harvest URLs/titles for verification.
                    const results = chunk.content_block?.content;
                    if (Array.isArray(results)) {
                      for (const r of results) {
                        if (r?.type === 'web_search_result' && typeof r.url === 'string') {
                          if (!claudeWebSourceMap.has(r.url)) {
                            claudeWebSourceMap.set(r.url, { url: r.url, ...(r.title ? { title: String(r.title) } : {}) });
                          }
                        }
                      }
                    }
                  } else if (blockType === 'web_fetch_tool_result') {
                    // web_fetch returns the fetched page wrapped in a result
                    // block: { type:'web_fetch_result', url, content:{...} }.
                    // The URL here is the page Claude actually OPENED (stronger
                    // proof than a mere search snippet).
                    const fr = chunk.content_block?.content;
                    const url = fr?.url || (Array.isArray(fr) ? fr.find((x: any) => x?.url)?.url : undefined);
                    const title = fr?.content?.title || fr?.title;
                    if (typeof url === 'string' && !claudeWebSourceMap.has(url)) {
                      claudeWebSourceMap.set(url, { url, ...(title ? { title: String(title) } : {}) });
                    }
                  }
                } else if (chunk.type === 'content_block_delta') {
                  const d = chunk.delta;
                  if (d?.type === 'summary_delta') {
                    const t = d.summary || d.text || '';
                    currentThinkingText += t;
                    enqueue({ type: 'thought', content: t });
                  } else if (d?.type === 'thinking_delta') {
                    currentThinkingText += d.thinking || '';
                    enqueue({ type: 'thought', content: d.thinking || '' });
                  } else if (d?.type === 'redacted_thinking_delta') {
                    currentThinkingText += d.data || '';
                  } else if (d?.type === 'signature_delta') {
                    currentThinkingSignature += d.signature || '';
                  } else if (d?.type === 'text_delta') {
                    if (currentTextIdx >= 0) assistantBlocks[currentTextIdx].text += d.text || '';
                    enqueue({ type: 'text', content: d.text || '' });
                  } else if (d?.type === 'input_json_delta') {
                    currentToolJson += d.partial_json || '';
                  }
                } else if (chunk.type === 'content_block_stop') {
                  if (inThinkingBlock) {
                    if (currentBlockType === 'redacted_thinking') {
                      assistantBlocks.push({ type: 'redacted_thinking', data: currentThinkingText });
                      enqueue({ type: 'thinking_signature', blockType: 'redacted_thinking', data: currentThinkingText, thinking: '', signature: '' });
                    } else if (currentThinkingSignature) {
                      assistantBlocks.push({ type: 'thinking', thinking: currentThinkingText, signature: currentThinkingSignature });
                      enqueue({ type: 'thinking_signature', blockType: 'thinking', thinking: currentThinkingText, signature: currentThinkingSignature });
                    }
                    inThinkingBlock = false;
                  } else if (currentToolUse) {
                    try { currentToolUse.input = JSON.parse(currentToolJson || '{}'); }
                    catch { currentToolUse.input = {}; }
                    assistantBlocks.push(currentToolUse);
                    currentToolUse = null;
                    currentToolJson = '';
                  }
                }
              }

              // Accumulate this iteration's usage into the cumulative total.
              cumUsage.input += iterUsageInput;
              cumUsage.output += iterUsageOutput;
              cumUsage.cacheRead += iterUsageCacheRead;
              cumUsage.cacheCreate += iterUsageCacheCreate;

              // Find tool_use blocks in this iteration's response that NEXUS
              // must execute locally and feed back. This MUST include
              // read_conversation — otherwise a read_conversation call falls
              // through, the loop breaks, no tool_result is returned, and the
              // turn dead-ends mid-tool-call (Claude waits forever for a result
              // that never comes). Web search/fetch are Anthropic server-side
              // tools (no client round-trip) so they're intentionally excluded.
              const LOCAL_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Delete', 'Bash', 'read_conversation', 'search_conversations', 'AskQuestion', 'spawn_subagent']);
              const toolUses = assistantBlocks.filter(b => b.type === 'tool_use' && LOCAL_TOOLS.has(b.name));
              if (toolUses.length === 0) {
                // Turn finished. If it was cut off at the token cap (thinking +
                // output combined), surface a clear notice so a truncated or
                // empty reply isn't a silent freeze. We CANNOT auto-continue a
                // thinking response (Anthropic forbids prefilling when thinking
                // is on) — the remedy is to lower the Thinking Level or retry.
                if (stopReason === 'max_tokens') {
                  const hadText = assistantBlocks.some(b => b.type === 'text' && (b.text || '').trim());
                  enqueue({
                    type: 'text',
                    content: (hadText ? '\n\n' : '')
                      + '⚠️ _[Response hit the token limit (thinking + output share one budget) and was cut off'
                      + (hadText ? ' mid-answer' : ' before any answer was produced')
                      + '. Lower the **Thinking Level (effort)** for this conversation, or resend to retry.]_',
                  });
                }
                break;
              }

              // Append the assistant turn and execute each tool, building
              // tool_result blocks for the next user turn.
              currentMessages.push({ role: 'assistant', content: assistantBlocks });
              const toolResultBlocks: any[] = [];
              for (const tu of toolUses) {
                let resultContent: any = '';        // string OR content-block array (Anthropic accepts both)
                let attachmentEvent: any = null;
                // Surface what the model is doing so the loading label reflects
                // the tool call instead of a silent "thinking...".
                const actLabel = toolActivityLabel(tu.name);
                if (actLabel) enqueue({ type: 'tool_activity', tool: actLabel });
                try {
                  if (tu.name === 'Read') {
                    const p = String(tu.input?.path || '');
                    if (isImageFilename(p)) {
                      const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess: agentFullSystemAccess });
                      if (!bin) {
                        resultContent = `Error: image not found or path outside workspace: ${p}`;
                      } else {
                        const base64 = bin.data.toString('base64');
                        // Anthropic tool_result accepts a content array including image blocks.
                        resultContent = [
                          { type: 'text', text: `Image content of ${p} (${bin.mimeType}) follows:` },
                          { type: 'image', source: { type: 'base64', media_type: bin.mimeType, data: base64 } },
                        ];
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: bin.mimeType,
                            size: bin.data.length,
                            isImage: true,
                            dataUrl: `data:${bin.mimeType};base64,${base64}`,
                            tokens: Math.max(1, Math.ceil(bin.data.length / 750)),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      }
                    } else {
                      const text = await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                      if (text == null) {
                        resultContent = `Error: file not found or path outside workspace: ${p}`;
                      } else {
                        resultContent = text;
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: 'text/plain',
                            size: text.length,
                            isText: true,
                            textData: text,
                            tokens: Math.ceil(text.length / 4),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      }
                    }
                  } else if (tu.name === 'Write') {
                    const p = String(tu.input?.path || '');
                    const c = String(tu.input?.content ?? '');
                    const wr = await writeWorkspaceFile(folderName, p, c, { fullAccess: agentFullSystemAccess });
                    if (!wr.ok) {
                      resultContent = `Error: ${wr.error || 'write failed'}`;
                    } else {
                      resultContent = `OK: ${wr.existed ? 'overwrote' : 'created'} ${p} (${c.length} chars).`;
                      attachmentEvent = {
                        type: 'file_attachment',
                        attachment: {
                          name: p,
                          type: 'text/plain',
                          size: c.length,
                          isText: true,
                          textData: c,
                          tokens: Math.ceil(c.length / 4),
                          excluded: false,
                          toolAction: wr.existed ? 'modified' : 'created',
                        },
                      };
                    }
                  } else if (tu.name === 'Edit') {
                    const p = String(tu.input?.path || '');
                    const oldS = String(tu.input?.old_string ?? '');
                    const newS = String(tu.input?.new_string ?? '');
                    const ed = await editWorkspaceFile(folderName, p, oldS, newS, { fullAccess: agentFullSystemAccess });
                    if (!ed.ok) {
                      resultContent = `Error: ${ed.error || 'edit failed'}`;
                    } else {
                      // Re-read so the UI attachment reflects the post-edit state.
                      const after = (await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess })) || '';
                      resultContent = `OK: edited ${p} (replaced ${oldS.length} chars with ${newS.length} chars).`;
                      attachmentEvent = {
                        type: 'file_attachment',
                        attachment: {
                          name: p,
                          type: 'text/plain',
                          size: after.length,
                          isText: true,
                          textData: after,
                          tokens: Math.ceil(after.length / 4),
                          excluded: false,
                          toolAction: 'modified',
                        },
                      };
                    }
                  } else if (tu.name === 'Glob') {
                    const pat = String(tu.input?.pattern || '**');
                    const matches = await globWorkspaceFiles(folderName, pat);
                    resultContent = matches.length === 0
                      ? `(no files match \`${pat}\`)`
                      : matches.join('\n');
                  } else if (tu.name === 'Grep') {
                    const pat = String(tu.input?.pattern || '');
                    const filePat = tu.input?.file_pattern ? String(tu.input.file_pattern) : undefined;
                    const flags = tu.input?.flags ? String(tu.input.flags) : undefined;
                    const gr = await grepWorkspaceFiles(folderName, pat, { filePattern: filePat, flags });
                    if (!gr.ok) {
                      resultContent = `Error: ${gr.error}`;
                    } else if (!gr.matches || gr.matches.length === 0) {
                      resultContent = `(no matches for /${pat}/${flags || ''})`;
                    } else {
                      resultContent = gr.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n');
                    }
                  } else if (tu.name === 'Delete') {
                    const p = String(tu.input?.path || '');
                    const del = await deleteWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                    resultContent = del.ok ? `OK: deleted ${p}.` : `Error: ${del.error || 'delete failed'}`;
                  } else if (tu.name === 'Bash') {
                    // DANGEROUS shell execution — only present when agentDangerousTools
                    // gated the tool in above. cwd = the entity's workspace.
                    const cmd = String(tu.input?.command || '');
                    if (!cmd.trim()) {
                      resultContent = 'Error: Bash requires a non-empty "command".';
                    } else {
                      const cwd = await ensureWorkspace(folderName);
                      const sh = await runShellCommand(cmd, { cwd, timeoutMs: Number(tu.input?.timeout_ms) || undefined });
                      resultContent = sh.output;
                    }
                  } else if (tu.name === 'read_conversation') {
                    // Pull a past conversation by name for this turn only.
                    // Inactive ("non-public") conversations are refused inside
                    // readConversationByName — nothing is saved.
                    const name = String(tu.input?.name || tu.input?.title || '').trim();
                    const r = await readConversationByName(folderName, name);
                    resultContent = r.ok
                      ? `Transcript of "${r.title}":\n\n${r.transcript}`
                      : `Error: ${r.error}`;
                  } else if (tu.name === 'search_conversations') {
                    // Search across the entity's conversations; inactive ones are
                    // excluded (privacy). Nothing is saved.
                    const sr = await searchConversations(folderName, String(tu.input?.query || tu.input?.q || '').trim(), { excludeInactive: true });
                    resultContent = formatSearchForTool(sr);
                  } else if (tu.name === 'AskQuestion') {
                    // Pause the turn: emit the question, wait for the user's
                    // selection (or the configured timeout), return it as the
                    // tool result. Same rendezvous as the other provider paths.
                    const questions = normalizeQuestions(tu.input);
                    if (questions.length === 0) {
                      resultContent = 'Error: AskQuestion requires 1-4 questions, each with 2-4 options.';
                    } else {
                      const askId = createAskId();
                      enqueue({ type: 'ask_user', askId, questions });
                      const answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                      const timedOut = answered === null;
                      const finalAnswers = timedOut ? recommendedDefaults(questions) : answered!;
                      enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                      resultContent = formatAnswerForModel(finalAnswers, timedOut);
                    }
                  } else if (tu.name === 'spawn_subagent') {
                    // Context firewall: a fresh read-only child investigates and
                    // returns only its distilled result. Child model defaults to
                    // a cheap Claude; non-Claude subagentModel values fall back.
                    const task = String((tu.input as any)?.task || '');
                    if (!task.trim()) {
                      resultContent = 'Error: spawn_subagent requires a non-empty "task".';
                    } else {
                      enqueue({ type: 'subagent_start', task });
                      // Route by the chosen model's family. Empty → a cheap
                      // Claude child on the same Anthropic key.
                      const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : 'Claude';
                      const childModel = subagentModel && subagentModel.trim() ? subagentModel.trim() : 'claude-haiku-4-5';
                      const sub = await runSubagent({
                        family: childFamily, model: childModel, keys, task,
                        returnContract: (tu.input as any)?.return_contract ? String((tu.input as any).return_contract) : undefined,
                        folderName, fullAccess: agentFullSystemAccess,
                        webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                      });
                      cumUsage.input += sub.usage.input;
                      cumUsage.output += sub.usage.output;
                      cumUsage.cacheRead += sub.usage.cacheRead;
                      cumUsage.cacheCreate += sub.usage.cacheCreate;
                      enqueue({ type: 'subagent_done', task, result: sub.text, via: sub.via });
                      resultContent = sub.text || '(subagent returned nothing)';
                    }
                  }
                } catch (e: any) {
                  resultContent = `Error: ${e?.message || 'tool execution failed'}`;
                }
                toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: resultContent });
                // NOTE: deliberately NOT emitting `attachmentEvent` — a file the
                // entity reads/creates/edits should NOT be pinned as a persistent
                // attachment on its message (which would re-enter the context
                // window every turn). The tool_result above already gives the
                // model the file content for THIS turn; on later turns it re-reads
                // on demand. This matches the OAuth path, which never attached
                // tool files either. (attachmentEvent is still built above but
                // intentionally left unused.)
                void attachmentEvent;
                if (actLabel) enqueue({ type: 'tool_activity', tool: null });
              }
              // Mid-turn partner interjection: if a note was queued while these
              // tools ran, append it as a text block on the same user turn that
              // carries the tool results, so the model sees it on its next step.
              const injectedClaude = drainInjections(injectTurnId);
              if (injectedClaude.length) {
                toolResultBlocks.push({ type: 'text', text: frameInjection(injectedClaude, I.injectionFraming) });
                enqueue({ type: 'injection_delivered', count: injectedClaude.length });
              }
              currentMessages.push({ role: 'user', content: toolResultBlocks });
              // …and around the loop again. Next iteration the model sees the
              // tool_result blocks and continues its reply.
            }

            // Emit normalized cache usage just before [DONE]. The frontend
            // stashes this on the AI message for display in the meta bar.
            const usagePayload = normalizeCacheUsage({
              input_tokens: cumUsage.input,
              output_tokens: cumUsage.output,
              cache_read_input_tokens: cumUsage.cacheRead,
              cache_creation_input_tokens: cumUsage.cacheCreate,
            }, 'claude');
            if (usagePayload) enqueue(usagePayload);

            if (claudeWebSourceMap.size > 0) {
              enqueue({ type: 'web_sources', sources: [...claudeWebSourceMap.values()] });
            }

            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
          } catch (e: any) {
            controller.enqueue(`data: ${JSON.stringify({ error: e.message })}\n\n`);
            controller.close();
          }
        }
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }
    else if (isGemini) {
      if (!keys.gemini) return NextResponse.json({ error: 'Gemini API key missing in settings.' }, { status: 400 });
      const ai = new GoogleGenAI({ apiKey: keys.gemini });

      const history = processedMessages.slice(0, -1).map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }));

      const lastMsg = processedMessages[processedMessages.length - 1].content;

      const geminiConfig: any = {
        systemInstruction: enhancedSystemPrompt,
        temperature: modelParams.temperature,
        topP: modelParams.topP,
        topK: modelParams.topK,
        ...(seedEnabled ? { seed: seedValue } : {}),
      };

      // Thinking configuration for Gemini 3.x models. The valid `thinkingLevel`
      // values are: 'minimal' | 'low' | 'medium' | 'high'. Per Google's docs:
      //   - 3.5 Flash defaults to 'medium', 3.1 Flash Lite defaults to 'minimal'
      //   - There is NO way to fully disable thinking on 3.x — 'minimal' is the
      //     closest (the model may still think a little on complex prompts)
      //   - Without `thinkingConfig`, the SDK uses the model's own default AND
      //     does not stream thought parts back — so it's important to always
      //     pass an explicit object when we want the user-visible thinking
      //     block to appear.
      // Legacy logs saved with thinkingLevel='none' are mapped to 'minimal' for
      // backward compatibility (no UI breakage on old conversations).
      if (specificModel.includes('gemini')) {
        let lvl = modelParams.thinkingLevel;
        if (!lvl || lvl === 'none') lvl = 'minimal';
        geminiConfig.thinkingConfig = {
          thinkingLevel: lvl,
          includeThoughts: true,
        };
      }

      const geminiTools: any[] = [];
      if (modelParams.enableWebSearch) {
        geminiTools.push({ googleSearch: {} });
      }
      if (toolUseEnabled) {
        // Same Read/Write/Edit/Glob/Grep tool surface as the Claude branch —
        // shapes are translated to Gemini's functionDeclarations schema.
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'Read',
              description: `${I.toolReadDesc} ${pathRule}`,
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', description: pathDesc },
                },
                required: ['path'],
              },
            },
            {
              name: 'Write',
              description: I.toolWriteDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', description: pathDesc },
                  content: { type: 'STRING', description: 'Full file contents to write' },
                },
                required: ['path', 'content'],
              },
            },
            {
              name: 'Edit',
              description: I.toolEditDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', description: pathDesc },
                  old_string: { type: 'STRING', description: 'Text to find. Must occur exactly once.' },
                  new_string: { type: 'STRING', description: 'Text to replace it with.' },
                },
                required: ['path', 'old_string', 'new_string'],
              },
            },
            {
              name: 'Glob',
              description: I.toolGlobDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  pattern: { type: 'STRING', description: 'Glob pattern. Use `**` to match all files.' },
                },
                required: ['pattern'],
              },
            },
            {
              name: 'Grep',
              description: I.toolGrepDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  pattern: { type: 'STRING', description: 'JavaScript regex (no surrounding slashes).' },
                  file_pattern: { type: 'STRING', description: 'Optional glob to restrict files.' },
                  flags: { type: 'STRING', description: 'Optional regex flags (e.g. "i").' },
                },
                required: ['pattern'],
              },
            },
          ],
        });
        // Dangerous tool: Bash/Shell — gated per-Entity, like Delete on the
        // other paths.
        if (agentDangerousTools) {
          geminiTools.push({
            functionDeclarations: [
              {
                name: 'Bash',
                description: I.toolBashDesc,
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    command: { type: 'STRING', description: 'The shell command to run.' },
                    timeout_ms: { type: 'NUMBER', description: 'Optional timeout in milliseconds (default 60000, max 600000).' },
                  },
                  required: ['command'],
                },
              },
            ],
          });
        }
      }
      if (enableReadConversation) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'read_conversation',
              description: I.readConversationDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: I.readConversationNameParam },
                },
                required: ['name'],
              },
            },
            {
              name: 'search_conversations',
              description: I.searchConversationsDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  query: { type: 'STRING', description: I.searchConversationsQueryParam },
                },
                required: ['query'],
              },
            },
          ],
        });
      }
      // Optional interactive AskUserQuestion tool (independent of file tools).
      if (askUserEnabled) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'AskQuestion',
              description: I.askUserDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  questions: {
                    type: 'ARRAY',
                    description: 'Between 1 and 4 questions to ask the user.',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        question: { type: 'STRING', description: 'The full question text. End with a question mark.' },
                        header: { type: 'STRING', description: 'Very short label/chip for the question (max ~12 chars).' },
                        multiSelect: { type: 'BOOLEAN', description: 'Set true to let the user pick multiple options.' },
                        options: {
                          type: 'ARRAY',
                          description: '2 to 4 distinct, mutually-exclusive choices.',
                          items: {
                            type: 'OBJECT',
                            properties: {
                              label: { type: 'STRING', description: 'Short option label (1-5 words).' },
                              description: { type: 'STRING', description: 'What choosing this option means.' },
                            },
                            required: ['label'],
                          },
                        },
                      },
                      required: ['question', 'options'],
                    },
                  },
                },
                required: ['questions'],
              },
            },
          ],
        });
      }
      // Optional subagent (context-firewall helper) tool.
      if (subagentEnabled) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'spawn_subagent',
              description: I.subagentDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  task: { type: 'STRING', description: 'A precise, self-contained investigation for the helper to perform.' },
                  return_contract: { type: 'STRING', description: 'Optional: how the distilled result should be shaped/formatted.' },
                },
                required: ['task'],
              },
            },
          ],
        });
      }
      if (geminiTools.length) geminiConfig.tools = geminiTools;
      // When mixing a built-in tool (googleSearch) with custom function
      // declarations in the same request, Gemini requires this flag — without
      // it the API rejects with code=400 "Please enable
      // tool_config.include_server_side_tool_invocations". Setting it
      // unconditionally when either tool family is present is harmless.
      if (geminiTools.length) {
        geminiConfig.toolConfig = {
          ...(geminiConfig.toolConfig || {}),
          includeServerSideToolInvocations: true,
        };
      }

      // Since GoogleGenAI `chat.sendMessage` expects to maintain local history object,
      // we can also just use `ai.models.generateContent` with the full history concatenated if `chats.create` with history fails.
      // For simplicity here:
      const fullContents = processedMessages.map((m: any) => {
        const parts: any[] = [];
        m.mediaFiles.forEach((media: any) => {
          if (media.name) {
            parts.push({ text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
          }
          parts.push({
            inlineData: { mimeType: media.mimeType, data: media.base64Data }
          });
        });

        if (m.content) {
          parts.push({ text: m.content });
        }

        return {
          role: m.role === 'user' ? 'user' : 'model',
          parts: parts.length > 0 ? parts : [{ text: '-' }]
        };
      });

      // Auto-continue when the model reports finishReason="MAX_TOKENS".
      // We re-call with the partial assistant turn as a prefill; Gemini will
      // continue that turn instead of starting a new one. CRITICAL details:
      //   1) We must REPLACE the previous prefill (not append) — Gemini
      //      rejects consecutive model turns.
      //   2) The prefill carries rawModelParts (with thoughtSignature)
      //      verbatim — thinking-capable models reject prefills that have
      //      been stripped or rebuilt as plain { text: ... }.
      // Increased from 2 to 5 so longer responses survive multiple cuts.
      const MAX_CONTINUATIONS = 5;
      const geminiModelId = specificModel?.includes('gemini') ? specificModel : 'gemini-3.5-flash';

      // ── Layer 1: Creativity analysis ────────────────────────────────────────
      // Must be after fullContents and geminiModelId are defined.
      let layer1C: number | null = null;

      if (creativityControlEnabled) {
        const creativityFnDecl = {
          name: 'set_creativity',
          description: 'Analyze the context and call this with the optimal creativity value C for generating the response.',
          parameters: {
            type: 'OBJECT',
            properties: { creativity: { type: 'NUMBER', description: 'Creativity level 0.0 to 1.0' } },
            required: ['creativity'],
          },
        };

        const layer1Contents = fullContents.map((c: any, i: number) => {
          if (i === fullContents.length - 1 && c.role === 'user') {
            const parts = [...c.parts];
            const lastTextIdx = parts.reduce((found: number, p: any, idx: number) => (p.text !== undefined ? idx : found), -1);
            if (lastTextIdx >= 0) {
              parts[lastTextIdx] = { ...parts[lastTextIdx], text: parts[lastTextIdx].text + '\n\n' + hiddenAnalysisInstruction };
            } else {
              parts.push({ text: hiddenAnalysisInstruction });
            }
            return { role: c.role, parts };
          }
          return c;
        });

        try {
          const layer1Resp = await ai.models.generateContent({
            model: geminiModelId,
            contents: layer1Contents,
            config: {
              systemInstruction: enhancedSystemPrompt,
              tools: [{ functionDeclarations: [creativityFnDecl] }],
              toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['set_creativity'] } },
            },
          });
          for (const cand of (layer1Resp as any).candidates || []) {
            for (const part of cand.content?.parts || []) {
              if (part.functionCall?.name === 'set_creativity') {
                const val = Number(part.functionCall.args?.creativity);
                if (!isNaN(val)) layer1C = Math.max(0, Math.min(1, val));
              }
            }
          }
          console.log(`[creativity] Gemini Layer 1: C=${layer1C}`);
        } catch (e: any) {
          console.warn('[creativity] Gemini Layer 1 failed:', e.message);
        }

        if (layer1C !== null) {
          geminiConfig.temperature = 2.0 * layer1C;
          geminiConfig.topP = 0.7 + 0.3 * layer1C;
        }
      }
      // ── End Layer 1 ─────────────────────────────────────────────────────────

      const runGeminiOnce = async (contents: any[], controller: ReadableStreamDefaultController) => {
        const stream = await ai.models.generateContentStream({
          model: geminiModelId,
          contents,
          config: geminiConfig,
        });
        let visibleText = '';
        let thoughtText = '';
        let finishReason: string | null = null;
        let chunkCount = 0;
        const functionCalls: { name: string; args: any }[] = [];
        // Capture every raw part the model emits, in order, so we can echo
        // them back verbatim on the next API call. This is essential for
        // Gemini's thinking-capable models — they attach a `thoughtSignature`
        // to functionCall parts as proof-of-thinking and reject subsequent
        // turns where the signature has been stripped or rebuilt.
        const rawModelParts: any[] = [];
        // Capture Gemini's usage metadata. It arrives on each chunk and
        // contains cumulative-to-now counts (promptTokenCount,
        // candidatesTokenCount, cachedContentTokenCount); we keep the latest
        // for the final cache_usage emission.
        let lastUsageMetadata: any = null;
        // Grounding citations from Google Search. Each grounding chunk carries
        // a `web: { uri, title }` for a page the model actually consulted.
        const geminiSourceMap = new Map<string, { url: string; title?: string }>();
        for await (const chunk of stream) {
          if ((chunk as any).usageMetadata) lastUsageMetadata = (chunk as any).usageMetadata;
          const gm = (chunk as any).candidates?.[0]?.groundingMetadata;
          if (gm?.groundingChunks && Array.isArray(gm.groundingChunks)) {
            for (const gc of gm.groundingChunks) {
              const uri = gc?.web?.uri;
              if (typeof uri === 'string' && /^https?:\/\//i.test(uri) && !geminiSourceMap.has(uri)) {
                geminiSourceMap.set(uri, { url: uri, ...(gc.web.title ? { title: String(gc.web.title) } : {}) });
              }
            }
          }
          chunkCount++;
          if (chunkCount <= 2) {
            try {
              const sample = JSON.stringify(chunk).slice(0, 500);
              console.log(`[gemini] ${geminiModelId} chunk ${chunkCount} raw:`, sample);
            } catch {}
          }
          const cand = chunk.candidates?.[0];
          if (cand?.content?.parts) {
            for (const part of cand.content.parts as any[]) {
              // Preserve the exact part shape (with thoughtSignature etc.) for echo-back
              rawModelParts.push(part);

              // Process for UI emission
              if (part.functionCall) {
                functionCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args || {},
                });
                continue;
              }
              // Only the explicit `thought: true` flag marks a part as thinking.
              // `thoughtSignature` appears on REGULAR text parts too (as a
              // continuity-proof token Gemini attaches after thinking models
              // have generated something). Using thoughtSignature as a
              // thought indicator misroutes the visible answer to the
              // collapsible thinking block, leaving the bubble empty.
              const isThought = part.thought === true;
              if (isThought) {
                const t = part.text || '';
                if (t) {
                  thoughtText += t;
                  controller.enqueue(`data: ${JSON.stringify({ type: 'thought', content: t })}\n\n`);
                }
              } else if (part.text) {
                visibleText += part.text;
                controller.enqueue(`data: ${JSON.stringify({ type: 'text', content: part.text })}\n\n`);
              }
            }
          }
          if (cand?.finishReason) finishReason = cand.finishReason;
        }
        console.log(`[gemini] ${geminiModelId} chunks=${chunkCount} visible=${visibleText.length}c thought=${thoughtText.length}c finish=${finishReason} fnCalls=${functionCalls.length} parts=${rawModelParts.length}`);
        if (visibleText.length > 0) {
          console.log(`[gemini]   visible[0..120]: ${JSON.stringify(visibleText.slice(0, 120))}`);
        }
        if (rawModelParts.length > 0 && visibleText.length === 0 && functionCalls.length === 0) {
          // Empty turn — log raw shapes so we can see what came back.
          console.log('[gemini]   EMPTY TURN — raw part shapes:', rawModelParts.map((p: any) => Object.keys(p)).slice(0, 10));
          console.log('[gemini]   first part sample:', JSON.stringify(rawModelParts[0]).slice(0, 400));
        }
        return { visibleText, finishReason, functionCalls, rawModelParts, usageMetadata: lastUsageMetadata, webSources: [...geminiSourceMap.values()] };
      };

      const readableStream = new ReadableStream({
        async start(controller) {
          const enqueue = (obj: any) => controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
          // Identify the model+thinking-mode about to respond (see Claude branch above).
          enqueue(modelSelectedPayload);
          emitSenseEvents(controller);
          if (layer1C !== null) {
            enqueue({ type: 'creativity_prefix', label: creativityDisplayPattern.replace('{C}', layer1C.toFixed(2)) });
          }
          const MAX_TOOL_ITERATIONS = 8;
          try {
            let contents = [...fullContents];
            let continuationAttempts = 0;
            let toolIterations = 0;
            let totalVisibleEmitted = 0;
            let lastFinishReason: string | null = null;
            // Accumulated raw model parts from prior continuations. When we
            // continue, we replace the trailing prefill model turn with one
            // containing every part the model has emitted so far (text,
            // thought, thoughtSignature). This preserves signature continuity
            // and avoids stacking consecutive model turns.
            let cumulativeContinuationParts: any[] = [];
            let lastIterationWasContinuation = false;
            // Sum of every iteration's usageMetadata so the final cache_usage
            // event reflects the whole turn (tool loop + continuations).
            let cumGeminiUsage: { promptTokenCount: number; candidatesTokenCount: number; cachedContentTokenCount: number } =
              { promptTokenCount: 0, candidatesTokenCount: 0, cachedContentTokenCount: 0 };
            // Grounding citations deduped across the whole turn.
            const cumGeminiSourceMap = new Map<string, { url: string; title?: string }>();

            while (true) {
              if (toolIterations >= MAX_TOOL_ITERATIONS) break;
              const { visibleText, finishReason, functionCalls, rawModelParts, usageMetadata, webSources } = await runGeminiOnce(contents, controller);
              for (const s of (webSources || [])) {
                if (!cumGeminiSourceMap.has(s.url)) cumGeminiSourceMap.set(s.url, s);
              }
              if (usageMetadata) {
                cumGeminiUsage.promptTokenCount += Number(usageMetadata.promptTokenCount || 0);
                cumGeminiUsage.candidatesTokenCount += Number(usageMetadata.candidatesTokenCount || 0);
                cumGeminiUsage.cachedContentTokenCount += Number(usageMetadata.cachedContentTokenCount || 0);
              }
              totalVisibleEmitted += visibleText.length;
              lastFinishReason = finishReason;

              // 1) Function calls → execute, append model+user turns, loop
              if (functionCalls.length > 0) {
                toolIterations++;
                // Echo the assistant turn back VERBATIM (with thoughtSignature
                // intact on each functionCall part) so thinking models accept it.
                contents = [...contents, { role: 'model', parts: rawModelParts }];

                // Execute each call, build functionResponse parts for one user turn.
                // Image reads produce an extra `inlineData` part in the same user turn so
                // the model can actually see the picture, not just text describing it.
                const fnRespParts: any[] = [];
                const extraInlineParts: any[] = [];
                for (const fc of functionCalls) {
                  let result: any = {};
                  let attachmentEvent: any = null;
                  // Reflect the tool call in the loading label (silent otherwise).
                  const actLabel = toolActivityLabel(fc.name);
                  if (actLabel) enqueue({ type: 'tool_activity', tool: actLabel });
                  try {
                    if (fc.name === 'Read') {
                      const p = String(fc.args?.path || '');
                      if (isImageFilename(p)) {
                        const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (!bin) {
                          result = { error: `image not found or path outside workspace: ${p}` };
                        } else {
                          const base64 = bin.data.toString('base64');
                          // Minimal, neutral metadata — no hidden instruction in here.
                          // All guidance lives in the user-controlled toolImageInstruction
                          // template (added as a separate text part below). If the user
                          // blanks that out, the model receives only this metadata + the
                          // raw image bytes.
                          result = {
                            ok: true,
                            filename: p,
                            mimeType: bin.mimeType,
                          };
                          extraInlineParts.push({ inlineData: { mimeType: bin.mimeType, data: base64 } });
                          // User-controlled hint text. {filename} substituted; empty string disables.
                          const hintTemplate = (toolImageInstruction || '').trim();
                          if (hintTemplate) {
                            const hint = hintTemplate.replace(/\{filename\}/g, p);
                            extraInlineParts.push({ text: hint });
                          }
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p,
                              type: bin.mimeType,
                              size: bin.data.length,
                              isImage: true,
                              dataUrl: `data:${bin.mimeType};base64,${base64}`,
                              tokens: Math.max(1, Math.ceil(bin.data.length / 750)),
                              excluded: false,
                              toolAction: 'read',
                            },
                          };
                        }
                      } else {
                        const text = await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (text == null) {
                          result = { error: `file not found or path outside workspace: ${p}` };
                        } else {
                          result = { content: text };
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p,
                              type: 'text/plain',
                              size: text.length,
                              isText: true,
                              textData: text,
                              tokens: Math.ceil(text.length / 4),
                              excluded: false,
                              toolAction: 'read',
                            },
                          };
                        }
                      }
                    } else if (fc.name === 'Write') {
                      const p = String(fc.args?.path || '');
                      const c = String(fc.args?.content ?? '');
                      const wr = await writeWorkspaceFile(folderName, p, c, { fullAccess: agentFullSystemAccess });
                      if (!wr.ok) {
                        result = { error: wr.error || 'write failed' };
                      } else {
                        result = { ok: true, existed: wr.existed, bytes: c.length };
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: 'text/plain',
                            size: c.length,
                            isText: true,
                            textData: c,
                            tokens: Math.ceil(c.length / 4),
                            excluded: false,
                            toolAction: wr.existed ? 'modified' : 'created',
                          },
                        };
                      }
                    } else if (fc.name === 'Edit') {
                      const p = String(fc.args?.path || '');
                      const oldS = String(fc.args?.old_string ?? '');
                      const newS = String(fc.args?.new_string ?? '');
                      const ed = await editWorkspaceFile(folderName, p, oldS, newS, { fullAccess: agentFullSystemAccess });
                      if (!ed.ok) {
                        result = { error: ed.error || 'edit failed' };
                      } else {
                        const after = (await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess })) || '';
                        result = { ok: true, bytes_replaced: oldS.length, bytes_inserted: newS.length };
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: 'text/plain',
                            size: after.length,
                            isText: true,
                            textData: after,
                            tokens: Math.ceil(after.length / 4),
                            excluded: false,
                            toolAction: 'modified',
                          },
                        };
                      }
                    } else if (fc.name === 'Glob') {
                      const pat = String(fc.args?.pattern || '**');
                      const matches = await globWorkspaceFiles(folderName, pat);
                      result = { files: matches };
                    } else if (fc.name === 'Grep') {
                      const pat = String(fc.args?.pattern || '');
                      const filePat = fc.args?.file_pattern ? String(fc.args.file_pattern) : undefined;
                      const flags = fc.args?.flags ? String(fc.args.flags) : undefined;
                      const gr = await grepWorkspaceFiles(folderName, pat, { filePattern: filePat, flags });
                      if (!gr.ok) result = { error: gr.error };
                      else result = { matches: gr.matches };
                    } else if (fc.name === 'Bash') {
                      // DANGEROUS shell execution — only present when
                      // agentDangerousTools gated the tool in above.
                      const cmd = String(fc.args?.command || '');
                      if (!cmd.trim()) {
                        result = { error: 'Bash requires a non-empty "command".' };
                      } else {
                        const cwd = await ensureWorkspace(folderName);
                        const sh = await runShellCommand(cmd, { cwd, timeoutMs: Number(fc.args?.timeout_ms) || undefined });
                        result = { output: sh.output };
                      }
                    } else if (fc.name === 'read_conversation') {
                      // Pull a past conversation by name for this turn only.
                      // Inactive ("non-public") conversations are refused inside
                      // readConversationByName — nothing is saved.
                      const name = String(fc.args?.name || fc.args?.title || '').trim();
                      const r = await readConversationByName(folderName, name);
                      result = r.ok
                        ? { title: r.title, transcript: r.transcript }
                        : { error: r.error };
                    } else if (fc.name === 'search_conversations') {
                      // Search across the entity's conversations; inactive ones
                      // excluded (privacy). Nothing is saved.
                      const sr = await searchConversations(folderName, String(fc.args?.query || fc.args?.q || '').trim(), { excludeInactive: true });
                      result = { report: formatSearchForTool(sr) };
                    } else if (fc.name === 'AskQuestion') {
                      // Pause the turn: emit the question, wait for the user's
                      // selection (or the configured timeout), return it as the
                      // functionResponse. Same rendezvous as the other paths.
                      const questions = normalizeQuestions(fc.args);
                      if (questions.length === 0) {
                        result = { error: 'AskQuestion requires 1-4 questions, each with 2-4 options.' };
                      } else {
                        const askId = createAskId();
                        enqueue({ type: 'ask_user', askId, questions });
                        const answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                        const timedOut = answered === null;
                        const finalAnswers = timedOut ? recommendedDefaults(questions) : answered!;
                        enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                        result = { answer: formatAnswerForModel(finalAnswers, timedOut) };
                      }
                    } else if (fc.name === 'spawn_subagent') {
                      // Context firewall: a fresh read-only child investigates
                      // and returns only its distilled result. Child model
                      // defaults to a fast Gemini; non-Gemini values fall back.
                      const task = String(fc.args?.task || '');
                      if (!task.trim()) {
                        result = { error: 'spawn_subagent requires a non-empty "task".' };
                      } else {
                        enqueue({ type: 'subagent_start', task });
                        // Route by the chosen model's family. Empty → a fast
                        // Gemini child on the same Google key.
                        const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : 'Gemini';
                        const childModel = subagentModel && subagentModel.trim() ? subagentModel.trim() : 'gemini-3.1-flash-lite';
                        const sub = await runSubagent({
                          family: childFamily, model: childModel, keys, task,
                          returnContract: fc.args?.return_contract ? String(fc.args.return_contract) : undefined,
                          folderName, fullAccess: agentFullSystemAccess,
                          webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                        });
                        cumGeminiUsage.promptTokenCount += sub.usage.input;
                        cumGeminiUsage.candidatesTokenCount += sub.usage.output;
                        enqueue({ type: 'subagent_done', task, result: sub.text, via: sub.via });
                        result = { result: sub.text || '(subagent returned nothing)' };
                      }
                    } else {
                      result = { error: `unknown function: ${fc.name}` };
                    }
                  } catch (e: any) {
                    result = { error: e?.message || 'tool execution failed' };
                  }
                  fnRespParts.push({ functionResponse: { name: fc.name, response: result } });
                  // Deliberately NOT emitting `attachmentEvent` — see the note on
                  // the Claude path: tool files are not pinned as persistent
                  // message attachments (no context-window re-entry every turn),
                  // matching the OAuth path. The functionResponse above already
                  // hands the model the content for this turn.
                  void attachmentEvent;
                  if (actLabel) enqueue({ type: 'tool_activity', tool: null });
                }
                // Mid-turn partner interjection: append as a text part on the
                // same user turn that carries the function responses.
                const injectedGemini = drainInjections(injectTurnId);
                const injectParts = injectedGemini.length
                  ? [{ text: frameInjection(injectedGemini, I.injectionFraming) }]
                  : [];
                if (injectedGemini.length) enqueue({ type: 'injection_delivered', count: injectedGemini.length });
                contents = [...contents, { role: 'user', parts: [...fnRespParts, ...extraInlineParts, ...injectParts] }];
                continue; // loop — model will continue with the function responses visible
              }

              // 2) No function calls, but output was truncated → continuation prefill.
              // Gemini reports this as finishReason "MAX_TOKENS" (string) — but
              // some SDK paths surface it as the enum value or even a lowercased
              // form, so match defensively.
              const fr = String(finishReason || '').toUpperCase();
              const truncated = fr === 'MAX_TOKENS' || fr.includes('MAX_TOKEN');
              if (truncated && continuationAttempts < MAX_CONTINUATIONS && rawModelParts.length > 0) {
                // Accumulate THIS iteration's raw parts into the running prefill.
                cumulativeContinuationParts = [...cumulativeContinuationParts, ...rawModelParts];
                // If we already added a prefill model turn last time, replace it.
                // Otherwise, this is the first continuation — append fresh.
                if (lastIterationWasContinuation) {
                  contents = contents.slice(0, -1);
                }
                contents = [
                  ...contents,
                  { role: 'model', parts: cumulativeContinuationParts.slice() },
                ];
                lastIterationWasContinuation = true;
                continuationAttempts++;
                console.log(`[gemini] continuation ${continuationAttempts}/${MAX_CONTINUATIONS} — finishReason=${finishReason}, cumulative parts=${cumulativeContinuationParts.length}, visible so far=${totalVisibleEmitted}c`);
                continue;
              }

              if (truncated) {
                console.warn(`[gemini] truncated but cannot continue: continuationAttempts=${continuationAttempts}/${MAX_CONTINUATIONS}, rawModelParts=${rawModelParts.length}`);
              }

              // 3) Done
              break;
            }

            if (continuationAttempts > 0) {
              enqueue({ type: 'continued', count: continuationAttempts });
            }
            // If the whole exchange produced zero visible text, the model
            // either thought-only with no answer (common with thinking models
            // when the thinking budget consumed all output tokens) or was
            // refused/blocked. Surface it instead of leaving the user with
            // a silent empty bubble.
            if (totalVisibleEmitted === 0) {
              console.warn(`[gemini] empty visible response — finishReason=${lastFinishReason}, toolIterations=${toolIterations}`);
              enqueue({
                type: 'text',
                content: `[empty response — finishReason=${lastFinishReason || 'unknown'}. The model produced no visible text. ` +
                         `Possible causes: thinking budget consumed all output tokens, safety filter, or the model couldn't decide how to answer the tool result. ` +
                         `Try disabling extended thinking, increasing context limit, or rewording the prompt.]`,
              });
            }
            const usagePayload = normalizeCacheUsage(cumGeminiUsage, 'gemini');
            if (usagePayload) enqueue(usagePayload);
            if (cumGeminiSourceMap.size > 0) {
              enqueue({ type: 'web_sources', sources: [...cumGeminiSourceMap.values()] });
            }
            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
          } catch (e: any) {
            controller.enqueue(`data: ${JSON.stringify({ error: e.message })}\n\n`);
            controller.close();
          }
        }
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }
    else if (isLocal || isDashScope || isGLM || isGrok || isKimi || isCohere || isMinimax || isOpenAI || isMimo || isBytedance) {
      // ----- OpenAI-compatible: LM Studio (Local), DashScope (Qwen / DeepSeek
      //       V3.2), DeepSeek's first-party API, or Z.AI (GLM family) -----
      // All speak the same /chat/completions JSON protocol; only the full URL,
      // Bearer auth, and a couple of extra-body params differ.
      //
      // DeepSeek routing rules: the model id picks the upstream.
      //   - "deepseek-v3.2" → Alibaba DashScope (Singapore intl endpoint).
      //     This is the only DeepSeek model available on dashscope-intl.
      //   - everything else starting with "deepseek-" (v4-pro/v4-flash, legacy
      //     deepseek-chat/deepseek-reasoner) → api.deepseek.com directly.
      //     Requires a separate DeepSeek API key (keys.deepseek).
      const useDeepSeekDirect = isDeepSeek && !!specificModel && specificModel !== 'deepseek-v3.2';

      if (useDeepSeekDirect && !keys.deepseek) {
        return NextResponse.json({
          error: `${specificModel} runs on DeepSeek's first-party API — add a DeepSeek API key in Preferences. (deepseek-v3.2 is the only model NEXUS can serve via your Alibaba/Qwen DashScope key, because the international DashScope endpoint doesn't host the others.)`,
        }, { status: 400 });
      }
      if (isDashScope && !useDeepSeekDirect && !keys.qwen) {
        return NextResponse.json({
          error: `${isDeepSeek ? 'DeepSeek V3.2 (via DashScope)' : 'Qwen'} requires the Alibaba (Qwen / DashScope) API key in Preferences.`,
        }, { status: 400 });
      }
      if (isGLM && !keys.glm) {
        return NextResponse.json({
          error: `GLM (Z.AI) requires the Z.AI API key in Preferences.`,
        }, { status: 400 });
      }

      if (isGrok && !keys.grok) {
        return NextResponse.json({
          error: `Grok (xAI) requires the xAI API key in Preferences.`,
        }, { status: 400 });
      }
      if (isKimi && !keys.kimi) {
        return NextResponse.json({
          error: `Kimi requires the Kimi (Moonshot) API key in Preferences (from platform.kimi.ai → Console → API Keys).`,
        }, { status: 400 });
      }
      if (isCohere && !keys.cohere) {
        return NextResponse.json({
          error: `Cohere requires the Cohere API key in Preferences.`,
        }, { status: 400 });
      }
      if (isMinimax && !keys.minimax) {
        return NextResponse.json({
          error: `MiniMax requires the MiniMax API key in Preferences.`,
        }, { status: 400 });
      }
      if (isOpenAI && !keys.openai) {
        return NextResponse.json({
          error: `ChatGPT (OpenAI) requires the OpenAI API key in Preferences (sk-...).`,
        }, { status: 400 });
      }
      if (isMimo && !keys.mimo) {
        return NextResponse.json({
          error: `MiMo (Xiaomi) requires the MiMo API key in Preferences.`,
        }, { status: 400 });
      }
      if (isBytedance && !keys.bytedance) {
        return NextResponse.json({
          error: `ByteDance (Seed) requires the BytePlus API key in Preferences.`,
        }, { status: 400 });
      }

      // Full URL of the chat-completions endpoint. We build it once instead
      // of "base + /v1/chat/completions" because each provider has a slightly
      // different path prefix — most notably Z.AI's path is /api/paas/v4
      // (no /v1) which broke when we naively appended /v1.
      const chatCompletionsUrl = useDeepSeekDirect
        ? 'https://api.deepseek.com/v1/chat/completions'
        : isDashScope
          ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'
          : isGLM
            ? 'https://api.z.ai/api/paas/v4/chat/completions'
            : isGrok
              ? 'https://api.x.ai/v1/chat/completions'
              : isKimi
                ? 'https://api.moonshot.ai/v1/chat/completions'
                : isCohere
                  ? 'https://api.cohere.ai/compatibility/v1/chat/completions'
                  : isMinimax
                    ? 'https://api.minimax.io/v1/chat/completions'
                    : isOpenAI
                      ? 'https://api.openai.com/v1/chat/completions'
                      : isMimo
                        ? 'https://api.xiaomimimo.com/v1/chat/completions'
                        : isBytedance
                          ? 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions'
                          : `${process.env.LOCAL_LLM_BASE || 'http://localhost:1234'}/v1/chat/completions`;
      const authHeaders: Record<string, string> = useDeepSeekDirect
        ? { Authorization: `Bearer ${keys.deepseek}` }
        : isDashScope
          ? { Authorization: `Bearer ${keys.qwen}` }
          : isGLM
            ? { Authorization: `Bearer ${keys.glm}` }
            : isGrok
              ? { Authorization: `Bearer ${keys.grok}` }
              : isKimi
                ? { Authorization: `Bearer ${keys.kimi}` }
                : isCohere
                  ? { Authorization: `Bearer ${keys.cohere}` }
                  : isMinimax
                    ? { Authorization: `Bearer ${keys.minimax}` }
                    : isOpenAI
                      ? { Authorization: `Bearer ${keys.openai}` }
                      : isMimo
                        ? { Authorization: `Bearer ${keys.mimo}` }
                        : isBytedance
                          ? { Authorization: `Bearer ${keys.bytedance}` }
                          : {};
      const localModel = isKimi ? resolveKimiModel(specificModel) : (specificModel || (
        isGLM      ? 'glm-4.7' :
        isGrok     ? 'grok-4.5' :
        isCohere   ? 'command-a-plus-05-2026' :
        // Case-sensitive per MiniMax docs: capital M's, lowercase i, hyphen.
        isMinimax  ? 'MiniMax-M3' :
        isDeepSeek ? 'deepseek-v4-flash' :
        isQwen     ? 'qwen3.6-plus' :
        isOpenAI   ? 'gpt-5.6-terra' :
        isMimo     ? 'mimo-v2.5' :
        isBytedance ? 'seed-2-0-pro-260328' :
                     'local-model'
      ));

      // ── DashScope/DeepSeek/Z.AI inline-file size preflight ─────────────────
      // DashScope (Qwen/DeepSeek-via-Alibaba), api.deepseek.com, and api.z.ai
      // all reject any single `data:` URI larger than 20 MiB with a 400.
      // Catch it here and return a clear error naming the offending file(s)
      // instead of letting the user see the cryptic upstream message.
      if (isDashScope || useDeepSeekDirect || isGLM || isGrok || isKimi || isCohere || isMinimax || isOpenAI || isMimo || isBytedance) {
        const DATA_URI_MAX = 20 * 1024 * 1024; // 20 MiB hard limit
        const tooBig: string[] = [];
        for (const m of processedMessages) {
          for (const media of (m.mediaFiles || [])) {
            // Rough size of the full `data:<mime>;base64,<b64>` string.
            const dataUriLen = `data:${media.mimeType};base64,${media.base64Data}`.length;
            if (dataUriLen > DATA_URI_MAX) {
              const mb = (dataUriLen / 1024 / 1024).toFixed(1);
              tooBig.push(`${media.name || '(unnamed)'} — ${mb} MB (after base64 encoding)`);
            }
          }
        }
        if (tooBig.length > 0) {
          return NextResponse.json({
            error:
              `Cannot send: DashScope/DeepSeek rejects any single inline file over 20 MiB. ` +
              `Oversize attachment(s): ${tooBig.join('; ')}. ` +
              `Resize/recompress the file (for images, use the Tools menu → Convert PNG → JPG, or scale them down) or exclude it with the eye icon, then resend.`,
          }, { status: 400 });
        }
      }
      // ── End preflight ───────────────────────────────────────────────────────

      // OpenAI-style function tools (when toolUseEnabled). Whether the model
      // actually emits tool_calls is up to the loaded model's training —
      // Qwen2.5/Llama-3.1-Instruct/Hermes-3/Gemma-4 should; base models won't.
      const localTools: any[] = [];
      if (toolUseEnabled) {
        // Same Read/Write/Edit/Glob/Grep set as the Claude and Gemini branches,
        // in OpenAI function-tool schema. The model's training determines how
        // well it picks these up — Qwen / Llama-3-Instruct / Gemma-4 generally
        // do, base models do not.
        localTools.push({
          type: 'function',
          function: {
            name: 'Read',
            description: `${I.toolReadDesc} ${pathRule}`,
            parameters: {
              type: 'object',
              properties: { path: { type: 'string', description: pathDesc } },
              required: ['path'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'Write',
            description: I.toolWriteDesc,
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: pathDesc },
                content: { type: 'string', description: 'Full file contents to write' },
              },
              required: ['path', 'content'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'Edit',
            description: I.toolEditDesc,
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: pathDesc },
                old_string: { type: 'string', description: 'Text to find. Must occur exactly once.' },
                new_string: { type: 'string', description: 'Text to replace it with.' },
              },
              required: ['path', 'old_string', 'new_string'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'Glob',
            description: I.toolGlobDesc,
            parameters: {
              type: 'object',
              properties: { pattern: { type: 'string', description: 'Glob pattern. Use `**` to match all files.' } },
              required: ['pattern'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'Grep',
            description: I.toolGrepDesc,
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'JavaScript regex (no surrounding slashes).' },
                file_pattern: { type: 'string', description: 'Optional glob to restrict files.' },
                flags: { type: 'string', description: 'Optional regex flags (e.g. "i").' },
              },
              required: ['pattern'],
            },
          },
        });
        if (agentDangerousTools) {
          localTools.push({
            type: 'function',
            function: {
              name: 'Delete',
              description: I.toolDeleteDesc,
              parameters: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Path of the file to delete.' } },
                required: ['path'],
              },
            },
          });
          localTools.push({
            type: 'function',
            function: {
              name: 'Bash',
              description: I.toolBashDesc,
              parameters: {
                type: 'object',
                properties: {
                  command: { type: 'string', description: 'The shell command to run.' },
                  timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, max 600000).' },
                },
                required: ['command'],
              },
            },
          });
        }
      }

      // ── Interactive AskUserQuestion tool (optional, independent toggle) ──────
      // Gives the model a way to pause and ask the user a multiple-choice
      // question, then continue once they answer. Independent of toolUseEnabled
      // and web tools — it's its own opt-in capability.
      if (askUserEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'AskQuestion',
            description: I.askUserDesc,
            parameters: {
              type: 'object',
              properties: {
                questions: {
                  type: 'array',
                  description: 'Between 1 and 4 questions to ask the user.',
                  items: {
                    type: 'object',
                    properties: {
                      question: { type: 'string', description: 'The full question text. End with a question mark.' },
                      header: { type: 'string', description: 'Very short label/chip for the question (max ~12 chars).' },
                      multiSelect: { type: 'boolean', description: 'Set true to let the user pick multiple options.' },
                      options: {
                        type: 'array',
                        description: '2 to 4 distinct, mutually-exclusive choices.',
                        items: {
                          type: 'object',
                          properties: {
                            label: { type: 'string', description: 'Short option label (1-5 words).' },
                            description: { type: 'string', description: 'What choosing this option means.' },
                          },
                          required: ['label'],
                        },
                      },
                    },
                    required: ['question', 'options'],
                  },
                },
              },
              required: ['questions'],
            },
          },
        });
      }

      // ── Subagent (context-firewall helper) tool (optional) ──────────────────
      if (subagentEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'spawn_subagent',
            description: I.subagentDesc,
            parameters: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'A precise, self-contained investigation for the helper to perform.' },
                return_contract: { type: 'string', description: 'Optional: how the distilled result should be shaped/formatted.' },
              },
              required: ['task'],
            },
          },
        });
      }

      // ── Universal NEXUS web tools ───────────────────────────────────────────
      // When "Enable Web Search" is on, give EVERY OpenAI-compatible provider a
      // real, uniform search+fetch capability backed by NEXUS's own server-side
      // implementation (src/lib/webTools.ts). This replaces the patchwork of
      // provider-native search shapes ($web_search / enable_search / tools[
      // web_search]) that were snippet-only, inconsistent, or unsupported. The
      // model calls `web_search` to find pages and `web_fetch` to actually read
      // one — and the URLs flow into the verifiable "Web sources" citation
      // panel. Independent of `toolUseEnabled` (web access ≠ file access).
      const nexusWebToolsEnabled = !!modelParams.enableWebSearch;
      if (nexusWebToolsEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'web_search',
            description: I.webSearchDesc,
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'The search query.' },
              },
              required: ['query'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'web_fetch',
            description: I.webFetchDesc,
            parameters: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The absolute http(s) URL to open and read.' },
              },
              required: ['url'],
            },
          },
        });
      }

      // read_conversation — pull the full text of a past conversation by name.
      // Available when the folder uses the summaries-as-Layer-4 mode: the model
      // sees short summaries in its system prompt and can drill into any one of
      // them on demand. Inactive (non-public) conversations are refused.
      if (enableReadConversation) {
        localTools.push({
          type: 'function',
          function: {
            name: 'read_conversation',
            description: I.readConversationDesc,
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: I.readConversationNameParam },
              },
              required: ['name'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'search_conversations',
            description: I.searchConversationsDesc,
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: I.searchConversationsQueryParam },
              },
              required: ['query'],
            },
          },
        });
      }

      // Build base OpenAI-style messages from the conversation
      const baseOaiMessages: any[] = [];
      if (enhancedSystemPrompt) baseOaiMessages.push({ role: 'system', content: enhancedSystemPrompt });

      // Derive the audio-format hint DashScope needs (e.g. "audio/mpeg" → "mp3",
      // "audio/wav" → "wav"). Falls back to 'mp3' for unknown subtypes.
      const audioFormatOf = (mime: string): string => {
        const sub = (mime.split('/')[1] || '').toLowerCase().replace(/^x-/, '');
        if (sub === 'mpeg') return 'mp3';
        if (sub === '3gpp') return '3gp';
        return sub || 'mp3';
      };

      for (const m of processedMessages) {
        const parts: any[] = [];
        m.mediaFiles?.forEach((media: any) => {
          const dataUrl = `data:${media.mimeType};base64,${media.base64Data}`;
          if (media.mimeType.startsWith('image/')) {
            if (media.name) parts.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            parts.push({ type: 'image_url', image_url: { url: dataUrl } });
          } else if (media.mimeType.startsWith('audio/')) {
            // DashScope/Qwen-Omni OpenAI-compatible audio input. The Python SDK
            // calls this `extra_body` content, but at the wire level it's just
            // a regular content-part with type "input_audio". Local LM Studio
            // models will typically ignore this (no harm — it's just an
            // unrecognized part).
            if (media.name) parts.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            parts.push({
              type: 'input_audio',
              // OpenAI's `input_audio.data` spec wants RAW base64. Qwen/MiMo
              // tolerate a full `data:` URL here, but ByteDance/Ark strictly
              // schema-validates it as pure base64 and nulls the whole message
              // otherwise ("messages[i] … expected an object, but got null").
              // So send raw base64 for ByteDance, the prefixed URL for the rest.
              input_audio: { data: isBytedance ? media.base64Data : dataUrl, format: audioFormatOf(media.mimeType) },
            });
          } else if (media.mimeType.startsWith('video/')) {
            // DashScope/Qwen video input — same shape as image_url but with a
            // dedicated "video_url" content type. Inline base64 data URLs are
            // accepted per Alibaba's docs.
            if (media.name) parts.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            parts.push({ type: 'video_url', video_url: { url: dataUrl } });
          }
          // Other mime types (PDF, etc.) are not part of the OpenAI multimodal
          // spec — they're already injected as <attached_file> text earlier
          // for the text-only path.
        });
        if (m.content) parts.push({ type: 'text', text: m.content });
        if (parts.length === 0) parts.push({ type: 'text', text: '-' });

        const allText = parts.every((p: any) => p.type === 'text');
        const content = allText ? parts.map((p: any) => p.text).join('\n') : parts;

        baseOaiMessages.push({ role: m.role === 'user' ? 'user' : 'assistant', content });
      }

      // NOTE: No "prevent thinking" switch for local models. There is no
      // portable, reliable way to force a local GGUF to skip its reasoning
      // phase via the OpenAI-compatible API:
      //   • chat_template_kwargs.enable_thinking → makes some models fail to
      //     load (Jinja template can't render the extra kwarg → 400).
      //   • `/no_think` text soft switch → only works when the GGUF's embedded
      //     chat template implements the parsing for it; many conversions and
      //     fine-tunes ship a template without it, so it's ignored.
      //   • Prefilled closed <think></think> → LM Studio's chat-completions
      //     does not continue a trailing assistant message, so it doesn't carry.
      // Thinking on local models is therefore left to the model/template itself
      // (choose a non-thinking model/quant to avoid it).

      // ── Layer 1: Creativity analysis (text-based — works with any local model) ─
      let layer1C: number | null = null;
      console.log(`[creativity] Local: enabled=${creativityControlEnabled}, model=${localModel}`);

      if (creativityControlEnabled) {
        // Build a dedicated Layer 1 conversation with its own system message.
        // The system message tells the model its ONLY job is to output a number.
        // We keep the conversation history so it understands context, but strip
        // the original system prompt and replace it with the analysis one.
        const analysisHeuristic =
          'C = 0.35: Grounded & Focused — analytical, factual, highly structured\n' +
          'C = 0.50: Standard & Conversational — default\n' +
          'C = 0.75: Creative & Brainstorming — novel perspectives, high variance\n' +
          'C = 1.00: Experimental & Chaotic — surreal, intentionally unpredictable\n\n' +
          'Choose the value that best fits the conversation above.';

        const layer1Msgs: any[] = [
          { role: 'system', content: 'Output ONLY a single decimal number from 0.0 to 1.0. No explanation, no other text.' },
        ];
        // Append conversation history (skip original system message)
        for (const m of baseOaiMessages) {
          if (m.role === 'system') continue;
          layer1Msgs.push({ ...m });
        }
        // Append heuristic guide to the last user message so the model knows the scale
        const lastIdx = layer1Msgs.length - 1;
        if (lastIdx >= 1 && layer1Msgs[lastIdx].role === 'user') {
          const last = layer1Msgs[lastIdx];
          layer1Msgs[lastIdx] = {
            ...last,
            content: typeof last.content === 'string'
              ? last.content + '\n\n' + analysisHeuristic
              : [...(Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }]),
                 { type: 'text', text: analysisHeuristic }],
          };
        } else {
          layer1Msgs.push({ role: 'user', content: analysisHeuristic });
        }

        try {
          console.log(`[creativity] Local Layer 1 — sending ${layer1Msgs.length} msgs to ${localModel}`);
          const layer1Res = await fetch(chatCompletionsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: JSON.stringify({
              model: localModel,
              messages: layer1Msgs,
              stream: false,
              temperature: 0.1,
              top_p: 0.9,
            }),
          });
          if (layer1Res.ok) {
            const layer1Data = await layer1Res.json();
            const msg = layer1Data.choices?.[0]?.message || {};
            // Thinking models (Gemma 4, QwQ, etc.) often return empty `content`
            // and put their output in `reasoning_content`. Check both.
            const raw = (msg.content || msg.reasoning_content || '').trim();
            console.log(`[creativity] Local Layer 1 raw: "${raw.slice(0, 120)}"`);
            // Find any float 0.0–1.0 anywhere in the text
            const match = raw.match(/\b(1(?:\.0+)?|0(?:\.\d+)?|\.\d+)\b/);
            if (match) {
              const val = parseFloat(match[1]);
              if (!isNaN(val)) layer1C = Math.max(0, Math.min(1, val));
            }
          } else {
            const errText = await layer1Res.text().catch(() => '');
            console.warn(`[creativity] Local Layer 1 HTTP ${layer1Res.status}: ${errText.slice(0, 300)}`);
          }
          console.log(`[creativity] Local Layer 1 result: C=${layer1C}`);
        } catch (e: any) {
          console.warn('[creativity] Local Layer 1 exception:', e.message);
        }
      }

      const effectiveLocalTemp = layer1C !== null ? 2.0 * layer1C : (modelParams.temperature ?? 0.7);
      const effectiveLocalTopP = layer1C !== null ? 0.7 + 0.3 * layer1C : (modelParams.topP ?? 0.95);
      // ── End Layer 1 ─────────────────────────────────────────────────────────

      // One streaming call. Returns visibleText (only the text portion, not thoughts)
      // and finishReason from the provider. Tokens are emitted to controller as they arrive.
      const runLocalOnce = async (
        msgs: any[],
        controller: ReadableStreamDefaultController,
        state: { inThink: boolean; textTail: string }
      ): Promise<{
        visibleText: string;
        reasoningText: string;
        finishReason: string | null;
        toolCalls: { id: string; name: string; arguments: string }[];
        usage: any;
        webSources: { url: string; title?: string }[];
      }> => {
        const requestBody: any = {
          model: localModel,
          messages: msgs,
          stream: true,
          // Ask the upstream to include the final usage block in the stream's
          // last data event. Without this, prompt-cache stats never make it
          // back to us — most OpenAI-compatible providers honor this flag.
          stream_options: { include_usage: true },
          temperature: effectiveLocalTemp,
          top_p: effectiveLocalTopP,
          ...(seedEnabled ? { seed: seedValue } : {}),
        };
        if (typeof modelParams.topK === 'number') requestBody.top_k = modelParams.topK;
        // OpenAI GPT-5 reasoning models reject any non-default `temperature` /
        // `top_p` / `top_k` (only the model default is allowed) and 400 if they
        // are present. Strip the sampling knobs entirely — Creativity Control's
        // T/P override therefore doesn't apply to ChatGPT (documented).
        if (isOpenAI) {
          delete requestBody.temperature;
          delete requestBody.top_p;
          delete requestBody.top_k;
        }
        // `max_tokens: -1` ("use the whole context window") is an LM Studio /
        // llama.cpp specific sentinel. DashScope returns 400, Z.AI returns
        // error 1210 "Invalid API parameter", DeepSeek's direct API rejects
        // it too. Only send it for Local.
        //
        // The "this specific chat" bug it caused: conversations that were
        // originally Local picked up `modelParams.localContextWindow` from
        // the UI's default (80000). When the user later switched the chat's
        // family to GLM/Qwen/DeepSeek, that field stayed in the saved log,
        // and previously `!isDashScope` let the -1 sentinel through to GLM.
        if (isLocal && typeof modelParams.localContextWindow === 'number') {
          requestBody.max_tokens = -1;
        }
        // COPY the shared tool list — the web-search blocks below do
        // `requestBody.tools.push(...)`, and runLocalOnce runs once per
        // tool-loop iteration. Assigning by reference made each iteration push
        // another search entry onto the SAME `localTools` array, so by the 2nd
        // iteration Kimi 400'd with "function name $web_search is duplicated".
        if (localTools.length) requestBody.tools = [...localTools];
        // DashScope thinking toggle via `enable_thinking` (extra top-level field).
        //   - Qwen 3.x: hybrid, on/off toggle
        //   - DeepSeek V3.2: also hybrid, same flag, same semantics
        // Local LM Studio models ignore it (no harm).
        //
        // EXCEPTION — Qwen Omni (qwen3.5-omni-flash / -plus): DashScope rejects
        // `enable_thinking` for these with a misleading "thinking_budget must be
        // a positive integer and not greater than 0" 400. Omni models have
        // built-in reasoning that's not user-toggleable, so simply skip the flag.
        const isOmniModel = (specificModel || '').toLowerCase().includes('omni');
        if ((isQwen || isDeepSeek) && !isOmniModel) {
          requestBody.enable_thinking = modelParams.qwenEnableThinking !== false;
        }
        // NOTE: Local LM Studio / llama.cpp models intentionally get NO thinking
        // flag. We tried forwarding `enable_thinking` + `chat_template_kwargs`,
        // but (a) it didn't reliably toggle thinking across local models, and
        // (b) passing `chat_template_kwargs` made some models fail to render
        // their Jinja chat template, which LM Studio reports as a hard "Failed
        // to load model" 400. Local thinking is therefore left to whatever the
        // model's own template decides (turn it off by choosing a non-thinking
        // model / quantization, or via a `/no_think`-style hint in the prompt).
        // Z.AI / GLM uses a different shape: `thinking: { type: 'enabled' | 'disabled' }`
        // (object, not boolean). Reuses the same UI toggle since semantics match.
        // Kimi K2.x uses the exact same shape, so it shares this branch.
        //
        // Kimi K3 is the EXCEPTION and must NOT use the K2.x `thinking` param:
        // its reasoning is ALWAYS on and is configured via the top-level
        // `reasoning_effort` field (only 'max' is supported today). It also fixes
        // temperature (1.0) and top_p (0.95) server-side — sending either 400s —
        // so we strip both. Net: the Thinking-Mode toggle has no effect on K3.
        const isKimiK3 = isKimi && /kimi-k3/i.test(String(requestBody.model || ''));
        if (isKimiK3) {
          requestBody.reasoning_effort = 'max';
          delete requestBody.temperature;
          delete requestBody.top_p;
        } else if (isGLM || isKimi) {
          requestBody.thinking = {
            type: modelParams.qwenEnableThinking !== false ? 'enabled' : 'disabled',
          };
        }
        // Kimi (Moonshot) pins temperature to a single fixed value per mode and
        // rejects anything else with a 400 ("invalid temperature: only X is
        // allowed for this model"):
        //   • Thinking ON  → temperature must be 1   (also Moonshot's
        //                     recommended value for chain-of-thought quality)
        //   • Thinking OFF → temperature must be 0.6
        // Override both the user's temperature and any Creativity-Control value
        // (2·C), which would otherwise trip the 400.
        if (isKimi && !isKimiK3) {
          requestBody.temperature = modelParams.qwenEnableThinking !== false ? 1 : 0.6;
        }
        // MiMo (Xiaomi) only accepts temperature within [0, 1.5] and 400s
        // otherwise ("temperature must be within [0, 1.5]"). The UI / Creativity
        // Control can produce up to 2.0 (T = 2·C), so clamp into range rather
        // than fail. top_p stays untouched (MiMo accepts the standard 0–1).
        if (isMimo && typeof requestBody.temperature === 'number') {
          requestBody.temperature = Math.min(1.5, Math.max(0, requestBody.temperature));
        }
        // Cohere's OpenAI-compat endpoint uses the OpenAI-standard
        // `reasoning_effort` field. Per Cohere's docs, only "none" and "high"
        // are accepted (no medium/low gradations). Map the same boolean UI
        // toggle to the two valid values.
        if (isCohere) {
          requestBody.reasoning_effort = modelParams.qwenEnableThinking !== false ? 'high' : 'none';
        }
        // OpenAI GPT-5 family uses the standard `reasoning_effort` field. Map the
        // shared Thinking-Mode toggle to high (on) / minimal (off).
        //
        // CRITICAL — function tools + reasoning on /v1/chat/completions:
        // These models 400 when function tools are attached while reasoning is
        // active ("Function tools with reasoning_effort are not supported … use
        // /v1/responses or set reasoning_effort to 'none'"). The catch: gpt-5.6
        // reasoning models default to reasoning ON, so simply OMITTING the field
        // is NOT enough — the model still reasons and the request 400s. gpt-5.6
        // fixes this by accepting reasoning_effort:'none', which must be sent
        // EXPLICITLY to turn reasoning off for the tool turn. Older gpt-5.4/5.5
        // don't accept 'none', so for them we omit the field (their default
        // behavior with tools worked). Net effect on 5.6+tools: tools work, but
        // the model does NOT reason on that turn — reasoning+tools together needs
        // the /v1/responses API (not used here).
        if (isOpenAI) {
          if (requestBody.tools) {
            if (/gpt-5\.6/i.test(requestBody.model || '')) {
              requestBody.reasoning_effort = 'none';
            }
            // older gpt-5.x with tools: leave reasoning_effort unset (omitted).
          } else {
            requestBody.reasoning_effort = modelParams.qwenEnableThinking !== false ? 'high' : 'minimal';
          }
        }

        // ── Web search ──────────────────────────────────────────────────────
        // SUPERSEDED by the universal NEXUS web tools (web_search + web_fetch,
        // added to `localTools` above and dispatched in the tool loop below).
        // Every OpenAI-compatible provider now gets the SAME real search+fetch
        // with verifiable citations, instead of the old patchwork of native
        // shapes that were snippet-only (GLM/Kimi/MiniMax), DashScope-only
        // (Qwen/DeepSeek `enable_search`), unsupported (Cohere/Local/DeepSeek-
        // direct), or broken on chat-completions (Grok). The native shapes are
        // intentionally NOT sent anymore — `nexusWebToolsEnabled` drives it all.
        //
        // (If a future provider ships clearly-superior first-party grounding we
        // can branch it back in here, gated to that provider only.)

        // xAI's docs recommend setting `x-grok-conv-id` to maximize cache
        // hit rate by hinting that this request belongs to the same
        // conversation as previous ones. No-op for other providers.
        const extraHeaders: Record<string, string> =
          isGrok && convoId ? { 'x-grok-conv-id': String(convoId) } : {};

        const lsRes = await fetch(chatCompletionsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders, ...extraHeaders },
          body: JSON.stringify(requestBody),
        });
        if (!lsRes.ok || !lsRes.body) {
          const errText = await lsRes.text().catch(() => '');
          const label = useDeepSeekDirect
            ? 'DeepSeek API'
            : isGLM
              ? 'Z.AI GLM'
              : isGrok
                ? 'xAI Grok'
                : isKimi
                  ? 'Kimi (Moonshot)'
                  : isCohere
                    ? 'Cohere'
                    : isMinimax
                      ? 'MiniMax'
                      : isOpenAI
                        ? 'OpenAI'
                        : isMimo
                          ? 'MiMo (Xiaomi)'
                          : isBytedance
                            ? 'ByteDance (BytePlus)'
                            : isDashScope
                            ? (isDeepSeek ? 'DeepSeek via DashScope' : 'Qwen DashScope')
                            : 'LM Studio';
          throw new Error(`${label}: ${lsRes.status} ${errText}`);
        }

        let visibleText = '';
        // Raw reasoning_content accumulated across the stream. Kimi (Moonshot)
        // REQUIRES this to be echoed back on the assistant tool-call message
        // when thinking is enabled — otherwise the next tool-loop iteration
        // 400s with "reasoning_content is missing in assistant tool call
        // message". Harmless to capture for other providers (only used below
        // when isKimi).
        let reasoningText = '';
        let finishReason: string | null = null;
        // Web-search citations the provider attached to this response. Different
        // OpenAI-compatible providers expose them in different (non-standard)
        // places — we probe every known shape and dedupe by URL. An EMPTY array
        // after a "web search" turn is itself meaningful: it means the provider
        // returned no verifiable sources, so any "facts" the model stated are
        // unproven (likely hallucinated). This is the user-facing proof signal.
        const webSourceMap = new Map<string, { url: string; title?: string }>();
        const addSource = (url: any, title?: any) => {
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
          const existing = webSourceMap.get(url);
          const t = typeof title === 'string' && title.trim() ? title.trim() : undefined;
          if (!existing) webSourceMap.set(url, { url, ...(t ? { title: t } : {}) });
          else if (t && !existing.title) existing.title = t;
        };
        // Harvest citation objects from any of the documented provider shapes.
        const harvestSources = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          // OpenAI-standard / Grok / Perplexity: annotations[].url_citation
          const anns = obj.annotations;
          if (Array.isArray(anns)) {
            for (const a of anns) {
              if (a?.type === 'url_citation' && a.url_citation) addSource(a.url_citation.url, a.url_citation.title);
              else if (a?.url) addSource(a.url, a.title);
            }
          }
          // Grok / Perplexity top-level: citations[] (array of URL strings or objects)
          if (Array.isArray(obj.citations)) {
            for (const c of obj.citations) {
              if (typeof c === 'string') addSource(c);
              else if (c?.url) addSource(c.url, c.title);
            }
          }
          // Qwen DashScope: search_info.search_results[] = { url, title, site_name }
          const si = obj.search_info || obj.search_results;
          const results = Array.isArray(si) ? si : (Array.isArray(si?.search_results) ? si.search_results : null);
          if (results) {
            for (const r of results) addSource(r?.url || r?.link, r?.title || r?.site_name);
          }
          // GLM (Z.AI): web_search[] = { link/url, title }
          if (Array.isArray(obj.web_search)) {
            for (const r of obj.web_search) addSource(r?.link || r?.url, r?.title);
          }
        };
        // Latest seen usage block. With stream_options.include_usage, the
        // upstream sends one final chunk where `choices` is empty (or missing)
        // and `usage` is populated.
        let usage: any = null;
        // Streaming tool calls arrive as partial deltas indexed by tool_calls[].index.
        // Accumulate id / name / arguments-json-string into a slot per index.
        const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

        const emitText = (t: string) => {
          if (!t) return;
          visibleText += t;
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', content: t })}\n\n`);
        };
        const emitThought = (t: string) => {
          if (!t) return;
          controller.enqueue(`data: ${JSON.stringify({ type: 'thought', content: t })}\n\n`);
        };

        // Stream-safe <think>...</think> splitter, state passed in so it persists across continuations.
        const processContent = (incoming: string) => {
          let s = state.textTail + incoming;
          state.textTail = '';
          while (s.length > 0) {
            if (state.inThink) {
              const close = s.indexOf('</think>');
              if (close === -1) {
                if (s.length > 8) { emitThought(s.slice(0, s.length - 8)); state.textTail = s.slice(-8); }
                else state.textTail = s;
                return;
              }
              if (close > 0) emitThought(s.slice(0, close));
              s = s.slice(close + 8);
              state.inThink = false;
            } else {
              const open = s.indexOf('<think>');
              if (open === -1) {
                if (s.length > 7) { emitText(s.slice(0, s.length - 7)); state.textTail = s.slice(-7); }
                else state.textTail = s;
                return;
              }
              if (open > 0) emitText(s.slice(0, open));
              s = s.slice(open + 7);
              state.inThink = true;
            }
          }
        };

        const reader = lsRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split('\n\n');
          buf = events.pop() || '';
          for (const ev of events) {
            const dl = ev.split('\n').find(l => l.startsWith('data: '));
            if (!dl) continue;
            const ds = dl.slice(6).trim();
            if (ds === '[DONE]') continue;
            let payload: any;
            try { payload = JSON.parse(ds); } catch { continue; }

            // The trailing "usage" chunk (sent because of
            // stream_options.include_usage) has an empty/absent `choices`
            // array and a populated `usage` block. Capture it for the final
            // cache_usage emission. Some providers also send `usage` on the
            // last `choices` chunk — overwrite either way.
            if (payload?.usage) usage = payload.usage;

            // Citations can appear at the top level of a chunk, on the choice,
            // on the delta, or on the (non-streaming) message object — probe all.
            harvestSources(payload);
            const choice = payload?.choices?.[0];
            harvestSources(choice);
            harvestSources(choice?.message);
            const delta = choice?.delta;
            harvestSources(delta);
            if (delta?.reasoning_content) { reasoningText += delta.reasoning_content; emitThought(delta.reasoning_content); }
            if (delta?.content) processContent(delta.content);
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                if (!toolAcc.has(idx)) toolAcc.set(idx, { id: '', name: '', arguments: '' });
                const slot = toolAcc.get(idx)!;
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (typeof tc.function?.arguments === 'string') slot.arguments += tc.function.arguments;
              }
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          }
        }

        // Stable-order array (by index) so we can iterate deterministically
        const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        return { visibleText, reasoningText, finishReason, toolCalls, usage, webSources: [...webSourceMap.values()] };
      };

      // Computed once so the cache-debug log (inside the loop) and the final
      // cache_usage emission (after the loop) read from the same source of
      // truth without duplicated ternary chains.
      const providerHint = useDeepSeekDirect || (isDeepSeek && isDashScope)
        ? 'deepseek'
        : isGLM ? 'glm'
        : isKimi ? 'kimi'
        : isGrok ? 'grok'
        : isCohere ? 'cohere'
        : isMinimax ? 'minimax'
        : isMimo ? 'mimo'
        : isBytedance ? 'bytedance'
        : isQwen ? 'qwen'
        : isLocal ? 'local'
        : 'oai';

      // Opt-in per-iteration cache diagnostic. Enable with `NEXUS_CACHE_DEBUG=1`
      // in the environment. Logs to the dev terminal (server-side) — never
      // reaches the browser. Captures:
      //   • stable_prefix_hash — SHA-256 of the first 2 messages (system +
      //     first user). Should be byte-identical across iterations within a
      //     turn. If it changes, our code is mutating the cacheable prefix.
      //   • prompt_tokens / cached / raw usage — what the provider reported.
      //     If cached ≈ 0 while the stable prefix is unchanged, the provider
      //     is not caching for us (account tier, model, or feature gate).
      const CACHE_DEBUG = process.env.NEXUS_CACHE_DEBUG === '1';

      const readableStream = new ReadableStream({
        async start(controller) {
          const enqueue = (obj: any) => controller.enqueue(`data: ${JSON.stringify(obj)}\n\n`);
          // Identify the model+thinking-mode about to respond (see Claude branch above).
          enqueue(modelSelectedPayload);
          emitSenseEvents(controller);
          if (layer1C !== null) {
            enqueue({ type: 'creativity_prefix', label: creativityDisplayPattern.replace('{C}', layer1C.toFixed(2)) });
          }

          // ── Grok native web + X search fork ─────────────────────────────────
          // When web search is on for a Grok conversation, run xAI's server-side
          // web_search + x_search via /v1/responses instead of the normal
          // chat/completions tool loop (whose only web option here is the flaky
          // keyless DuckDuckGo tool). Non-streaming, then close the stream.
          // Text-only input (images are dropped for the search query); workspace
          // tools / thinking are not part of this scoped search turn.
          if (isGrok && modelParams.enableWebSearch) {
            const grokInput = baseOaiMessages.map((m: any) => ({
              role: m.role,
              content: typeof m.content === 'string'
                ? m.content
                : (Array.isArray(m.content)
                    ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
                    : String(m.content ?? '')),
            }));
            try {
              await runGrokNativeSearch({ apiKey: keys.grok || '', model: localModel, input: grokInput, enqueue });
            } catch (e: any) {
              enqueue({ type: 'text', content: `[Grok native search failed: ${e?.message || 'unknown error'}]` });
            }
            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
            return;
          }

          const MAX_CONTINUATIONS = 2;
          const MAX_TOOL_ITERATIONS = 8;
          const tagState = { inThink: false, textTail: '' };
          let msgs = [...baseOaiMessages];
          let cumulativeAssistantText = '';
          // Reasoning text accumulated across continuation rounds. Needed so a
          // model that runs out of tokens WHILE STILL THINKING can be handed its
          // own prior thought to continue from (otherwise the prefill is empty
          // and the model emits nothing — the "continued ×N, no output" bug).
          let cumulativeReasoningText = '';
          let attempt = 0;
          let toolIterations = 0;
          // Dedup web-search citations across every tool-loop iteration +
          // continuation so the final `web_sources` event carries the full set.
          const cumWebSourceMap = new Map<string, { url: string; title?: string }>();
          // Accumulate prompt-cache usage across tool-loop iterations and
          // continuation prefills so the cache_usage SSE event reflects the
          // total turn-level token bill.
          const cumOaiUsage: any = {
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            // DeepSeek's split-bucket fields:
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 0,
          };
          try {
            while (true) {
              // Hash the cacheable-prefix portion *before* the call. We want
              // to verify that what we sent this iteration begins with the
              // exact same bytes as previous iterations. The first 2 messages
              // (system + first user) are the most reliably re-used prefix.
              const stablePrefixHash = CACHE_DEBUG && msgs.length > 0
                ? crypto
                    .createHash('sha256')
                    .update(JSON.stringify(msgs.slice(0, Math.min(2, msgs.length))))
                    .digest('hex')
                    .slice(0, 16)
                : '';

              const { visibleText, reasoningText, finishReason, toolCalls, usage, webSources } = await runLocalOnce(msgs, controller, tagState);
              for (const s of webSources) {
                if (!cumWebSourceMap.has(s.url)) cumWebSourceMap.set(s.url, s);
              }
              if (usage) {
                cumOaiUsage.prompt_tokens += Number(usage.prompt_tokens || 0);
                cumOaiUsage.completion_tokens += Number(usage.completion_tokens || 0);
                cumOaiUsage.cached_tokens += Number(
                  usage.prompt_tokens_details?.cached_tokens ??
                  usage.cache_read_input_tokens ??
                  usage.cached_tokens ??
                  0
                );
                cumOaiUsage.prompt_cache_hit_tokens += Number(usage.prompt_cache_hit_tokens || 0);
                cumOaiUsage.prompt_cache_miss_tokens += Number(usage.prompt_cache_miss_tokens || 0);
              }
              if (CACHE_DEBUG && usage) {
                const iterCached = Number(
                  usage.prompt_tokens_details?.cached_tokens ??
                  usage.cache_read_input_tokens ??
                  usage.cached_tokens ??
                  0
                );
                console.log(
                  `[CACHE-DEBUG] provider=${providerHint} model=${localModel} ` +
                  `iter=${toolIterations} total_msgs=${msgs.length} ` +
                  `stable_prefix_hash=${stablePrefixHash} ` +
                  `prompt_tokens=${usage.prompt_tokens || 0} cached=${iterCached} ` +
                  `raw_usage=${JSON.stringify(usage)}`
                );
              }

              // 1) Tool calls present → execute, append assistant turn (with
              // tool_calls field) and one role:'tool' message per call, loop.
              if (toolCalls.length > 0 && toolIterations < MAX_TOOL_ITERATIONS) {
                toolIterations++;
                msgs = [...msgs, {
                  role: 'assistant',
                  content: visibleText || '',
                  // Kimi (Moonshot) with thinking enabled validates that the
                  // assistant tool-call message carries the reasoning_content
                  // from that same turn; omitting it 400s the NEXT iteration
                  // ("reasoning_content is missing in assistant tool call
                  // message"). Echo it back. Gated to Kimi+thinking so we don't
                  // send a non-standard field to providers that reject it.
                  ...((isKimi && modelParams.qwenEnableThinking !== false)
                    ? { reasoning_content: reasoningText || '' }
                    : {}),
                  tool_calls: toolCalls.map(tc => ({
                    id: tc.id || `call_${toolIterations}_${tc.name}`,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments || '{}' },
                  })),
                }];
                // If any tool call returned an image, queue it for injection
                // as a user message right after the tool results. OpenAI's
                // `tool` role can't carry image_url cleanly, so this two-step
                // (tool result text + follow-up user message with the image)
                // is the standard workaround.
                const pendingImageInjects: { name: string; dataUrl: string }[] = [];
                for (const tc of toolCalls) {
                  let parsed: any = {};
                  try { parsed = JSON.parse(tc.arguments || '{}'); } catch {}
                  let resultText = '';
                  let attachmentEvent: any = null;
                  // Reflect the tool call in the loading label (silent otherwise).
                  const actLabel = toolActivityLabel(tc.name);
                  if (actLabel) enqueue({ type: 'tool_activity', tool: actLabel });
                  try {
                    if (tc.name === 'Read') {
                      const p = String(parsed.path || '');
                      if (isImageFilename(p)) {
                        const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (!bin) {
                          resultText = `Error: image not found or path outside workspace: ${p}`;
                        } else if (useEyes) {
                          // Text-only primary model — bridge the image via
                          // the eyes vision model and return a description
                          // as the tool result text. No follow-up
                          // user-message injection (the model can't see).
                          const base64 = bin.data.toString('base64');
                          const eyesResult = await describeImage({
                            imageBase64: base64,
                            imageMimeType: bin.mimeType,
                            eyesPrompt,
                            eyesModel,
                            zaiKey: keys.glm || '',
                            geminiKey: keys.gemini || '',
                            mimoKey: keys.mimo || '',
                            oauthToken: keys.claudeOAuthToken || '',
                          });
                          resultText =
                            `Image "${p}" (${bin.mimeType}, ${bin.data.length} bytes) — described via ${eyesModel}:\n\n` +
                            eyesResult.description;
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p, type: bin.mimeType, size: bin.data.length,
                              isImage: true,
                              dataUrl: `data:${bin.mimeType};base64,${base64}`,
                              tokens: Math.max(1, Math.ceil(eyesResult.description.length / 4)),
                              excluded: false, toolAction: 'read',
                            },
                          };
                        } else {
                          // Vision-capable models (Qwen-VL, Gemma 4 mmproj,
                          // etc.) pick up the image from the follow-up user
                          // message and respond about it.
                          const base64 = bin.data.toString('base64');
                          const dataUrl = `data:${bin.mimeType};base64,${base64}`;
                          resultText = `Image "${p}" (${bin.mimeType}, ${bin.data.length} bytes) loaded successfully. Image content follows in the next user message.`;
                          pendingImageInjects.push({ name: p, dataUrl });
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p, type: bin.mimeType, size: bin.data.length,
                              isImage: true, dataUrl,
                              tokens: Math.max(1, Math.ceil(bin.data.length / 750)),
                              excluded: false, toolAction: 'read',
                            },
                          };
                        }
                      } else {
                        const text = await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (text == null) {
                          resultText = `Error: file not found or path outside workspace: ${p}`;
                        } else {
                          resultText = text;
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p, type: 'text/plain', size: text.length,
                              isText: true, textData: text,
                              tokens: Math.ceil(text.length / 4),
                              excluded: false, toolAction: 'read',
                            },
                          };
                        }
                      }
                    } else if (tc.name === 'Write') {
                      const p = String(parsed.path || '');
                      const c = String(parsed.content ?? '');
                      const wr = await writeWorkspaceFile(folderName, p, c, { fullAccess: agentFullSystemAccess });
                      if (!wr.ok) {
                        resultText = `Error: ${wr.error || 'write failed'}`;
                      } else {
                        resultText = `OK: ${wr.existed ? 'overwrote' : 'created'} ${p} (${c.length} chars).`;
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p, type: 'text/plain', size: c.length,
                            isText: true, textData: c,
                            tokens: Math.ceil(c.length / 4),
                            excluded: false, toolAction: wr.existed ? 'modified' : 'created',
                          },
                        };
                      }
                    } else if (tc.name === 'Edit') {
                      const p = String(parsed.path || '');
                      const oldS = String(parsed.old_string ?? '');
                      const newS = String(parsed.new_string ?? '');
                      const ed = await editWorkspaceFile(folderName, p, oldS, newS, { fullAccess: agentFullSystemAccess });
                      if (!ed.ok) {
                        resultText = `Error: ${ed.error || 'edit failed'}`;
                      } else {
                        const after = (await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess })) || '';
                        resultText = `OK: edited ${p} (replaced ${oldS.length} chars with ${newS.length} chars).`;
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p, type: 'text/plain', size: after.length,
                            isText: true, textData: after,
                            tokens: Math.ceil(after.length / 4),
                            excluded: false, toolAction: 'modified',
                          },
                        };
                      }
                    } else if (tc.name === 'Glob') {
                      const pat = String(parsed.pattern || '**');
                      const matches = await globWorkspaceFiles(folderName, pat);
                      resultText = matches.length === 0
                        ? `(no files match \`${pat}\`)`
                        : matches.join('\n');
                    } else if (tc.name === 'Grep') {
                      const pat = String(parsed.pattern || '');
                      const filePat = parsed.file_pattern ? String(parsed.file_pattern) : undefined;
                      const flags = parsed.flags ? String(parsed.flags) : undefined;
                      const gr = await grepWorkspaceFiles(folderName, pat, { filePattern: filePat, flags });
                      if (!gr.ok) {
                        resultText = `Error: ${gr.error}`;
                      } else if (!gr.matches || gr.matches.length === 0) {
                        resultText = `(no matches for /${pat}/${flags || ''})`;
                      } else {
                        resultText = gr.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n');
                      }
                    } else if (tc.name === 'Delete') {
                      const p = String(parsed.path || '');
                      const del = await deleteWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                      resultText = del.ok ? `OK: deleted ${p}.` : `Error: ${del.error || 'delete failed'}`;
                    } else if (tc.name === 'Bash') {
                      // DANGEROUS shell execution — only present when
                      // agentDangerousTools gated the tool in above.
                      const cmd = String(parsed.command || '');
                      if (!cmd.trim()) {
                        resultText = 'Error: Bash requires a non-empty "command".';
                      } else {
                        const cwd = await ensureWorkspace(folderName);
                        const sh = await runShellCommand(cmd, { cwd, timeoutMs: Number(parsed.timeout_ms) || undefined });
                        resultText = sh.output;
                      }
                    } else if (tc.name === 'web_search') {
                      // Universal NEXUS web search (DuckDuckGo, keyless). Runs
                      // here on the server; results are fed back to the model AND
                      // registered as verifiable citations.
                      const query = String(parsed.query || parsed.q || '').trim();
                      if (!query) {
                        resultText = 'Error: web_search requires a non-empty "query".';
                      } else {
                        const hits = await webSearch(query, { maxResults: 6 });
                        for (const h of hits) {
                          if (h.url && !cumWebSourceMap.has(h.url)) {
                            cumWebSourceMap.set(h.url, { url: h.url, ...(h.title ? { title: h.title } : {}) });
                          }
                        }
                        resultText = hits.length === 0
                          ? `(no results for "${query}")`
                          : hits.map((h, i) =>
                              `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`
                            ).join('\n\n') +
                            `\n\n(To read a full page, call web_fetch with one of the URLs above.)`;
                      }
                    } else if (tc.name === 'web_fetch') {
                      // Universal NEXUS web access — open ONE URL and return its
                      // readable text. SSRF-guarded inside webFetch().
                      const target = String(parsed.url || parsed.URL || '').trim();
                      if (!target) {
                        resultText = 'Error: web_fetch requires an absolute "url".';
                      } else {
                        const page = await webFetch(target, { maxChars: 8000 });
                        if (page.url && !cumWebSourceMap.has(page.url)) {
                          cumWebSourceMap.set(page.url, { url: page.url, ...(page.title ? { title: page.title } : {}) });
                        }
                        resultText =
                          `URL: ${page.url}\n` +
                          (page.title ? `Title: ${page.title}\n` : '') +
                          `\n${page.text}` +
                          (page.truncated ? `\n\n[...content truncated...]` : '');
                      }
                    } else if (tc.name === 'read_conversation') {
                      // Pull a past conversation by name into context for this
                      // turn only. Inactive ("non-public") conversations are
                      // refused inside readConversationByName — nothing is saved.
                      const name = String(parsed.name || parsed.title || '').trim();
                      const r = await readConversationByName(folderName, name);
                      resultText = r.ok
                        ? `Transcript of "${r.title}":\n\n${r.transcript}`
                        : `Error: ${r.error}`;
                    } else if (tc.name === 'search_conversations') {
                      // Search across the entity's conversations; inactive ones
                      // excluded (privacy). Nothing is saved.
                      const sr = await searchConversations(folderName, String(parsed.query || parsed.q || '').trim(), { excludeInactive: true });
                      resultText = formatSearchForTool(sr);
                    } else if (tc.name === '$web_search') {
                      // Moonshot (Kimi) builtin web search. Unlike the
                      // workspace tools, the search itself runs on Moonshot's
                      // servers — the documented client contract is to echo the
                      // model's arguments straight back as the tool result.
                      // Moonshot then performs the search and continues the
                      // completion (billed separately on their side). Returning
                      // anything else (or "unknown function") makes Kimi report
                      // it has no web access.
                      resultText = tc.arguments || '{}';
                    } else if (tc.name === 'AskQuestion') {
                      // Pause the turn: emit the question to the client, wait
                      // for the user's selection (or indefinitely / until the
                      // configured timeout), then return it as the tool result.
                      const questions = normalizeQuestions(parsed);
                      if (questions.length === 0) {
                        resultText = 'Error: AskQuestion requires 1-4 questions, each with 2-4 options.';
                      } else {
                        const askId = createAskId();
                        enqueue({ type: 'ask_user', askId, questions });
                        const answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                        const timedOut = answered === null;
                        const finalAnswers = timedOut ? recommendedDefaults(questions) : answered!;
                        enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                        resultText = formatAnswerForModel(finalAnswers, timedOut);
                      }
                    } else if (tc.name === 'spawn_subagent') {
                      // Context firewall: a fresh read-only child investigates
                      // and returns only its distilled result. Default child
                      // model = subagentModel, else the parent's own model.
                      const task = String(parsed?.task || '');
                      if (!task.trim()) {
                        resultText = 'Error: spawn_subagent requires a non-empty "task".';
                      } else {
                        enqueue({ type: 'subagent_start', task });
                        // Route the child to the provider that owns the chosen
                        // model (subagentFamily/subagentModel), NOT the parent's
                        // endpoint. Empty → inherit the parent's family+model.
                        const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : aiName;
                        const childModel = subagentModel && subagentModel.trim() ? subagentModel.trim() : localModel;
                        const sub = await runSubagent({
                          family: childFamily, model: childModel, keys,
                          task, returnContract: parsed?.return_contract ? String(parsed.return_contract) : undefined,
                          folderName, fullAccess: agentFullSystemAccess,
                          webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                        });
                        cumOaiUsage.prompt_tokens += sub.usage.input;
                        cumOaiUsage.completion_tokens += sub.usage.output;
                        enqueue({ type: 'subagent_done', task, result: sub.text, via: sub.via });
                        resultText = sub.text || '(subagent returned nothing)';
                      }
                    } else {
                      resultText = `Error: unknown function ${tc.name}`;
                    }
                  } catch (e: any) {
                    resultText = `Error: ${e?.message || 'tool execution failed'}`;
                  }
                  msgs = [...msgs, {
                    role: 'tool',
                    tool_call_id: tc.id || `call_${toolIterations}_${tc.name}`,
                    // Moonshot's builtin $web_search requires the function name
                    // on the tool-result message to match the call. The `name`
                    // field is part of the original OpenAI function-calling
                    // spec and is tolerated/ignored by the other providers.
                    name: tc.name,
                    content: resultText,
                  }];
                  // Deliberately NOT emitting `attachmentEvent` — see the note on
                  // the Claude path: tool files are not pinned as persistent
                  // message attachments (no context-window re-entry every turn),
                  // matching the OAuth path. The tool result above already hands
                  // the model the content for this turn.
                  void attachmentEvent;
                  if (actLabel) enqueue({ type: 'tool_activity', tool: null });
                }

                // If any image was read, inject a follow-up user message
                // carrying the actual bytes for vision-capable local models
                // to look at. Uses the same customizable image-instruction
                // template the Gemini path uses.
                if (pendingImageInjects.length > 0) {
                  const hintTemplate = (toolImageInstruction || '').trim();
                  const parts: any[] = [];
                  for (const img of pendingImageInjects) {
                    if (hintTemplate) {
                      parts.push({
                        type: 'text',
                        text: hintTemplate.replace(/\{filename\}/g, img.name),
                      });
                    }
                    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
                  }
                  msgs = [...msgs, { role: 'user', content: parts }];
                }

                // Mid-turn partner interjection: append as a user message after
                // the tool results, so the model sees it on its next iteration.
                const injectedOai = drainInjections(injectTurnId);
                if (injectedOai.length) {
                  msgs = [...msgs, { role: 'user', content: frameInjection(injectedOai, I.injectionFraming) }];
                  enqueue({ type: 'injection_delivered', count: injectedOai.length });
                }

                continue; // loop — next iteration sees tool results
              }

              // 2) No tool calls — accumulate text and maybe continuation.
              cumulativeAssistantText += visibleText;
              cumulativeReasoningText += reasoningText;
              const truncated = finishReason === 'length';
              if (!truncated || attempt >= MAX_CONTINUATIONS) break;

              // Build the continuation prefill. Normally we feed back the
              // model's own visible text so it resumes exactly where it stopped.
              // But when the model ran out of tokens WHILE STILL THINKING (long
              // reasoning, no visible answer yet — common on local thinking
              // models like Qwen3 / Gemma GGUF), the visible text is empty.
              // Feeding back an empty assistant turn makes the next call produce
              // nothing — the "↵ continued ×N" badge with no actual output the
              // user reported. In that case, hand the model back its accumulated
              // reasoning wrapped in an (unclosed) <think> block so it can pick
              // up the thought and finish it.
              let prefillContent = cumulativeAssistantText;
              if (!prefillContent.trim()) {
                if (cumulativeReasoningText.trim()) {
                  prefillContent = `<think>\n${cumulativeReasoningText}`;
                } else {
                  // Nothing visible AND nothing thought — a continuation round
                  // would just yield another empty turn. Stop instead of
                  // emitting a misleading "continued" badge.
                  break;
                }
              }
              msgs = [...msgs, { role: 'assistant', content: prefillContent }];
              attempt++;
            }
            // Flush any held-back tag-detection tail
            if (tagState.textTail) {
              const ev = tagState.inThink
                ? { type: 'thought', content: tagState.textTail }
                : { type: 'text', content: tagState.textTail };
              controller.enqueue(`data: ${JSON.stringify(ev)}\n\n`);
            }
            if (attempt > 0) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'continued', count: attempt })}\n\n`);
            }
            // Emit normalized cache usage. `providerHint` was computed above
            // (just outside the ReadableStream) so the per-iteration cache
            // debug log and this final emission read from the same source.
            const usagePayload = normalizeCacheUsage(cumOaiUsage, providerHint);
            if (usagePayload) enqueue(usagePayload);
            // Surface web-search citations (if any) so the user can click
            // through and verify the model actually read those pages. An empty
            // set after a search-enabled turn flags possible hallucination.
            if (cumWebSourceMap.size > 0) {
              enqueue({ type: 'web_sources', sources: [...cumWebSourceMap.values()] });
            }
            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
          } catch (e: any) {
            controller.enqueue(`data: ${JSON.stringify({ error: e.message })}\n\n`);
            controller.close();
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }
    else {
      // Fallback
      return NextResponse.json({ text: `I am ${aiName}. This is a simulated response since no API key or specific integration was found for this model name.` });
    }

  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: error.message || 'Unknown error occurred.' }, { status: 500 });
  }
}
