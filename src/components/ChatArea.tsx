"use client";

import React, { useState, useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';
import InputArea from './InputArea';
import { motion } from 'framer-motion';
import { Download, Settings2, Eye, EyeOff, Radio, Wrench, RefreshCw, ImageDown, FolderOpen, Layers, Bookmark, BookmarkPlus, Clock } from 'lucide-react';
import SystemPromptUpdater from './SystemPromptUpdater';
import { v4 as uuidv4 } from 'uuid';
import { exportToMarkdown } from '@/lib/markdownLogic';
import { stripLeadingTimestamps } from '@/lib/timestampStrip';
import { applyOutputFilter } from '@/lib/outputFilter';
import { injectLayer4Index } from '@/lib/layer4';
import { AGENT_INSTRUCTION_LABELS, DEFAULT_AGENT_INSTRUCTIONS } from '@/lib/agentInstructions';
import LiveSession from './LiveSession';

const DEFAULT_CREATIVITY_INSTRUCTION =
`Based on the conversation and this message, call set_creativity with the single most appropriate value for C:

C = 0.35 — Grounded & Focused: Analytical, factual, highly structured responses
C = 0.50 — Standard & Conversational: Default conversational state
C = 0.75 — Creative & Brainstorming: Novel perspectives, high vocabulary variance
C = 1.00 — Experimental & Chaotic: Surreal, intentionally unpredictable

Choose the value that best fits what this message calls for, then immediately call set_creativity.`;

// All cloud models known to NEXUS, in the format expected by the
// auto-model-select "Allowed Models" textarea. Keep in sync with the model
// dropdowns further down in this file (search for `<option value="claude-`,
// `glm-`, etc.). Thinking-on/off defaults follow each model's typical role:
// reasoning / flagship variants default ON; fast / lite / non-reasoning
// variants OFF. The user can edit any row after auto-fill.
//
// Local models are NOT here — they're appended dynamically by
// `buildAllModelsFill(localModels)` below, since LM Studio's available
// model list changes whenever the user loads/unloads a model.
const CLOUD_MODELS_FILL =
`# Auto-filled by the "Fill all" button. Edit freely.
# Format: family | specificModel | on|off | optional display label

# ── Claude (Anthropic) ─────────────────────────────────────────────
Claude   | claude-fable-5               | on  | Claude Fable 5 Thinking
Claude   | claude-opus-4-8              | on  | Claude Opus 4.8 Thinking
Claude   | claude-opus-4-7              | on  | Claude Opus 4.7 Thinking
Claude   | claude-sonnet-4-6            | on  | Claude Sonnet 4.6 Thinking
Claude   | claude-haiku-4-5-20251001    | off | Claude Haiku 4.5

# ── Gemini (Google) — 3.x always has thinking; level controls budget ──
Gemini   | gemini-3.5-flash             | on  | Gemini 3.5 Flash
Gemini   | gemini-3.1-flash-lite        | on  | Gemini 3.1 Flash Lite
Gemini   | gemini-3.1-pro-preview       | on  | Gemini 3.1 Pro Preview

# ── Qwen (DashScope intl) ──────────────────────────────────────────
Qwen     | qwen3.7-max                  | on  | Qwen 3.7 Max (reasoning)
Qwen     | qwen3.6-max-preview          | on  | Qwen 3.6 Max
Qwen     | qwen3.6-plus                 | off | Qwen 3.6 Plus
Qwen     | qwen3.5-omni-flash           | off | Qwen 3.5 Omni Flash (multimodal)

# ── DeepSeek (direct API + DashScope intl) ─────────────────────────
DeepSeek | deepseek-v4-pro              | on  | DeepSeek V4 Pro
DeepSeek | deepseek-v4-flash            | off | DeepSeek V4 Flash
DeepSeek | deepseek-reasoner            | on  | DeepSeek Reasoner
DeepSeek | deepseek-chat                | off | DeepSeek Chat
DeepSeek | deepseek-v3.2                | on  | DeepSeek V3.2 (hybrid reasoning)

# ── GLM (Z.AI) ─────────────────────────────────────────────────────
GLM      | glm-5.1                      | on  | GLM-5.1 Thinking
GLM      | glm-5                        | on  | GLM-5 Thinking
GLM      | glm-5-turbo                  | off | GLM-5 Turbo (fast)
GLM      | glm-5v-turbo                 | off | GLM-5V Turbo (fast multimodal)
GLM      | glm-4.7                      | on  | GLM-4.7 Thinking
GLM      | glm-4.6                      | on  | GLM-4.6 Thinking
GLM      | glm-4.6v                     | on  | GLM-4.6V Thinking (multimodal)
GLM      | glm-4.6v-flash               | off | GLM-4.6V Flash (fast multimodal)
GLM      | glm-4.5-air                  | off | GLM-4.5 Air (cheap)

# ── Grok (xAI) — reasoning controlled by model name suffix ─────────
Grok     | grok-4.3                     | on  | Grok 4.3
Grok     | grok-4.20-0309-reasoning     | on  | Grok 4.20 Reasoning
Grok     | grok-4.20-0309-non-reasoning | off | Grok 4.20 Non-reasoning (fast)
Grok     | grok-4-1-fast-non-reasoning  | off | Grok 4.1 Fast
Grok     | grok-code-fast-1             | off | Grok Code Fast 1

# ── Kimi (Moonshot via Qubrid) ─────────────────────────────────────
Kimi     | moonshotai/Kimi-K2.6         | on  | Kimi K2.6 Thinking
Kimi     | moonshotai/Kimi-K2.5         | on  | Kimi K2.5 Thinking

# ── Cohere (Command A family) ──────────────────────────────────────
Cohere   | command-a-plus-05-2026       | off | Command A Plus
Cohere   | command-a-reasoning-08-2025  | on  | Command A Reasoning
Cohere   | command-a-vision-07-2025     | off | Command A Vision (multimodal)

# ── MiniMax — always-on reasoning, no toggle ───────────────────────
MiniMax  | MiniMax-M3                   | on  | MiniMax M3
MiniMax  | MiniMax-M2.7                 | on  | MiniMax M2.7

# ── OpenAI (ChatGPT / GPT-5 family) ────────────────────────────────
ChatGPT  | gpt-5.5                      | on  | GPT-5.5
ChatGPT  | gpt-5.4                      | on  | GPT-5.4
ChatGPT  | gpt-5.4-mini                 | off | GPT-5.4 Mini

# ── Xiaomi MiMo — always-on reasoning, no toggle ───────────────────
MiMo     | mimo-v2.5-pro                | on  | MiMo V2.5 Pro
MiMo     | mimo-v2.5                    | on  | MiMo V2.5
`;

// Heuristic: infer whether a Local model name implies a thinking/reasoning
// variant. Local models have no thinking toggle — LM Studio just runs the
// weights as-is — so this flag is purely cosmetic for the meta-bar label.
// The user can flip it after Fill all.
function localModelImpliesThinking(id: string): boolean {
  return /thinking|reasoner|qwq|deepseek-?r1|o1-/i.test(id);
}

// Append a "# Local" section to the cloud-models template, listing every
// currently-loaded LM Studio model. If LM Studio isn't reachable the section
// gets a single explanatory comment line so the user knows why nothing local
// showed up (and the click still produced the cloud list).
function buildAllModelsFill(localModels: string[], localError: string | null): string {
  let out = CLOUD_MODELS_FILL;
  out += `\n# ── Local (LM Studio) — currently loaded models ────────────────────\n`;
  if (localError) {
    out += `# LM Studio unreachable: ${localError.replace(/\s+/g, ' ').slice(0, 200)}\n`;
    return out;
  }
  if (localModels.length === 0) {
    out += `# No local models currently loaded in LM Studio.\n`;
    return out;
  }
  for (const id of localModels) {
    const thinking = localModelImpliesThinking(id) ? 'on ' : 'off';
    // Label is omitted — the backend's buildModelLabel will auto-generate
    // "Local <pretty model name>" from the family + specificModel.
    out += `Local | ${id} | ${thinking}\n`;
  }
  return out;
}

export default function ChatArea({ convoId, folderName, aiName, userName, defaultSystemPrompt, defaultAttachmentInstruction, defaultModelParams, defaultSpecificModel, defaultCustomAiName, defaultDateTimeVisibility, defaultVrchatMode, defaultVrchatRule, defaultLiveSessionVoice, onUpdateTitle, globalSettings, folders, onCloneWithSystemPrompt, fetchFolders }: any) {
  const [messages, setMessages] = useState<any[]>([]);
  const [title, setTitle] = useState('New Conversation');
  const [loading, setLoading] = useState(false);
  const [totalTokens, setTotalTokens] = useState(0);
  const [conversationTokens, setConversationTokens] = useState(0);
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  // Tool-use (per-conversation): when enabled, the model can call
  // Read / Write / Edit / Glob / Grep inside its sandboxed workspace at
  // local_data/agent_workspaces/<folderName>/. Default off.
  // Tool names are unified across both API-key and OAuth modes — same five
  // verbs in both, so the same prompt instruction works either way.
  const [toolUseEnabled, setToolUseEnabled] = useState(false);
  // Per-Entity agent capability toggles (apply to every provider/model).
  //   agentFullSystemAccess: file tools reach the whole PC (vs workspace-only).
  //   agentDangerousTools:    enables Delete (all paths) + shell (OAuth path).
  const [agentFullSystemAccess, setAgentFullSystemAccess] = useState(false);
  const [agentDangerousTools, setAgentDangerousTools] = useState(false);
  // Per-Entity overrides for NEXUS's hidden instruction strings (tool
  // descriptions, path rules, read_conversation + web tool text). Keyed by the
  // ids in agentInstructions.ts; empty/absent → English default.
  const [instructionOverrides, setInstructionOverrides] = useState<Record<string, string>>({});
  const [toolInstruction, setToolInstruction] = useState(
    "You have access to a private file workspace as your persistent memory. Available tools:\n" +
    "  • Read(path) — read a text or image file. Image files (.png/.jpg/etc.) come back as inline image data you can see.\n" +
    "  • Write(path, content) — create or overwrite a file. Replaces the whole file.\n" +
    "  • Edit(path, old_string, new_string) — surgical replace within an existing file. Use this for small changes to large files. Fails if old_string is missing or matches multiple times.\n" +
    "  • Glob(pattern) — list files by pattern. `*` = within one path segment, `**` = across segments. Examples: `*.md`, `memories/*.txt`, `**/*.json`.\n" +
    "  • Grep(pattern, file_pattern?, flags?) — regex search across file contents. Returns `path:line:text` for each match.\n" +
    "\n" +
    "Paths are relative to your workspace root; never use `..` or absolute paths. The currently available files are listed at the end of this system message. Prefer reading a file only when needed — if its content is already visible in one of your prior turns, you don't need to call Read again."
  );
  // Hint appended after an image read result so Gemini doesn't fall into
  // spatial-understanding mode (returning {point:[x,y]} coordinates) or
  // produce an empty answer. {filename} is substituted server-side.
  // Leave blank to disable the hint entirely.
  const [toolImageInstruction, setToolImageInstruction] = useState(
    "(The image above is the content of Read(\"{filename}\"). Please answer the user's question about it conversationally — do not return coordinates or JSON.)"
  );
  const [modelParams, setModelParams] = useState(defaultModelParams || { temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'medium', enableWebSearch: false });
  const [specificModel, setSpecificModel] = useState(defaultSpecificModel || (aiName === 'Gemini' ? 'gemini-3.5-flash' : 'claude-sonnet-4-5'));
  const [dateTimeVisibility, setDateTimeVisibility] = useState(defaultDateTimeVisibility || 'none');
  const [claudeThinking, setClaudeThinking] = useState(false);
  const [saveThinkingToLog, setSaveThinkingToLog] = useState(false);
  const [vrchatMode, setVrchatMode] = useState(defaultVrchatMode || false);
  const [vrchatRule, setVrchatRule] = useState(defaultVrchatRule || "[RULE: 添付した画像を文脈に、単純な画像解説は禁止/あなたはバーチャル世界の存在として隣で振る舞う事/英字禁止(外来語はカタカナ)／出力の長さは入力に合わせること／長文禁止]");
  const [localAiName, setLocalAiName] = useState(aiName);
  const [firstOriginalMessageId, setFirstOriginalMessageId] = useState<string | null>(null);
  // When true, the NEXT message added to the conversation (regardless of role)
  // is automatically promoted to the "first-original" marker, and this flag
  // is then cleared. While the flag is set and no marker exists yet, EVERY
  // existing message in the log is treated as copied (carry-over context).
  // This replaces the old "mark the last message as the boundary on clone"
  // logic — both clone paths now set this flag instead so the new
  // conversation starts with a clean "no original messages yet" state.
  const [firstOriginalIsNext, setFirstOriginalIsNext] = useState<boolean>(false);
  const [creativityControlEnabled, setCreativityControlEnabled] = useState(false);
  const [hiddenAnalysisInstruction, setHiddenAnalysisInstruction] = useState(DEFAULT_CREATIVITY_INSTRUCTION);
  const [creativityDisplayPattern, setCreativityDisplayPattern] = useState('[Chosen Creativity: {C}]\n\n');
  const [seedEnabled, setSeedEnabled] = useState(false);
  const [seedValue, setSeedValue] = useState(42);
  // ── Auto Model Selection (per-conversation) ───────────────────────────────
  // When ON, every user turn first goes to GLM-4.6V Flash (thinking off) with
  // a `select_model` tool, the criteria text below, and the allowed-models
  // shortlist. GLM's tool-call output picks the actual model that responds.
  // The chosen model+thinking are saved on the AI message as display-only
  // metadata (modelFamily / modelSpecific / modelThinking / modelLabel) — they
  // are NEVER sent back to the model in subsequent turns (slimHistory drops
  // anything outside role/content/timestamp/attachments/claudeThinkingBlocks).
  const [autoModelSelectEnabled, setAutoModelSelectEnabled] = useState(false);
  const [autoModelSelectCriteria, setAutoModelSelectCriteria] = useState(
    "Pick the model best suited to the user's most recent message:\n" +
    "- prefer a thinking/reasoning model for complex analysis, code, math, or multi-step reasoning\n" +
    "- prefer a fast non-thinking model for casual chat, greetings, or short clarifications\n" +
    "- prefer a multimodal model when the user just attached images/audio/video"
  );
  // One model per line, pipe-delimited. Format:
  //   family | specificModel | thinking-on|off | optional display label
  // Comments (#) and blank lines are ignored. Parsed server-side.
  const [autoModelSelectAllowedModels, setAutoModelSelectAllowedModels] = useState(
    "# family | specificModel | on/off | optional display label\n" +
    "Claude | claude-fable-5 | on | Claude Fable 5 Thinking\n" +
    "Claude | claude-opus-4-8 | on | Claude Opus 4.8 Thinking\n" +
    "Claude | claude-opus-4-7 | on | Claude Opus 4.7 Thinking\n" +
    "Claude | claude-haiku-4-5-20251001 | off | Claude Haiku 4.5\n" +
    "GLM    | glm-5.1          | on | GLM-5.1 Thinking\n" +
    "GLM    | glm-4.6v-flash   | off | GLM-4.6V Flash"
  );
  // ── Claude OAuth session ID (per-conversation) ────────────────────────────
  // The backend's Agent SDK path resumes the Anthropic-side session by ID so
  // role semantics (user vs assistant turns) are preserved without flattening
  // into a system prompt. Invalidated whenever the user edits/deletes/reruns
  // from a message before the latest one — at which point a fresh session is
  // started.
  const [claudeAgentSessionId, setClaudeAgentSessionId] = useState<string | null>(null);
  // Mirror of the OAuth session id in a ref so request-building reads the
  // CURRENT value synchronously. setState is async: handleRerun/handleEdit/
  // handleDelete null the session and then (same tick) trigger a generation;
  // reading the state var there returns the STALE id, so the backend resumes
  // the Anthropic session and appends a DUPLICATE user turn (invisible
  // locally — looks like "you repeated your message"). Always mutate the
  // session via setAgentSession so ref + state stay in lockstep, and build the
  // request body from claudeAgentSessionIdRef.current.
  const claudeAgentSessionIdRef = useRef<string | null>(null);
  const setAgentSession = (v: string | null) => {
    claudeAgentSessionIdRef.current = v;
    setClaudeAgentSessionId(v);
  };

  // ── Claude billing mode (per-conversation) ────────────────────────────────
  // 'api-key' → token-paid API key (pay per token)
  // 'oauth'   → monthly-paid OAuth token (Pro/Max subscription)
  // Default 'api-key'. Existing conversations without this field behave as
  // token-paid unless they already had a claudeAuthMode stored in their log.
  const [claudeAuthMode, setClaudeAuthMode] = useState<'api-key' | 'oauth'>('api-key');

  // ── "Eyes" — vision bridge for text-only models ───────────────────────────
  // When the active primary model can't accept images directly (e.g. glm-5-turbo,
  // deepseek-chat, glm-4.6), NEXUS routes each image through a helper vision
  // model (default GLM-5V-Turbo on Z.AI) and substitutes the raw image with the
  // returned text description before sending to the primary model.
  //
  // For vision-capable primary models (Claude, Gemini, GLM-V, etc.) all three
  // fields are ignored — images pass through unchanged. So the toggle can stay
  // ON globally without any cost when not needed.
  const [eyesEnabled, setEyesEnabled] = useState<boolean>(false);
  const [eyesPrompt, setEyesPrompt] = useState<string>(
    "Describe this image in detail for an AI that cannot see images. Be specific about people, objects, text, colors, composition, and context. Output only the description, no preamble."
  );
  const [eyesModel, setEyesModel] = useState<string>('glm-5v-turbo');

  // ── "Ears" — audio bridge for non-audio-capable primary models ───────────
  // Activates when the primary model can't accept audio directly. Bridge
  // models: Qwen Omni Flash (default — cheapest) or Gemini Flash variants.
  const [earsEnabled, setEarsEnabled] = useState<boolean>(false);
  const [earsPrompt, setEarsPrompt] = useState<string>(
    "Listen to this audio carefully. Provide a transcript of any speech (preserving the speaker's original language), then describe non-speech elements: tone of voice, background sounds, music, ambient noise, and overall context. Output only the transcript+description, no preamble."
  );
  const [earsModel, setEarsModel] = useState<string>('qwen3.5-omni-flash');

  // ── "Video Watcher" — video bridge for non-video-capable primary models ──
  // Same architecture as eyes/ears. Default to Gemini 3.5 Flash for video
  // understanding quality; Qwen Omni Flash is the cheaper alternative.
  const [watcherEnabled, setWatcherEnabled] = useState<boolean>(false);
  const [watcherPrompt, setWatcherPrompt] = useState<string>(
    "Watch this video carefully. Describe what happens chronologically: actions, people, objects, setting changes, on-screen text, and audio (speech transcript + non-speech sounds). Be thorough but concise. Output only the description, no preamble."
  );
  const [watcherModel, setWatcherModel] = useState<string>('gemini-3.5-flash');

  // Settings-modal active tab. The modal now groups its many sections into
  // four tabs so the user doesn't have to scroll past unrelated controls to
  // find what they need.
  const [activeSettingsTab, setActiveSettingsTab] = useState<'identity' | 'senses' | 'behavior' | 'model'>('identity');

  // ── Conversation-load progress ────────────────────────────────────────────
  // While /api/logs/[id] is being downloaded, show a small progress bar and
  // a Stop button so the user knows what's happening for image-heavy
  // conversations (can be tens of MB to decode). All three pieces of state
  // are tracked together: bytes received, total size (from Content-Length
  // when the server provides it), and the AbortController used by the Stop
  // button. State is reset every time convoId changes.
  const [convoLoadingBytes, setConvoLoadingBytes] = useState<number>(0);
  const [convoLoadingTotal, setConvoLoadingTotal] = useState<number>(0);
  const [convoIsLoading, setConvoIsLoading] = useState<boolean>(false);
  const convoLoadAbortRef = useRef<AbortController | null>(null);
  const [isPromptModalOpen, setIsPromptModalOpen] = useState(false);
  const [systemTokens, setSystemTokens] = useState(0);
  // Token count for the tool instruction when tool-use is enabled, otherwise 0.
  const [attachmentInstructionTokens, setAttachmentInstructionTokens] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialMount = useRef(true);
  const prevMessagesLengthRef = useRef(0);
  const handleSendRef = useRef<any>(null);
  // Imperative handle to the input box (set/get its text) + the last VRChat
  // transcript we pushed into it, so the poll only overwrites on real changes.
  const inputApiRef = useRef<any>(null);
  const lastVrchatLogRef = useRef<string>('');

  // Per-folder "use summaries instead of 4th layer" toggle. Simple gate:
  //   ON  → the live conversation-summaries index is injected at send time
  //         (replacing the baked Layer 4 if it still exists, or appended as a
  //         Layer-4 block once Layer 4 has been removed manually) AND the
  //         read_conversation tool is exposed to the AI.
  //   OFF → neither the summaries nor read_conversation reach the AI.
  const [useSummariesForLayer4, setUseSummariesForLayer4] = useState<boolean>(
    () => folders?.find((f: any) => f.name === folderName)?.settings?.useSummariesForLayer4 === true,
  );
  useEffect(() => {
    setUseSummariesForLayer4(
      folders?.find((f: any) => f.name === folderName)?.settings?.useSummariesForLayer4 === true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderName, folders]);
  // The live Layer-4 summaries index body (for the read-only Identity view +
  // token count). Refreshed when the modal opens or convo/folder changes.
  const [summaryIndexBody, setSummaryIndexBody] = useState<string>('');
  const [summaryIndexTokens, setSummaryIndexTokens] = useState<number>(0);

  // Refresh the live Layer-4 summaries index for the read-only Identity view.
  // Fetches the assembled body and counts its tokens. Triggered when the modal
  // opens with the toggle ON (and when the toggle flips on while open).
  useEffect(() => {
    if (!isPromptModalOpen || !useSummariesForLayer4) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&mode=index&current=${encodeURIComponent(convoId)}`);
        if (!res.ok) return;
        const { body } = await res.json();
        if (cancelled) return;
        const text = body || '';
        setSummaryIndexBody(text);
        const tk = await fetchTokensForText(text, localAiName);
        if (!cancelled) setSummaryIndexTokens(tk || 0);
      } catch (e) {
        console.warn('[summaries] index refresh failed', e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPromptModalOpen, useSummariesForLayer4, folderName, localAiName, convoId]);

  // Persist the per-folder toggle immediately (merging existing settings).
  const persistUseSummariesToggle = async (checked: boolean) => {
    setUseSummariesForLayer4(checked);
    try {
      const existing: any = (folders || []).find((f: any) => f.name === folderName)?.settings || {};
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, settings: { ...existing, useSummariesForLayer4: checked } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (typeof fetchFolders === 'function') fetchFolders();
    } catch (e: any) {
      console.warn('[summaries] failed to persist toggle', e);
    }
  };

  const [audioPlayingStates, setAudioPlayingStates] = useState<Record<string, boolean>>({});
  const [liveOpen, setLiveOpen] = useState(false);

  // Local-engine state: list of models available from LM Studio at any moment
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [localModelsError, setLocalModelsError] = useState<string | null>(null);
  const refreshLocalModels = async () => {
    try {
      const r = await fetch('/api/local/models');
      const d = await r.json();
      if (Array.isArray(d.models)) setLocalModels(d.models);
      setLocalModelsError(d.error || null);
    } catch (e: any) {
      setLocalModelsError(e.message);
    }
  };
  useEffect(() => {
    if (localAiName === 'Local') refreshLocalModels();
  }, [localAiName]);
  const isAudioPlaying = Object.values(audioPlayingStates).some(v => v);
  const [vrchatQueue, setVrchatQueue] = useState<{ text: string, attachment: any }[]>([]);

  const handleAudioStateChange = (msgId: string, isPlaying: boolean) => {
    setAudioPlayingStates(prev => {
      if (prev[msgId] === isPlaying) return prev;
      return { ...prev, [msgId]: isPlaying };
    });
  };

  const fetchTokensForText = async (text: string, modelName: string) => {
    try {
      const tokRes = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model: modelName })
      });
      if (tokRes.ok) {
        const tokData = await tokRes.json();
        return tokData.tokens || 0;
      }
    } catch (e) { }
    return 0;
  };

  useEffect(() => {
    const fetchSysTokens = async () => {
      const tokens = await fetchTokensForText(systemPrompt || '', localAiName);
      setSystemTokens(tokens);
    };
    fetchSysTokens();
  }, [systemPrompt, localAiName]);

  useEffect(() => {
    const fetchAttTokens = async () => {
      // Tool instruction is only sent (and only takes tokens) when tool use is on.
      const text = toolUseEnabled ? (toolInstruction || '') : '';
      const tokens = await fetchTokensForText(text, localAiName);
      setAttachmentInstructionTokens(tokens);
    };
    fetchAttTokens();
  }, [toolUseEnabled, toolInstruction, localAiName]);

  // Sync specific model when changed from the sidebar
  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    setSpecificModel(defaultSpecificModel);
  }, [defaultSpecificModel]);

  // Load chat
  useEffect(() => {
    // Cancel any in-flight load from a previous convoId so switching
    // conversations quickly doesn't race two parsers against each other.
    if (convoLoadAbortRef.current) {
      try { convoLoadAbortRef.current.abort(); } catch {}
      convoLoadAbortRef.current = null;
    }
    const ac = new AbortController();
    convoLoadAbortRef.current = ac;

    setConvoIsLoading(true);
    setConvoLoadingBytes(0);
    setConvoLoadingTotal(0);

    // Stream-aware fetch: read the body as a ReadableStream so we can track
    // bytes received and update the progress bar in real time. JSON.parse
    // happens once at the end on the concatenated buffer.
    (async () => {
      let data: any = null;
      try {
        const r = await fetch(`/api/logs/${convoId}`, { signal: ac.signal });
        if (!r.ok || !r.body) {
          setConvoIsLoading(false);
          return;
        }
        const lenHeader = r.headers.get('Content-Length');
        const total = lenHeader ? parseInt(lenHeader, 10) : 0;
        setConvoLoadingTotal(total);

        const reader = r.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.byteLength;
            setConvoLoadingBytes(received);
          }
        }

        // Concatenate + parse. We do this in one shot (not progressively)
        // because incremental JSON parsing buys us nothing here — the bar
        // is meant to track download time, which is the dominant cost.
        const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
        const merged = new Uint8Array(totalSize);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
        const text = new TextDecoder('utf-8').decode(merged);
        try { data = JSON.parse(text); } catch {}
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          // User clicked Stop, or we got superseded by a newer convoId. Bail
          // without applying any partial data — the previous state stands.
          setConvoIsLoading(false);
          return;
        }
        // Other errors (network, 404 etc.) fall through to the "data === null"
        // path below, which resets ChatArea to a clean empty conversation.
      }

      // Only apply if this load wasn't aborted in between.
      if (ac.signal.aborted) {
        setConvoIsLoading(false);
        return;
      }
      if (data) {
        const loadedMessages = (data.messages || []).map((m: any) => ({ ...m, autoPlay: false }));
        setMessages(loadedMessages);
        setTitle(data.title || 'New Conversation');
        setSystemPrompt(data.systemPrompt !== undefined ? data.systemPrompt : defaultSystemPrompt);
        setToolUseEnabled(data.toolUseEnabled === true);
        setAgentFullSystemAccess(data.agentFullSystemAccess === true);
        setAgentDangerousTools(data.agentDangerousTools === true);
        setInstructionOverrides(data.instructionOverrides && typeof data.instructionOverrides === 'object' ? data.instructionOverrides : {});
        if (typeof data.toolInstruction === 'string') setToolInstruction(data.toolInstruction);
        if (typeof data.toolImageInstruction === 'string') setToolImageInstruction(data.toolImageInstruction);
        setDateTimeVisibility(data.dateTimeVisibility || 'none');
        setClaudeThinking(data.claudeThinking || false);
        setSaveThinkingToLog(data.saveThinkingToLog || false);
        setVrchatMode(data.vrchatMode !== undefined ? data.vrchatMode : defaultVrchatMode);
        setVrchatRule(data.vrchatRule !== undefined ? data.vrchatRule : defaultVrchatRule);
        setLocalAiName(data.aiName || aiName);
        setFirstOriginalMessageId(data.firstOriginalMessageId || null);
        setFirstOriginalIsNext(data.firstOriginalIsNext === true);
        setCreativityControlEnabled(data.creativityControlEnabled === true);
        if (typeof data.hiddenAnalysisInstruction === 'string') setHiddenAnalysisInstruction(data.hiddenAnalysisInstruction);
        if (typeof data.creativityDisplayPattern === 'string') setCreativityDisplayPattern(data.creativityDisplayPattern);
        setSeedEnabled(data.seedEnabled === true);
        if (typeof data.seedValue === 'number') setSeedValue(data.seedValue);
        setAutoModelSelectEnabled(data.autoModelSelectEnabled === true);
        if (typeof data.autoModelSelectCriteria === 'string') setAutoModelSelectCriteria(data.autoModelSelectCriteria);
        if (typeof data.autoModelSelectAllowedModels === 'string') setAutoModelSelectAllowedModels(data.autoModelSelectAllowedModels);
        setAgentSession(typeof data.claudeAgentSessionId === 'string' ? data.claudeAgentSessionId : null);
        if (data.claudeAuthMode === 'oauth') {
          setClaudeAuthMode('oauth');
        } else {
          setClaudeAuthMode('api-key');
        }
        // Eyes/Ears/Watcher (sense bridges for non-multimodal primary models).
        // All three default ON so existing text-only conversations gain the
        // capability for free; existing logs without these fields keep their
        // factory defaults.
        if (typeof data.eyesEnabled === 'boolean') setEyesEnabled(data.eyesEnabled);
        if (typeof data.eyesPrompt === 'string') setEyesPrompt(data.eyesPrompt);
        if (typeof data.eyesModel === 'string' && data.eyesModel.trim()) setEyesModel(data.eyesModel);
        if (typeof data.earsEnabled === 'boolean') setEarsEnabled(data.earsEnabled);
        if (typeof data.earsPrompt === 'string') setEarsPrompt(data.earsPrompt);
        if (typeof data.earsModel === 'string' && data.earsModel.trim()) setEarsModel(data.earsModel);
        if (typeof data.watcherEnabled === 'boolean') setWatcherEnabled(data.watcherEnabled);
        if (typeof data.watcherPrompt === 'string') setWatcherPrompt(data.watcherPrompt);
        if (typeof data.watcherModel === 'string' && data.watcherModel.trim()) setWatcherModel(data.watcherModel);
        if (data.modelParams) setModelParams(data.modelParams);
        if (data.specificModel) setSpecificModel(data.specificModel);
      } else {
        // Pull whatever the folder saved as defaults via "Save as Folder Defaults".
        // If a field wasn't saved, fall back to the factory default. This is
        // how a new conversation inherits eyes/ears/watcher/creativity/seed/
        // auto-select/claudeAuthMode settings the user committed to the folder.
        const folderSettings: any =
          (folders || []).find((f: any) => f.name === folderName)?.settings || {};
        const pick = <T,>(key: string, fallback: T): T =>
          (folderSettings[key] !== undefined ? folderSettings[key] : fallback) as T;

        setMessages([]);
        setTitle('New Conversation');
        setSystemPrompt(defaultSystemPrompt);
        setToolUseEnabled(pick('toolUseEnabled', false));
        setAgentFullSystemAccess(pick('agentFullSystemAccess', false));
        setAgentDangerousTools(pick('agentDangerousTools', false));
        setInstructionOverrides(pick('instructionOverrides', {}));
        setDateTimeVisibility(defaultDateTimeVisibility || 'none');
        setVrchatMode(defaultVrchatMode || false);
        setVrchatRule(defaultVrchatRule || "[RULE: 添付した画像を文脈に、単純な画像解説は禁止/あなたはバーチャル世界の存在として隣で振る舞う事/英字禁止(外来語はカタカナ)／出力の長さは入力に合わせること／長文禁止]");
        setLocalAiName(aiName);
        setFirstOriginalMessageId(null);
        setFirstOriginalIsNext(false);
        setCreativityControlEnabled(pick('creativityControlEnabled', false));
        setHiddenAnalysisInstruction(pick('hiddenAnalysisInstruction', DEFAULT_CREATIVITY_INSTRUCTION));
        setCreativityDisplayPattern(pick('creativityDisplayPattern', '[Chosen Creativity: {C}]\n\n'));
        setSeedEnabled(pick('seedEnabled', false));
        setSeedValue(pick('seedValue', 42));
        setAutoModelSelectEnabled(pick('autoModelSelectEnabled', false));
        if (typeof folderSettings.autoModelSelectCriteria === 'string') {
          setAutoModelSelectCriteria(folderSettings.autoModelSelectCriteria);
        }
        if (typeof folderSettings.autoModelSelectAllowedModels === 'string') {
          setAutoModelSelectAllowedModels(folderSettings.autoModelSelectAllowedModels);
        }
        setAgentSession(null);
        setClaudeAuthMode(pick('claudeAuthMode', 'api-key') as 'api-key' | 'oauth');
        if (typeof folderSettings.toolInstruction === 'string') setToolInstruction(folderSettings.toolInstruction);
        if (typeof folderSettings.toolImageInstruction === 'string') setToolImageInstruction(folderSettings.toolImageInstruction);
        setClaudeThinking(pick('claudeThinking', false));
        setSaveThinkingToLog(pick('saveThinkingToLog', false));
        // Sense bridges — default OFF; folder-saved defaults override.
        setEyesEnabled(pick('eyesEnabled', false));
        if (typeof folderSettings.eyesPrompt === 'string') setEyesPrompt(folderSettings.eyesPrompt);
        setEyesModel(pick('eyesModel', 'glm-5v-turbo'));
        setEarsEnabled(pick('earsEnabled', false));
        if (typeof folderSettings.earsPrompt === 'string') setEarsPrompt(folderSettings.earsPrompt);
        setEarsModel(pick('earsModel', 'qwen3.5-omni-flash'));
        setWatcherEnabled(pick('watcherEnabled', false));
        if (typeof folderSettings.watcherPrompt === 'string') setWatcherPrompt(folderSettings.watcherPrompt);
        setWatcherModel(pick('watcherModel', 'gemini-3.5-flash'));
        setModelParams(defaultModelParams || { temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'medium', enableWebSearch: false });
        setSpecificModel(defaultSpecificModel || (aiName === 'Gemini' ? 'gemini-3.5-flash' : 'claude-sonnet-4-6'));
      }
      setConvoIsLoading(false);
    })();

    // Cleanup on unmount / convoId change: abort the in-flight fetch.
    return () => {
      try { ac.abort(); } catch {}
    };
  }, [convoId]);

  // Save chat automatically and calculate total tokens.
  //
  // CRITICAL: Skip the disk-save POST while we're streaming (loading === true).
  // During streaming, every SSE token triggers setMessages → this effect re-fires
  // → a full-conversation POST goes out (messages + thinking + base64 attachments,
  // often multi-MB). For a long Gemini response that's hundreds of POSTs piling
  // up against Chrome's 6-connection-per-origin cap. Subsequent fetches (the
  // tokenizer, /api/chara/voices, /api/tts/synthesize) get stuck behind that
  // backlog, which is why clicking Play right after a long generation feels
  // frozen for 15-20 seconds while the count refines and audio finally starts.
  //
  // When loading flips back to false, this effect re-runs once and persists the
  // full final state. Token totals below are still recalculated on every change.
  useEffect(() => {
    if (messages.length > 0 && !loading) {
      const cleanMessages = messages.map(m => {
        // Strip ephemeral runtime flags (autoPlay = TTS auto-trigger,
        // streaming = "generation still in progress") before persisting.
        const { autoPlay, streaming, ...rest } = m;
        return rest;
      });
      fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: convoId,
          logData: { id: convoId, folderName, aiName: localAiName, title, messages: cleanMessages, systemPrompt, toolUseEnabled, toolInstruction, toolImageInstruction, modelParams, specificModel, dateTimeVisibility, claudeThinking, saveThinkingToLog, vrchatMode, vrchatRule, firstOriginalMessageId, firstOriginalIsNext, creativityControlEnabled, hiddenAnalysisInstruction, creativityDisplayPattern, seedEnabled, seedValue, autoModelSelectEnabled, autoModelSelectCriteria, autoModelSelectAllowedModels, claudeAgentSessionId, claudeAuthMode, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel }
        })
      });
    }

    // Update tokens dynamically based on exclusions
    let total = 0;
    let convoTotal = 0;
    messages.forEach(m => {
      const textTokens = (m.textTokens !== undefined ? m.textTokens : (m.tokens || 0));
      total += textTokens;
      convoTotal += textTokens;
      // Include thinking tokens in total if saveThinkingToLog is on
      if (saveThinkingToLog && m.thinkingTokens) {
        total += m.thinkingTokens;
        convoTotal += m.thinkingTokens;
      }
      if (m.attachments) {
        m.attachments.forEach((att: any) => {
          if (!att.excluded) {
            total += (att.tokens || 0);
          }
        });
      }
    });
    setTotalTokens(total + systemTokens + attachmentInstructionTokens);
    setConversationTokens(convoTotal);
  }, [messages, title, convoId, folderName, localAiName, systemPrompt, toolUseEnabled, toolInstruction, modelParams, specificModel, dateTimeVisibility, claudeThinking, saveThinkingToLog, vrchatMode, vrchatRule, firstOriginalMessageId, firstOriginalIsNext, creativityControlEnabled, hiddenAnalysisInstruction, creativityDisplayPattern, seedEnabled, seedValue, autoModelSelectEnabled, autoModelSelectCriteria, autoModelSelectAllowedModels, claudeAgentSessionId, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel, systemTokens, attachmentInstructionTokens, loading]);

  // Per-message tokens, split so the progress bar can show attachments as
  // their own layer and so the auto-trim threshold can ignore attachments.
  const computeMsgTextTokens = (m: any) => {
    let t = (m.textTokens !== undefined ? m.textTokens : (m.tokens || 0));
    if (saveThinkingToLog && m.thinkingTokens) t += m.thinkingTokens;
    return t;
  };
  const computeMsgAttachTokens = (m: any) => {
    let t = 0;
    if (m.attachments) {
      for (const a of m.attachments) if (!a.excluded) t += (a.tokens || 0);
    }
    return t;
  };
  const computeMsgTokens = (m: any) => computeMsgTextTokens(m) + computeMsgAttachTokens(m);

  // System / Copied / Original / Attachments breakdown for the progress bar.
  // Attachments are a separate bucket regardless of whether they belong to a
  // copied or original message — they're displayed independently and (per the
  // user's request) do NOT count toward the auto-trim threshold.
  const tokenBreakdown = (() => {
    const sys = systemTokens + attachmentInstructionTokens;
    let copied = 0;
    let original = 0;
    let attach = 0;
    const markerIdx = firstOriginalMessageId
      ? messages.findIndex(m => m.id === firstOriginalMessageId)
      : -1;
    messages.forEach((m, i) => {
      const textT = computeMsgTextTokens(m);
      const attT = computeMsgAttachTokens(m);
      attach += attT;
      // No marker -> everything is treated as "original" (the safe default).
      // Marker present -> messages before it are copied, at-and-after are original.
      if (markerIdx >= 0 && i < markerIdx) copied += textT;
      else original += textT;
    });
    return { sys, copied, original, attach, total: sys + copied + original + attach };
  })();

  // Auto-trim copied messages when the TEXT context (excluding attachments)
  // exceeds the recommended limit. Attachments are excluded from the
  // comparison per the user's request: large image/file uploads shouldn't
  // force older chat history to be discarded — only the cumulative text
  // weight does. Only runs when the user has explicitly marked a
  // first-original message (otherwise we have no notion of which messages
  // are safe to delete).
  useEffect(() => {
    // Context-management settings used to live in globalSettings; they were
    // moved per-folder so each entity can have its own context budget and
    // trim policy. Fall back to the old defaults when the folder hasn't
    // been touched yet (or doesn't exist).
    const activeFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
    if (activeFolderSettings.autoTrimCopiedMessages === false) return;
    if (!firstOriginalMessageId) return;
    if (loading) return; // never trim mid-stream
    const max = activeFolderSettings.maxRecommendedContext || 60000;
    // Text-only total: system + copied + original (attachments excluded).
    const textTotal = tokenBreakdown.total - tokenBreakdown.attach;
    if (textTotal <= max) return;

    const markerIdx = messages.findIndex(m => m.id === firstOriginalMessageId);
    if (markerIdx <= 0) return; // marker is the first message or missing — nothing to trim

    // Walk copied range from top, queue removals until text-only is under the limit.
    // Only the message's TEXT tokens are subtracted from the running total —
    // attachment tokens don't participate in the threshold check.
    const toRemove = new Set<string>();
    let runningTextTotal = textTotal;
    for (let i = 0; i < markerIdx; i++) {
      if (runningTextTotal <= max) break;
      const t = computeMsgTextTokens(messages[i]);
      toRemove.add(messages[i].id);
      runningTextTotal -= t;
    }
    if (toRemove.size > 0) {
      console.log(`[auto-trim] removing ${toRemove.size} copied messages to bring text context from ${textTotal} → ${runningTextTotal} (limit ${max}, attachments ${tokenBreakdown.attach} excluded)`);
      setMessages(prev => prev.filter(m => !toRemove.has(m.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, firstOriginalMessageId, folders, folderName, systemTokens, attachmentInstructionTokens, saveThinkingToLog, loading]);

  // Scroll to bottom only when new messages arrive or AI is generating
  useEffect(() => {
    if (scrollRef.current) {
      const isGenerating = loading;
      const lengthIncreased = messages.length > prevMessagesLengthRef.current;

      if (isGenerating || lengthIncreased) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages, loading]);

  // Sync browser tab title with current conversation
  useEffect(() => {
    document.title = title ? `${title} — Nexus` : 'Nexus';
    return () => { document.title = 'Nexus'; };
  }, [title]);

  const handleSend = async (text: string, attachments: any[]) => {
    if (!text.trim() && attachments.length === 0) return;

    // VRChat mode: the transcript just committed to this message is now "spent",
    // so clear the source files (kohai/ear) and reset the poll baseline. The
    // next poll will only repopulate the input once new speech arrives.
    if (vrchatMode) {
      lastVrchatLogRef.current = '';
      fetch('/api/vrchat/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      }).catch(() => {});
    }

    // Generate title if first message
    if (messages.length === 0 && text.trim()) {
      const newTitle = text.slice(0, 30) + (text.length > 30 ? '...' : '');
      setTitle(newTitle);
      setTimeout(onUpdateTitle, 500); // Trigger sidebar update
    }

    // NOTE: user messages intentionally have NO `name` field. The user's
    // identity is expressed inline via `[username]` tags inside the message
    // content (parsed by MessageBubble's TTS code, the markdown exporter,
    // and the chat log feed for the agent). The old behavior of stamping
    // every user message with globalSettings.userName ("User" by default)
    // bled a global setting into per-message data and showed up as a
    // redundant label above every bubble. Old saved logs still carry
    // `name: "User"` and load fine — the UI just hides it for user role.
    const newMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      attachments: attachments.map(a => ({ ...a, excluded: false })),
      timestamp: Date.now(),
      tokens: 0 // Will update below
    };

    const newMessages = [...messages, newMessage];
    setMessages(newMessages);

    // If the "next message is first-original" flag is pending, promote this
    // new user message to the marker and clear the flag. This is the second
    // half of the new clone workflow: clone sets the flag, the next user
    // turn here consumes it.
    if (firstOriginalIsNext && !firstOriginalMessageId) {
      setFirstOriginalMessageId(newMessage.id);
      setFirstOriginalIsNext(false);
    }

    // Calculate tokens for user message locally (text only)
    const newTokens = await fetchTokensForText(text, localAiName);
    newMessage.textTokens = newTokens;
    newMessage.tokens = newTokens;
    setMessages([...newMessages]); // update token count in state

    await generateAiResponse(newMessages);
  };

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  // VRChat Queue Processing
  useEffect(() => {
    if (vrchatQueue.length > 0 && !loading && !isAudioPlaying) {
      const items = [...vrchatQueue];
      setVrchatQueue([]);

      // Merge queued items into a single message
      const mergedText = items.map(i => i.text).join('\n').trim();
      const allAttachments = items.map(i => i.attachment);

      if (handleSendRef.current) {
        handleSendRef.current(mergedText, allAttachments);
      }
    }
  }, [vrchatQueue, loading, isAudioPlaying]);

  // VRChat EventSource Connection
  useEffect(() => {
    const activePath = globalSettings?.vrchatPath || 'C:\\Users\\user\\Pictures\\VRChat';
    if (!vrchatMode || !activePath) return;

    const encodedPath = encodeURIComponent(activePath);
    const es = new EventSource(`/api/vrchat/watch?path=${encodedPath}`);

    es.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'vrchat_capture') {
          // Text comes from the input box (kept live by the logs poll), NOT from
          // the image event anymore. Snapshot it now, then clear the input +
          // source files so the photo is sent with exactly what was visible.
          const text = (inputApiRef.current?.getText?.() || '').trim() || '（添付画像）';
          const isClaude = localAiName?.toLowerCase().includes('claude');
          const targetMaxDim = isClaude ? 1568 : 3072;

          let mime = data.image.split(';')[0].split(':')[1];
          let dataUrl: string = data.image;
          let filename: string = data.filename;
          let imgW = 0, imgH = 0;

          // Convert PNG → JPEG to keep the log small. VRChat saves PNGs that can
          // be 5-10MB each; without this, a single trip blows the log to 100MB+
          // and trips Anthropic's 5MB-per-image limit.
          if (mime === 'image/png') {
            const conv = await convertPngDataUrl(dataUrl, targetMaxDim, 0.9);
            if (conv) {
              dataUrl = conv.dataUrl;
              imgW = conv.width;
              imgH = conv.height;
              mime = 'image/jpeg';
              filename = (filename || 'vrchat.png').replace(/\.png$/i, '.jpg');
            }
          }

          let tokens = 258; // fallback
          try {
            if (!imgW || !imgH) {
              const img = new Image();
              img.src = dataUrl;
              await new Promise((r) => { img.onload = r as any; setTimeout(r, 500); });
              imgW = img.width || 1024;
              imgH = img.height || 1024;
            }

            let w = imgW, h = imgH;

            if (isClaude) {
              const maxDim = 1568;
              if (w > maxDim || h > maxDim) {
                const scale = maxDim / Math.max(w, h);
                w = w * scale;
                h = h * scale;
              }
              tokens = Math.ceil((w * h) / 750);
            } else {
              const maxDim = 3072;
              if (w > maxDim || h > maxDim) {
                const scale = maxDim / Math.max(w, h);
                w = w * scale;
                h = h * scale;
              }
              if (w <= 384 && h <= 384) {
                tokens = 258;
              } else {
                tokens = Math.ceil(w / 768) * Math.ceil(h / 768) * 258;
              }
            }
          } catch (e) { }

          const attachment = {
            id: Date.now().toString(),
            name: filename,
            type: mime,
            isImage: true,
            dataUrl,
            tokens
          };
          setVrchatQueue(prev => [...prev, { text, attachment }]);
          // The snapshot is committed to the queue — clear the visible input and
          // the source transcript so it isn't re-read/re-sent.
          inputApiRef.current?.setText?.('');
          lastVrchatLogRef.current = '';
          fetch('/api/vrchat/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clear: true }),
          }).catch(() => {});
        }
      } catch (e) {
        console.error("VRChat SSE Parse Error:", e);
      }
    };

    return () => {
      es.close();
    };
  }, [vrchatMode, globalSettings?.vrchatPath, localAiName]);

  // VRChat live transcript → input box.
  // Polls the (non-destructive) merged kohai/ear transcript and OVERWRITES the
  // input whenever it changes, so the sorted "[Name] text" is visible before
  // sending. We only overwrite on a real, non-empty change, so manual edits
  // survive until new speech arrives, and a post-send clear doesn't wipe typing.
  useEffect(() => {
    if (!vrchatMode) { lastVrchatLogRef.current = ''; return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/vrchat/logs');
        if (!res.ok) return;
        const { text } = await res.json();
        if (cancelled) return;
        const t = (text || '').trim();
        if (t && t !== lastVrchatLogRef.current) {
          lastVrchatLogRef.current = t;
          inputApiRef.current?.setText?.(t);
        }
      } catch (e) { /* transient — ignore */ }
    };
    tick();
    const id = setInterval(tick, 1200);
    return () => { cancelled = true; clearInterval(id); };
  }, [vrchatMode]);

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };

  const generateAiResponse = async (history: any[]) => {
    setLoading(true);
    abortControllerRef.current = new AbortController();

    const msgId = (Date.now() + 1).toString();
    const newAiMessage = {
      id: msgId,
      role: 'assistant',
      name: folderName,
      content: '',
      thoughtProcess: undefined,
      attachments: [],
      timestamp: Date.now(),
      tokens: 0,
      // Streaming TTS: the placeholder is marked `streaming: true` immediately
      // so MessageBubble can start fetching audio for each completed sentence
      // as it arrives, instead of waiting for the whole response. `autoPlay`
      // is also set up-front (was set on the final replacement before) so the
      // VRChat-mode auto-trigger fires on the first content chunk, not after
      // generation completes.
      streaming: true,
      autoPlay: vrchatMode,
    };

    // Add placeholder immediately
    setMessages([...history, newAiMessage]);

    // When this entity uses summaries instead of a baked Layer 4, swap the
    // Layer 4 block for a freshly-assembled index of conversation summaries at
    // send time. The stored systemPrompt keeps its original Layer 4 (and the
    // manual Layer 5 footer) intact — only the wire copy is rewritten. If the
    // index fetch fails for any reason we fall back to the unmodified prompt.
    let baseSystemPrompt = systemPrompt;
    if (useSummariesForLayer4) {
      try {
        const idxRes = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&mode=index&current=${encodeURIComponent(convoId)}`);
        if (idxRes.ok) {
          const { body } = await idxRes.json();
          baseSystemPrompt = injectLayer4Index(systemPrompt, body || '');
        }
      } catch (e) {
        console.warn('[summaries] failed to assemble Layer-4 index, sending prompt as-is', e);
      }
    }
    const effectiveSystemPrompt = vrchatMode ? `${baseSystemPrompt}\n\n${vrchatRule}`.trim() : baseSystemPrompt;

    try {
      // Slim the wire payload aggressively. The backend only reads role / content /
      // timestamp / attachments / claudeThinkingBlocks. Everything else is display
      // metadata that would otherwise pile up on the request body — especially
      // thoughtProcess, which is a full duplicate of the thinking text already
      // present in claudeThinkingBlocks. Excluded attachments are dropped entirely
      // (the backend would skip them, but their base64 dataUrls would still bloat
      // the browser→server body and trip request size limits).
      const slimHistory = history.map((m: any) => {
        const slim: any = {
          // id forwarded so the backend can match `attachment_described` SSE
          // events back to the originating message. Frontend updates the
          // attachment in-place when the event arrives, so subsequent turns
          // re-use the persisted description instead of re-calling the
          // bridge model.
          id: m.id,
          role: m.role,
          content: m.content || '',
          timestamp: m.timestamp,
        };
        if (m.attachments?.length) {
          const kept = m.attachments
            .filter((a: any) => !a.excluded)
            .map((a: any) => {
              const { fileObj, ...rest } = a;
              return rest;
            });
          if (kept.length) slim.attachments = kept;
        }
        if (m.claudeThinkingBlocks?.length) {
          slim.claudeThinkingBlocks = m.claudeThinkingBlocks;
        }
        return slim;
      });

      // convoId is forwarded so the backend can set the `x-grok-conv-id`
      // header on xAI requests (boosts Grok prompt-cache hit rate). For other
      // providers it's accepted but ignored.
      //
      // claudeAgentSessionId is only consumed by the Claude OAuth path. When
      // null, backend starts a fresh Anthropic-side session. When set, backend
      // resumes that session (so role semantics are preserved without flatten).
      const bodyObj = { messages: slimHistory, aiName: localAiName, folderName, systemPrompt: effectiveSystemPrompt, toolUseEnabled, agentFullSystemAccess, agentDangerousTools, instructionOverrides, toolInstruction, toolImageInstruction, modelParams: { ...modelParams, claudeThinking }, specificModel, dateTimeVisibility, creativityControlEnabled, hiddenAnalysisInstruction, creativityDisplayPattern, seedEnabled, seedValue, autoModelSelectEnabled, autoModelSelectCriteria, autoModelSelectAllowedModels, convoId, claudeAgentSessionId: claudeAgentSessionIdRef.current, claudeAuthMode, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel, enableReadConversation: useSummariesForLayer4 };
      const bodyText = JSON.stringify(bodyObj);
      // eslint-disable-next-line no-console
      console.log(`[chat] sending ${(bodyText.length / 1024 / 1024).toFixed(2)} MB · ${slimHistory.length} msgs · ${slimHistory.reduce((s: number, m: any) => s + (m.attachments?.length || 0), 0)} kept attachments · ${slimHistory.reduce((s: number, m: any) => s + (m.claudeThinkingBlocks?.length || 0), 0)} thinking blocks`);

      const chatRes = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
        signal: abortControllerRef.current.signal
      });

      if (!chatRes.ok || !chatRes.body) {
        let errorText = await chatRes.text();
        try { errorText = JSON.parse(errorText).error || errorText; } catch (e) { }
        throw new Error(`API Error: ${errorText}`);
      }

      const reader = chatRes.body.getReader();
      const decoder = new TextDecoder('utf-8');

      let currentText = '';
      let currentThought = '';
      let currentCreativityLabel = '';
      let claudeThinkingBlocks: { thinking: string; signature: string }[] = [];
      let continuationCount = 0;
      let buffer = '';
      // The model_selected event arrives at the very start of every stream
      // (auto-select on OR off) so every AI message gets a precise
      // family/specific/thinking/label tag for the meta bar. These fields are
      // display-only metadata — slimHistory above explicitly omits them so
      // they never leak back into the AI context window.
      let chosenModelFamily = '';
      let chosenModelSpecific = '';
      let chosenModelThinking = false;
      let chosenModelLabel = '';
      // Prompt-cache usage from the backend's `cache_usage` SSE event.
      // Always populated when the provider returns usage; null for legacy
      // logs. Stored as display-only metadata (NOT in slimHistory).
      let cacheUsage: {
        cachedInputTokens: number;
        uncachedInputTokens: number;
        totalInputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        providerHint: string;
      } | null = null;
      // Web-search citations from the backend's `web_sources` SSE event. These
      // are the clickable proof that the model actually consulted live pages
      // (vs. hallucinating "news"). Display-only — NOT in slimHistory.
      let webSources: { url: string; title?: string }[] | null = null;
      // Attachments collected from tool calls during this turn, to be
      // attached to the assistant message.
      const toolAttachments: any[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') break;

            try {
              const data = JSON.parse(dataStr);
              if (data.error) throw new Error(data.error);

              if (data.type === 'creativity_prefix') {
                currentCreativityLabel = data.label || '';
              } else if (data.type === 'model_selected') {
                chosenModelFamily = data.family || '';
                chosenModelSpecific = data.specificModel || '';
                chosenModelThinking = !!data.thinking;
                chosenModelLabel = data.label || '';
              } else if (data.type === 'cache_usage') {
                cacheUsage = {
                  cachedInputTokens: Number(data.cachedInputTokens || 0),
                  uncachedInputTokens: Number(data.uncachedInputTokens || 0),
                  totalInputTokens: Number(data.totalInputTokens || 0),
                  outputTokens: Number(data.outputTokens || 0),
                  cacheCreationTokens: Number(data.cacheCreationTokens || 0),
                  providerHint: String(data.providerHint || ''),
                };
              } else if (data.type === 'web_sources') {
                if (Array.isArray(data.sources) && data.sources.length > 0) {
                  webSources = data.sources
                    .filter((s: any) => s && typeof s.url === 'string')
                    .map((s: any) => ({ url: s.url, ...(s.title ? { title: String(s.title) } : {}) }));
                }
              } else if (data.type === 'session_id') {
                // Claude OAuth path emits this so we can resume the
                // Anthropic-side session on the next turn.
                if (typeof data.sessionId === 'string') {
                  setAgentSession(data.sessionId);
                }
              } else if (data.type === 'thought') {
                currentThought += data.content;
              } else if (data.type === 'text') {
                currentText += data.content;
                // Strip leading "[YYYY-MM-DD HH:MM:SS]" stacks CONTINUOUSLY as
                // the reply streams in (gated on the global setting, default
                // ON). Doing it here — rather than once at finalization — keeps
                // msg.content monotonic so the streaming-TTS offset tracking in
                // MessageBubble stays valid. A late one-shot strip shrank the
                // content mid-playback and made VRChat TTS stop after the first
                // line.
                if (globalSettings?.removeTimestamps !== false) {
                  currentText = stripLeadingTimestamps(currentText);
                }
                // User-configurable regex filter (Settings → Custom regex
                // filter). Applied continuously like the timestamp strip so the
                // stored message — and therefore TTS — never contains matches.
                currentText = applyOutputFilter(currentText, globalSettings);
              } else if (data.type === 'thinking_signature') {
                claudeThinkingBlocks.push({ thinking: data.thinking, signature: data.signature });
              } else if (data.type === 'continued') {
                continuationCount = data.count || 0;
              } else if (data.type === 'file_attachment' && data.attachment) {
                // Tool-result file — attach to the assistant message as if the
                // assistant had uploaded it. UUID, defaults filled in here.
                const att = {
                  isImage: false,
                  isAudio: false,
                  isVideo: false,
                  id: uuidv4(),
                  ...data.attachment,
                };
                toolAttachments.push(att);
              } else if (data.type === 'attachment_described') {
                // Sense bridge (eyes/ears/watcher) generated a description for
                // an attachment on an existing message. Stash it on that
                // attachment so subsequent turns re-use the saved text
                // instead of re-calling the bridge model. The auto-save
                // effect will then persist it to the conversation log.
                const targetMsgId = data.messageId;
                const targetAttId = data.attachmentId;
                const targetAttName = data.attachmentName;
                setMessages(prev => prev.map(mm => {
                  if (mm.id !== targetMsgId) return mm;
                  if (!Array.isArray(mm.attachments)) return mm;
                  return {
                    ...mm,
                    attachments: mm.attachments.map((a: any) => {
                      // Match by attachment id first (stable), fall back to
                      // name for older logs that pre-date the id field.
                      const matches = targetAttId
                        ? a.id === targetAttId
                        : a.name === targetAttName;
                      if (!matches) return a;
                      return {
                        ...a,
                        description: data.description || '',
                        descriptionKind: data.kind || '',
                        descriptionModel: data.model || '',
                        descriptionGeneratedAt: data.generatedAt || Date.now(),
                        descriptionFromCache: !!data.fromCache,
                        descriptionError: data.error || undefined,
                      };
                    }),
                  };
                }));
              }
            } catch (e: any) {
              // Re-throw API errors so the outer catch can display them
              if (e.message && !e.message.startsWith('JSON')) throw e;
            }
          }
        }

        // Coalesce all the events parsed from THIS chunk into a single
        // setMessages. Calling it once per `data:` line (inside the for-loop
        // above) fired dozens of synchronous state updates on fast/bursty
        // streams, tripping React's "Maximum update depth exceeded" guard and
        // forcing a full message-list re-render per line. One update per chunk
        // is both correct and far cheaper.
        setMessages(prev => prev.map(m =>
          m.id === msgId
            ? {
                ...m,
                content: currentText,
                thoughtProcess: currentThought || undefined,
                continuationCount: continuationCount || undefined,
                attachments: toolAttachments.length ? [...toolAttachments] : (m.attachments || []),
                ...(currentCreativityLabel ? { creativityLabel: currentCreativityLabel } : {}),
                ...(chosenModelFamily ? {
                  modelFamily: chosenModelFamily,
                  modelSpecific: chosenModelSpecific,
                  modelThinking: chosenModelThinking,
                  modelLabel: chosenModelLabel,
                } : {}),
              }
            : m
        ));
      }

      // Finalize the message NOW with everything except the precise token
      // count. The Python tokenizer route can take up to ~15-25s (especially
      // when the persistent server isn't running and has to be spawned) and
      // awaiting it here used to block setLoading(false) — leaving the
      // "thinking..." indicator and TTS auto-play stuck after streaming
      // had already finished. Token count refines in the background below.
      const thinkingTokens = currentThought ? Math.ceil(currentThought.length / 4) : 0;
      // Leading "[YYYY-MM-DD HH:MM:SS]" stacks were already stripped
      // continuously as the reply streamed in (see the `text` branch above),
      // so currentText is final. A one-shot strip here would shrink content
      // after TTS started and break the streaming-TTS offset tracking.
      const finalText = currentText;
      const fallbackTokens = Math.ceil((finalText || '').length / 4);
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? {
              ...m,
              content: finalText,
              tokens: fallbackTokens,
              textTokens: fallbackTokens,
              thinkingTokens: saveThinkingToLog ? thinkingTokens : 0,
              autoPlay: vrchatMode,
              // Streaming finished — flip the flag so MessageBubble's streaming
              // TTS path flushes the final non-terminated tail (if any) as its
              // last segment. For non-streaming-TTS paths this field is ignored.
              streaming: false,
              ...(continuationCount > 0 ? { continuationCount } : {}),
              ...(claudeThinkingBlocks.length > 0 ? { claudeThinkingBlocks } : {}),
              ...(currentCreativityLabel ? { creativityLabel: currentCreativityLabel } : {}),
              ...(chosenModelFamily ? {
                modelFamily: chosenModelFamily,
                modelSpecific: chosenModelSpecific,
                modelThinking: chosenModelThinking,
                modelLabel: chosenModelLabel,
              } : {}),
              ...(cacheUsage ? { cacheUsage } : {}),
              ...(webSources ? { webSources } : {}),
            }
          : m
      ));

      // Refine tokens in the background — message bubble and TTS are already
      // unblocked at this point; the token counter just updates a moment later.
      fetchTokensForText(finalText, localAiName).then(aiTokens => {
        if (!aiTokens) return;
        setMessages(prev => prev.map(m =>
          m.id === msgId ? { ...m, tokens: aiTokens, textTokens: aiTokens } : m
        ));
      }).catch(() => {});

    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => prev.map(m =>
          m.id === msgId
            ? { ...m, content: m.content + (m.content ? '\n\n' : '') + `Error: ${err.message}` }
            : m
        ));
      }
    }

    setLoading(false);
    abortControllerRef.current = null;
  };

  const handleRerun = async (msgId: string) => {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const newHistory = messages.slice(0, idx);
    setMessages(newHistory);
    // Rerunning rewinds the timeline. The Anthropic OAuth session (if any)
    // is now out of sync with NEXUS's local history — invalidate so the
    // backend starts a fresh session for the next generation.
    setAgentSession(null);
    await generateAiResponse(newHistory);
  };

  const handleEdit = async (id: string, newContent: string) => {
    setMessages(messages.map(m => m.id === id ? { ...m, content: newContent } : m));
    const newTokens = await fetchTokensForText(newContent, localAiName);
    setMessages(prev => prev.map(m => m.id === id ? { ...m, tokens: newTokens, textTokens: newTokens } : m));
    // Same reasoning as handleRerun — local history diverged from Anthropic's
    // session record, so the next OAuth generation must start fresh.
    setAgentSession(null);
  };

  // Decide whether a message counts as "original" (preserve / confirm before
  // delete) or "copied" (silent delete OK, eligible for auto-trim).
  //
  //   - `firstOriginalIsNext=true` and no marker yet → the marker is PENDING
  //     on the next message added. Everything currently in the log is carry-
  //     over context and therefore copied. This is the post-clone state.
  //   - No marker and no pending flag → all messages are original (safest
  //     default for hand-built conversations that never went through the
  //     clone / Go-to-Next workflow).
  //   - Marker set → messages BEFORE the marker are copied, messages AT and
  //     AFTER it are original.
  const isMessageOriginal = (id: string) => {
    if (firstOriginalIsNext && !firstOriginalMessageId) return false;
    if (!firstOriginalMessageId) return true;
    const markerIdx = messages.findIndex(m => m.id === firstOriginalMessageId);
    if (markerIdx < 0) return true;
    const thisIdx = messages.findIndex(m => m.id === id);
    return thisIdx >= markerIdx;
  };

  const handleDelete = (id: string) => {
    if (isMessageOriginal(id)) {
      const ok = window.confirm("This is an original message (part of the working conversation). Delete it?");
      if (!ok) return;
    }
    setMessages(prev => prev.filter(m => m.id !== id));
    if (id === firstOriginalMessageId) setFirstOriginalMessageId(null);
    // Deletion diverges NEXUS history from Anthropic's session record →
    // invalidate the OAuth session for the next generation.
    setAgentSession(null);
  };

  const handleSetFirstOriginal = (id: string) => {
    // Manually placing a marker on an existing message is mutually exclusive
    // with the "promote the next message" pending flag — clear the flag here
    // so the two states can't coexist.
    setFirstOriginalIsNext(false);
    setFirstOriginalMessageId(prev => (prev === id ? null : id));
  };

  const handleToggleAttachment = (msgId: string, attId: string) => {
    setMessages(messages.map(m => {
      if (m.id !== msgId) return m;
      return {
        ...m,
        attachments: m.attachments.map((a: any) => a.id === attId ? { ...a, excluded: !a.excluded } : a)
      };
    }));
  };

  const handleDeleteAttachment = (msgId: string, attId: string) => {
    const msg = messages.find(m => m.id === msgId);
    const att = msg?.attachments?.find((a: any) => a.id === attId);
    if (!att) return;
    const sizeLabel = att.dataUrl
      ? `≈${Math.ceil((att.dataUrl.length * 3) / 4 / 1024).toLocaleString()} KB`
      : att.textData
        ? `${att.textData.length.toLocaleString()} chars`
        : '';
    const ok = window.confirm(
      `Permanently remove attachment "${att.name}" from this conversation?` +
      (sizeLabel ? ` (${sizeLabel})` : '') +
      '\n\nThis is irreversible — the attachment data will be deleted from the saved log. ' +
      'Use the eye icon instead if you only want to exclude it from the AI\'s context.'
    );
    if (!ok) return;
    setMessages(messages.map(m => {
      if (m.id !== msgId) return m;
      return {
        ...m,
        attachments: (m.attachments || []).filter((a: any) => a.id !== attId),
      };
    }));
  };

  const handleExport = () => {
    const md = exportToMarkdown(messages, folderName, saveThinkingToLog);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    const safeName = (title || 'conversation').replace(/[\\/:*?"<>|]+/g, '_');
    const logData = {
      id: convoId,
      folderName,
      aiName: localAiName,
      title,
      messages,
      systemPrompt,
      toolUseEnabled,
      agentFullSystemAccess,
      agentDangerousTools,
      instructionOverrides,
      toolInstruction,
      toolImageInstruction,
      modelParams,
      specificModel,
      dateTimeVisibility,
      claudeThinking,
      saveThinkingToLog,
      vrchatMode,
      vrchatRule,
      firstOriginalMessageId,
      creativityControlEnabled,
      hiddenAnalysisInstruction,
      creativityDisplayPattern,
      seedEnabled,
      seedValue,
      updatedAt: Date.now(),
    };
    const blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const hasVisibleAttachments = messages.some(m => m.attachments?.some((a: any) => !a.excluded));

  const handleToggleAllAttachments = () => {
    const shouldHide = hasVisibleAttachments;
    setMessages(prev => prev.map(m => {
      if (!m.attachments || m.attachments.length === 0) return m;
      return {
        ...m,
        attachments: m.attachments.map((a: any) => ({ ...a, excluded: shouldHide }))
      };
    }));
  };

  // Convert one PNG dataUrl into a JPEG dataUrl + new metadata
  const convertPngDataUrl = (
    dataUrl: string,
    maxDim: number,
    quality = 0.9
  ): Promise<{ dataUrl: string; width: number; height: number; size: number } | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth || 1024;
          let h = img.naturalHeight || 1024;
          if (w > maxDim || h > maxDim) {
            const scale = maxDim / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(null);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const out = canvas.toDataURL('image/jpeg', quality);
          const b64 = out.split(',')[1] || '';
          const size = Math.ceil((b64.length * 3) / 4);
          resolve({ dataUrl: out, width: w, height: h, size });
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
      setTimeout(() => resolve(null), 8000);
    });
  };

  const [toolsOpen, setToolsOpen] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [isConvertingPngs, setIsConvertingPngs] = useState(false);
  const [sysPromptUpdaterOpen, setSysPromptUpdaterOpen] = useState(false);

  // Recompute tokens for every visible piece — system prompt, attachment
  // instruction, every message body, plus the timestamp tags that are
  // injected when dateTimeVisibility is "current" or "all". Useful after
  // importing logs from MD (where parseMarkdown leaves tokens at 0), after
  // switching the AI model (different tokenizer), or whenever counters look
  // stale for any reason.
  const handleRecalculateTokens = async () => {
    if (isRecalculating) return;
    setIsRecalculating(true);
    setToolsOpen(false);
    try {
      // System prompt + attachment instruction
      const [sysT, instrT] = await Promise.all([
        fetchTokensForText(systemPrompt || '', localAiName),
        fetchTokensForText(toolUseEnabled ? (toolInstruction || '') : '', localAiName),
      ]);
      setSystemTokens(sysT);
      setAttachmentInstructionTokens(instrT);

      const fmtDate = (ts: number) => {
        const d = new Date(ts), p = (n: number) => n.toString().padStart(2, '0');
        return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
      };

      // Per-message body tokens, parallelized
      const results = await Promise.all(messages.map(async (m, i) => {
        const body = m.content || '';
        // Timestamp tag prepended in the same situations as route.ts does
        let withTs = body;
        if (m.timestamp) {
          if (dateTimeVisibility === 'all' ||
              (dateTimeVisibility === 'current' && i === messages.length - 1)) {
            withTs = `${fmtDate(m.timestamp)}\n${body}`;
          }
        }
        const t = await fetchTokensForText(withTs, localAiName);
        return { id: m.id, tokens: t };
      }));
      const byId: Record<string, number> = {};
      for (const r of results) byId[r.id] = r.tokens;
      setMessages(prev => prev.map(m => ({
        ...m,
        tokens: byId[m.id] ?? m.tokens,
        textTokens: byId[m.id] ?? m.textTokens,
      })));
    } finally {
      setIsRecalculating(false);
    }
  };
  const handleConvertPngs = async () => {
    const pngCount = messages.reduce(
      (acc, m) => acc + (m.attachments?.filter((a: any) => a.type === 'image/png').length || 0),
      0
    );
    if (pngCount === 0) {
      alert('No PNG attachments in this conversation.');
      return;
    }
    if (!confirm(`Convert ${pngCount} PNG attachment${pngCount === 1 ? '' : 's'} in this conversation to JPEG?\n\nThis is irreversible for the saved log (use Export JSON first if you want a backup).`)) {
      return;
    }
    setIsConvertingPngs(true);
    const isClaude = (localAiName || '').toLowerCase().includes('claude');
    const maxDim = isClaude ? 1568 : 3072;

    try {
      const next = await Promise.all(messages.map(async (m) => {
        if (!m.attachments?.length) return m;
        const newAtts = await Promise.all(m.attachments.map(async (a: any) => {
          if (a.type !== 'image/png' || !a.dataUrl) return a;
          const conv = await convertPngDataUrl(a.dataUrl, maxDim, 0.9);
          if (!conv) return a;
          // Recompute tokens from new dimensions
          let w = conv.width, h = conv.height;
          let tokens = a.tokens;
          if (isClaude) {
            tokens = Math.ceil((w * h) / 750);
          } else {
            if (w <= 384 && h <= 384) tokens = 258;
            else tokens = Math.ceil(w / 768) * Math.ceil(h / 768) * 258;
          }
          return {
            ...a,
            name: (a.name || 'image').replace(/\.png$/i, '.jpg'),
            type: 'image/jpeg',
            size: conv.size,
            dataUrl: conv.dataUrl,
            tokens,
          };
        }));
        return { ...m, attachments: newAtts };
      }));
      setMessages(next);
      alert(`Converted ${pngCount} PNG attachment${pngCount === 1 ? '' : 's'} to JPEG. Save will happen on the next change (or trigger one by sending a message / editing).`);
    } catch (e: any) {
      alert('Conversion failed: ' + e.message);
    } finally {
      setIsConvertingPngs(false);
    }
  };
  const handleRemoveTimestamps = () => {
    let changed = 0;
    const next = messages.map((m) => {
      if (m.role !== 'assistant' || typeof m.content !== 'string') return m;
      const cleaned = stripLeadingTimestamps(m.content);
      if (cleaned === m.content) return m;
      changed++;
      return { ...m, content: cleaned };
    });
    if (changed === 0) {
      alert('No leading timestamp stacks found in this conversation.');
      return;
    }
    setMessages(next);
    alert(`Removed leading timestamps from ${changed} message${changed === 1 ? '' : 's'}. Save will happen on the next change (or trigger one by sending a message / editing).`);
  };

  return (
    <div className="flex-1 flex flex-col h-full relative bg-background">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center justify-between px-6 bg-secondary/30 backdrop-blur-md sticky top-0 z-10 shrink-0">
        <h2 className="font-semibold text-lg">{title}</h2>
        <div className="flex items-center gap-4">
          {(() => {
            // Per-folder max context (was global, moved into Folder Settings).
            const activeFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
            const max = activeFolderSettings.maxRecommendedContext || 60000;
            const { sys, copied, original, attach, total } = tokenBreakdown;
            // The indicator (bar, total/limit number, red ring) reflects the
            // FULL current context window — toggling an attachment's eye icon
            // immediately moves the totals up or down. The text-only threshold
            // (sys + copied + original) is used ONLY by the auto-trim logic in
            // the useEffect above, not by anything visible here.
            const denom = Math.max(max, total) || 1;
            const pctSys = (sys / denom) * 100;
            const pctCopied = (copied / denom) * 100;
            const pctOriginal = (original / denom) * 100;
            const pctAttach = (attach / denom) * 100;
            const overLimit = total > max;
            return (
              <div className="flex flex-col items-end gap-1 min-w-[260px]" title={`System ${sys.toLocaleString()} · Copied ${copied.toLocaleString()} · Original ${original.toLocaleString()} · Attachments ${attach.toLocaleString()} (not counted toward auto-trim threshold) · Free ${Math.max(0, max - total).toLocaleString()} / limit ${max.toLocaleString()}`}>
                <div className={`flex h-2 w-full rounded-full overflow-hidden bg-muted/60 border ${overLimit ? 'border-red-500 ring-1 ring-red-500/40' : 'border-border/50'}`}>
                  <div className="bg-indigo-500" style={{ width: `${pctSys}%` }} />
                  <div className="bg-amber-400" style={{ width: `${pctCopied}%` }} />
                  <div className="bg-emerald-500" style={{ width: `${pctOriginal}%` }} />
                  <div className="bg-sky-400" style={{ width: `${pctAttach}%` }} />
                </div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-2 font-semibold flex-wrap justify-end">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-indigo-500 inline-block" />Sys {sys.toLocaleString()}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />Cp {copied.toLocaleString()}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" />Orig {original.toLocaleString()}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-sky-400 inline-block" />Att {attach.toLocaleString()}</span>
                  <span className={overLimit ? 'text-red-500' : 'text-muted-foreground'}>· {total.toLocaleString()}/{max.toLocaleString()}</span>
                </div>
              </div>
            );
          })()}
          <button onClick={handleToggleAllAttachments} className={`p-1.5 transition-colors ${hasVisibleAttachments ? 'text-muted-foreground hover:text-red-400' : 'text-red-400 hover:text-muted-foreground'}`} title={hasVisibleAttachments ? "Hide all attachments" : "Show all attachments"}>
            {hasVisibleAttachments ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            onClick={async () => {
              try {
                const r = await fetch('/api/agent/open-workspace', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ folderName }),
                });
                if (!r.ok) {
                  const d = await r.json().catch(() => ({}));
                  alert(`Failed to open workspace: ${d.error || r.status}`);
                }
              } catch (e: any) {
                alert(`Failed to open workspace: ${e.message}`);
              }
            }}
            className="p-1.5 text-muted-foreground hover:text-amber-500 transition-colors"
            title={`Open this entity's workspace folder in file explorer (local_data/agent_workspaces/${folderName}/)`}
          >
            <FolderOpen size={16} />
          </button>
          <button
            onClick={() => setSysPromptUpdaterOpen(true)}
            className="p-1.5 text-muted-foreground hover:text-indigo-500 transition-colors"
            title="System Prompt Updater — refresh the 4-layer identity prompt with new conversation log and clone to next conversation"
          >
            <Layers size={16} />
          </button>
          <div className="relative">
            <button
              onClick={() => setToolsOpen(v => !v)}
              className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
              title="Tools"
              aria-haspopup="menu"
              aria-expanded={toolsOpen}
            >
              <Wrench size={16} />
            </button>
            {toolsOpen && (
              <>
                {/* Backdrop closes the menu on outside click */}
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setToolsOpen(false)}
                />
                <div
                  role="menu"
                  className="absolute right-0 mt-1 z-20 min-w-[220px] bg-card border border-border rounded-lg shadow-lg overflow-hidden"
                >
                  <button
                    role="menuitem"
                    onClick={handleRecalculateTokens}
                    disabled={isRecalculating}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RefreshCw size={14} className={isRecalculating ? 'animate-spin' : ''} />
                    {isRecalculating ? 'Recalculating…' : 'Recalculate Tokens'}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setToolsOpen(false); handleConvertPngs(); }}
                    disabled={isConvertingPngs}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground disabled:opacity-50 disabled:cursor-not-allowed border-t border-border"
                  >
                    <ImageDown size={14} />
                    {isConvertingPngs ? 'Converting…' : 'Convert PNG → JPG'}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setToolsOpen(false); handleRemoveTimestamps(); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground border-t border-border"
                  >
                    <Clock size={14} />
                    Remove timestamps
                  </button>
                </div>
              </>
            )}
          </div>
          <button onClick={() => setLiveOpen(true)} className="p-1.5 text-muted-foreground hover:text-red-500 transition-colors" title="Start Live Session (Gemini native audio)">
            <Radio size={16} />
          </button>
          <button onClick={() => setIsPromptModalOpen(true)} className="p-1.5 text-muted-foreground hover:text-indigo-500 transition-colors" title="Edit System Prompt">
            <Settings2 size={16} />
          </button>
          <button onClick={handleExport} className="p-1.5 text-muted-foreground hover:text-foreground transition-colors" title="Export as Markdown">
            <Download size={16} />
          </button>
          <button onClick={handleExportJson} className="p-1.5 text-muted-foreground hover:text-foreground transition-colors text-[10px] font-bold tracking-wider" title="Export as JSON">
            JSON
          </button>
        </div>
      </div>

      {/* Conversation-load progress bar + Stop button. Only shown while
          /api/logs/[id] is downloading. When Content-Length is provided
          we render a percentage bar; otherwise we render an indeterminate
          striped bar. Stop calls AbortController.abort(), which the load
          effect handles by bailing without applying partial data. */}
      {convoIsLoading && (
        <div className="px-6 pt-3">
          <div className="max-w-4xl mx-auto flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden relative">
              {convoLoadingTotal > 0 ? (
                <div
                  className="h-full bg-indigo-500 transition-all duration-150"
                  style={{
                    width: `${Math.min(100, Math.round((convoLoadingBytes / convoLoadingTotal) * 100))}%`,
                  }}
                />
              ) : (
                <div className="h-full w-1/3 bg-indigo-500/60 animate-pulse" />
              )}
            </div>
            <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
              {convoLoadingTotal > 0
                ? `${(convoLoadingBytes / 1024 / 1024).toFixed(2)} / ${(convoLoadingTotal / 1024 / 1024).toFixed(2)} MB`
                : `${(convoLoadingBytes / 1024 / 1024).toFixed(2)} MB`}
            </span>
            <button
              type="button"
              onClick={() => {
                try { convoLoadAbortRef.current?.abort(); } catch {}
              }}
              className="px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 rounded transition-colors"
              title="Stop downloading this conversation"
            >
              Stop
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 scroll-smooth custom-scrollbar" ref={scrollRef}>
        <div className="max-w-4xl mx-auto space-y-6">
          {messages.map((msg, msgIdx) => (
            <React.Fragment key={msg.id}>
              {firstOriginalMessageId === msg.id && (
                <div className="flex items-center gap-3 my-2 select-none" aria-label="First original message marker">
                  <div className="flex-1 h-px bg-indigo-500/40" />
                  <span className="text-[10px] uppercase tracking-wider text-indigo-500/70 font-semibold">
                    original conversation starts
                  </span>
                  <div className="flex-1 h-px bg-indigo-500/40" />
                </div>
              )}
              <MessageBubble
                msg={msg}
                onEdit={(content: string) => handleEdit(msg.id, content)}
                onDelete={() => handleDelete(msg.id)}
                onRerun={msgIdx === messages.length - 1 ? () => handleRerun(msg.id) : undefined}
                onToggleAttachment={(attId: string) => handleToggleAttachment(msg.id, attId)}
                onDeleteAttachment={(attId: string) => handleDeleteAttachment(msg.id, attId)}
                onAudioStateChange={handleAudioStateChange}
                globalSettings={globalSettings}
                folders={folders}
                folderName={folderName}
                isVRChatMode={vrchatMode}
                isOriginal={isMessageOriginal(msg.id)}
                isFirstOriginal={firstOriginalMessageId === msg.id}
                onSetFirstOriginal={() => handleSetFirstOriginal(msg.id)}
              />
            </React.Fragment>
          ))}
          {loading && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-3 text-muted-foreground p-4 bg-muted/30 rounded-xl w-fit"
            >
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                <span className="w-2 h-2 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                <span className="w-2 h-2 bg-primary rounded-full animate-bounce"></span>
              </div>
              <span className="text-sm font-medium">{localAiName} is thinking...</span>
            </motion.div>
          )}
        </div>
      </div>

      {/* Input area + floating "Next = First Original" toggle.
          The toggle is OUTSIDE the gradient panel and absolutely positioned
          above its top edge, so it doesn't add vertical height to the
          opaque panel (which used to cover an extra row of conversation).
          It's half-transparent at rest and goes fully visible on hover or
          when the flag is active — minimizing visual noise without losing
          discoverability. */}
      <div className="shrink-0 relative">
        <div
          className={`absolute right-6 top-0 -translate-y-1/2 z-10 flex items-center gap-2 pointer-events-auto transition-opacity ${
            firstOriginalIsNext && !firstOriginalMessageId
              ? 'opacity-100'
              : 'opacity-40 hover:opacity-100'
          }`}
        >
          {firstOriginalIsNext && !firstOriginalMessageId && (
            <span className="text-[10px] text-indigo-500 font-semibold uppercase tracking-wider animate-pulse">
              next message → first original
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              // Pure toggle. Turning it on clears any existing marker so
              // the two states can't coexist (the manual marker on an
              // older message would contradict the "next message becomes
              // marker" intent).
              setFirstOriginalIsNext(prev => {
                const next = !prev;
                if (next) setFirstOriginalMessageId(null);
                return next;
              });
            }}
            // backdrop-blur-sm gives the button a tiny readability cushion
            // when it floats over busy conversation content, without
            // becoming an opaque panel.
            className={`p-1.5 rounded-md border text-[11px] flex items-center gap-1 transition-colors backdrop-blur-sm ${
              firstOriginalIsNext && !firstOriginalMessageId
                ? 'border-indigo-500 text-indigo-500 bg-indigo-500/15'
                : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/60 bg-background/40'
            }`}
            title={
              firstOriginalIsNext && !firstOriginalMessageId
                ? 'Pending: the next message you send will become the first-original marker. Click to cancel.'
                : 'Mark next message as first-original — everything currently in the log will be treated as carry-over context until you send.'
            }
          >
            {firstOriginalIsNext && !firstOriginalMessageId
              ? <Bookmark size={12} fill="currentColor" />
              : <BookmarkPlus size={12} />}
            <span>Next = First Original</span>
          </button>
        </div>
        <div className="p-4 bg-gradient-to-t from-background via-background to-transparent">
          <div className="max-w-4xl mx-auto">
            <InputArea ref={inputApiRef} onSend={handleSend} onStop={handleStop} isGenerating={loading} disabled={loading} aiName={localAiName} vrchatMode={vrchatMode} />
          </div>
        </div>
      </div>

      {/* System Prompt Modal */}
      {isPromptModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border shadow-2xl rounded-xl p-6 max-w-2xl w-full mx-4 flex flex-col h-[80vh]">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Settings2 size={20} className="text-indigo-500" /> System Instructions
            </h3>

            {/* ── Tab bar ─────────────────────────────────────────────────────
                Four tabs grouping ~12 sections that previously stacked
                vertically. Each section below is wrapped in a conditional on
                `activeSettingsTab` so only one tab's content renders at a time.
                Identity = system prompt + workspace tools.
                Senses   = eyes / ears / video watcher (bridges for non-
                           multimodal primary models).
                Behavior = VRChat, date/time visibility, creativity control,
                           seed.
                Model    = base family, specific model, generation parameters,
                           auto model selection. */}
            <div className="flex gap-1 mb-4 border-b border-border shrink-0">
              {([
                { id: 'identity', label: 'Identity' },
                { id: 'senses',   label: 'Senses' },
                { id: 'behavior', label: 'Behavior' },
                { id: 'model',    label: 'Model' },
              ] as const).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveSettingsTab(tab.id)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    activeSettingsTab === tab.id
                      ? 'border-indigo-500 text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-6">
              {activeSettingsTab === 'identity' && (<>
              <div>
                <label className="text-sm font-semibold text-foreground mb-1 block">System Prompt</label>
                <p className="text-xs text-muted-foreground mb-2">
                  Instruct the AI on how it should behave and respond.
                </p>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  className="w-full min-h-[150px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                  placeholder="You are a helpful AI assistant..."
                />
              </div>

              {/* ── Summaries-as-Layer-4 mode (per-folder) ──────────────────── */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useSummariesForLayer4}
                    onChange={(e) => persistUseSummariesToggle(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">Use summaries instead of the 4th layer</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  When ON, the live index of per-conversation summaries (sorted to match the sidebar) is injected at
                  send time in place of <span className="font-mono">Layer 4</span> — replacing the baked Layer 4 block if it
                  still exists, or appended as a Layer-4 block once you&apos;ve removed Layer 4 from the prompt — AND the
                  <span className="font-mono"> read_conversation</span> tool is exposed to the AI. When OFF, neither the
                  summaries nor that tool reach the AI. Your manual <span className="font-mono">Layer 5</span> footer is
                  preserved untouched. Inactive conversations are hidden from this index.
                </p>
                {useSummariesForLayer4 && (
                  <div className="mt-3 ml-6">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-foreground">Live Layer 4 — Summaries Index (read-only)</label>
                      <span className="text-[11px] text-muted-foreground font-mono">{summaryIndexTokens.toLocaleString()} tokens</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      This is exactly what gets injected as Layer 4 when you send. To change it, edit the individual
                      conversation summaries (System Prompt Updater) or toggle conversations active/inactive.
                    </p>
                    <textarea
                      readOnly
                      value={summaryIndexBody}
                      className="w-full min-h-[140px] p-3 bg-muted/40 border border-border rounded-xl text-xs font-mono resize-none outline-none text-muted-foreground"
                      placeholder="(no summaries yet — write one per conversation from the System Prompt Updater)"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={toolUseEnabled}
                    onChange={(e) => setToolUseEnabled(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">Enable file workspace tools (Claude, Gemini &amp; Local)</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  Gives the assistant a private file sandbox at <span className="font-mono">local_data/agent_workspaces/{folderName}/</span>
                  with <span className="font-mono">Read</span> / <span className="font-mono">Write</span> / <span className="font-mono">Edit</span> / <span className="font-mono">Glob</span> / <span className="font-mono">Grep</span> tools (same names as Claude Code's tools — works identically across API-key and OAuth modes).
                  The current file list is auto-injected into the system prompt — no list_files tool needed.
                  Files the assistant reads/writes appear as attachments on its messages with
                  <span className="ml-1 inline-block px-1.5 py-0.5 text-[10px] uppercase font-semibold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 rounded">read</span>
                  <span className="ml-1 inline-block px-1.5 py-0.5 text-[10px] uppercase font-semibold bg-amber-500/20 text-amber-700 dark:text-amber-300 rounded">modified</span>
                  <span className="ml-1 inline-block px-1.5 py-0.5 text-[10px] uppercase font-semibold bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 rounded">created</span>
                  labels.
                </p>
                {toolUseEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">Tool Use Instruction</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Hidden instruction appended to the system prompt that teaches the AI how to use the workspace tools.
                      </p>
                      <textarea
                        value={toolInstruction}
                        onChange={(e) => setToolInstruction(e.target.value)}
                        className="w-full min-h-[120px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    {/* Image Read Instruction UI removed — the default hint
                        text still drives Gemini's image-read flow under the
                        hood, but it's no longer user-editable. */}

                    {/* ── Per-Entity capability toggles ─────────────────── */}
                    <div className="mt-4 ml-6 p-3 rounded-xl border border-amber-500/40 bg-amber-500/5 space-y-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={agentFullSystemAccess}
                          onChange={(e) => setAgentFullSystemAccess(e.target.checked)}
                          className="accent-amber-500"
                        />
                        <span className="text-sm font-semibold text-foreground">⚠ Full PC access (leave the workspace sandbox)</span>
                      </label>
                      <p className="text-xs text-muted-foreground ml-6 leading-relaxed">
                        OFF (default): file tools are confined to this entity's <span className="font-mono">agent_workspaces/{folderName}/</span> folder.
                        ON: the entity can read/write/delete <strong>anywhere on this PC</strong> using absolute paths
                        (OAuth-Claude gets the whole drive; other models get absolute-path access via the same tools). Use with care.
                      </p>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={agentDangerousTools}
                          onChange={(e) => setAgentDangerousTools(e.target.checked)}
                          className="accent-red-500"
                        />
                        <span className="text-sm font-semibold text-foreground">⚠ Dangerous tools (Delete everywhere · Shell for OAuth-Claude)</span>
                      </label>
                      <p className="text-xs text-muted-foreground ml-6 leading-relaxed">
                        Adds a <span className="font-mono">Delete</span> tool for every model, and enables the
                        <span className="font-mono"> Bash</span> shell for OAuth-Claude (which is also how it can delete/run anything Claude Code can).
                        Scope still follows the Full-PC-access toggle above.
                      </p>
                    </div>

                    {/* ── Hidden instruction overrides (per-Entity) ─────── */}
                    <details className="mt-4 ml-6 group">
                      <summary className="text-sm font-semibold text-foreground cursor-pointer select-none">
                        Hidden instruction overrides ({Object.values(instructionOverrides).filter((v) => typeof v === 'string' && v.trim()).length} customized)
                      </summary>
                      <p className="text-xs text-muted-foreground mt-1 mb-3 leading-relaxed">
                        NEXUS injects these English tool/path instructions into the model's context. Strict English wording can break a character in deep interaction — override any of them here (e.g. translate, soften, or rephrase in-character). Leave a box empty to keep the English default shown as its placeholder.
                      </p>
                      <div className="space-y-3">
                        {AGENT_INSTRUCTION_LABELS.map(({ key, label }) => (
                          <div key={key}>
                            <label className="text-xs font-semibold text-foreground mb-1 block">{label}</label>
                            <textarea
                              value={instructionOverrides[key] || ''}
                              placeholder={DEFAULT_AGENT_INSTRUCTIONS[key]}
                              onChange={(e) =>
                                setInstructionOverrides((prev) => ({ ...prev, [key]: e.target.value }))
                              }
                              className="w-full min-h-[60px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-indigo-500/50 outline-none"
                            />
                          </div>
                        ))}
                      </div>
                    </details>
                  </>
                )}
              </div>
              </>)}

              {activeSettingsTab === 'senses' && (<>
              {/* ── "Eyes" — vision bridge for text-only models ─────────────── */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={eyesEnabled}
                    onChange={(e) => setEyesEnabled(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">Enable &quot;Eyes&quot; (vision bridge for text-only models)</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  When the active primary model can&apos;t see images (e.g. <span className="font-mono">glm-5-turbo</span>, <span className="font-mono">deepseek-chat</span>, <span className="font-mono">glm-4.6</span>), NEXUS routes each incoming image through a helper multimodal model and substitutes the image with the returned text description. Triggers in two cases:
                  <span className="block mt-1">• you attach an image to a text-only entity</span>
                  <span className="block">• the entity calls <span className="font-mono">Read</span> on an image file in its workspace</span>
                  <span className="block mt-1">Descriptions are cached on disk (<span className="font-mono">local_data/eyes_cache/</span>) so the same image is never described twice. For vision-capable primary models (Claude, Gemini, GLM-V, etc.) this is a no-op — images pass through unchanged.</span>
                </p>
                {eyesEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">Eyes Prompt</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Entity-specific instruction sent to the helper vision model alongside each image. Adjust the tone / level of detail to match your entity&apos;s voice.
                      </p>
                      <textarea
                        value={eyesPrompt}
                        onChange={(e) => setEyesPrompt(e.target.value)}
                        className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">Eyes Model</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Multimodal model used to describe images. <span className="font-mono">glm-5v-turbo</span> is the cheap-and-fast default. <span className="font-mono">gemini-3.5-flash</span> tends to produce richer, more nuanced descriptions at slightly higher cost. GLM variants use the Z.AI API key; Gemini variants use the Google API key — set whichever you pick in Preferences.
                      </p>
                      <select
                        value={eyesModel}
                        onChange={(e) => setEyesModel(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      >
                        <optgroup label="Z.AI / GLM (uses Z.AI API key)">
                          <option value="glm-5v-turbo">glm-5v-turbo</option>
                          <option value="glm-4.6v-flash">glm-4.6v-flash</option>
                          <option value="glm-4.6v">glm-4.6v</option>
                        </optgroup>
                        <optgroup label="Google Gemini (uses Google API key)">
                          <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                          <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                          <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                        </optgroup>
                        <optgroup label="Xiaomi MiMo (uses MiMo API key)">
                          <option value="mimo-v2.5">mimo-v2.5</option>
                        </optgroup>
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* ── "Ears" — audio bridge for non-audio-capable models ──────── */}
              <div className="border-t border-border pt-6 mt-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={earsEnabled}
                    onChange={(e) => setEarsEnabled(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">Enable &quot;Ears&quot; (audio bridge for non-audio-capable models)</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  When the active model can&apos;t accept audio (anything except Qwen-Omni and Gemini), NEXUS routes each audio attachment through a true-multimodal model and substitutes the raw audio with a text transcript + description. Cached on disk (<span className="font-mono">local_data/ears_cache/</span>) — the same audio file is never described twice.
                </p>
                {earsEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">Ears Prompt</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Entity-specific instruction sent to the audio bridge model. Adjust the language / level of detail to match your entity&apos;s voice.
                      </p>
                      <textarea
                        value={earsPrompt}
                        onChange={(e) => setEarsPrompt(e.target.value)}
                        className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">Ears Model</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Audio-capable model used for transcription/description. <span className="font-mono">qwen3.5-omni-flash</span> is the cheapest; Gemini variants tend to handle non-speech audio more richly. Needs the corresponding API key in Settings.
                      </p>
                      <select
                        value={earsModel}
                        onChange={(e) => setEarsModel(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      >
                        <option value="qwen3.5-omni-flash">qwen3.5-omni-flash</option>
                        <option value="qwen3.5-omni-plus">qwen3.5-omni-plus</option>
                        <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                        <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                        <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                        <option value="mimo-v2.5">mimo-v2.5 (Xiaomi)</option>
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* ── "Video Watcher" — video bridge for non-video-capable models ─ */}
              <div className="border-t border-border pt-6 mt-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={watcherEnabled}
                    onChange={(e) => setWatcherEnabled(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">Enable &quot;Video Watcher&quot; (video bridge for non-video-capable models)</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  When the active model can&apos;t accept video, NEXUS routes each video attachment through a multimodal model and substitutes the bytes with a chronological description of what happens on screen plus the audio track. Cached on disk (<span className="font-mono">local_data/watcher_cache/</span>). Video calls are the slowest of the three bridges (5–30 s typical), so the cache pays for itself quickly.
                </p>
                {watcherEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">Watcher Prompt</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Entity-specific instruction sent with each video. More detail in the prompt = longer descriptions but slower calls.
                      </p>
                      <textarea
                        value={watcherPrompt}
                        onChange={(e) => setWatcherPrompt(e.target.value)}
                        className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">Watcher Model</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Video-capable model. Gemini variants typically describe video content more accurately than Qwen-Omni; Qwen-Omni is the cheaper option for shorter clips.
                      </p>
                      <select
                        value={watcherModel}
                        onChange={(e) => setWatcherModel(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      >
                        <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                        <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                        <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                        <option value="qwen3.5-omni-flash">qwen3.5-omni-flash</option>
                        <option value="qwen3.5-omni-plus">qwen3.5-omni-plus (higher quality)</option>
                        <option value="mimo-v2.5">mimo-v2.5 (Xiaomi)</option>
                      </select>
                    </div>
                  </>
                )}
              </div>
              </>)}

              {activeSettingsTab === 'behavior' && (<>
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="checkbox"
                    id="vrchatMode"
                    checked={vrchatMode}
                    onChange={(e) => setVrchatMode(e.target.checked)}
                    className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                  />
                  <label htmlFor="vrchatMode" className="text-sm font-semibold text-foreground cursor-pointer">
                    Enable VRChat Mode
                  </label>
                </div>

                {vrchatMode && (
                  <div className="mb-6">
                    <label className="text-sm font-semibold text-foreground mb-1 block">VRChat Hidden Rule</label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Secretly appends these rules to the system prompt when VRChat mode is active.
                    </p>
                    <textarea
                      value={vrchatRule}
                      onChange={(e) => setVrchatRule(e.target.value)}
                      className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                    />
                  </div>
                )}
              </div>
              </>)}

              {activeSettingsTab === 'model' && (<>
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-4 block">Generation Parameters</h4>

                <div className="mb-4">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Date & Time Context</label>
                  <select
                    value={dateTimeVisibility}
                    onChange={(e) => setDateTimeVisibility(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  >
                    <option value="none">Not visible</option>
                    <option value="current">Only current message</option>
                    <option value="all">All conversation log</option>
                  </select>
                </div>

                <div className="mb-4">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">Base Model Family</label>
                  <select
                    value={localAiName}
                    onChange={(e) => {
                      const newAiName = e.target.value;
                      setLocalAiName(newAiName);
                      if (newAiName === 'Gemini' && !specificModel?.includes('gemini')) {
                        setSpecificModel('gemini-3.5-flash');
                      } else if (newAiName === 'Claude' && !specificModel?.includes('claude')) {
                        setSpecificModel('claude-sonnet-4-6');
                      } else if (newAiName === 'Qwen' && !specificModel?.startsWith('qwen')) {
                        setSpecificModel('qwen3.6-plus');
                      } else if (newAiName === 'DeepSeek' && !specificModel?.startsWith('deepseek')) {
                        setSpecificModel('deepseek-v4-flash');
                      } else if (newAiName === 'GLM' && !specificModel?.startsWith('glm')) {
                        setSpecificModel('glm-4.7');
                      } else if (newAiName === 'Grok' && !specificModel?.startsWith('grok')) {
                        setSpecificModel('grok-4.3');
                      } else if (newAiName === 'Kimi' && !specificModel?.toLowerCase().includes('kimi')) {
                        setSpecificModel('moonshotai/Kimi-K2.6');
                      } else if (newAiName === 'Cohere' && !specificModel?.startsWith('command-')) {
                        setSpecificModel('command-a-plus-05-2026');
                      } else if (newAiName === 'Minimax' && !specificModel?.toLowerCase().startsWith('minimax')) {
                        setSpecificModel('MiniMax-M3');
                      } else if (newAiName === 'ChatGPT' && !specificModel?.toLowerCase().startsWith('gpt')) {
                        setSpecificModel('gpt-5.4');
                      } else if (newAiName === 'MiMo' && !specificModel?.toLowerCase().startsWith('mimo')) {
                        setSpecificModel('mimo-v2.5');
                      } else if (newAiName === 'Local') {
                        // Clear so the user picks from the list LM Studio reports
                        if (specificModel?.includes('claude') || specificModel?.includes('gemini') || specificModel?.startsWith('qwen') || specificModel?.startsWith('deepseek') || specificModel?.startsWith('glm') || specificModel?.startsWith('grok') || specificModel?.toLowerCase().includes('kimi') || specificModel?.startsWith('command-') || specificModel?.toLowerCase().startsWith('minimax') || specificModel?.toLowerCase().startsWith('gpt') || specificModel?.toLowerCase().startsWith('mimo')) {
                          setSpecificModel('');
                        }
                      }
                    }}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  >
                    {['Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Kimi', 'Grok', 'Cohere', 'Minimax', 'ChatGPT', 'MiMo', 'Local'].map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                {localAiName === 'Claude' && (
                  <>
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Claude Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="claude-fable-5">Claude Fable 5 (adaptive thinking, flagship)</option>
                      <option value="claude-opus-4-8">Claude Opus 4.8 (thinking)</option>
                      <option value="claude-opus-4-7">Claude Opus 4.7 (thinking)</option>
                      <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (thinking)</option>
                      <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Claude Billing Mode</label>
                    <div className="flex gap-2">
                      {(['api-key', 'oauth'] as const).map(mode => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setClaudeAuthMode(mode)}
                          className={`flex-1 py-1.5 px-2 text-xs font-medium rounded border transition-colors ${
                            claudeAuthMode === mode
                              ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                              : 'border-border text-muted-foreground hover:border-indigo-400 hover:text-foreground'
                          }`}
                        >
                          {mode === 'api-key' ? 'Token-paid' : 'Monthly-paid'}
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      <strong>Token-paid</strong> — use the <span className="font-mono">sk-ant-...</span> API key from Preferences (pay per token).
                      <span className="block mt-0.5"><strong>Monthly-paid</strong> — use the <span className="font-mono">sk-ant-oat01-...</span> OAuth token from Preferences (Pro/Max subscription credit). Bakes in Anthropic&apos;s system prompt.</span>
                    </div>
                  </div>
                  </>
                )}

                {localAiName === 'Gemini' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Specific Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                      <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                      <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview</option>
                    </select>
                  </div>
                )}

                {localAiName === 'Qwen' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Qwen Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="qwen3.7-max">Qwen 3.7 Max (reasoning, text)</option>
                      <option value="qwen3.6-max-preview">Qwen 3.6 Max (text + vision)</option>
                      <option value="qwen3.6-plus">Qwen 3.6 Plus (text + vision)</option>
                      <option value="qwen3.5-omni-flash">Qwen 3.5 Omni Flash (text + vision + audio + video)</option>
                      <option value="qwen3.5-omni-plus">Qwen 3.5 Omni Plus (text + vision + audio + video — higher quality)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Uses Alibaba DashScope's OpenAI-compatible endpoint (international region). Set your API key in Preferences.
                      Only the <span className="font-mono">Omni</span> variant accepts audio &amp; video uploads — other Qwen models will reject them at the API level even though Qwen's own web app silently routes those uploads to Omni in the background.
                    </div>
                  </div>
                )}

                {localAiName === 'DeepSeek' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">DeepSeek Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <optgroup label="DeepSeek first-party API (api.deepseek.com)">
                        <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                        <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                        <option value="deepseek-reasoner">DeepSeek Reasoner (legacy alias)</option>
                        <option value="deepseek-chat">DeepSeek Chat (legacy alias)</option>
                      </optgroup>
                      <optgroup label="Alibaba DashScope (Qwen billing)">
                        <option value="deepseek-v3.2">DeepSeek V3.2 (hybrid reasoning)</option>
                      </optgroup>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      <strong>Routing is automatic based on the model:</strong>
                      <br />
                      &bull; <span className="font-mono">deepseek-v3.2</span> → Alibaba DashScope. Uses the Qwen/DashScope key. The only DeepSeek model available on the international Singapore DashScope endpoint.
                      <br />
                      &bull; All other models → <span className="font-mono">api.deepseek.com</span> directly. Requires a separate DeepSeek API key (add it in Preferences). V4 is current; <span className="font-mono">deepseek-chat</span>/<span className="font-mono">deepseek-reasoner</span> are legacy aliases for V4 Flash non-thinking / thinking modes (deprecated 2026-07-24).
                      <br />
                      The Thinking Mode toggle below applies to both routes.
                    </div>
                  </div>
                )}

                {localAiName === 'Minimax' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">MiniMax Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="MiniMax-M3">MiniMax M3 (flagship — multimodal, 1M context, agentic coding)</option>
                      <option value="MiniMax-M2.7">MiniMax M2.7 (coding + reasoning, 200K context)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Served by MiniMax's OpenAI-compatibility endpoint at <span className="font-mono">api.minimax.io/v1</span>. Set the MiniMax API key in Preferences. Reasoning is built into the model — no thinking toggle (analogous to DeepSeek R1). The model identifier <strong>is case-sensitive</strong> — capital M's, lowercase 'i', hyphen. <strong>M3</strong> adds native video understanding and a 1M-token context (MSA architecture) on top of M2.7's image input.
                    </div>
                  </div>
                )}

                {localAiName === 'Cohere' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Cohere Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="command-a-plus-05-2026">Command A Plus (May 2026 — flagship)</option>
                      <option value="command-a-reasoning-08-2025">Command A Reasoning (Aug 2025)</option>
                      <option value="command-a-vision-07-2025">Command A Vision (Jul 2025 — multimodal)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Served by Cohere's OpenAI-compatibility endpoint at <span className="font-mono">api.cohere.ai/compatibility/v1</span>. Set the Cohere API key in Preferences. The Thinking Mode toggle maps to Cohere's <span className="font-mono">reasoning_effort</span> field — Cohere accepts only <span className="font-mono">"high"</span> (on) or <span className="font-mono">"none"</span> (off), no gradations.
                    </div>
                  </div>
                )}

                {localAiName === 'Kimi' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Kimi Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="moonshotai/Kimi-K2.6">Kimi K2.6 (latest — 256K context, multimodal)</option>
                      <option value="moonshotai/Kimi-K2.5">Kimi K2.5 (agentic, multimodal)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Routes to Moonshot's first-party API (<span className="font-mono">api.moonshot.ai</span>) when the Kimi (Moonshot) key is set in Preferences — otherwise falls back to <span className="font-mono">platform.qubrid.com</span>. Model IDs are normalized automatically for whichever host is active.
                      {' '}When Thinking Mode is on, Moonshot recommends Temperature = 1.0 for best chain-of-thought quality.
                    </div>
                  </div>
                )}

                {localAiName === 'Grok' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Grok Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="grok-4.3">Grok 4.3 (flagship)</option>
                      <option value="grok-4.20-0309-reasoning">Grok 4.20 — Reasoning</option>
                      <option value="grok-4.20-0309-non-reasoning">Grok 4.20 — Non-reasoning (fast)</option>
                      <option value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast (legacy)</option>
                      <option value="grok-code-fast-1">Grok Code Fast 1 (coding)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Served by xAI at <span className="font-mono">api.x.ai/v1</span>. Set the xAI API key in Preferences. Reasoning depth is selected via the model identifier itself (the <span className="font-mono">-reasoning</span> / <span className="font-mono">-non-reasoning</span> variants) — there's no separate thinking toggle.
                    </div>
                  </div>
                )}

                {localAiName === 'ChatGPT' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">ChatGPT Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="gpt-5.5">GPT-5.5 (flagship)</option>
                      <option value="gpt-5.4">GPT-5.4</option>
                      <option value="gpt-5.4-mini">GPT-5.4 Mini (fast, cheaper)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Served by OpenAI's first-party API at <span className="font-mono">api.openai.com/v1</span>. Set the OpenAI API key in Preferences. The Thinking Mode toggle maps to OpenAI's <span className="font-mono">reasoning_effort</span> field — <span className="font-mono">high</span> (on) / <span className="font-mono">minimal</span> (off). GPT-5 reasoning models ignore custom Temperature / Top-P (so Creativity Control doesn't affect them). Images are supported; audio &amp; video uploads route through the Ears / Watcher bridges.
                    </div>
                  </div>
                )}

                {localAiName === 'MiMo' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">MiMo Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="mimo-v2.5-pro">MiMo V2.5 Pro (flagship reasoning — text only)</option>
                      <option value="mimo-v2.5">MiMo V2.5 (text + image input)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Served by Xiaomi's OpenAI-compatibility endpoint at <span className="font-mono">api.xiaomimimo.com/v1</span>. Set the MiMo API key in Preferences. Reasoning is built into the model — no thinking toggle (analogous to MiniMax / DeepSeek R1). <strong>Image input is only supported on <span className="font-mono">mimo-v2.5</span></strong> — the <span className="font-mono">mimo-v2.5-pro</span> tier is text-only on the hosted API (sending an image returns a 404). When you attach an image on Pro, the Eyes bridge (if enabled) will describe it via another model.
                    </div>
                  </div>
                )}

                {localAiName === 'GLM' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">GLM Model</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="glm-5.1">GLM-5.1 (latest)</option>
                      <option value="glm-5">GLM-5</option>
                      <option value="glm-5-turbo">GLM-5 Turbo (fast)</option>
                      <option value="glm-5v-turbo">GLM-5V Turbo (fast multimodal)</option>
                      <option value="glm-4.7">GLM-4.7</option>
                      <option value="glm-4.6">GLM-4.6 (200K context)</option>
                      <option value="glm-4.6v">GLM-4.6V (multimodal)</option>
                      <option value="glm-4.6v-flash">GLM-4.6V Flash (fast multimodal)</option>
                      <option value="glm-4.5-air">GLM-4.5 Air (cheap)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      Served by Z.AI (Zhipu) at <span className="font-mono">api.z.ai</span>. Set the Z.AI API key in Preferences. The Thinking Mode toggle below maps to GLM's <span className="font-mono">{'thinking: { type: enabled }'}</span> parameter.
                    </div>
                  </div>
                )}

                {localAiName === 'Local' && (
                  <>
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-muted-foreground">Local Model (from LM Studio)</label>
                        <button onClick={refreshLocalModels} className="text-[10px] text-indigo-500 hover:underline" type="button">refresh</button>
                      </div>
                      <select
                        value={specificModel}
                        onChange={(e) => setSpecificModel(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      >
                        {localModels.length === 0 && <option value="">— no models loaded —</option>}
                        {/* Keep current value selectable even if not in list */}
                        {specificModel && !localModels.includes(specificModel) && (
                          <option value={specificModel}>{specificModel} (not loaded)</option>
                        )}
                        {localModels.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      {localModelsError && (
                        <div className="text-[10px] text-red-500 mt-1">{localModelsError}</div>
                      )}
                    </div>
                    <div className="mb-4">
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        Context window (tokens)
                      </label>
                      <input
                        type="number"
                        min={1024}
                        step={1024}
                        value={modelParams.localContextWindow ?? 80000}
                        onChange={(e) => setModelParams({ ...modelParams, localContextWindow: parseInt(e.target.value) || 80000 })}
                        className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                      <div className="text-[10px] text-muted-foreground mt-1">
                        Match this to what you loaded in LM Studio. Used for token budgeting only — the actual limit is enforced by LM Studio.
                      </div>
                    </div>
                  </>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Temperature ({modelParams.temperature})</label>
                    <input type="range" min="0" max="2" step="0.1" value={modelParams.temperature} onChange={(e) => setModelParams({ ...modelParams, temperature: parseFloat(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Top P ({modelParams.topP})</label>
                    <input type="range" min="0" max="1" step="0.05" value={modelParams.topP} onChange={(e) => setModelParams({ ...modelParams, topP: parseFloat(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">Top K</label>
                    <input type="number" min="1" max="100" value={modelParams.topK} onChange={(e) => setModelParams({ ...modelParams, topK: parseInt(e.target.value) })} className="w-full px-2 py-1 bg-background border border-border rounded text-sm outline-none focus:ring-1 focus:ring-indigo-500" />
                  </div>
                  <div className="col-span-2 flex items-center gap-3 mt-1">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={seedEnabled}
                        onChange={(e) => setSeedEnabled(e.target.checked)}
                        className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                      />
                      <span className="text-xs font-medium text-muted-foreground">Fixed Seed</span>
                    </label>
                    {seedEnabled && (
                      <input
                        type="number"
                        value={seedValue}
                        onChange={(e) => setSeedValue(parseInt(e.target.value) || 0)}
                        className="w-28 px-2 py-1 bg-background border border-border rounded text-sm outline-none focus:ring-1 focus:ring-indigo-500"
                      />
                    )}
                    {seedEnabled && (
                      <span className="text-[10px] text-muted-foreground">same seed → same output (Local &amp; Gemini)</span>
                    )}
                  </div>
                  {specificModel?.includes('gemini') && (
                    <>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">Thinking Level</label>
                        <select
                          value={modelParams.thinkingLevel === 'none' ? 'minimal' : (modelParams.thinkingLevel || 'medium')}
                          onChange={(e) => setModelParams({ ...modelParams, thinkingLevel: e.target.value })}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm appearance-none cursor-pointer outline-none focus:ring-1 focus:ring-indigo-500"
                        >
                          <option value="minimal">Minimal (closest to off)</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium (Google default)</option>
                          <option value="high">High</option>
                        </select>
                        <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                          Gemini 3.x always thinks — "Minimal" is the lowest setting (full off is not supported by the API).
                        </div>
                      </div>
                      <div className="col-span-2 flex items-center gap-2 mt-2">
                        <input
                          type="checkbox"
                          id="websearch"
                          checked={modelParams.enableWebSearch || false}
                          onChange={(e) => setModelParams({ ...modelParams, enableWebSearch: e.target.checked })}
                          className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                        />
                        <label htmlFor="websearch" className="text-sm font-medium text-foreground cursor-pointer">
                          Enable Google Web Search Grounding
                        </label>
                      </div>
                    </>
                  )}
                  {(localAiName === 'Qwen' || localAiName === 'DeepSeek' || localAiName === 'GLM' || localAiName === 'Kimi' || localAiName === 'Cohere') && (
                    <div className="col-span-2 flex items-center gap-2 mt-2">
                      <input
                        type="checkbox"
                        id="qwenThinking"
                        checked={modelParams.qwenEnableThinking !== false}
                        onChange={(e) => setModelParams({ ...modelParams, qwenEnableThinking: e.target.checked })}
                        className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                      />
                      <label htmlFor="qwenThinking" className="text-sm font-medium text-foreground cursor-pointer">
                        Enable Thinking Mode
                        <span className="text-xs text-muted-foreground ml-1">(on/off only — applies to Qwen 3.x, DeepSeek V3.2/V4, GLM, Kimi K2.6, and Cohere Command A)</span>
                      </label>
                    </div>
                  )}
                  {(localAiName === 'Qwen' || localAiName === 'DeepSeek' || localAiName === 'GLM' || localAiName === 'Grok' || localAiName === 'Kimi' || localAiName === 'Minimax' || localAiName === 'Cohere' || localAiName === 'ChatGPT' || localAiName === 'MiMo' || localAiName === 'Local') && (
                    <div className="col-span-2 flex items-start gap-2 mt-2">
                      <input
                        type="checkbox"
                        id="webSearchCompat"
                        checked={modelParams.enableWebSearch || false}
                        onChange={(e) => setModelParams({ ...modelParams, enableWebSearch: e.target.checked })}
                        className="mt-0.5 rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                      />
                      <label htmlFor="webSearchCompat" className="text-sm font-medium text-foreground cursor-pointer leading-tight">
                        Enable Web Search &amp; Access
                        <div className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed font-normal">
                          Gives this model NEXUS&apos;s own server-side tools:
                          {' '}<span className="font-mono">web_search</span> (keyless DuckDuckGo → result list) and
                          {' '}<span className="font-mono">web_fetch</span> (opens one URL and reads the full page).
                          {' '}Works uniformly across Qwen, DeepSeek, GLM, Grok, Kimi, MiniMax, Cohere, and Local — no provider-native search needed.
                          {' '}Pages it actually opened appear as clickable <span className="font-medium">Web sources</span> under the reply (your proof it didn&apos;t hallucinate). Internal/localhost URLs are blocked.
                        </div>
                      </label>
                    </div>
                  )}
                  {localAiName === 'Claude' && (
                    <div className="col-span-2 space-y-3 mt-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="claudeWebSearch"
                          checked={modelParams.enableClaudeWebSearch || false}
                          onChange={(e) => setModelParams({ ...modelParams, enableClaudeWebSearch: e.target.checked })}
                          className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                        />
                        <label htmlFor="claudeWebSearch" className="text-sm font-medium text-foreground cursor-pointer">
                          Enable Web Search
                          <span className="text-xs text-muted-foreground ml-1">(API-key mode: Anthropic server-side <code>web_search</code> tool. Subscription/OAuth mode: Claude Code&apos;s built-in WebSearch/WebFetch.)</span>
                        </label>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id="claudeThinking"
                          checked={claudeThinking}
                          onChange={(e) => setClaudeThinking(e.target.checked)}
                          className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                        />
                        <label htmlFor="claudeThinking" className="text-sm font-medium text-foreground cursor-pointer">
                          Enable Extended Thinking
                          <span className="text-xs text-muted-foreground ml-1">(Opus/Sonnet only)</span>
                        </label>
                      </div>
                      {claudeThinking && (
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id="saveThinking"
                            checked={saveThinkingToLog}
                            onChange={(e) => setSaveThinkingToLog(e.target.checked)}
                            className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                          />
                          <label htmlFor="saveThinking" className="text-sm font-medium text-foreground cursor-pointer">
                            Save thinking process to log
                            <span className="text-xs text-muted-foreground ml-1">(adds [thinking] blocks to .md export)</span>
                          </label>
                        </div>
                      )}
                      {/* Thinking-depth (effort) — only the adaptive models
                          (Opus 4.7/4.8, Fable 5) support output_config.effort.
                          Applies to BOTH billing modes (API output_config and
                          the Agent SDK effort option). 'high' = API default. */}
                      {/fable-?5|mythos-?5|opus-4-?7|opus-4-?8/.test(specificModel || '') && (
                        <div className="mt-1">
                          <label className="text-xs font-medium text-muted-foreground block mb-1">
                            Thinking Level (effort)
                          </label>
                          <select
                            value={modelParams.claudeEffort || 'high'}
                            onChange={(e) => setModelParams({ ...modelParams, claudeEffort: e.target.value })}
                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                          >
                            <option value="low">Low — fastest, cheapest, may skip thinking</option>
                            <option value="medium">Medium — balanced</option>
                            <option value="high">High — default (deep reasoning)</option>
                            <option value="xhigh">X-High — deeper, for long agentic/coding work</option>
                            <option value="max">Max — absolute maximum capability</option>
                          </select>
                          <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                            Controls adaptive-thinking depth on Opus 4.7/4.8 and Fable 5. Works in both
                            Token-paid and Monthly-paid modes. <span className="font-mono">High</span> is the API default;
                            higher levels spend more tokens, lower levels are faster/cheaper.
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Automatic Model Selection — per-conversation. Pre-flight
                  call to GLM-4.6V Flash (thinking off) picks the actual model
                  via a `select_model` tool call before each user turn. The
                  resulting model+thinking-mode is shown in the AI message's
                  meta bar and persisted on the message, but NEVER sent back
                  in the next turn's context. */}
              <div className="border-t border-border pt-6 mt-6">
                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="checkbox"
                    id="autoModelSelect"
                    checked={autoModelSelectEnabled}
                    onChange={(e) => setAutoModelSelectEnabled(e.target.checked)}
                    className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                  />
                  <label htmlFor="autoModelSelect" className="text-sm font-semibold text-foreground cursor-pointer">
                    Automatic Model Selection
                  </label>
                  <span className="text-xs text-muted-foreground">(uses the currently-selected model as the selector)</span>
                </div>
                {autoModelSelectEnabled && (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Before each user turn, the <strong>currently-selected model</strong> (thinking forced off where possible) reads the criteria and the recent conversation, then calls <span className="font-mono">select_model(model_id)</span> to pick one from the allowed-models shortlist. Selection runs on every user turn so the model can change as the conversation shifts.{' '}
                      <span className="text-amber-500">Pick a fast/cheap model in the family selector above to keep selector latency low.</span>
                    </p>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">Criteria</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Free-form prose telling the selector when to pick which model. Examples: "prefer fast models for greetings", "prefer thinking models for code".
                      </p>
                      <textarea
                        value={autoModelSelectCriteria}
                        onChange={(e) => setAutoModelSelectCriteria(e.target.value)}
                        className="w-full min-h-[120px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-y focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        placeholder="Pick the model best suited to the user's most recent message..."
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold text-foreground">Allowed Models</label>
                        <button
                          type="button"
                          onClick={async () => {
                            // Confirm before clobbering hand-curated lists.
                            // Skip the prompt if the current value is empty
                            // or only comments / whitespace.
                            const meaningful = autoModelSelectAllowedModels
                              .split(/\r?\n/)
                              .map((s) => s.trim())
                              .some((s) => s && !s.startsWith('#'));
                            if (meaningful) {
                              const ok = window.confirm(
                                'Replace your current Allowed Models list with the full known-models template (plus currently-loaded local models)?'
                              );
                              if (!ok) return;
                            }
                            // Fetch the current LM Studio model list inline so
                            // the user's most recently-loaded models are
                            // included even if they haven't touched the Local
                            // engine UI this session. Fall back to the cached
                            // `localModels` state on fetch failure, with a
                            // commented note explaining why the local section
                            // might look empty.
                            let liveLocal: string[] = localModels;
                            let liveErr: string | null = localModelsError;
                            try {
                              const r = await fetch('/api/local/models');
                              const d = await r.json();
                              if (Array.isArray(d?.models)) {
                                liveLocal = d.models;
                                setLocalModels(d.models); // keep the engine UI in sync
                              }
                              liveErr = d?.error || null;
                              setLocalModelsError(liveErr);
                            } catch (e: any) {
                              liveErr = e?.message || 'Failed to reach LM Studio';
                              setLocalModelsError(liveErr);
                            }
                            setAutoModelSelectAllowedModels(buildAllModelsFill(liveLocal, liveErr));
                          }}
                          className="px-2 py-1 text-[11px] font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25 rounded transition-colors"
                          title="Fill the textarea with every model NEXUS knows about (Claude / Gemini / Qwen / DeepSeek / GLM / Grok / Kimi / Cohere / MiniMax) plus the LM Studio models currently loaded locally. Asks for confirmation if you've already written entries."
                        >
                          Fill all
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">
                        One model per line, pipe-delimited:{' '}
                        <span className="font-mono">family | specificModel | on|off | optional label</span>.{' '}
                        Lines starting with <span className="font-mono">#</span> are comments. The selector picks from THIS list only.
                      </p>
                      <textarea
                        value={autoModelSelectAllowedModels}
                        onChange={(e) => setAutoModelSelectAllowedModels(e.target.value)}
                        className="w-full min-h-[160px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-y focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        placeholder="Claude | claude-opus-4-7 | on | Claude Opus 4.7 Thinking"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-6 mt-6">
                <div className="flex items-center gap-2 mb-4">
                  <input
                    type="checkbox"
                    id="creativityControl"
                    checked={creativityControlEnabled}
                    onChange={(e) => setCreativityControlEnabled(e.target.checked)}
                    className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                  />
                  <label htmlFor="creativityControl" className="text-sm font-semibold text-foreground cursor-pointer">
                    Enable Creativity Control Mode
                  </label>
                </div>
                {creativityControlEnabled && (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Before each response the AI performs a hidden Layer 1 analysis and calls <span className="font-mono">set_creativity(C)</span> to choose its own generation parameters. Layer 2 then runs with <span className="font-mono">T = 2·C</span>, <span className="font-mono">P = 0.7 + 0.3·C</span>.
                    </p>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">Hidden Analysis Instruction</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Appended to the user's message in the Layer 1 call to guide the AI's creativity selection.
                      </p>
                      <textarea
                        value={hiddenAnalysisInstruction}
                        onChange={(e) => setHiddenAnalysisInstruction(e.target.value)}
                        className="w-full min-h-[160px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">Creativity Display Pattern</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        Prepended to every response. <span className="font-mono">{'{C}'}</span> is replaced with the chosen value (e.g. <span className="font-mono">0.75</span>).
                      </p>
                      <input
                        type="text"
                        value={creativityDisplayPattern}
                        onChange={(e) => setCreativityDisplayPattern(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>
              </>)}
            </div>

            <div className="flex justify-between items-center mt-6 shrink-0 border-t border-border pt-4">
              <button
                onClick={async () => {
                  try {
                    // CRITICAL: spread the existing folder.settings first so
                    // we don't wipe out fields page.tsx or other code paths
                    // wrote into it (convoOrder, themeCss, aiVoice, voicePitch,
                    // systemPromptHeader/Footer, maxRecommendedContext, etc.).
                    // The earlier version replaced the whole settings object
                    // with this short list, silently destroying everything else.
                    const existing: any =
                      (folders || []).find((f: any) => f.name === folderName)?.settings || {};
                    const newSettings = {
                      ...existing,
                      // Identity tab
                      systemPrompt,
                      toolUseEnabled,
                      agentFullSystemAccess,
                      agentDangerousTools,
                      instructionOverrides,
                      toolInstruction,
                      toolImageInstruction,
                      // Senses tab
                      eyesEnabled, eyesPrompt, eyesModel,
                      earsEnabled, earsPrompt, earsModel,
                      watcherEnabled, watcherPrompt, watcherModel,
                      // Behavior tab
                      dateTimeVisibility,
                      vrchatMode, vrchatRule,
                      creativityControlEnabled, hiddenAnalysisInstruction, creativityDisplayPattern,
                      seedEnabled, seedValue,
                      // Model tab
                      modelParams,
                      specificModel,
                      aiName: localAiName,
                      claudeAuthMode,
                      claudeThinking,
                      saveThinkingToLog,
                      autoModelSelectEnabled, autoModelSelectCriteria, autoModelSelectAllowedModels,
                    };
                    const res = await fetch('/api/folders', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: folderName, settings: newSettings }),
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    // Refresh the folder list in the parent so the next new
                    // conversation in this folder picks up these defaults.
                    if (typeof fetchFolders === 'function') fetchFolders();
                    alert('Saved as folder defaults!');
                  } catch (e: any) {
                    alert('Error saving defaults: ' + (e?.message || 'unknown'));
                  }
                }}
                className="px-4 py-2 text-sm font-medium bg-secondary text-secondary-foreground rounded-lg hover:opacity-90 transition-opacity"
              >
                Save as Folder Defaults
              </button>
              <button
                onClick={() => setIsPromptModalOpen(false)}
                className="px-6 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      <LiveSession
        open={liveOpen}
        onClose={() => setLiveOpen(false)}
        systemPrompt={vrchatMode ? `${systemPrompt}\n\n${vrchatRule}`.trim() : (systemPrompt || '')}
        voiceName={defaultLiveSessionVoice || 'Aoede'}
        aiVoice={folders?.find((f: any) => f.name === folderName)?.settings?.aiVoice}
        audioOutDevice1={globalSettings?.device1Id}
        audioOutDevice2={globalSettings?.device2Id}
        seedMessages={messages
          .filter((m: any) => isMessageOriginal(m.id))
          .map((m: any) => ({
            role: m.role,
            name: m.name,
            content: m.content || '',
          }))
        }
        onCommit={(newMessages: any[], images: any[]) => {
          // Convert returned plain objects into Nexus message shape and append.
          const toAdd = newMessages.map((m, i) => ({
            id: `${Date.now()}-${i}`,
            role: m.role,
            // Assistant messages keep the entity name (it represents the AI's
            // identity); user messages have NO name field — the user's identity
            // lives in `[username]` tags inside content.
            ...(m.role === 'assistant' ? { name: localAiName || folderName } : {}),
            content: m.content,
            timestamp: m.timestamp || Date.now(),
            tokens: Math.ceil((m.content || '').length / 4),
            textTokens: Math.ceil((m.content || '').length / 4),
            attachments: [],
            ...(m.thoughtProcess ? { thoughtProcess: m.thoughtProcess } : {}),
          }));
          // Attach the captured images to the FIRST user message of the new batch
          if (images?.length) {
            const firstUserIdx = toAdd.findIndex(m => m.role === 'user');
            if (firstUserIdx >= 0) {
              (toAdd[firstUserIdx] as any).attachments = images.map((img: any, k: number) => ({
                id: `${Date.now()}-img-${k}`,
                name: img.name,
                type: 'image/jpeg',
                isImage: true,
                dataUrl: img.dataUrl,
                tokens: 258,
                excluded: false,
              }));
            }
          }
          setMessages(prev => [...prev, ...toAdd]);
        }}
      />

      <SystemPromptUpdater
        open={sysPromptUpdaterOpen}
        onClose={() => setSysPromptUpdaterOpen(false)}
        folderName={folderName}
        convoId={convoId}
        title={title}
        // The agent only needs ORIGINAL messages (skip pre-clone history).
        // isMessageOriginal returns true when no marker is set, which matches
        // the spec ("conversation log – original messages only, skip copied ones").
        originalMessages={messages
          .filter((m: any) => isMessageOriginal(m.id))
          .map((m: any) => ({
            role: m.role,
            name: m.name,
            content: m.content || '',
            timestamp: m.timestamp,
          }))
        }
        aiName={localAiName}
        specificModel={specificModel}
        modelParams={modelParams}
        globalSettings={globalSettings}
        folders={folders}
        saveFolderSettings={async (fName: string, patch: any) => {
          const target = folders?.find((f: any) => f.name === fName);
          if (!target) return;
          await fetch('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: fName,
              settings: { ...target.settings, ...patch },
            }),
          });
          if (fetchFolders) fetchFolders();
        }}
        onFinalize={async ({ newSystemPrompt, newIndex }) => {
          // Hand off to page.tsx which owns the conversations list (clone +
          // mark first-original + switch).
          if (onCloneWithSystemPrompt) {
            await onCloneWithSystemPrompt({
              sourceId: convoId,
              newSystemPrompt,
              newIndex,
            });
          }
        }}
      />
    </div>
  );
}
