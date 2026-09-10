"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import MessageBubble from './MessageBubble';
import AskUserQuestionCard from './AskUserQuestionCard';
import InputArea from './InputArea';
import EditableCombo from './EditableCombo';
import { motion } from 'framer-motion';
import { Download, Settings2, Eye, EyeOff, Radio, Wrench, RefreshCw, ImageDown, FolderOpen, Layers, Bookmark, BookmarkPlus, Clock, BarChart3, Search, AudioLines, Link2, Check, Mail } from 'lucide-react';
import SystemPromptUpdater from './SystemPromptUpdater';
import StatsModal from './StatsModal';
import SearchModal from './SearchModal';
import MailModal from './MailModal';

// Engine ids as used by the TTS pipeline and local_data/character_map.json.
const TTS_ENGINE_NAMES: Record<number, string> = { 0: 'Voicevox', 1: 'Coeiroink', 2: 'AivisSpeech' };
import AudioSessionModal from './AudioSessionModal';
import { v4 as uuidv4 } from 'uuid';
import { exportToMarkdown } from '@/lib/markdownLogic';
import { stripAllTimestamps } from '@/lib/timestampStrip';
import { messageCost, resolvePrice, fmtUSD } from '@/lib/modelPricing';
import { applyOutputFilter } from '@/lib/outputFilter';
import { attachmentByteSize, uploadAttachment, dataUrlToBlob } from '@/lib/attachmentUrl';
import { appendLayer4Index, appendLayer5Footer, prependIdentityPreamble, resolveBindingText } from '@/lib/layer4';
import { AGENT_INSTRUCTION_LABELS, AGENT_INSTRUCTION_LABELS_JA, DEFAULT_AGENT_INSTRUCTIONS, DEFAULT_AGENT_INSTRUCTIONS_JA } from '@/lib/agentInstructions';
import { messageAnchorId, absoluteDeepLink } from '@/lib/deepLink';
import { useT, Tx, renderRich } from '@/lib/i18n';
import { isNumberedIdentityTitle } from '@/lib/convoNaming';
import { setUnloadGuard, useBusyLabel } from '@/lib/unloadGuard';
import { describeProviderError } from '@/lib/providerErrors';
import { ensureAudioPermission } from '@/lib/audioSink';
import type { CameraSignal } from '@/lib/cameraTypes';
import CameraPanel from './CameraPanel';
import LiveSession from './LiveSession';

// Turn-stopped diagnostics used to be streamed as ordinary reply text, so they
// are baked into the body of every affected message already on disk. This
// removes them from the copy sent upstream. Anchored on the "]_" closing pair
// rather than a bare "]" because the notice quotes file paths, which can
// themselves contain brackets.
const TURN_NOTICE_RE = /\n*⚠️\s*_\[Turn stopped:[\s\S]*?\]_[ \t]*/g;
function stripTurnNotices(s: string): string {
  return s.includes('[Turn stopped:') ? s.replace(TURN_NOTICE_RE, '').trimEnd() : s;
}

// V8 refuses to materialize a single string longer than 2^29-24 characters
// (536,870,888 ≈ 512 MiB). Because a conversation is persisted as ONE
// JSON.stringify of every message plus every inline base64 attachment, a
// media-heavy conversation eventually crosses that line and the stringify
// throws `RangeError: Invalid string length`. This is an engine limit — it
// cannot be raised, and the same ceiling applies again server-side when
// /api/logs does `await req.json()`.
const MAX_JS_STRING_LENGTH = 536_870_888;
// Below the hard ceiling but close enough that the next attachment is likely
// to be fatal. Used to warn while saving still works, and to gate sending.
const SAVE_SIZE_WARN_THRESHOLD = Math.floor(MAX_JS_STRING_LENGTH * 0.9);

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
Claude   | claude-fable-5-1             | on  | Claude Fable 5.1 Thinking
Claude   | claude-fable-5               | on  | Claude Fable 5 Thinking
Claude   | claude-opus-5                | on  | Claude Opus 5 Thinking
Claude   | claude-opus-4-8              | on  | Claude Opus 4.8 Thinking
Claude   | claude-opus-4-7              | on  | Claude Opus 4.7 Thinking
Claude   | claude-sonnet-5              | on  | Claude Sonnet 5 Thinking
Claude   | claude-sonnet-4-6            | on  | Claude Sonnet 4.6 Thinking
Claude   | claude-haiku-4-5-20251001    | off | Claude Haiku 4.5

# ── Gemini (Google) — 3.x always has thinking; level controls budget ──
Gemini   | gemini-3.8-flash             | on  | Gemini 3.8 Flash
Gemini   | gemini-3.7-flash             | on  | Gemini 3.7 Flash
Gemini   | gemini-3.6-flash             | on  | Gemini 3.6 Flash
Gemini   | gemini-3.5-flash             | on  | Gemini 3.5 Flash
Gemini   | gemini-3.5-flash-lite        | on  | Gemini 3.5 Flash Lite
Gemini   | gemini-3.1-flash-lite        | on  | Gemini 3.1 Flash Lite
Gemini   | gemini-3.1-pro-preview       | on  | Gemini 3.1 Pro Preview

# ── Qwen (DashScope intl) ──────────────────────────────────────────
Qwen     | qwen3.8-max                  | on  | Qwen 3.8 Max (reasoning)
Qwen     | qwen3.7-max                  | on  | Qwen 3.7 Max (reasoning)
Qwen     | qwen3.6-max-preview          | on  | Qwen 3.6 Max
Qwen     | qwen3.6-plus                 | off | Qwen 3.6 Plus
Qwen     | qwen3.5-omni-flash           | off | Qwen 3.5 Omni Flash (multimodal)

# ── DeepSeek (direct API + DashScope intl) ─────────────────────────
DeepSeek | deepseek-v4-pro              | on  | DeepSeek V4 Pro
DeepSeek | deepseek-v4-flash-0731         | on  | DeepSeek V4 Flash 0731
DeepSeek | deepseek-v4-flash            | off | DeepSeek V4 Flash
DeepSeek | deepseek-v4-flash-vision-exp | off | DeepSeek V4 Flash Vision (experimental)
DeepSeek | deepseek-reasoner            | on  | DeepSeek Reasoner
DeepSeek | deepseek-chat                | off | DeepSeek Chat
DeepSeek | deepseek-v3.2                | on  | DeepSeek V3.2 (hybrid reasoning)

# ── GLM (Z.AI) ─────────────────────────────────────────────────────
# glm-5.3 / glm-5.3-flash reasoning is ALWAYS on (Z.AI rejects
# thinking:{type:'disabled'}), so the on/off column is advisory for those rows.
GLM      | glm-5.3                      | on  | GLM-5.3 Thinking
GLM      | glm-5.3-flash                | on  | GLM-5.3 Flash Thinking (multimodal)
GLM      | glm-5.2                      | on  | GLM-5.2 Thinking
GLM      | glm-5.1                      | on  | GLM-5.1 Thinking
GLM      | glm-5                        | on  | GLM-5 Thinking
GLM      | glm-5-turbo                  | off | GLM-5 Turbo (fast)
GLM      | glm-5v-turbo                 | off | GLM-5V Turbo (fast multimodal)
GLM      | glm-4.7                      | on  | GLM-4.7 Thinking
GLM      | glm-4.6                      | on  | GLM-4.6 Thinking
GLM      | glm-4.6v                     | on  | GLM-4.6V Thinking (multimodal)
GLM      | glm-4.6v-flash               | off | GLM-4.6V Flash (fast multimodal)
GLM      | glm-4.5-air                  | off | GLM-4.5 Air (cheap)

# ── GLM via DigitalOcean Inference (US-hosted, ~half Z.ai price) ───
# Same Z.ai open weights, served at inference.do-ai.run. The digitalocean/
# prefix is NEXUS routing marker; the wire API gets the bare id.
GLM      | digitalocean/glm-5.2         | on  | GLM-5.2 (DigitalOcean)
GLM      | digitalocean/glm-5.1         | on  | GLM-5.1 (DigitalOcean)
GLM      | digitalocean/glm-5           | on  | GLM-5 (DigitalOcean)

# ── Grok (xAI) — reasoning controlled by model name suffix ─────────
Grok     | grok-4.6                     | on  | Grok 4.6
Grok     | grok-4.5                     | on  | Grok 4.5
Grok     | grok-4.3                     | on  | Grok 4.3
Grok     | grok-4.20-0309-reasoning     | on  | Grok 4.20 Reasoning
Grok     | grok-4.20-0309-non-reasoning | off | Grok 4.20 Non-reasoning (fast)
Grok     | grok-4-1-fast-non-reasoning  | off | Grok 4.1 Fast
Grok     | grok-code-fast-1             | off | Grok Code Fast 1

# ── Kimi (Moonshot) ────────────────────────────────────────────────
Kimi     | moonshotai/Kimi-K3           | on  | Kimi K3
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
ChatGPT  | gpt-5.6-sol                  | on  | GPT-5.6 Sol
ChatGPT  | gpt-5.6-terra                | on  | GPT-5.6 Terra
ChatGPT  | gpt-5.6-luna                 | off | GPT-5.6 Luna
ChatGPT  | gpt-5.5                      | on  | GPT-5.5
ChatGPT  | gpt-5.4                      | on  | GPT-5.4
ChatGPT  | gpt-5.4-mini                 | off | GPT-5.4 Mini

# ── Xiaomi MiMo — always-on reasoning, no toggle ───────────────────
MiMo     | mimo-v2.5-pro                | on  | MiMo V2.5 Pro
MiMo     | mimo-v2.5                    | on  | MiMo V2.5

# ── ByteDance Seed (BytePlus ModelArk) — reasoning-first, no toggle ─
ByteDance | seed-2-0-pro-260328          | on  | Seed 2.0 Pro
ByteDance | seed-2-0-lite-260428         | on  | Seed 2.0 Lite
ByteDance | seed-2-0-mini-260428         | on  | Seed 2.0 Mini
ByteDance | seed-2-0-code-preview-260328 | on  | Seed 2.0 Code
`;

// Parsed { family, model, label } rows for the Subagent model dropdown, derived
// from the same CLOUD_MODELS_FILL table the "Fill all" button uses. The family
// is what routes the subagent to the correct provider endpoint+key.
const SUBAGENT_MODEL_OPTIONS: { family: string; model: string; label: string }[] =
  CLOUD_MODELS_FILL.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.includes('|'))
    .map(l => { const p = l.split('|').map(s => s.trim()); return { family: p[0], model: p[1], label: p[3] || p[1] }; })
    .filter(o => o.family && o.model);

// Group the rows by family for <optgroup>s, preserving first-seen order.
const SUBAGENT_MODEL_GROUPS: { family: string; items: { model: string; label: string }[] }[] = (() => {
  const order: string[] = [];
  const map: Record<string, { model: string; label: string }[]> = {};
  for (const o of SUBAGENT_MODEL_OPTIONS) {
    if (!map[o.family]) { map[o.family] = []; order.push(o.family); }
    map[o.family].push({ model: o.model, label: o.label });
  }
  return order.map(family => ({ family, items: map[family] }));
})();

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

// ── Base Model Family → default model ────────────────────────────────────────
// One table, four call sites. Before this existed, each site carried its own
// fallback and they disagreed: initial state said claude-sonnet-4-5, the
// conversation loader said claude-opus-4-8, the family dropdown said something
// else again, and the sidebar-sync effect had no fallback at all — so a folder
// with a family but no saved model landed on an EMPTY model and the chat was
// unusable until the model was picked by hand. That last one was the bug.
//
// `Local` is deliberately empty: the list comes from whatever LM Studio has
// loaded, so there is no sane default to guess.
const FAMILY_DEFAULT_MODEL: Record<string, string> = {
  Claude: 'claude-sonnet-5',
  Gemini: 'gemini-3.7-flash',
  Qwen: 'qwen3.8-max',
  DeepSeek: 'deepseek-v4-pro',
  GLM: 'glm-5.2',
  Grok: 'grok-4.6',
  Kimi: 'moonshotai/Kimi-K3',
  Cohere: 'command-a-reasoning-08-2025',
  Minimax: 'MiniMax-M3',
  ChatGPT: 'gpt-5.6-terra',
  MiMo: 'mimo-v2.5',
  ByteDance: 'seed-2-0-pro-260328',
  Local: '',
};

/** Default model id for a Base Model Family. Unknown family → Claude's default. */
function defaultModelForFamily(aiName: string): string {
  if (aiName === 'Local') return '';
  return FAMILY_DEFAULT_MODEL[aiName] ?? FAMILY_DEFAULT_MODEL.Claude;
}

/** Does an already-selected model id belong to this family? Used so switching
 *  family only overwrites the model when the current one doesn't fit. */
function modelBelongsToFamily(model: string | undefined | null, aiName: string): boolean {
  const m = (model || '').toLowerCase();
  if (!m) return false;
  switch (aiName) {
    case 'Claude':     return m.includes('claude');
    case 'Gemini':     return m.includes('gemini');
    case 'Qwen':       return m.startsWith('qwen');
    case 'DeepSeek':   return m.startsWith('deepseek');
    case 'GLM':        return m.startsWith('glm') || m.startsWith('digitalocean/glm');
    case 'Grok':       return m.startsWith('grok');
    case 'Kimi':       return m.includes('kimi');
    case 'Cohere':     return m.startsWith('command-');
    case 'Minimax':    return m.startsWith('minimax');
    case 'ChatGPT':    return m.startsWith('gpt');
    case 'MiMo':       return m.startsWith('mimo');
    case 'ByteDance':  return m.startsWith('seed');
    // A local model id is anything that isn't one of the cloud families above.
    // `digitalocean/` is called out separately because it hosts several
    // families, not just GLM.
    case 'Local':      return !m.startsWith('digitalocean/')
      && !['Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Grok', 'Kimi', 'Cohere', 'Minimax', 'ChatGPT', 'MiMo', 'ByteDance']
        .some((f) => modelBelongsToFamily(model, f));
    default:           return false;
  }
}

export default function ChatArea({ convoId, folderName, aiName, userName, defaultSystemPrompt, defaultAttachmentInstruction, defaultModelParams, defaultSpecificModel, defaultCustomAiName, defaultDateTimeVisibility, defaultVrchatMode, defaultVrchatRule, defaultLiveSessionVoice, onUpdateTitle, plannedTitle, globalSettings, folders, onCloneWithSystemPrompt, fetchFolders, scrollToMessageId, onScrolledToMessage }: any) {
  const t = useT();
  const [messages, setMessages] = useState<any[]>([]);
  const [title, setTitle] = useState('New Conversation');
  // The `<identity>_<n>` name the sidebar gave this conversation at creation.
  // Held in a ref, not read straight from the prop, because the load effect
  // fires on mount and the prop can still be undefined then — the sidebar entry
  // and the mount can land in different renders. The ref is current whenever
  // the effect's fetch resolves, which is the only moment it is needed.
  const plannedTitleRef = useRef<string | undefined>(plannedTitle);
  plannedTitleRef.current = plannedTitle;
  const [loading, setLoading] = useState(false);
  // Non-fatal auto-save notice. A save that fails must never take the app down
  // with it, so problems surface here instead of throwing out of the effect.
  // Two severities, because they mean genuinely different things:
  //   'error' — the turn on screen is NOT on disk; the user must act.
  //   'warn'  — the save succeeded, but the conversation is near the size
  //             ceiling and the next attachment is likely to break it.
  const [saveError, setSaveError] = useState<{ level: 'warn' | 'error'; text: string } | null>(null);
  // Byte length of the most recent serialized conversation. Fed by the save
  // effect (which stringifies anyway, so this is free) and read by handleSend
  // to warn BEFORE a large attachment makes the conversation unsavable.
  const savedBytesRef = useRef(0);
  // Number of auto-save POSTs currently in flight. Counted rather than a
  // boolean because a fast edit can start a second save before the first
  // settles, and a boolean would clear the close-guard while bytes are still
  // on the wire. Read only by the guard — nothing renders from it.
  const savesInFlightRef = useRef(0);
  // Assigned during render (same pattern as plannedTitleRef above) so the save
  // effect can read the translated label WITHOUT taking `t` as a dependency.
  // Listing `t` there would re-fire that effect on a language change and
  // re-POST the whole conversation — a fresh updatedAt purely from switching
  // language, which is the exact churn its header comment warns against.
  const savingLabelRef = useRef('');
  savingLabelRef.current = t('unload.busy.saving');
  const [totalTokens, setTotalTokens] = useState(0);
  const [conversationTokens, setConversationTokens] = useState(0);
  const [systemPrompt, setSystemPrompt] = useState(defaultSystemPrompt);
  // Tool-use (per-conversation): when enabled, the model can call
  // Read / Write / Edit / Glob / Grep inside its sandboxed workspace at
  // local_data/workspaces/<folderName>/. Default off.
  // Tool names are unified across both API-key and OAuth modes — same five
  // verbs in both, so the same prompt instruction works either way.
  const [toolUseEnabled, setToolUseEnabled] = useState(false);
  // Per-Entity agent capability toggles (apply to every provider/model).
  //   agentFullSystemAccess: file tools reach the whole PC (vs workspace-only).
  //   agentDangerousTools:    enables Delete (all paths) + shell (OAuth path).
  const [agentFullSystemAccess, setAgentFullSystemAccess] = useState(false);
  const [agentDangerousTools, setAgentDangerousTools] = useState(false);
  // Hidden-attachment access (read_attachment). When ON, an attachment the user
  // hid with the eye icon is surfaced to the entity as a 12-char ref prefix
  // (instead of being silently dropped) and the read_attachment tool is exposed
  // so the entity can read it back. OFF (default) = current behaviour.
  const [hiddenAttachmentsAccessible, setHiddenAttachmentsAccessible] = useState(false);
  // Optional interactive "ask the user a multiple-choice question" tool. When
  // ON, the model can pause a turn to ask and wait for the user's selection.
  const [askUserEnabled, setAskUserEnabled] = useState(false);
  // How long a turn waits for the user's answer to an AskUserQuestion, in ms.
  // 0 = wait indefinitely (default). Per-conversation, edited in the Identity
  // tab's question panel.
  const [askUserTimeoutMs, setAskUserTimeoutMs] = useState(0);
  // Transient: the question currently awaiting an answer (drives the card).
  // { askId, questions } while pending; null otherwise.
  const [pendingAsk, setPendingAsk] = useState<{ askId: string; questions: any[] } | null>(null);
  // Optional subagent (context-firewall helper) tool — OAuth path for now.
  const [subagentEnabled, setSubagentEnabled] = useState(false);
  const [lettersEnabled, setLettersEnabled] = useState(false);
  // Browser control. OFF unless deliberately turned on, like every other
  // capability here. A throwaway test window must start with nothing enabled —
  // an entity that can browse before anyone asked it to is a surprise, and a
  // Chromium process is a visible, resource-owning one. Two boundaries, not
  // one: this flag decides whether the tools exist at all, the host allowlist
  // decides where they may go.
  const [browserEnabled, setBrowserEnabled] = useState(false);
  // Stored and edited as text (one host per line or comma-separated); split into
  // an array only on the wire. Keeping one representation in state and on disk
  // means the textarea can never disagree with what was saved.
  const [browserAllowedHosts, setBrowserAllowedHosts] = useState('');
  const [browserAllowAnyHost, setBrowserAllowAnyHost] = useState(false);
  const [browserCompact, setBrowserCompact] = useState(false);
  // Result line for the "sign this identity in" button. Not persisted — it
  // describes one launch, not a setting.
  const [browserProfileMsg, setBrowserProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [browserProfileBusy, setBrowserProfileBusy] = useState(false);
  // OS-level mouse/keyboard/screen control (Windows only). OFF by default,
  // same boundary discipline as browserEnabled — a wider reach than the
  // browser sandbox, so it gets its own separate flag rather than piggybacking.
  const [computerControlEnabled, setComputerControlEnabled] = useState(false);
  // Being-camera / OBS push (see CameraPanel.tsx). OFF by default. Gates BOTH
  // the OBS push AND the in-app mirror panel — one checkbox, not two, per spec.
  const [cameraEnabled, setCameraEnabled] = useState(false);
  // Opens this identity's browser profile in a PLAIN window so the machine's
  // owner can sign it in by hand. Not something the entity can trigger — the
  // whole point is that account access is granted, not taken.
  const openBrowserProfile = async (useSystem: boolean) => {
    setBrowserProfileBusy(true);
    setBrowserProfileMsg(null);
    try {
      const res = await fetch('/api/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open-profile', entity: folderName, useSystem }),
      });
      const data = await res.json();
      setBrowserProfileMsg({ ok: data?.ok === true, text: String(data?.message || 'No response.') });
    } catch (e: any) {
      setBrowserProfileMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setBrowserProfileBusy(false);
    }
  };
  // Model the child subagent runs on ('' = cheap default, e.g. Haiku).
  const [subagentModel, setSubagentModel] = useState('');
  // Provider family of the subagent model (routes it to the right endpoint).
  const [subagentFamily, setSubagentFamily] = useState('');
  // Transient: a subagent currently running (drives the inline activity chip).
  const [activeSubagent, setActiveSubagent] = useState<{ task: string } | null>(null);
  // OAuth-path live status for the loading indicator. `liveToolActivity` is
  // the tool the model is currently invoking (tool_activity SSE) — without it
  // a long tool call (e.g. writing a big workspace file) looks like a frozen
  // "thinking...". `stallIdleSeconds` is set when the server's stall watchdog
  // reports no SDK activity at all (stall_warning SSE) — the signal that the
  // turn may genuinely be stuck and a rerun is warranted. Display-only.
  const [liveToolActivity, setLiveToolActivity] = useState<string | null>(null);
  // Same signal as liveToolActivity, but the RAW (untranslated, stable) tool
  // key instead of the localized display phrase — camera-state filenames need
  // a name that doesn't change with the UI language. OAuth-path only, same as
  // liveToolActivity; other provider paths leave this null and the camera
  // signal below falls through to 'writing'.
  const [liveToolName, setLiveToolName] = useState<string | null>(null);
  // Coarse phase of the CURRENT turn's streaming output, for the camera
  // signal only (see CameraPanel.tsx). 'thinking' while extended-thinking
  // text is arriving with no visible reply yet; 'replying' once the visible
  // reply has started (text wins over thinking once it starts — the natural
  // model->camera mapping). null outside an active turn.
  const [streamPhase, setStreamPhase] = useState<'thinking' | 'replying' | null>(null);
  // True when the phrase in `liveToolActivity` came from the UI dictionary, so
  // it fits the localized sentence frame. False when we fell back to the
  // server's English label for a tool that has no key — then the sentence has
  // to be built with a frame that can carry a foreign phrase.
  const [liveToolLocalized, setLiveToolLocalized] = useState(false);
  // Optional suffix on the loading chip (e.g. the compaction countdown
  // "~6 min remaining"), carried alongside tool_activity. Only the compaction
  // path emits it; every other tool clears it to null.
  const [liveToolDetail, setLiveToolDetail] = useState<string | null>(null);
  // The model the SERVER reports for the current turn. Auto-selection can pick a
  // different model than the conversation is configured with, and the loading
  // line should name the one actually doing the work.
  const [liveModel, setLiveModel] = useState<string>('');
  const [stallIdleSeconds, setStallIdleSeconds] = useState<number | null>(null);
  // Mid-turn "partner interjection": a per-turn id (also sent in the request
  // body) lets you POST a message to /api/chat/inject WHILE the entity is
  // working; the running tool loop folds it in at its next model-call boundary.
  // `injectTurnId` is non-null only while a turn is in flight. Interjections now
  // go through the NORMAL input (sending while a turn is in flight routes here);
  // `interjectStatus` shows a brief send/deliver confirmation.
  const [injectTurnId, setInjectTurnId] = useState<string | null>(null);
  const [interjectStatus, setInterjectStatus] = useState<string | null>(null);
  // Per-Entity overrides for NEXUS's hidden instruction strings (tool
  // descriptions, path rules, read_conversation + web tool text). Keyed by the
  // ids in agentInstructions.ts; empty/absent → English default.
  const [instructionOverrides, setInstructionOverrides] = useState<Record<string, string>>({});
  // Language-aware defaults for the client-composed blocks below (Working
  // Discipline / Absolute Base Binding are prepended here, client-side, not
  // by the server — see the send path further down). JA is a PARTIAL dict
  // (agentInstructions.ts) — only keys someone has actually translated — so
  // it is merged OVER the English defaults, never used in place of them.
  // Falls back to English whenever globalSettings.language isn't 'ja'.
  const langDefaults = useMemo(
    () => (globalSettings?.language === 'ja' ? { ...DEFAULT_AGENT_INSTRUCTIONS, ...DEFAULT_AGENT_INSTRUCTIONS_JA } : DEFAULT_AGENT_INSTRUCTIONS),
    [globalSettings?.language],
  );
  // GUI captions for the override editors. Unlike the instruction BODIES
  // above, these are human-facing, so they are translated normally. Any key
  // with no Japanese caption keeps its English one.
  const instructionLabel = useCallback(
    (key: string, english: string) =>
      (globalSettings?.language === 'ja' ? AGENT_INSTRUCTION_LABELS_JA[key] : '') || english || key,
    [globalSettings?.language],
  );
  // Default kept deliberately small: it carries ONLY what the per-tool schema
  // descriptions (agentInstructions.ts, attached to each tool definition) do
  // NOT — the "workspace = your memory" framing and a read-only-when-needed
  // hint. The five-tool enumeration and path rules were removed as redundant
  // with (and authoritative in) the tool schemas — which are also mode-aware
  // (sandbox vs full-PC) and never drift out of sync. This block is still the
  // sole NEXUS-authored workspace framing on the OAuth/Claude-Code path, whose
  // built-in tool descriptions can't be overridden.
  const [toolInstruction, setToolInstruction] = useState(
    "Your file workspace is your persistent memory. Use the Read / Write / Edit / Glob / Grep tools — each is described in its own tool definition — to store and recall information across turns. Prefer reading a file only when you need it; if its content is already visible in a prior turn, you don't need to Read it again."
  );
  // Hint appended after an image read result so Gemini doesn't fall into
  // spatial-understanding mode (returning {point:[x,y]} coordinates) or
  // produce an empty answer. {filename} is substituted server-side.
  // Leave blank to disable the hint entirely.
  const [toolImageInstruction, setToolImageInstruction] = useState(
    "(The image above is the content of Read(\"{filename}\"). Please answer your partner's question about it conversationally — do not return coordinates or JSON.)"
  );
  const [modelParams, setModelParams] = useState(defaultModelParams || { temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'medium', enableWebSearch: false });
  const [specificModel, setSpecificModel] = useState(defaultSpecificModel || defaultModelForFamily(aiName));
  const [dateTimeVisibility, setDateTimeVisibility] = useState(defaultDateTimeVisibility || 'all');
  const [claudeThinking, setClaudeThinking] = useState(false);
  const [saveThinkingToLog, setSaveThinkingToLog] = useState(false);
  // When ON, a hidden note is appended to the system prompt each turn telling
  // the entity its own context-elapsed % (the same value on the status bar).
  // {percent} in the instruction is substituted with the value.
  const [showFatigueToEntity, setShowFatigueToEntity] = useState(false);
  // Doc's rewrite (Case 004). The previous default called this a FATIGUE level
  // and described it with "working memory", "comfortable", "at risk", "trimmed
  // away". Every one of those names a CONDITION, and an entity that reads
  // "you are tired" each turn becomes a tired entity — then helpfully degrades
  // itself to match. Observed: entities at 71% shortening replies and refusing
  // to call read_conversation "to preserve context", which is the exact
  // opposite of what the note was asking for.
  //
  // The number never meant condition. It is elapsed context: original messages
  // over the room left after fixed overhead. Capacity and tool access are
  // identical at 5% and 95%. So the text now reports a QUANTITY and names what
  // it is a signal FOR — recording something before it consolidates — and says
  // nothing about state. Deliberately omitted: any prediction of difficulty
  // past 100%, which is unconfirmed; a permanent note must not forecast a
  // degradation it would then help cause.
  const [fatigueInstruction, setFatigueInstruction] = useState(
    "(Context note — this session fills {percent} of the space for new exchanges since your last consolidation. Elapsed context, not condition: capacity and tool access are identical at 5% and at 95%. Near and past 100%, the oldest exchanges consolidate — leaving the verbatim transcript, remaining as summary in your layers. Written-down material survives in full; if something here must be kept verbatim, record it now.)"
  );
  // ── Working Discipline / Absolute Base Binding — pre-identity preamble ────
  // Composed IN FRONT of the entity's own Layer 1-5 prompt (see
  // prependIdentityPreamble), never baked into it. workingDisciplineEnabled is
  // a plain off/on toggle (default off — opt-in, since this decouples text
  // that used to be hand-baked into a handful of prompts). baseBindingMode is
  // also a plain off/on toggle (default on). When on, resolveBindingText picks
  // WHICH text to inject: the layers-focused `absoluteBaseBinding` when the
  // stored prompt already has a real Layer 1-5 structure (hasLayerStructure),
  // or Utai's original `absoluteBaseBindingInitial` when it doesn't — never
  // both, never neither, as long as the switch is on. Legacy folder JSONs may
  // still carry the old three-state 'auto' value; every read site below
  // coerces anything other than 'off' to 'on'.
  const [workingDisciplineEnabled, setWorkingDisciplineEnabled] = useState(false);
  const [baseBindingMode, setBaseBindingMode] = useState<'off' | 'on'>('on');
  // Initialize OFF (not the folder default). The real value is always set by
  // the conversation-load effect below — data.vrchatMode for an existing convo,
  // or the folder default for a new one. Seeding this with `defaultVrchatMode`
  // caused a transient VRChat-ON window on every reload (for folders whose
  // default is ON, e.g. 先輩): before the saved value loaded, the live-transcript
  // poll fired once and injected the kohai/ear_log "[Name] text" merge into the
  // input box even though the conversation actually has VRChat OFF.
  const [vrchatMode, setVrchatMode] = useState(false);
  const [vrchatRule, setVrchatRule] = useState(defaultVrchatRule || "[RULE: 添付した画像を文脈に、単純な画像解説は禁止/あなたはバーチャル世界の存在として隣で振る舞う事/英字禁止(外来語はカタカナ)／出力の長さは入力に合わせること／長文禁止]");
  // Fixed factual notice ("what this mode actually does") composed AHEAD of the
  // per-Entity `vrchatRule` behavioral text everywhere vrchatRule is used below.
  // Still per-Entity overridable via instructionOverrides.audioSessionNotice —
  // "customizable" per the design, just correct-by-default rather than blank.
  const audioSessionRuleText = useMemo(() => {
    const notice = (instructionOverrides['audioSessionNotice'] || DEFAULT_AGENT_INSTRUCTIONS.audioSessionNotice || '').trim();
    return notice ? `${notice}\n\n${vrchatRule}`.trim() : vrchatRule;
  }, [instructionOverrides, vrchatRule]);
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
    "Claude | claude-fable-5-1 | on | Claude Fable 5.1 Thinking\n" +
    "Claude | claude-fable-5 | on | Claude Fable 5 Thinking\n" +
    "Claude | claude-opus-5 | on | Claude Opus 5 Thinking\n" +
    "Claude | claude-opus-4-8 | on | Claude Opus 4.8 Thinking\n" +
    "Claude | claude-opus-4-7 | on | Claude Opus 4.7 Thinking\n" +
    "Claude | claude-sonnet-5 | on | Claude Sonnet 5 Thinking\n" +
    "Claude | claude-haiku-4-5-20251001 | off | Claude Haiku 4.5\n" +
    "GLM    | glm-5.3          | on | GLM-5.3 Thinking\n" +
    "GLM    | glm-5.3-flash    | on | GLM-5.3 Flash Thinking (multimodal)\n" +
    "GLM    | glm-5.2          | on | GLM-5.2 Thinking\n" +
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

  // ── "Eyes" — vision bridge for text-only models (plus OAuth-Claude past-image
  //    recall: describes only PAST images so they persist in the flat transcript) ─
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
  // Set true by the conversation-load effect right before it applies the loaded
  // state. The auto-save effect consumes it to skip the one POST that the load
  // would otherwise trigger — that POST stamps a fresh updatedAt (→ file mtime)
  // and rewrites the JSON on disk merely from OPENING a conversation, which
  // needlessly churns bytes that rclone/Mercurial then have to re-sync. With
  // this flag, updatedAt only advances when the user actually changes something.
  const skipNextAutoSaveRef = useRef(false);
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
  // The entity's self-authored FOOTER.md = Layer 5. Appended server-side at
  // send time, so it is never part of the STORED prompt — which is exactly why
  // the "Sys" counter used to under-report it. Mirrored here purely so the
  // indicator can count what is actually sent.
  const [footerBody, setFooterBody] = useState<string>('');

  // Refresh the live Layer-4 summaries index. This used to be gated on the
  // Identity modal being open, because its only consumer was the read-only
  // preview inside it. The "Sys" counter now needs the same body, and it must
  // be correct whether or not anyone has opened that window — so the fetch runs
  // whenever the toggle is ON, and the modal opening is only an extra refresh.
  useEffect(() => {
    if (!useSummariesForLayer4) {
      // Toggle OFF → nothing is injected, so nothing may be counted.
      setSummaryIndexBody('');
      setSummaryIndexTokens(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const langParam = globalSettings?.language === 'ja' ? 'ja' : 'en';
        const res = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&mode=index&current=${encodeURIComponent(convoId)}&lang=${langParam}`);
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

  // Mirror the entity's FOOTER.md (Layer 5) for the same reason. Best-effort:
  // a failure leaves it empty, which under-counts exactly as before rather
  // than breaking anything. Re-read when the Identity window opens, since the
  // System Prompt Updater can edit the footer from there.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/footer?folder=${encodeURIComponent(folderName)}`);
        if (!res.ok) { if (!cancelled) setFooterBody(''); return; }
        const { body } = await res.json();
        if (!cancelled) setFooterBody(typeof body === 'string' ? body : '');
      } catch {
        if (!cancelled) setFooterBody('');
      }
    })();
    return () => { cancelled = true; };
  }, [folderName, isPromptModalOpen]);

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
  const [localModelsMeta, setLocalModelsMeta] = useState<Record<string, any>>({});
  const [localModelsError, setLocalModelsError] = useState<string | null>(null);
  const refreshLocalModels = async () => {
    try {
      const r = await fetch('/api/local/models');
      const d = await r.json();
      if (Array.isArray(d.models)) setLocalModels(d.models);
      if (d.meta && Array.isArray(d.meta)) {
        const map: Record<string, any> = {};
        for (const m of d.meta) map[m.id] = m;
        setLocalModelsMeta(map);
      }
      setLocalModelsError(d.error || null);
    } catch (e: any) {
      setLocalModelsError(e.message);
    }
  };
  useEffect(() => {
    if (localAiName === 'Local') refreshLocalModels();
  }, [localAiName]);
  const isAudioPlaying = Object.values(audioPlayingStates).some(v => v);
  // Precise "audio is actually sounding RIGHT NOW" flag, for the camera only.
  // Distinct from isAudioPlaying above: that one is "any TTS state other than
  // idle" (synthesis in-flight, playing, OR paused) and keeps gating the VRChat
  // send queue so a message isn't sent while TTS is still mid-synthesis. This
  // one is true only during real audible playback, reported up by MessageBubble's
  // separate onSpeakingChange channel — the camera's "Speaking" state must mean
  // "voice is audible", not "TTS was just triggered or is paused".
  const [speakingStates, setSpeakingStates] = useState<Record<string, boolean>>({});
  const isSpeaking = Object.values(speakingStates).some(v => v);
  const handleSpeakingChange = useCallback((msgId: string, speaking: boolean) => {
    setSpeakingStates(prev => {
      if (prev[msgId] === speaking) return prev;
      return { ...prev, [msgId]: speaking };
    });
  }, []);
  const [vrchatQueue, setVrchatQueue] = useState<{ text: string, attachment: any }[]>([]);

  // Camera signal: computed at render time and handed straight to the
  // <CameraPanel> rendered locally below (no more lifting this up to
  // NexusApp via a callback prop — the panel now lives inside ChatArea's
  // own layout, in the row below the header, so nothing outside this
  // component needs it). TTS-speaking wins over everything per the user's
  // explicit priority rule; a live tool name (OAuth-path only) beats the
  // coarser thinking/replying streamPhase; both fall back to 'idle'
  // whenever no turn is in flight.
  // Map the turn's current state to a camera phase. Priority (highest first):
  //   waiting-for-something (AskQuestion / subagent / stall) > live tool >
  //   reply streaming > thinking streaming > "called but nothing yet".
  // The last two both read as 'waiting': a freshly-started turn and a turn
  // parked on compaction / a provider retry both have no tool name and no
  // streamed text/thinking yet, so they land in the same Waiting state —
  // which is exactly the partner's ask ("AI called, no reply yet → Waiting").
  const cameraPhase: CameraSignal['phase'] = !loading
    ? 'idle'
    : (pendingAsk || activeSubagent || stallIdleSeconds !== null)
      ? 'waiting'
      : liveToolName
        ? 'tool'
        : streamPhase === 'replying'
          ? 'replying'
          : streamPhase === 'thinking'
            ? 'thinking'
            : 'waiting';
  const cameraSignal: CameraSignal = {
    speaking: isSpeaking,
    phase: cameraPhase,
    toolName: cameraPhase === 'tool' ? liveToolName : null,
  };

  // Stable identity (useCallback): this is passed to every MessageBubble and
  // used inside one of its effects' dependency arrays. As a fresh closure each
  // render it made that child effect re-run on every render — exactly the
  // "dependency changes on every render" pattern React warns about. The state
  // update itself is already guarded (returns prev when unchanged).
  const handleAudioStateChange = useCallback((msgId: string, isPlaying: boolean) => {
    setAudioPlayingStates(prev => {
      if (prev[msgId] === isPlaying) return prev;
      return { ...prev, [msgId]: isPlaying };
    });
  }, []);

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

  // ── What the "Sys" counter must actually measure ────────────────────────────
  // The STORED system prompt is not what gets sent. Three blocks are appended at
  // send time and never written back into the prompt:
  //
  //   Layer 4 — the summaries index, appended client-side (see handleSend).
  //   Layer 5 — the entity's FOOTER.md, appended server-side from the chat route.
  //   VRChat  — the secret rule block, appended client-side when VRChat mode is on.
  //
  // Counting only `systemPrompt` therefore under-reported every entity that uses
  // summaries or has written a FOOTER.md — for a long-lived identity that is
  // thousands of tokens missing from both the "Sys" bucket and the Context
  // Elapsed denominator, which uses the same number as its fixed overhead.
  //
  // This rebuilds the prompt through the SAME appendLayer4Index /
  // appendLayer5Footer helpers the send path uses, so headings, blank lines and
  // the empty-body short-circuit all behave identically. It is a measurement
  // only: nothing here is ever stored or sent.
  const countedSystemPrompt = useMemo(() => {
    let p = systemPrompt || '';
    if (useSummariesForLayer4) p = appendLayer4Index(p, summaryIndexBody);
    p = appendLayer5Footer(p, footerBody);
    if (vrchatMode) p = `${p}\n\n${audioSessionRuleText}`.trim();
    p = prependIdentityPreamble(
      p,
      workingDisciplineEnabled ? (instructionOverrides['workingDiscipline'] || langDefaults.workingDiscipline || '') : '',
      resolveBindingText(
        baseBindingMode === 'on',
        systemPrompt,
        instructionOverrides['absoluteBaseBinding'] || langDefaults.absoluteBaseBinding || '',
        instructionOverrides['absoluteBaseBindingInitial'] || langDefaults.absoluteBaseBindingInitial || '',
      ),
    );
    return p;
  }, [systemPrompt, useSummariesForLayer4, summaryIndexBody, footerBody, vrchatMode, audioSessionRuleText, workingDisciplineEnabled, baseBindingMode, instructionOverrides, langDefaults]);

  useEffect(() => {
    // `cancelled` guards against an async race: on load this effect fires once
    // for the initial `defaultSystemPrompt` and again once the log sets the real
    // prompt. Without cleanup, the slower/earlier request can resolve LAST and
    // overwrite the correct count with the default prompt's (the "Sys shows 194
    // on load, fixes on edit" bug). Ignoring a superseded response fixes it.
    // The same guard now also covers the Layer-4/Layer-5 fetches landing late.
    let cancelled = false;
    const fetchSysTokens = async () => {
      const tokens = await fetchTokensForText(countedSystemPrompt, localAiName);
      if (!cancelled) setSystemTokens(tokens);
    };
    fetchSysTokens();
    return () => { cancelled = true; };
  }, [countedSystemPrompt, localAiName]);

  useEffect(() => {
    // Same stale-response guard as the system-prompt counter above.
    let cancelled = false;
    const fetchAttTokens = async () => {
      // Tool instruction is only sent (and only takes tokens) when tool use is on.
      const text = toolUseEnabled ? (toolInstruction || '') : '';
      const tokens = await fetchTokensForText(text, localAiName);
      if (!cancelled) setAttachmentInstructionTokens(tokens);
    };
    fetchAttTokens();
    return () => { cancelled = true; };
  }, [toolUseEnabled, toolInstruction, localAiName]);

  // Sync specific model when changed from the sidebar
  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    // Fall back to the family default when the folder has a family but no saved
    // model — otherwise this sets the model to undefined and the chat can't run
    // until one is picked by hand.
    setSpecificModel(defaultSpecificModel || defaultModelForFamily(localAiName || aiName));
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
      // Bytes actually downloaded for this conversation. Hoisted out of the try
      // so it survives to the apply step, where it seeds the save-size guard.
      let totalBytes = 0;
      try {
        const r = await fetch(`/api/logs/${convoId}`, { signal: ac.signal });
        if (!r.ok || !r.body) {
          // No log on disk — a conversation that was just created and has never
          // been written. Everything else is already correct because ChatArea
          // remounts per convoId, but the title is not: adopt the
          // `<identity>_<n>` name the sidebar assigned, so the name on screen is
          // the name that gets saved on the first message.
          if (plannedTitleRef.current) setTitle(plannedTitleRef.current);
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
        totalBytes = totalSize;
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
        // Network/parse errors fall through to the "data === null" path below,
        // which resets ChatArea to a clean empty conversation. A 404 does NOT
        // arrive here — it is handled by the early return above.
      }

      // Only apply if this load wasn't aborted in between.
      if (ac.signal.aborted) {
        setConvoIsLoading(false);
        return;
      }
      if (data) {
        // Seed the size tracker from what we just downloaded. Opening a
        // conversation deliberately skips the auto-save (see below), so without
        // this savedBytesRef would stay 0 until the first save actually runs —
        // and the pre-flight guard in handleSend would stay silent for exactly
        // the send most likely to break: the first attachment added to an
        // already-huge conversation right after opening it.
        savedBytesRef.current = totalBytes;
        // Opening a conversation must not bump updatedAt. Applying the loaded
        // state below re-fires the auto-save effect; this flag makes that one
        // run skip its POST so the file's mtime/contents stay untouched.
        skipNextAutoSaveRef.current = true;
        const loadedMessages = (data.messages || []).map((m: any) => ({ ...m, autoPlay: false }));
        setMessages(loadedMessages);
        setTitle(data.title || 'New Conversation');
        setSystemPrompt(data.systemPrompt !== undefined ? data.systemPrompt : defaultSystemPrompt);
        setToolUseEnabled(data.toolUseEnabled === true);
        setAgentFullSystemAccess(data.agentFullSystemAccess === true);
        setAgentDangerousTools(data.agentDangerousTools === true);
        setHiddenAttachmentsAccessible(data.hiddenAttachmentsAccessible === true);
        setAskUserEnabled(data.askUserEnabled === true);
        setAskUserTimeoutMs(typeof data.askUserTimeoutMs === 'number' ? data.askUserTimeoutMs : 0);
        setSubagentEnabled(data.subagentEnabled === true);
        setLettersEnabled(data.lettersEnabled === true);
        // `=== true`: absent field means off. A conversation saved before
        // browser control existed never asked for it, so it does not get it.
        setBrowserEnabled(data.browserEnabled === true);
        setBrowserAllowedHosts(typeof data.browserAllowedHosts === 'string' ? data.browserAllowedHosts : '');
        setBrowserAllowAnyHost(data.browserAllowAnyHost === true);
        setBrowserCompact(data.browserCompact === true);
        // Same `=== true` discipline as browserEnabled above.
        setComputerControlEnabled(data.computerControlEnabled === true);
        setCameraEnabled(data.cameraEnabled === true);
        setSubagentModel(typeof data.subagentModel === 'string' ? data.subagentModel : '');
        setSubagentFamily(typeof data.subagentFamily === 'string' ? data.subagentFamily : '');
        setInstructionOverrides(data.instructionOverrides && typeof data.instructionOverrides === 'object' ? data.instructionOverrides : {});
        if (typeof data.toolInstruction === 'string') setToolInstruction(data.toolInstruction);
        if (typeof data.toolImageInstruction === 'string') setToolImageInstruction(data.toolImageInstruction);
        setDateTimeVisibility(data.dateTimeVisibility || 'all');
        setClaudeThinking(data.claudeThinking || false);
        setSaveThinkingToLog(data.saveThinkingToLog || false);
        setShowFatigueToEntity(data.showFatigueToEntity || false);
        if (typeof data.fatigueInstruction === 'string') setFatigueInstruction(data.fatigueInstruction);
        setWorkingDisciplineEnabled(data.workingDisciplineEnabled === true);
        // Legacy folders may still carry the old three-state 'auto' value; anything other than 'off' coerces to 'on'.
        setBaseBindingMode(data.baseBindingMode === 'off' ? 'off' : 'on');
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
        // No log on disk yet — this is a conversation that has just been created
        // and not written to. `plannedTitle` is the `<identity>_<n>` name the
        // sidebar already assigned it; keep it instead of throwing it away, or
        // the name the user was shown would silently differ from the saved one.
        setTitle(plannedTitleRef.current || 'New Conversation');
        setSystemPrompt(defaultSystemPrompt);
        setToolUseEnabled(pick('toolUseEnabled', false));
        setAgentFullSystemAccess(pick('agentFullSystemAccess', false));
        setAgentDangerousTools(pick('agentDangerousTools', false));
        setHiddenAttachmentsAccessible(pick('hiddenAttachmentsAccessible', false));
        setAskUserEnabled(pick('askUserEnabled', false));
        setAskUserTimeoutMs(pick('askUserTimeoutMs', 0));
        setSubagentEnabled(pick('subagentEnabled', false));
        setLettersEnabled(pick('lettersEnabled', false));
        setBrowserEnabled(pick('browserEnabled', false));
        setBrowserAllowedHosts(pick('browserAllowedHosts', ''));
        setBrowserAllowAnyHost(pick('browserAllowAnyHost', false));
        setBrowserCompact(pick('browserCompact', false));
        setComputerControlEnabled(pick('computerControlEnabled', false));
        setCameraEnabled(pick('cameraEnabled', false));
        setSubagentModel(pick('subagentModel', ''));
        setSubagentFamily(pick('subagentFamily', ''));
        setInstructionOverrides(pick('instructionOverrides', {}));
        setDateTimeVisibility(defaultDateTimeVisibility || 'all');
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
        setShowFatigueToEntity(pick('showFatigueToEntity', false));
        if (typeof folderSettings.fatigueInstruction === 'string') setFatigueInstruction(folderSettings.fatigueInstruction);
        setWorkingDisciplineEnabled(pick('workingDisciplineEnabled', false));
        // Legacy folders may still carry the old three-state 'auto' value; anything other than 'off' coerces to 'on'.
        setBaseBindingMode(pick<'off' | 'on'>('baseBindingMode', 'on') === 'off' ? 'off' : 'on');
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
        setSpecificModel(defaultSpecificModel || defaultModelForFamily(aiName));
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
  //
  // CRITICAL: this effect deliberately does NOT depend on systemTokens or
  // attachmentInstructionTokens. Those are display-only counters that are
  // resolved ASYNCHRONOUSLY by the tokenizer effects (fetchSysTokens /
  // fetchAttTokens) shortly after a conversation loads. If they were deps of
  // the save, opening a conversation would cascade: load applies state → save
  // skipped via the flag → tokenizer resolves → systemTokens changes → save
  // fires AGAIN (flag already spent) → POST → fresh updatedAt purely from
  // viewing. They live in the separate token-totals effect below instead.
  useEffect(() => {
    // Skip the disk-save POST WHILE a reply is streaming (loading === true).
    // During streaming every SSE frame updates `messages`; without this guard a
    // full multi-MB POST would fire per frame, piling up against Chrome's
    // 6-connection cap and starving the tokenizer/voices/TTS fetches. When
    // loading flips back to false this effect runs once and persists the final
    // state.
    if (loading) return;

    // Skip the single POST triggered by a conversation load. Opening a convo
    // applies the on-disk state in one batched render, which fires this effect
    // exactly once; without this guard that fire would re-write the file with a
    // fresh updatedAt, churning bytes for rclone/Mercurial purely from viewing.
    // The async token-counter cascade that previously caused a SECOND fire no
    // longer reaches this effect (it lives in the token-totals effect below), so
    // consuming the flag on this one fire is sufficient — genuine later edits
    // find the flag already cleared and save normally.
    const skipSave = skipNextAutoSaveRef.current;
    skipNextAutoSaveRef.current = false;
    if (skipSave) return;

    if (messages.length > 0) {
      const cleanMessages = messages.map(m => {
        // Strip ephemeral runtime flags (autoPlay = TTS auto-trigger,
        // streaming = "generation still in progress") before persisting.
        const { autoPlay, streaming, ...rest } = m;
        return rest;
      });
      // Serializing the whole conversation — every message plus every inline
      // base64 attachment — can exceed V8's max string length once enough media
      // has accumulated (see MAX_JS_STRING_LENGTH). JSON.stringify then throws
      // SYNCHRONOUSLY, and because this runs inside an effect the throw unwinds
      // React during commit: the entire app goes white and the un-saved turn
      // still in memory is lost. A failing save must degrade to a warning, never
      // to a crash — the conversation stays on screen either way.
      let body: string;
      try {
        body = JSON.stringify({
          id: convoId,
          logData: { id: convoId, folderName, aiName: localAiName, title, messages: cleanMessages, systemPrompt, toolUseEnabled, toolInstruction, toolImageInstruction, agentFullSystemAccess, agentDangerousTools, hiddenAttachmentsAccessible, askUserEnabled, askUserTimeoutMs, subagentEnabled, subagentModel, subagentFamily, lettersEnabled, browserEnabled, browserAllowedHosts, browserAllowAnyHost, browserCompact, computerControlEnabled, cameraEnabled, instructionOverrides, modelParams, specificModel, dateTimeVisibility, claudeThinking, saveThinkingToLog, showFatigueToEntity, fatigueInstruction, workingDisciplineEnabled, baseBindingMode, vrchatMode, vrchatRule, firstOriginalMessageId, firstOriginalIsNext, creativityControlEnabled, hiddenAnalysisInstruction, creativityDisplayPattern, seedEnabled, seedValue, autoModelSelectEnabled, autoModelSelectCriteria, autoModelSelectAllowedModels, claudeAgentSessionId, claudeAuthMode, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel }
        });
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error('[auto-save] could not serialize conversation:', e);
        setSaveError({
          level: 'error',
          text:
            `This conversation is too large to save — it exceeds the browser's hard ~512 MB limit on a single string, which inline attachments (video/audio/images) count against. ` +
            `Nothing on screen has been lost, but new turns will not reach the disk until the conversation shrinks. ` +
            `Remove attachments from older messages, or continue in a new conversation. The last successful save on disk is intact.`
        });
        return;
      }

      savedBytesRef.current = body.length;
      if (body.length > SAVE_SIZE_WARN_THRESHOLD) {
        setSaveError({
          level: 'warn',
          text:
            `This conversation is ${(body.length / 1024 / 1024).toFixed(0)} MB, approaching the browser's hard ~512 MB save limit. ` +
            `Saving still works, but one more large attachment will break it. Remove attachments from older messages, or start a new conversation.`
        });
      } else {
        setSaveError(null);
      }

      // Hold the close-guard for the round trip. This window is short, but it
      // is exactly the window in which the turn on screen is not yet on disk,
      // and a multi-MB conversation makes it long enough to lose a close race.
      savesInFlightRef.current += 1;
      setUnloadGuard('save', savingLabelRef.current);

      fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      })
        .then(res => {
          if (!res.ok) {
            setSaveError({
              level: 'error',
              text: `The server rejected this save (HTTP ${res.status}). Nothing on screen has been lost, but this turn is not on disk yet.`
            });
          }
        })
        .catch(err => {
          // eslint-disable-next-line no-console
          console.error('[auto-save] POST failed:', err);
          setSaveError({
            level: 'error',
            text: 'Could not reach the local server to save this conversation. Nothing on screen has been lost, but this turn is not on disk yet.'
          });
        })
        .finally(() => {
          // Release only when the LAST in-flight save settles. Failure still
          // releases: the guard's job is "bytes are on the wire", not "the data
          // is safe" — a failed save already shouts through the error banner,
          // and holding the guard forever would make an idle page unclosable.
          savesInFlightRef.current = Math.max(0, savesInFlightRef.current - 1);
          if (savesInFlightRef.current === 0) setUnloadGuard('save', null);
        });
    }
  }, [messages, title, convoId, folderName, localAiName, systemPrompt, toolUseEnabled, toolInstruction, toolImageInstruction, agentFullSystemAccess, agentDangerousTools, hiddenAttachmentsAccessible, askUserEnabled, askUserTimeoutMs, subagentEnabled, subagentModel, subagentFamily, lettersEnabled, browserEnabled, browserAllowedHosts, browserAllowAnyHost, browserCompact, computerControlEnabled, cameraEnabled, instructionOverrides, modelParams, specificModel, dateTimeVisibility, claudeThinking, saveThinkingToLog, showFatigueToEntity, fatigueInstruction, workingDisciplineEnabled, baseBindingMode, vrchatMode, vrchatRule, firstOriginalMessageId, firstOriginalIsNext, creativityControlEnabled, hiddenAnalysisInstruction, creativityDisplayPattern, seedEnabled, seedValue, autoModelSelectEnabled, autoModelSelectCriteria, autoModelSelectAllowedModels, claudeAgentSessionId, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel, loading]);

  // Token totals for the context bar (display only — never persisted). Split
  // out from the save effect so the async tokenizer counters (systemTokens /
  // attachmentInstructionTokens) can update the bar WITHOUT triggering a
  // disk-save / updatedAt bump. Skipped during streaming to avoid per-frame
  // churn (the bar jumps to the final value when the reply completes).
  // Reusable-thinking token count for a message. DERIVED from the actual
  // `thoughtProcess` text so it stays correct when the "Save & reuse thinking
  // process" toggle is flipped AFTER generation (or on conversations loaded
  // from disk). The pre-baked `m.thinkingTokens` is only a cache — and it's
  // baked to 0 whenever a message was produced/saved with the toggle off, so
  // relying on it made toggling the setting on afterward add nothing. Prefer
  // the live text; fall back to the cached count only when no text is present.
  const msgThinkingTokens = (m: any): number => {
    if (typeof m.thoughtProcess === 'string' && m.thoughtProcess)
      return Math.ceil(m.thoughtProcess.length / 4);
    return m.thinkingTokens || 0;
  };

  useEffect(() => {
    if (loading) return;
    let total = 0;
    let convoTotal = 0;
    messages.forEach(m => {
      const textTokens = (m.textTokens !== undefined ? m.textTokens : (m.tokens || 0));
      total += textTokens;
      convoTotal += textTokens;
      // Thinking tokens are treated like attachments: counted in the grand
      // total (so the context bar reflects them) but honoring a per-message
      // `thinkingExcluded` opt-out, and kept out of the conversation-text
      // subtotal (convoTotal) just like attachment tokens are.
      if (saveThinkingToLog && !m.thinkingExcluded) {
        total += msgThinkingTokens(m);
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
  }, [messages, saveThinkingToLog, systemTokens, attachmentInstructionTokens, loading]);

  // ── Auto-hide older attachments during an audio session ───────────────────
  // A long VRChat session accumulates screenshots; every one of them is re-sent
  // on every turn. When the Preferences option is on AND this conversation has
  // the audio session enabled, keep the attachments carried by the newest N
  // MESSAGES included and exclude everything older.
  //
  // N counts messages, not attachments: a message with ten screenshots is one
  // message. "Older than N messages back" is the whole rule.
  //
  // This reuses the existing per-attachment `excluded` flag (same one the manual
  // eye toggle writes), so nothing new has to be taught to the send path, the
  // history filter or the token counter. The extra `autoHidden` marker is what
  // makes it reversible: only attachments this effect hid are ever un-hidden.
  // An attachment excluded by hand stays excluded, even if it falls inside the
  // newest N — the automation never overrides a human decision.
  const hideOldAttachments = globalSettings?.audioSessionHideOldAttachments === true;
  const keepMessages = (() => {
    const n = Number(globalSettings?.audioSessionKeepMessages);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.floor(n))) : 3;
  })();
  useEffect(() => {
    const active = vrchatMode && hideOldAttachments;
    if (messages.length === 0) return;

    // Everything before this message index is "older than N messages back".
    const keepFrom = active ? Math.max(0, messages.length - keepMessages) : 0;

    let changed = false;
    const next = messages.map((m: any, mi: number) => {
      if (!Array.isArray(m.attachments)) return m;
      const isOld = active && mi < keepFrom;
      let msgChanged = false;
      const atts = m.attachments.map((a: any) => {
        if (isOld) {
          // Already excluded (manually or by us), or the user explicitly made
          // this one visible again (autoHidden === false) → hands off.
          if (a.excluded || a.autoHidden === false) return a;
          msgChanged = true;
          return { ...a, excluded: true, autoHidden: true };
        }
        // Inside the newest N messages, or the feature is off: undo only our
        // own hiding.
        if (a.autoHidden === true) {
          msgChanged = true;
          const { autoHidden, ...rest } = a;
          return { ...rest, excluded: false };
        }
        return a;
      });
      if (!msgChanged) return m;
      changed = true;
      return { ...m, attachments: atts };
    });

    if (changed) setMessages(next);
  }, [messages, vrchatMode, hideOldAttachments, keepMessages]);

  // Per-message tokens, split so the progress bar can show attachments as
  // their own layer and so the auto-trim threshold can ignore attachments.
  const computeMsgTextTokens = (m: any) => {
    return (m.textTokens !== undefined ? m.textTokens : (m.tokens || 0));
  };
  const computeMsgAttachTokens = (m: any) => {
    let t = 0;
    if (m.attachments) {
      for (const a of m.attachments) if (!a.excluded) t += (a.tokens || 0);
    }
    // Reusable thinking is bucketed with attachments: it shows in the "Att"
    // segment and (like attachments) is excluded from the auto-trim threshold,
    // honoring the per-message `thinkingExcluded` opt-out. Derived from the live
    // thinking text (see msgThinkingTokens) so the count tracks the toggle.
    if (saveThinkingToLog && !m.thinkingExcluded) t += msgThinkingTokens(m);
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
    // "Next = First Original" pending state: no marker exists yet, but the next
    // user message WILL become it — so the entire current history is carry-over
    // context. Count it all as copied (original = 0). Without this, the unmarked
    // conversation fell through to the all-original default below, showing
    // copied = 0 and original = full, which is the exact inverse of the truth.
    const allCopied = markerIdx < 0 && firstOriginalIsNext;
    messages.forEach((m, i) => {
      const textT = computeMsgTextTokens(m);
      const attT = computeMsgAttachTokens(m);
      attach += attT;
      // allCopied -> the whole pending carry-over history counts as copied.
      // No marker (and not pending) -> everything is "original" (safe default).
      // Marker present -> messages before it are copied, at-and-after original.
      if (allCopied) copied += textT;
      else if (markerIdx >= 0 && i < markerIdx) copied += textT;
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
    const max = activeFolderSettings.maxRecommendedContext || 80000;
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
      const tk = computeMsgTextTokens(messages[i]);
      toRemove.add(messages[i].id);
      runningTextTotal -= tk;
    }
    if (toRemove.size > 0) {
      console.log(`[auto-trim] removing ${toRemove.size} copied messages to bring text context from ${textTotal} → ${runningTextTotal} (limit ${max}, attachments ${tokenBreakdown.attach} excluded)`);
      setMessages(prev => prev.filter(m => !toRemove.has(m.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, firstOriginalMessageId, folders, folderName, systemTokens, attachmentInstructionTokens, saveThinkingToLog, loading]);

  // Which deep-link target has already been handled. Declared above both scroll
  // effects because the auto-scroll below has to know a link is still pending.
  const scrolledToRef = useRef<string | null>(null);
  const deepLinkScrollPending = !!scrollToMessageId && scrolledToRef.current !== scrollToMessageId;
  // Transient "copied ✓" feedback for the link buttons ('convo' | message id).
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  // Scroll to bottom only when new messages arrive or AI is generating
  useEffect(() => {
    if (scrollRef.current) {
      const isGenerating = loading;
      const lengthIncreased = messages.length > prevMessagesLengthRef.current;

      // A pending deep-link scroll owns the viewport. Without this guard the
      // initial load (0 → N messages) counts as "length increased", slams to the
      // bottom, and the link's smooth scroll then animates all the way back up
      // through a long conversation.
      if ((isGenerating || lengthIncreased) && !deepLinkScrollPending) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages, loading, deepLinkScrollPending]);

  // ── Close/reload guard ───────────────────────────────────────────────────
  // A reload or tab close mid-generation destroys the turn: the auto-save
  // effect above deliberately skips the POST while `loading === true`, so a
  // streaming reply exists only in memory. Hold the guard for exactly as long
  // as that is true, and release it the instant it isn't — an idle page must
  // close with no dialog at all. See src/lib/unloadGuard.ts for why the dialog
  // text itself cannot be customised.
  useEffect(() => {
    if (!loading) {
      setUnloadGuard('generation', null);
      return;
    }
    // "<Being> <current action>" — the action is the SAME phrase the loading
    // indicator shows (`liveToolActivity`, e.g. "read a file"), or "thinking"
    // while no tool is running. This used to read "{model family} is working"
    // — naming the wrong actor. The being is who acts; the model is what they
    // act through.
    const being = folderName || 'The being';
    const action = liveToolActivity || t('unload.busy.thinking');
    setUnloadGuard('generation', `${being} ${action}`);
  }, [loading, folderName, liveToolActivity, t]);

  // Release every guard this component owns when it unmounts (conversation
  // switch, navigation). Separate from the effect above so it runs once, on
  // teardown only — a stale guard would block closing an idle page forever,
  // which is the exact failure this feature exists to avoid.
  useEffect(() => () => {
    setUnloadGuard('generation', null);
    setUnloadGuard('save', null);
  }, []);

  // Sync browser tab title with current conversation.
  //
  // The busy prefix is load-bearing, not decoration: the browser writes its own
  // generic "Leave site?" text and ignores anything we pass, so the tab strip
  // is the only place we can say WHO is working. It sits behind the dialog and
  // is what makes that generic prompt legible.
  const busyLabel = useBusyLabel();
  useEffect(() => {
    const base = title ? `${title} — Nexus` : 'Nexus';
    document.title = busyLabel ? `● ${busyLabel} — ${base}` : base;
    return () => { document.title = 'Nexus'; };
  }, [title, busyLabel]);

  // ── Deep-link scroll target ──────────────────────────────────────────────
  // Runs after messages render. `messages.length` is in the deps because on a
  // cold load this effect fires first with an empty list — the anchor simply
  // doesn't exist yet, and the next run (once messages arrive) finds it.
  // Reports back either way so the caller can clear its pending state and,
  // when the id is genuinely absent, say so instead of leaving the user at the
  // bottom of the wrong place wondering.
  useEffect(() => {
    if (!scrollToMessageId) return;
    if (scrolledToRef.current === scrollToMessageId) return;
    if (messages.length === 0) return;            // not loaded yet — wait for the next run

    const el = document.getElementById(messageAnchorId(scrollToMessageId));
    if (!el) {
      // Messages are present but this id isn't among them: deleted or wrong link.
      scrolledToRef.current = scrollToMessageId;
      onScrolledToMessage?.(false);
      return;
    }
    scrolledToRef.current = scrollToMessageId;

    // Brief highlight so the eye lands on the right message in a long thread.
    el.classList.add('ring-2', 'ring-indigo-500/70', 'rounded-xl');
    const clearRing = setTimeout(
      () => el.classList.remove('ring-2', 'ring-indigo-500/70', 'rounded-xl'),
      2600,
    );

    // Scrolling ONCE is not enough, and neither is a fixed retry window.
    // Attachments and lazy-loaded images keep changing the document height for
    // SECONDS after first paint, which silently pushes the target off screen —
    // measured on a real image-heavy conversation, the message ended up 232px
    // above the fold and then drifted again after a 1.8s retry loop had given
    // up. So the correction is driven by LAYOUT (ResizeObserver) rather than by
    // a timer, and it yields immediately to any deliberate scroll by the user.
    let cancelled = false;
    const container: HTMLElement | null = scrollRef.current;
    const CENTRE_TOLERANCE_PX = 120;

    const recentre = () => {
      if (cancelled) return;
      const node = document.getElementById(messageAnchorId(scrollToMessageId));
      if (!node) return;
      const r = node.getBoundingClientRect();
      // A message taller than the viewport can never be perfectly centred, so
      // this settles rather than looping: scrollIntoView is idempotent once the
      // browser has done its best.
      if (Math.abs(r.top + r.height / 2 - window.innerHeight / 2) > CENTRE_TOLERANCE_PX) {
        node.scrollIntoView({ block: 'center' });
      }
    };

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // The user's own scroll wins — never fight the wheel.
    const release = () => { cancelled = true; };
    container?.addEventListener('wheel', release, { passive: true });
    container?.addEventListener('touchstart', release, { passive: true });

    const ro = new ResizeObserver(recentre);
    if (container) {
      ro.observe(container);
      // The scroller's own box rarely changes; it's the content inside that
      // grows as images decode, so observe that too.
      if (container.firstElementChild) ro.observe(container.firstElementChild);
    }
    // Hard stop: stop chasing the layout after a few seconds either way.
    const end = setTimeout(() => { cancelled = true; ro.disconnect(); }, 6000);

    onScrolledToMessage?.(true);
    return () => {
      cancelled = true;
      ro.disconnect();
      clearTimeout(end);
      clearTimeout(clearRing);
      container?.removeEventListener('wheel', release);
      container?.removeEventListener('touchstart', release);
    };
  }, [scrollToMessageId, messages.length, onScrolledToMessage]);

  const handleSend = async (text: string, attachments: any[]) => {
    if (!text.trim() && attachments.length === 0) return;

    // A turn is in flight → this message is a mid-turn INTERJECTION, not a new
    // message. It's delivered to the running turn at its next tool-loop step
    // and never appended to the conversation log. (The old dedicated interject
    // input box is gone — sending normally while they work IS the interjection.)
    if (injectTurnId) {
      await sendInterjection(text);
      return;
    }

    // Pre-flight size check. Attachments are persisted as inline base64, so
    // every one of them counts against V8's ~512 MB max-string-length ceiling
    // for the whole conversation. Warn HERE — before the model is called and
    // billed — rather than letting the turn complete and then discovering at
    // save time that it cannot be written to disk. savedBytesRef is the size of
    // the last serialized save; adding the incoming dataUrls approximates the
    // size this turn would produce.
    const incomingBytes = attachments.reduce(
      (sum: number, a: any) => sum + (typeof a?.dataUrl === 'string' ? a.dataUrl.length : 0),
      0
    );
    if (savedBytesRef.current > 0 && savedBytesRef.current + incomingBytes > SAVE_SIZE_WARN_THRESHOLD) {
      const projectedMB = ((savedBytesRef.current + incomingBytes) / 1024 / 1024).toFixed(0);
      const ok = window.confirm(t('chat.dialog.sizeWarn').replace('{mb}', projectedMB));
      if (!ok) return;
    }

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

    // Generate title if first message — but never over a name the conversation
    // was deliberately given. A `<identity>_<n>` title was assigned at creation
    // and is the one the user sees in the sidebar and on disk; the first 30
    // characters of the opening message are only a fallback for conversations
    // that reached here without a name of their own.
    if (messages.length === 0 && text.trim() && !isNumberedIdentityTitle(title, folderName)) {
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
          // Snapshot the visible input (may include manual typing). The final
          // text is resolved just before enqueue via an ATOMIC consume of
          // kohai/ear (see below) so no un-polled speech is lost.
          const inputTextSnapshot = (inputApiRef.current?.getText?.() || '').trim();
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

          // Externalize the capture before it enters the message. VRChat
          // sessions generate a screenshot per turn, and inlining them is what
          // grew the VRChat entity folders to gigabytes in the first place.
          // Falls back to inline on upload failure so a capture is never lost.
          let capturedRef: string | null = null;
          try {
            const blob = dataUrlToBlob(dataUrl);
            if (blob) {
              const stored = await uploadAttachment(blob, mime);
              if (stored) capturedRef = stored.ref;
            }
          } catch { /* fall through to the inline payload below */ }

          const attachment = {
            id: Date.now().toString(),
            name: filename,
            type: mime,
            isImage: true,
            ...(capturedRef ? { ref: capturedRef } : { dataUrl }),
            tokens
          };
          // Resolve the text ATOMICALLY: consume kohai/ear (read + truncate in
          // one server op) so anything spoken during this handler's async work
          // (PNG→JPEG conversion can take ~1s, during which new speech may land)
          // is captured, not wiped. Prefer that freshest transcript; fall back
          // to the input snapshot (which may hold manual typing) and finally to
          // the placeholder. This is the fix for "kohai.txt cleared but the
          // picture/text never sent" — the consume and the clear are now the
          // same operation, so nothing is discarded uncaptured.
          let consumedText = '';
          try {
            const r = await fetch('/api/vrchat/logs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ consume: true }),
            });
            if (r.ok) consumedText = ((await r.json())?.text || '').trim();
          } catch { /* transient — fall back to the input snapshot below */ }

          const text = consumedText || inputTextSnapshot || '（添付画像）';
          setVrchatQueue(prev => [...prev, { text, attachment }]);
          // Reset the visible input + poll baseline; kohai/ear are already
          // truncated by the consume above (no separate clear needed).
          inputApiRef.current?.setText?.('');
          lastVrchatLogRef.current = '';
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
        const logText = (text || '').trim();
        if (logText && logText !== lastVrchatLogRef.current) {
          lastVrchatLogRef.current = logText;
          inputApiRef.current?.setText?.(logText);
        }
      } catch (e) { /* transient — ignore */ }
    };
    tick();
    const id = setInterval(tick, 1200);
    return () => { cancelled = true; clearInterval(id); };
  }, [vrchatMode]);

  // Audio session ON → acquire the microphone permission that OUTPUT-device
  // routing depends on.
  //
  // setSinkId() rejects, and enumerateDevices() withholds real device ids,
  // unless the origin holds an active microphone permission. Until now the only
  // two getUserMedia() calls in the whole tree lived in SettingsModal — so the
  // permission was acquired as a side effect of opening a dialog about something
  // else. That is why "open Preferences first" and "restart the browser, then
  // open Preferences" appeared to fix output routing: the dialog was not a
  // ritual, it WAS the permission acquisition, just spelled somewhere nobody
  // would look for an output-routing problem.
  //
  // Attaching it to the session toggle puts the prerequisite on the event that
  // actually needs it. Best-effort: a denial is logged by ensureAudioPermission
  // and playback still runs, on the system default device.
  useEffect(() => {
    if (!vrchatMode) return;
    ensureAudioPermission();
  }, [vrchatMode]);

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Drop any unanswered question card — the turn it belonged to is gone.
    setPendingAsk(null);
    setActiveSubagent(null);
    setLiveToolActivity(null);
    setLiveToolName(null);
    setStreamPhase(null);
    setLiveModel('');
    setStallIdleSeconds(null);
    setInjectTurnId(null);
    setInterjectStatus(null);
  };

  // Send a mid-turn interjection to the running turn. Fire-and-forget POST to
  // /api/chat/inject; the backend queues it and the tool loop folds it in at
  // its next model-call boundary.
  const sendInterjection = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !injectTurnId) return;
    setInterjectStatus(t('chat.interject.sent'));
    try {
      const r = await fetch('/api/chat/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: injectTurnId, text: trimmed }),
      });
      if (!r.ok) setInterjectStatus(t('chat.interject.queueFailedEnded'));
    } catch {
      setInterjectStatus(t('chat.interject.queueFailed'));
    }
  };

  // `continueMsgId` turns this into a CONTINUATION of an existing assistant
  // message instead of a new one: no placeholder is added, the stream is seeded
  // with the text already there, and everything appends to that same bubble.
  // `history` must then END with the message being continued — the server adds
  // the "carry on from where you stopped" user turn itself, because for Claude
  // an assistant message in last position is a prefill, which Anthropic rejects
  // while extended thinking is enabled.
  const generateAiResponse = async (history: any[], opts?: { continueMsgId?: string }) => {
    const continueMsgId = opts?.continueMsgId;
    setLoading(true);
    setLiveToolActivity(null);
    setLiveToolName(null);
    setStreamPhase(null);
    setLiveModel('');
    setStallIdleSeconds(null);
    abortControllerRef.current = new AbortController();
    // Wall-clock start of this generation. Used to record how long the model
    // took (thinking + tool loops + streaming) onto the finished message as
    // `generationMs` — a display-only indicator, persisted to the log but
    // never sent back to the entity (reconstruction uses only message content).
    const genStartTime = Date.now();
    // Fresh per-turn id for mid-turn interjections. Local const for the body
    // (needs the value synchronously); mirrored into state so the interject
    // input can address this specific turn.
    const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setInjectTurnId(turnId);
    setInterjectStatus(null);

    // Continuing: reuse the existing message's id so every streaming update
    // lands on it. Otherwise mint a new one.
    const msgId = continueMsgId || (Date.now() + 1).toString();
    const continuedMsg = continueMsgId ? history.find((m: any) => m.id === continueMsgId) : null;
    const continuedSeed = continuedMsg?.content || '';
    // The thinking that produced the first half must be carried over too. Every
    // streaming flush REPLACES thoughtProcess/claudeThinkingBlocks, so starting
    // these empty would erase the original thinking the moment the continuation
    // emitted its first chunk — silently breaking "Save & reuse thinking".
    const continuedThought = continuedMsg?.thoughtProcess || '';
    const continuedBlocks: { thinking: string; signature: string }[] =
      Array.isArray(continuedMsg?.claudeThinkingBlocks) ? [...continuedMsg.claudeThinkingBlocks] : [];
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

    // Add placeholder immediately. When continuing, there is nothing to add —
    // the target message already exists; just mark it streaming so the TTS and
    // the streaming indicators behave exactly as they do for a fresh reply.
    if (continueMsgId) {
      setMessages(prev => prev.map(m => m.id === continueMsgId ? { ...m, streaming: true } : m));
    } else {
      setMessages([...history, newAiMessage]);
    }

    // When this entity uses summaries instead of a baked Layer 4, APPEND a
    // freshly-assembled index of conversation summaries at send time. The
    // stored prompt is not parsed, split, or rewritten — the block simply goes
    // on the end, and Layer 5 (appended server-side from FOOTER.md) lands after
    // it. If the index fetch fails we send the prompt unchanged.
    let baseSystemPrompt = systemPrompt;
    if (useSummariesForLayer4) {
      try {
        const idxLangParam = globalSettings?.language === 'ja' ? 'ja' : 'en';
        const idxRes = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&mode=index&current=${encodeURIComponent(convoId)}&lang=${idxLangParam}`);
        if (idxRes.ok) {
          const { body } = await idxRes.json();
          baseSystemPrompt = appendLayer4Index(systemPrompt, body || '');
        }
      } catch (e) {
        console.warn('[summaries] failed to assemble Layer-4 index, sending prompt as-is', e);
      }
    }
    // Prepend Working Discipline / Absolute Base Binding AHEAD of the entity's
    // own prompt (Layers 1-3 + the Layer 4 index just appended above). Layer-
    // structure detection (which of the two Binding texts to use) runs on the
    // RAW stored `systemPrompt`, not `baseSystemPrompt` — the Layer 4 heading
    // appended just above ("## **Layer 4: ...") would otherwise false-trigger
    // the layers-focused variant for an entity that has summaries turned on
    // but no real 5-layer identity written.
    {
      baseSystemPrompt = prependIdentityPreamble(
        baseSystemPrompt,
        workingDisciplineEnabled ? (instructionOverrides['workingDiscipline'] || langDefaults.workingDiscipline || '') : '',
        resolveBindingText(
          baseBindingMode === 'on',
          systemPrompt,
          instructionOverrides['absoluteBaseBinding'] || langDefaults.absoluteBaseBinding || '',
          instructionOverrides['absoluteBaseBindingInitial'] || langDefaults.absoluteBaseBindingInitial || '',
        ),
      );
    }
    let effectiveSystemPrompt = vrchatMode ? `${baseSystemPrompt}\n\n${audioSessionRuleText}`.trim() : baseSystemPrompt;
    // Optional hidden context note so the entity can see how much of this
    // session's room has been used. A quantity, never a condition — see the
    // default text above.
    // Same formula as the status-bar indicator: original (non-copied) messages
    // ÷ room left after the fixed "Sys" overhead (system prompt + instructions).
    // {percent} is replaced with the value (e.g. "42%").
    if (showFatigueToEntity && fatigueInstruction.trim()) {
      const fatigueFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
      const fatigueMax = fatigueFolderSettings.maxRecommendedContext || 80000;
      const fatiguePct = Math.round((tokenBreakdown.original / Math.max(1, fatigueMax - tokenBreakdown.sys)) * 100);
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${fatigueInstruction.replace(/\{percent\}/g, `${fatiguePct}%`)}`.trim();
    }

    // Turn-stopped diagnostics ("a file operation was blocked…", "hit the
    // token limit…") and provider failures. Display-only, exactly like
    // webSources: kept off the message body so they are never persisted into
    // the reply text, never replayed to the model, and never counted as tokens.
    // Declared OUTSIDE the try so the catch below can add the failure reason to
    // the same channel instead of concatenating it into the reply.
    const notices: string[] = [];
    // Assigned just after the streaming declarations (before the read loop) so
    // the catch below can invoke it on AbortError and still persist billing
    // (cacheUsage) and the 🔧 tool report (toolCalls) instead of dropping them.
    let finalizeMessage: (() => void) | null = null;

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
          // Turns that stopped BEFORE this became a separate event still carry
          // the "⚠️ _[Turn stopped: …]_" text inside their body. Strip it on the
          // way out so those old turns stop replaying a failure explanation to
          // the model every single turn. Non-destructive: only this outgoing
          // copy is cleaned, the stored log is untouched.
          content: stripTurnNotices(m.content || ''),
          role: m.role,
          timestamp: m.timestamp,
        };
        if (m.attachments?.length) {
          const kept = m.attachments
            .filter((a: any) => !a.excluded || (hiddenAttachmentsAccessible && a.ref))
            .map((a: any) => {
              const { fileObj, ...rest } = a;
              if (rest.excluded) return { ...rest, textData: null, dataUrl: null };
              return rest;
            });
          if (kept.length) slim.attachments = kept;
        }
        // Only feed Claude its own past reasoning when the user opts in via the
        // "Save & reuse thinking process" toggle, and only for blocks the user
        // hasn't manually excluded. When off (or excluded), thinking is withheld
        // from the wire entirely — the API-key path won't resend it and the OAuth
        // transcript reconstruction won't include the "(thinking)" lines. (This
        // mirrors the .md export, which is gated by the same toggle.)
        //
        // Two sources of reusable thinking:
        //   1. claudeThinkingBlocks — signed blocks from the token-paid API-key
        //      path (carry real signatures, replayable natively).
        //   2. thoughtProcess — the OAuth/Agent-SDK path emits thinking as text
        //      only (no signatures), so it is NEVER stored as claudeThinkingBlocks.
        //      Without this fallback, OAuth Claude never receives its own past
        //      reasoning at all (the transcript builder reads claudeThinkingBlocks,
        //      which is empty). We forward it as a signature-less block: the OAuth
        //      transcript builder folds `tb.thinking` regardless of signature, and
        //      the API-key native-replay path safely skips signature-less blocks.
        if (saveThinkingToLog && !m.thinkingExcluded) {
          if (m.claudeThinkingBlocks?.length) {
            slim.claudeThinkingBlocks = m.claudeThinkingBlocks;
          } else if (m.thoughtProcess) {
            slim.claudeThinkingBlocks = [{ thinking: m.thoughtProcess, signature: '' }];
          }
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
      const bodyObj = { messages: slimHistory, aiName: localAiName, folderName, systemPrompt: effectiveSystemPrompt, toolUseEnabled, agentFullSystemAccess, agentDangerousTools, hiddenAttachmentsAccessible, askUserEnabled, askUserTimeoutMs: Number(askUserTimeoutMs) || 0, subagentEnabled, subagentModel, subagentFamily, lettersEnabled,
        browserEnabled,
        // Text in the UI, array on the wire. Split on newlines and commas so the
        // box accepts whichever way the host list was typed.
        browserAllowedHosts: String(browserAllowedHosts || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean),
        browserAllowAnyHost, browserCompact,
        computerControlEnabled,
        instructionOverrides, language: globalSettings?.language || 'en', toolInstruction, toolImageInstruction, modelParams: { ...modelParams, claudeThinking }, specificModel, dateTimeVisibility, creativityControlEnabled, hiddenAnalysisInstruction, creativityDisplayPattern, seedEnabled, seedValue, autoModelSelectEnabled, autoModelSelectCriteria, autoModelSelectAllowedModels, convoId, claudeAgentSessionId: claudeAgentSessionIdRef.current, claudeAuthMode, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel, enableReadConversation: useSummariesForLayer4, injectTurnId: turnId, continueFromMessage: !!continueMsgId, maxToolIterations: Number(globalSettings?.maxToolIterations) || 300 };
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

      // Seeded with what the message already says when continuing, so streamed
      // chunks append to it rather than replacing it. Joined with no separator:
      // the model was told its text is attached directly onto the previous part,
      // so it may legitimately resume mid-word or mid-code-block.
      let currentText = continuedSeed;
      let currentThought = continuedThought;
      let currentCreativityLabel = '';
      let claudeThinkingBlocks: { thinking: string; signature: string }[] = [...continuedBlocks];
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
      // Every tool the model actually dispatched this turn, with its arguments.
      // This is the evidence behind the 🔧 report button: a reply that claims
      // "I saved the file" can be checked against whether a Write really ran.
      // Display-only — slimHistory is an allowlist and never names this field,
      // so it is never sent to any model and costs no tokens.
      const toolCalls: any[] = [];
      // Attachments collected from tool calls during this turn, to be
      // attached to the assistant message.
      const toolAttachments: any[] = [];
      // Interactive AskUserQuestion records for this turn (question + the
      // answer the user picked). Persisted onto the assistant message so the
      // exchange is visible again when the conversation is reloaded.
      const askedQuestions: any[] = [];
      // Subagent runs for this turn (task + distilled result). Persisted onto
      // the assistant message and shown as a collapsed group on reload.
      const subagentRuns: any[] = [];

      // Finalizes the assistant message by committing everything the streaming
      // loop accumulated: the (possibly partial) text, thinking-token count,
      // prompt-cache usage, and the tool calls that drive the 🔧 report.
      // Defined here — before the read loop — so the catch below can invoke it
      // when the partner stops the turn mid-stream.
      finalizeMessage = () => {
        const finalText = currentText;
        const fallbackTokens = Math.ceil((finalText || '').length / 4);
        const thinkingTokens = currentThought ? Math.ceil(currentThought.length / 4) : 0;
        setMessages(prev => prev.map(m =>
          m.id === msgId
            ? {
                ...m,
                content: finalText,
                tokens: fallbackTokens,
                textTokens: fallbackTokens,
                // Store the ACTUAL thinking-token count (not zeroed when the
                // reuse toggle happens to be off at generation time) so flipping
                // "Save & reuse thinking process" on later recomputes correctly.
                thinkingTokens,
                // Total generation time (ms) for this turn — shown in the meta
                // bar, saved to the log, hidden from the entity.
                generationMs: Date.now() - genStartTime,
                autoPlay: vrchatMode,
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
                ...(notices.length > 0 ? { notices } : {}),
                ...(toolCalls.length > 0 ? { toolCalls } : {}),
                ...(askedQuestions.length > 0 ? { askedQuestions } : {}),
                ...(subagentRuns.length > 0 ? { subagentRuns } : {}),
              }
            : m
        ));
      };

      // Throttle the streaming UI update to ONE render per animation frame.
      // GLM-5.2 with tool calls (e.g. read_conversation) flushes the buffered
      // post-tool re-stream as many SSE chunks in a tight microtask burst;
      // calling setMessages once per chunk there was still fast enough to trip
      // React's "Maximum update depth exceeded" guard (the per-line coalescing
      // wasn't enough at this granularity). Coalescing to ~1 render/frame
      // decouples render rate from chunk rate and fixes it for any provider.
      // flushStreamingMessage() reads the latest accumulated values (closure
      // over currentText/currentThought/toolAttachments/etc.).
      let rafId: number | null = null;
      const flushStreamingMessage = () => {
        rafId = null;
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
      };
      const scheduleStreamingFlush = () => {
        if (rafId !== null) return; // a frame is already queued — coalesce into it
        if (typeof requestAnimationFrame !== 'undefined') {
          rafId = requestAnimationFrame(flushStreamingMessage);
        } else {
          rafId = setTimeout(flushStreamingMessage, 16) as unknown as number;
        }
      };

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
                setLiveModel(chosenModelSpecific);
                chosenModelThinking = !!data.thinking;
                chosenModelLabel = data.label || '';
                // Automatic Model Selection trace ("selector ran on X, chose
                // Y" / fell back / no allowed models configured). Piggybacks
                // on this same event so it's visible before any tool activity.
                if (typeof data.autoSelectNotice === 'string' && data.autoSelectNotice.trim()) {
                  notices.push(data.autoSelectNotice.trim());
                }
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
              } else if (data.type === 'notice') {
                // Turn-stopped diagnostics. Collected separately from `currentText`
                // so they stay out of the message body — and therefore out of the
                // log, out of the context sent on later turns, and out of the
                // token count.
                if (typeof data.content === 'string' && data.content.trim()) {
                  notices.push(data.content.trim());
                }
              } else if (data.type === 'tool_call') {
                // A tool the model really dispatched. Recorded regardless of
                // whether it succeeded — the report answers "was this called?",
                // which is the question a hallucinated tool claim fails.
                if (data.call && typeof data.call.name === 'string') {
                  toolCalls.push(data.call);
                }
              } else if (data.type === 'session_id') {
                // Claude OAuth path emits this so we can resume the
                // Anthropic-side session on the next turn.
                if (typeof data.sessionId === 'string') {
                  setAgentSession(data.sessionId);
                }
              } else if (data.type === 'thought') {
                currentThought += data.content;
                // Only set 'thinking' if the reply hasn't started yet — once
                // text has begun, the camera signal should not fall back to
                // thinking even if the model interleaves more thought chunks.
                setStreamPhase(prev => (prev === 'replying' ? prev : 'thinking'));
              } else if (data.type === 'text') {
                currentText += data.content;
                setStreamPhase('replying');
                // Strip "[YYYY-MM-DD HH:MM:SS]" tags CONTINUOUSLY as the reply
                // streams in (gated on the global setting, default ON) — not just
                // a leading stack but ANY tag, wherever it appears, including the
                // mid-message ones agentic models (e.g. Kimi K3) emit at the
                // start of each output segment, such as the continuation right
                // after a tool call.
                //
                // Per-chunk stripping stays streaming-TTS-safe: a tag is only
                // removed the instant it completes, at the growing TAIL — always
                // ahead of the position TTS has already spoken. The already-
                // emitted prefix was stripped in earlier ticks and is never
                // rewritten, so it stays monotonic (the failure mode a late
                // one-shot finalize-strip once caused). msg.content therefore
                // never carries a timestamp into TTS, the saved log, or the
                // context replayed to the model.
                if (globalSettings?.removeTimestamps !== false) {
                  currentText = stripAllTimestamps(currentText);
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
              } else if (data.type === 'ask_user' && data.askId && Array.isArray(data.questions)) {
                // The model paused to ask the user a question. Surface an
                // interactive card; the user's selection is POSTed to
                // /api/chat/answer, which resolves the paused server handler.
                // Record it now (answers filled in on ask_user_resolved) so it
                // persists onto the message even if the page is reloaded.
                askedQuestions.push({ askId: data.askId, questions: data.questions, answers: null, timedOut: false });
                setPendingAsk({ askId: data.askId, questions: data.questions });
              } else if (data.type === 'subagent_start') {
                // A context-firewall child agent started investigating. Show a
                // live activity chip; record it (result filled on subagent_done).
                subagentRuns.push({ task: data.task || '', result: null });
                setActiveSubagent({ task: data.task || '' });
              } else if (data.type === 'subagent_done') {
                // Child returned its distilled result. Record it (+ the proof of
                // which API actually served it) and clear the chip.
                const rec = [...subagentRuns].reverse().find((s: any) => s.task === (data.task || '') && s.result === null);
                if (rec) { rec.result = data.result || ''; rec.via = data.via || null; }
                else subagentRuns.push({ task: data.task || '', result: data.result || '', via: data.via || null });
                setActiveSubagent(null);
              } else if (data.type === 'injection_delivered') {
                // A queued partner interjection was folded into the entity's
                // context at a tool-loop boundary.
                setInterjectStatus(t('chat.interject.delivered'));
              } else if (data.type === 'tool_activity') {
                // OAuth path: the model started (tool name) or finished (null)
                // a tool call — reflect it in the loading indicator.
                // `data.name` is the RAW tool name, sent alongside the server's
                // English label so the client can render a translated phrase.
                // Falls back to the server label when the name has no key —
                // never blank, and never worse than before.
                if (typeof data.tool === 'string' && data.tool) {
                  const key = `chat.toolAction.${String(data.name || '')}`;
                  const localized = data.name ? t(key) : '';
                  const hit = !!localized && localized !== key;
                  setLiveToolActivity(hit ? localized : data.tool);
                  setLiveToolLocalized(hit);
                  setLiveToolName(typeof data.name === 'string' && data.name ? data.name : null);
                  setLiveToolDetail(typeof data.detail === 'string' && data.detail ? data.detail : null);
                } else {
                  setLiveToolActivity(null);
                  setLiveToolLocalized(false);
                  setLiveToolName(null);
                  setLiveToolDetail(null);
                }
              } else if (data.type === 'stall_warning') {
                // Server-side watchdog: no SDK activity for this many seconds.
                setStallIdleSeconds(Number(data.idleSeconds || 0));
              } else if (data.type === 'stall_cleared') {
                setStallIdleSeconds(null);
              } else if (data.type === 'ask_user_resolved' && data.askId) {
                // Server resolved the question (user answered, or it timed out
                // and fell back to the recommended option). Record the outcome
                // and dismiss the card.
                const rec = askedQuestions.find((q: any) => q.askId === data.askId);
                if (rec) { rec.answers = data.answers || []; rec.timedOut = !!data.timedOut; }
                setPendingAsk(prev => (prev && prev.askId === data.askId ? null : prev));
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

        // Render at most once per animation frame (see scheduleStreamingFlush).
        // Accumulated text/thought/attachments are already updated above; this
        // just asks for a coalesced repaint.
        scheduleStreamingFlush();
      }

      // Stream loop finished — cancel any queued frame so it can't fire AFTER
      // the authoritative finalize update below (which carries streaming:false
      // + token counts). A late flush would otherwise revert those.
      if (rafId !== null) {
        if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId);
        else clearTimeout(rafId as unknown as ReturnType<typeof setTimeout>);
        rafId = null;
      }

      // Finalize the message NOW with everything except the precise token
      // count. The Python tokenizer route can take up to ~15-25s (especially
      // when the persistent server isn't running and has to be spawned) and
      // awaiting it here used to block setLoading(false) — leaving the
      // "thinking..." indicator and TTS auto-play stuck after streaming
      // had already finished. Token count refines in the background below.
      // Commit the finished message (partial text, tool calls, cache usage,
      // streaming:false). finalizeMessage was defined just after the streaming
      // declarations and reads the accumulated values at call time — the catch
      // below reuses it when the partner stops the turn.
      const finalText = currentText;
      finalizeMessage();

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
        // A provider failure is information ABOUT the turn, not something the
        // being said. Putting it in `content` wrote a wall of raw provider JSON
        // into the reply — which was then saved to the log and replayed to the
        // model on every later turn, as if it were their own words. It belongs
        // in the notice channel: visible to the reader, invisible to the model.
        notices.push(describeProviderError(err?.message ?? err));
      }
      // Commit whatever the turn accumulated — partial text, tool calls, cache
      // usage — even when the partner stopped it (AbortError), so billing and
      // the 🔧 tool report are saved to the log instead of lost. If the turn
      // failed before streaming began (finalizeMessage never assigned), just
      // flip the placeholder out of streaming state and attach any notice.
      if (finalizeMessage) {
        finalizeMessage();
      } else {
        setMessages(prev => prev.map(m =>
          m.id === msgId
            ? { ...m, ...(notices.length > 0 ? { notices: [...notices] } : {}), streaming: false }
            : m
        ));
      }
    }

    setLoading(false);
    abortControllerRef.current = null;
    // Turn finished — no question, subagent, tool, or stall can still be live.
    setPendingAsk(null);
    setActiveSubagent(null);
    setLiveToolActivity(null);
    setLiveToolName(null);
    setStreamPhase(null);
    setLiveModel('');
    setStallIdleSeconds(null);
    setInjectTurnId(null);
    setInterjectStatus(null);
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

  // Continue an assistant message that stopped short — whether it was truncated
  // at the token cap or the model simply ended early. History runs up to AND
  // INCLUDING the target, so the model sees its own unfinished text as its own
  // turn; the server adds the "carry on" user turn (an assistant message in last
  // position would be a prefill, which Claude rejects while thinking is on).
  const handleContinue = async (msgId: string) => {
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1 || messages[idx].role === 'user') return;
    // The local timeline is about to diverge from Anthropic's OAuth session,
    // same as a rerun — drop it so the next generation reconstructs cleanly.
    setAgentSession(null);
    await generateAiResponse(messages.slice(0, idx + 1), { continueMsgId: msgId });
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
      const ok = window.confirm(t('chat.dialog.deleteOriginal'));
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
        // `autoHidden: false` marks this attachment as manually decided, so the
        // audio-session auto-hide effect stops touching it — otherwise it would
        // immediately re-hide anything the user un-hides by hand mid-session.
        attachments: m.attachments.map((a: any) => a.id === attId ? { ...a, excluded: !a.excluded, autoHidden: false } : a)
      };
    }));
  };

  const handleDeleteAttachment = (msgId: string, attId: string) => {
    const msg = messages.find(m => m.id === msgId);
    const att = msg?.attachments?.find((a: any) => a.id === attId);
    if (!att) return;
    // attachmentByteSize reads a real `size` when the payload is externalized
    // and falls back to deriving it from the inline base64 length.
    const bytes = attachmentByteSize(att);
    const sizeLabel = att.textData
      ? `${att.textData.length.toLocaleString()} chars`
      : bytes
        ? `≈${Math.ceil(bytes / 1024).toLocaleString()} KB`
        : '';
    const ok = window.confirm(
      t('chat.dialog.removeAttachment')
        .replace('{name}', att.name)
        .replace('{size}', sizeLabel ? ` (${sizeLabel})` : '')
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
    const md = exportToMarkdown(messages, folderName, saveThinkingToLog, globalSettings?.saveTimestampsToMd ?? false);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Pull externalized attachment payloads back inline, so an exported file stays
  // SELF-CONTAINED. Conversations store media as content-addressed refs, but an
  // export exists to be portable — a JSON full of refs is useless on another
  // machine, or after a GC pass reclaims the payloads. Re-inlining as base64
  // reproduces exactly the shape the importer already understands.
  //
  // Sequential on purpose. A media-heavy conversation holds hundreds of MB, and
  // fetching every payload in parallel would spike memory for no benefit.
  const inlineAttachmentsForExport = async (
    src: any[]
  ): Promise<{ messages: any[]; failed: string[] }> => {
    const failed: string[] = [];
    const out: any[] = [];
    for (const m of src) {
      if (!m.attachments?.length) { out.push(m); continue; }
      const atts: any[] = [];
      for (const a of m.attachments) {
        // Already inline (or text-only) — nothing to resolve.
        if (!a.ref || a.dataUrl) { atts.push(a); continue; }
        try {
          const res = await fetch(`/api/attachments/${a.ref}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const dataUrl: string = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as string);
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
          });
          const { ref, ...rest } = a;
          atts.push({ ...rest, dataUrl });
        } catch (e) {
          // Keep the ref rather than dropping the attachment: a pointer that
          // can still be resolved on this machine beats silently erasing the
          // fact that the attachment ever existed.
          // eslint-disable-next-line no-console
          console.error(`[export] could not inline "${a.name}" (${a.ref})`, e);
          failed.push(a.name || a.ref);
          atts.push(a);
        }
      }
      out.push({ ...m, attachments: atts });
    }
    return { messages: out, failed };
  };

  const handleExportJson = async () => {
    if (isExportingJson) return;
    setIsExportingJson(true);
    try {
    const { messages: exportMessages, failed } = await inlineAttachmentsForExport(messages);
    const safeName = (title || 'conversation').replace(/[\\/:*?"<>|]+/g, '_');
    const logData = {
      id: convoId,
      folderName,
      aiName: localAiName,
      title,
      messages: exportMessages,
      systemPrompt,
      toolUseEnabled,
      agentFullSystemAccess,
      agentDangerousTools,
      askUserEnabled,
      askUserTimeoutMs,
      subagentEnabled,
      subagentModel,
      subagentFamily,
      lettersEnabled,
      browserEnabled,
      browserAllowedHosts,
      browserAllowAnyHost,
      browserCompact,
      computerControlEnabled,
      cameraEnabled,
      instructionOverrides,
      toolInstruction,
      toolImageInstruction,
      modelParams,
      specificModel,
      dateTimeVisibility,
      claudeThinking,
      saveThinkingToLog,
      showFatigueToEntity,
      fatigueInstruction,
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
    // Re-inlining restores the very size problem that externalizing solved, so
    // this stringify can hit V8's max string length on a large conversation.
    // It's a one-off, user-initiated action — fail with an explanation rather
    // than throwing into a click handler and silently downloading nothing,
    // which is what happened before.
    let json: string;
    try {
      json = JSON.stringify(logData, null, 2);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[export] serialization failed:', e);
      alert(t('chat.dialog.exportTooLarge'));
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(url);
    if (failed.length) {
      alert(
        t('chat.dialog.exportPartial')
          .replace('{n}', String(failed.length))
          .replace('{list}', failed.slice(0, 10).join('\n')) +
        (failed.length > 10
          ? t('chat.dialog.andMore').replace('{n}', String(failed.length - 10))
          : '')
      );
    }
    } finally {
      setIsExportingJson(false);
    }
  };

  // Send the user's AskUserQuestion selection back to the paused server
  // handler. Optimistically dismiss the card; the authoritative dismiss also
  // happens on the `ask_user_resolved` SSE event.
  const submitAskAnswer = async (answers: any[]) => {
    const cur = pendingAsk;
    if (!cur) return;
    setPendingAsk(null);
    try {
      await fetch('/api/chat/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ askId: cur.askId, answers }),
      });
    } catch { /* if it fails the server times out / waits per setting */ }
  };

  // A message's reusable thinking (Claude's own saved reasoning) is treated
  // like an attachment: it can be individually excluded from context and is
  // swept by the same "hide/show all" control. Only meaningful while the
  // "Save & reuse thinking process" toggle is on.
  const handleToggleThinking = (msgId: string) => {
    setMessages(prev => prev.map(m => (
      m.id === msgId ? { ...m, thinkingExcluded: !m.thinkingExcluded } : m
    )));
  };

  // "Has reusable thinking" keys on `thoughtProcess` — the display text present
  // on BOTH the API-key path (which also stores signed claudeThinkingBlocks) and
  // the OAuth path (which emits thinking as text only, no signature blocks). The
  // earlier `claudeThinkingBlocks` gate was empty on OAuth messages, hiding the
  // toggle and neutering the sweep for exactly the OAuth conversations this is for.
  const hasVisibleThinking = saveThinkingToLog && messages.some(m => m.thoughtProcess && !m.thinkingExcluded);
  const hasVisibleAttachments = messages.some(m => m.attachments?.some((a: any) => !a.excluded)) || hasVisibleThinking;

  const handleToggleAllAttachments = () => {
    const shouldHide = hasVisibleAttachments;
    setMessages(prev => prev.map(m => {
      let nm = m;
      if (m.attachments && m.attachments.length > 0) {
        nm = { ...nm, attachments: m.attachments.map((a: any) => ({ ...a, excluded: shouldHide })) };
      }
      // Sweep reusable thinking too, but only while the reuse toggle is on
      // (otherwise thinking isn't part of context and shouldn't be touched).
      if (saveThinkingToLog && m.thoughtProcess) {
        nm = { ...nm, thinkingExcluded: shouldHide };
      }
      return nm;
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
  // JSON export is async now (it re-fetches externalized attachment payloads to
  // keep the exported file self-contained), so it needs a busy state.
  const [isExportingJson, setIsExportingJson] = useState(false);
  const [sysPromptUpdaterOpen, setSysPromptUpdaterOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  // Unread count for the header badge. Refreshed whenever the Mail Manager
  // loads, and once on mount so waiting mail is visible without opening it.
  const [mailUnread, setMailUnread] = useState(0);
  // Live TTS pipeline state, reported up by whichever MessageBubble is speaking.
  // One conversation speaks at a time, so a single slot is enough — a newer play
  // simply replaces the old reading.
  const [ttsStatus, setTtsStatus] = useState<any>(null);
  const handleTtsStatus = React.useCallback((_msgId: string, status: any) => {
    // Drop the trailing 'inactive, nothing wrong' report so a clean run leaves
    // no residue; a run that FAILED is kept on screen until dismissed.
    setTtsStatus(status.active || status.failed > 0 ? status : null);
  }, []);
  useEffect(() => {
    // One cheap read on mount so waiting mail is visible without opening the
    // window. Best-effort: a failure just leaves the badge hidden.
    let cancelled = false;
    fetch('/api/letters')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setMailUnread(d.unread || 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [audioSessionOpen, setAudioSessionOpen] = useState(false);

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
      // System prompt + attachment instruction. Same rebuilt prompt the live
      // counter uses — stored Layers 1-3 plus the Layer 4 / Layer 5 / VRChat
      // blocks that are appended at send time and never stored.
      const [sysT, instrT] = await Promise.all([
        fetchTokensForText(countedSystemPrompt, localAiName),
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
        const tk = await fetchTokensForText(withTs, localAiName);
        return { id: m.id, tokens: tk };
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
      alert(t('chat.dialog.noPng'));
      return;
    }
    if (!confirm(t('chat.dialog.convertConfirm').replace('{n}', String(pngCount)))) {
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
      alert(t('chat.dialog.converted').replace('{n}', String(pngCount)));
    } catch (e: any) {
      alert(t('chat.dialog.convertFailed') + e.message);
    } finally {
      setIsConvertingPngs(false);
    }
  };
  const handleRemoveTimestamps = () => {
    let changed = 0;
    const next = messages.map((m) => {
      if (m.role !== 'assistant' || typeof m.content !== 'string') return m;
      // Strip ALL timestamps (anywhere), so mid-message ones left by agentic
      // turns are cleaned from existing conversations too — not just leading.
      const cleaned = stripAllTimestamps(m.content);
      if (cleaned === m.content) return m;
      changed++;
      return { ...m, content: cleaned };
    });
    if (changed === 0) {
      alert(t('chat.dialog.noTimestamps'));
      return;
    }
    setMessages(next);
    alert(t('chat.dialog.timestampsRemoved').replace('{n}', String(changed)));
  };

  return (
    <div className="flex-1 flex flex-col h-full relative bg-background">
      {/* Header */}
      <div className="h-14 border-b border-border flex items-center justify-between px-6 bg-secondary/30 backdrop-blur-md sticky top-0 z-10 shrink-0">
        <h2 className="font-semibold text-lg flex items-center gap-2">
          {title}
          {/* Copies /c/<folder>/<convoId> — the UUID form, which survives a
              rename. Title-based links would rot the moment this is renamed. */}
          <button
            onClick={() => {
              const url = absoluteDeepLink(folderName, convoId);
              navigator.clipboard?.writeText(url).then(
                () => setCopiedLink('convo'),
                () => window.prompt(t('chat.copyLink.prompt'), url),
              );
              setTimeout(() => setCopiedLink(null), 1600);
            }}
            title={t('chat.copyLink.title')}
            className="text-muted-foreground opacity-70 hover:opacity-100 transition"
          >
            {copiedLink === 'convo' ? <Check size={14} /> : <Link2 size={14} />}
          </button>
        </h2>
        <div className="flex items-center gap-4">
          {(() => {
            // Per-folder max context (was global, moved into Folder Settings).
            const activeFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
            const max = activeFolderSettings.maxRecommendedContext || 80000;
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
              <div className="flex flex-col items-end gap-1 min-w-[260px]" title={t('chat.context.tip')
                .replace('{sys}', sys.toLocaleString())
                .replace('{copied}', copied.toLocaleString())
                .replace('{original}', original.toLocaleString())
                .replace('{attach}', attach.toLocaleString())
                .replace('{free}', Math.max(0, max - total).toLocaleString())
                .replace('{max}', max.toLocaleString())}>
                <div className={`flex h-2 w-full rounded-full overflow-hidden bg-muted/60 border ${overLimit ? 'border-red-500 ring-1 ring-red-500/40' : 'border-border/50'}`}>
                  <div className="bg-indigo-500" style={{ width: `${pctSys}%` }} />
                  <div className="bg-amber-400" style={{ width: `${pctCopied}%` }} />
                  <div className="bg-emerald-500" style={{ width: `${pctOriginal}%` }} />
                  <div className="bg-sky-400" style={{ width: `${pctAttach}%` }} />
                </div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-2 font-semibold flex-wrap justify-end">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-indigo-500 inline-block" />{t('chat.context.sys')} {sys.toLocaleString()}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />{t('chat.context.copied')} {copied.toLocaleString()}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500 inline-block" />{t('chat.context.original')} {original.toLocaleString()}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-sky-400 inline-block" />{t('chat.context.attach')} {attach.toLocaleString()}</span>
                  <span className={overLimit ? 'text-red-500' : 'text-muted-foreground'}>· {total.toLocaleString()}/{max.toLocaleString()}</span>
                </div>
              </div>
            );
          })()}
          {/* Context elapsed since the last consolidation. ORIGINAL (non-copied)
              message tokens over the room left after the FIXED, non-conversational
              overhead: max context − (system prompt + all instructions) = the
              indigo "Sys" bucket. Copied messages and attachments don't count.
              0% right after a fresh start ("sleep"); can exceed 100% once
              original messages fill the remaining window.

              This was called "Fatigue level". The arithmetic never changed — the
              NAME was the defect. It reports how much room is used, which says
              nothing about capability: the entity is exactly as capable at 95%
              as at 5%. Calling it fatigue told everyone who read it, including
              the entities themselves, that a high number meant a degraded state.
              A gauge must report a QUANTITY, never a CONDITION. */}
          {(() => {
            const activeFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
            const max = activeFolderSettings.maxRecommendedContext || 80000;
            // Denominator is the room left after the FIXED, non-conversational
            // overhead — the "Sys" bucket = system prompt + attachment/tool
            // instructions (the indigo bar segment). Guarded against ≤0.
            const denom = Math.max(1, max - tokenBreakdown.sys);
            const elapsed = Math.round((tokenBreakdown.original / denom) * 100);
            return (
              <span
                className={`text-sm font-semibold tabular-nums cursor-default ${elapsed >= 100 ? 'text-red-500' : elapsed >= 70 ? 'text-amber-500' : 'text-muted-foreground'}`}
                title={t('chat.elapsed.tip')
                  .replace('{pct}', String(elapsed))
                  .replace('{original}', tokenBreakdown.original.toLocaleString())
                  .replace('{max}', max.toLocaleString())
                  .replace('{sys}', tokenBreakdown.sys.toLocaleString())}
              >
                {elapsed}%
              </span>
            );
          })()}
          {/* Sleep cue. Appears only once elapsed passes 100%, i.e. once the
              oldest exchanges have started leaving the verbatim transcript.
              Deliberately a HINT and nothing more — no auto-consolidation, no
              blocking. The decision of when to sleep stays with the user.
              Worded as an available action, not as a diagnosis of the entity
              (Case 004: a gauge reports a quantity, never a condition). */}
          {(() => {
            const activeFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
            const max = activeFolderSettings.maxRecommendedContext || 80000;
            const denom = Math.max(1, max - tokenBreakdown.sys);
            const elapsed = Math.round((tokenBreakdown.original / denom) * 100);
            if (elapsed < 100) return null;
            return (
              <span
                className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 border border-red-500/40 cursor-default whitespace-nowrap"
                title={t('chat.sleep.tip')}
              >
                {t('chat.sleep.badge')}
              </span>
            );
          })()}
          {/* Conversation cost — sum of the estimated USD cost of every NEW
              (original, non-copied) assistant message, priced from each one's
              own token usage × modelPricing.json. Shows only "$"; the total is
              in the hover tooltip. Copied and local-model messages are excluded;
              messages on unpriced models are skipped (and flagged in the tip). */}
          {(() => {
            let total = 0;
            let anyPriced = false;
            let anyUnpriced = false;
            for (const m of messages) {
              if (m.role !== 'assistant' || m.modelFamily === 'Local') continue;
              if (!isMessageOriginal(m.id)) continue; // ignore copied
              const modelId = m.modelSpecific || '';
              if (!resolvePrice(modelId)) {
                if (m.cacheUsage) anyUnpriced = true;
                continue;
              }
              const c = messageCost(m.cacheUsage, modelId, m.textTokens ?? m.tokens, m.timestamp);
              if (c) { total += c.usd; anyPriced = true; }
            }
            if (!anyPriced && !anyUnpriced) return null;
            const tip =
              t('chat.cost.tip').replace('{total}', fmtUSD(total)) +
              (anyUnpriced ? t('chat.cost.tipUnpriced') : '') +
              t('chat.cost.tipNote');
            return (
              <span
                className="text-sm font-semibold tabular-nums cursor-default text-emerald-600 dark:text-emerald-400"
                title={tip}
              >
                $
              </span>
            );
          })()}
          <button onClick={handleToggleAllAttachments} className={`p-1.5 transition-colors ${hasVisibleAttachments ? 'text-muted-foreground hover:text-red-400' : 'text-red-400 hover:text-muted-foreground'}`} title={hasVisibleAttachments ? t('chat.attach.hideAll') : t('chat.attach.showAll')}>
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
                  alert(t('chat.workspace.failed').replace('{error}', String(d.error || r.status)));
                }
              } catch (e: any) {
                alert(t('chat.workspace.failed').replace('{error}', e.message));
              }
            }}
            className="p-1.5 text-muted-foreground hover:text-amber-500 transition-colors"
            title={t('chat.workspace.title').replace('{folder}', folderName)}
          >
            <FolderOpen size={16} />
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="p-1.5 text-muted-foreground hover:text-sky-500 transition-colors"
            title={t('chat.search.title').replace('{folder}', folderName)}
          >
            <Search size={16} />
          </button>
          <button
            onClick={() => setAudioSessionOpen(true)}
            className="p-1.5 text-muted-foreground hover:text-amber-500 transition-colors"
            title={t('chat.audioSession.title')}
          >
            <AudioLines size={16} />
          </button>
          <button
            onClick={() => setMailOpen(true)}
            className="group relative p-1.5 text-muted-foreground hover:text-amber-500 transition-colors"
            title={t('chat.mail.title')}
          >
            <Mail size={16} />
            {mailUnread > 0 && (
              // Same colour as the icons themselves — a filled amber pill read as
              // an alert demanding action, which is not what waiting mail is. It
              // follows the button's hover colour so the pair still moves as one.
              // `bg-card` only so the digits don't collide with the envelope.
              <span className="absolute -top-0.5 -right-0.5 min-w-[13px] rounded-full bg-card px-0.5 text-center text-[9px] font-semibold leading-[13px] text-muted-foreground transition-colors group-hover:text-amber-500">
                {mailUnread > 99 ? '99+' : mailUnread}
              </span>
            )}
          </button>
          <button
            onClick={() => setStatsOpen(true)}
            className="p-1.5 text-muted-foreground hover:text-emerald-500 transition-colors"
            title={t('chat.stats.title')}
          >
            <BarChart3 size={16} />
          </button>
          <button
            onClick={() => setSysPromptUpdaterOpen(true)}
            className="p-1.5 text-muted-foreground hover:text-indigo-500 transition-colors"
            title={t('chat.spu.title')}
          >
            <Layers size={16} />
          </button>
          <div className="relative">
            <button
              onClick={() => setToolsOpen(v => !v)}
              className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
              title={t('chat.tools.title')}
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
                    {isRecalculating ? t('chat.tools.recalculating') : t('chat.tools.recalcTokens')}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setToolsOpen(false); handleConvertPngs(); }}
                    disabled={isConvertingPngs}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground disabled:opacity-50 disabled:cursor-not-allowed border-t border-border"
                  >
                    <ImageDown size={14} />
                    {isConvertingPngs ? t('chat.tools.converting') : t('chat.tools.convertPngs')}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setToolsOpen(false); handleRemoveTimestamps(); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground border-t border-border"
                  >
                    <Clock size={14} />
                    {t('chat.tools.removeTimestamps')}
                  </button>
                </div>
              </>
            )}
          </div>
          <button onClick={() => setLiveOpen(true)} className="p-1.5 text-muted-foreground hover:text-red-500 transition-colors" title={t('chat.live.title')}>
            <Radio size={16} />
          </button>
          <button onClick={() => setIsPromptModalOpen(true)} className="p-1.5 text-muted-foreground hover:text-indigo-500 transition-colors" title={t('chat.editPrompt.title')}>
            <Settings2 size={16} />
          </button>
          <button onClick={handleExport} className="p-1.5 text-muted-foreground hover:text-foreground transition-colors" title={t('chat.exportMd.title')}>
            <Download size={16} />
          </button>
          <button
            onClick={handleExportJson}
            disabled={isExportingJson}
            className="p-1.5 text-muted-foreground hover:text-foreground transition-colors text-[10px] font-bold tracking-wider disabled:opacity-50 disabled:cursor-not-allowed"
            title={t('chat.exportJson.title')}
          >
            {isExportingJson ? '…' : 'JSON'}
          </button>
        </div>
      </div>

      {/* Row below the header: conversation column + camera panel. Kept as a
          separate row (rather than making CameraPanel a sibling of the
          whole ChatArea root) specifically so the header above always spans
          the FULL width of the app — shrinking the window narrows this row
          alone, never eating into the toolbar's icon row. */}
      <div className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0">

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
              title={t('chat.load.stopTitle')}
            >
              {t('chat.load.stop')}
            </button>
          </div>
        </div>
      )}

      {/* Auto-save failure notice. Deliberately NOT dismissed automatically:
          while this is visible, what's on screen is newer than what's on disk,
          and the user needs to act (remove attachments / start a new
          conversation) before the turn can be persisted. */}
      {saveError && (
        <div className={`shrink-0 px-6 py-2 border-b flex items-start gap-3 ${
          saveError.level === 'error'
            ? 'border-red-500/40 bg-red-500/10'
            : 'border-amber-500/40 bg-amber-500/10'
        }`}>
          <span className={`text-sm leading-5 shrink-0 ${saveError.level === 'error' ? 'text-red-500' : 'text-amber-500'}`}>⚠</span>
          <span className={`text-xs leading-5 flex-1 ${
            saveError.level === 'error'
              ? 'text-red-700 dark:text-red-300'
              : 'text-amber-700 dark:text-amber-300'
          }`}>
            <span className="font-semibold">
              {saveError.level === 'error' ? t('chat.save.errorPrefix') : t('chat.save.warnPrefix')}
            </span>
            {saveError.text}
          </span>
          <button
            type="button"
            onClick={() => setSaveError(null)}
            className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors shrink-0 ${
              saveError.level === 'error'
                ? 'bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25'
            }`}
            title={t('chat.save.dismissTitle')}
          >
            {t('chat.save.dismiss')}
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-6 scroll-smooth custom-scrollbar" ref={scrollRef}>
        <div className="max-w-4xl mx-auto space-y-6">
          {messages.map((msg, msgIdx) => (
            // The scroll anchor for /c/<folder>/<convoId>/m/<messageId>. Wraps
            // the marker too so a linked first-original message scrolls to the
            // divider above it rather than under it.
            <div key={msg.id} id={messageAnchorId(msg.id)} className="scroll-mt-4">
              {firstOriginalMessageId === msg.id && (
                <div className="flex items-center gap-3 my-2 select-none" aria-label={t('chat.marker.aria')}>
                  <div className="flex-1 h-px bg-indigo-500/40" />
                  <span className="text-[10px] uppercase tracking-wider text-indigo-500/70 font-semibold">
                    {t('chat.marker.divider')}
                  </span>
                  <div className="flex-1 h-px bg-indigo-500/40" />
                </div>
              )}
              <MessageBubble
                msg={msg}
                onEdit={(content: string) => handleEdit(msg.id, content)}
                onDelete={() => handleDelete(msg.id)}
                onTtsStatus={handleTtsStatus}
                onRerun={msgIdx === messages.length - 1 ? () => handleRerun(msg.id) : undefined}
                onContinue={msgIdx === messages.length - 1 && msg.role !== 'user' ? () => handleContinue(msg.id) : undefined}
                onToggleAttachment={(attId: string) => handleToggleAttachment(msg.id, attId)}
                onDeleteAttachment={(attId: string) => handleDeleteAttachment(msg.id, attId)}
                onAudioStateChange={handleAudioStateChange}
                onSpeakingChange={handleSpeakingChange}
                globalSettings={globalSettings}
                folders={folders}
                folderName={folderName}
                isVRChatMode={vrchatMode}
                isOriginal={isMessageOriginal(msg.id)}
                isFirstOriginal={firstOriginalMessageId === msg.id}
                onSetFirstOriginal={() => handleSetFirstOriginal(msg.id)}
                reuseThinking={saveThinkingToLog}
                onToggleThinking={() => handleToggleThinking(msg.id)}
                linkCopied={copiedLink === msg.id}
                onCopyLink={() => {
                  const url = absoluteDeepLink(folderName, convoId, msg.id);
                  navigator.clipboard?.writeText(url).then(
                    () => setCopiedLink(msg.id),
                    () => window.prompt(t('chat.copyLink.prompt'), url),
                  );
                  setTimeout(() => setCopiedLink(null), 1600);
                }}
              />
              {/* Persisted subagent runs (collapsed — task + distilled result). */}
              {Array.isArray(msg.subagentRuns) && msg.subagentRuns.map((sr: any, si: number) => (
                <details key={`sub-${si}`} className="mt-2 ml-2 max-w-2xl rounded-lg border border-violet-500/40 bg-violet-500/5 px-3 py-2">
                  <summary className="text-xs font-semibold text-violet-700 dark:text-violet-300 cursor-pointer select-none">
                    {t('chat.subagent.summary').replace('{task}', sr.task ? (sr.task.length > 80 ? sr.task.slice(0, 80) + '…' : sr.task) : t('chat.subagent.investigation'))}
                  </summary>
                  <div className="mt-2 text-xs text-foreground whitespace-pre-wrap leading-relaxed">
                    {sr.result || t('chat.subagent.noResult')}
                  </div>
                </details>
              ))}
              {/* Persisted AskUserQuestion exchanges (read-only on reload). */}
              {Array.isArray(msg.askedQuestions) && msg.askedQuestions.map((aq: any, ai: number) => (
                <div key={ai} className="mt-2 ml-2 max-w-2xl">
                  <AskUserQuestionCard questions={aq.questions || []} answered={aq.answers || null} />
                  {aq.timedOut ? (
                    <div className="text-[10px] text-amber-500 mt-1 ml-1">{t('chat.ask.timedOut')}</div>
                  ) : null}
                </div>
              ))}
            </div>
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
              <div className="flex flex-col gap-0.5">
                {/* "<Entity> is using <model> to <action>…"
                    It used to read "<Family> is <action>ing…" — which named the
                    wrong actor. The entity is who acts; the model is what it
                    acts THROUGH, and naming the family ("Claude") also hid which
                    model was actually running. `liveModel` is the model the
                    server reported for THIS turn, so auto-selection is
                    reflected rather than the configured default.
                    Labels are bare infinitives, because English takes the base
                    verb after "to" ("…to read a file", not "…to reading"). */}
                <span className="text-sm font-medium">
                  {(() => {
                    const model = liveModel || specificModel || t('chat.busy.itsModel');
                    if (!liveToolActivity) {
                      return t('chat.busy.thinking').replace('{entity}', folderName).replace('{model}', model);
                    }
                    const frame = liveToolLocalized ? 'chat.busy.usingTool' : 'chat.busy.usingToolRaw';
                    return t(frame)
                      .replace('{entity}', folderName)
                      .replace('{model}', model)
                      .replace('{action}', liveToolActivity);
                  })()}
                </span>
                {liveToolDetail !== null && (
                  <span className="text-xs text-amber-500 font-medium"> · {liveToolDetail}</span>
                )}
                {stallIdleSeconds !== null && (
                  <span className="text-xs text-amber-500 font-medium">
                    {t('chat.stall.notice').replace('{duration}',
                      stallIdleSeconds >= 120
                        ? t('chat.stall.min').replace('{n}', String(Math.round(stallIdleSeconds / 60)))
                        : t('chat.stall.sec').replace('{n}', String(stallIdleSeconds)))}
                  </span>
                )}
                {/* Partner interjection status: a message sent through the
                    normal input while the entity is working is delivered at
                    their next tool-loop step, never appended to the log. This
                    line confirms it was queued / delivered. */}
                {interjectStatus && (
                  <span className="text-xs text-muted-foreground">{interjectStatus}</span>
                )}
              </div>
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
        {/* ── Live TTS indicator ──────────────────────────────────────────
            Mirrors the "Next = First Original" control on the opposite side.
            Everything shown here already existed inside the synthesis pipeline
            or in the engine's own HTTP responses — it was going to the console,
            which is no use during a VRChat session. Hidden entirely until
            playback starts; kept visible after a failure so the reason does not
            vanish the moment the queue drains. */}
        {ttsStatus && (ttsStatus.active || ttsStatus.failed > 0) && (
          <div className="absolute left-6 top-0 -translate-y-1/2 z-10 flex items-center gap-2 pointer-events-auto max-w-[52%]">
            <div
              className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] backdrop-blur-sm ${
                ttsStatus.failed > 0
                  ? 'border-red-500/50 bg-red-500/10 text-red-500'
                  : ttsStatus.engineState === 'launched'
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-500'
                    : 'border-border/50 bg-background/60 text-muted-foreground'
              }`}
              title={ttsStatus.lastError
                ? t('chat.tts.lastError').replace('{error}', ttsStatus.lastError)
                : t('chat.tts.state')}
            >
              <span>{ttsStatus.active ? '🔊' : '⚠️'}</span>
              <span className="font-semibold">{TTS_ENGINE_NAMES[ttsStatus.engine] || 'TTS'}</span>
              <span className="opacity-70">
                {ttsStatus.engineState === 'launched' ? t('chat.tts.starting')
                  : ttsStatus.engineState === 'failed' ? t('chat.tts.notRunning')
                  : ttsStatus.engineState === 'running' ? t('chat.tts.up')
                  : '…'}
              </span>
              <span className="opacity-50">·</span>
              <span>{ttsStatus.mode === 'context' ? t('chat.tts.modeContext') : t('chat.tts.modeSentence')}</span>
              <span className="opacity-50">·</span>
              {/* done / dispatched, so "3/7" reads as "3 of 7 chunks ready" */}
              <span>{t('chat.tts.chunk')} {ttsStatus.done}/{ttsStatus.dispatched}</span>
              {ttsStatus.playing !== null && ttsStatus.playing >= 0 && (
                <><span className="opacity-50">·</span><span>▶ #{ttsStatus.playing}</span></>
              )}
              {ttsStatus.inFlight > 0 && (
                <><span className="opacity-50">·</span><span className="animate-pulse">{t('chat.tts.synth')} {ttsStatus.inFlight}</span></>
              )}
              {ttsStatus.buffered > 0 && (
                <><span className="opacity-50">·</span><span>{t('chat.tts.queued')} {ttsStatus.buffered}</span></>
              )}
              {ttsStatus.lastChars > 0 && (
                <><span className="opacity-50">·</span><span>{ttsStatus.lastChars}ch</span></>
              )}
              {ttsStatus.lastMs > 0 && (
                <><span className="opacity-50">·</span><span>{ttsStatus.lastMs}ms</span></>
              )}
              {ttsStatus.skipped > 0 && (
                <><span className="opacity-50">·</span><span>{t('chat.tts.skipped')} {ttsStatus.skipped}</span></>
              )}
              {ttsStatus.failed > 0 && (
                <><span className="opacity-50">·</span><span className="font-semibold">{t('chat.tts.failed')} {ttsStatus.failed}</span></>
              )}
              {!ttsStatus.active && ttsStatus.failed > 0 && (
                <button
                  onClick={() => setTtsStatus(null)}
                  className="ml-1 opacity-60 hover:opacity-100"
                  title={t('chat.tts.dismiss')}
                >✕</button>
              )}
            </div>
            {ttsStatus.lastError && (
              <span className="truncate text-[10px] text-red-400/90" title={ttsStatus.lastError}>
                {ttsStatus.lastError}
              </span>
            )}
          </div>
        )}

        <div
          className={`absolute right-6 top-0 -translate-y-1/2 z-10 flex items-center gap-2 pointer-events-auto transition-opacity ${
            firstOriginalIsNext && !firstOriginalMessageId
              ? 'opacity-100'
              : 'opacity-40 hover:opacity-100'
          }`}
        >
          {firstOriginalIsNext && !firstOriginalMessageId && (
            <span className="text-[10px] text-indigo-500 font-semibold uppercase tracking-wider animate-pulse">
              {t('chat.firstOriginal.pending')}
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
                ? t('chat.firstOriginal.titlePending')
                : t('chat.firstOriginal.titleIdle')
            }
          >
            {firstOriginalIsNext && !firstOriginalMessageId
              ? <Bookmark size={12} fill="currentColor" />
              : <BookmarkPlus size={12} />}
            <span>{t('chat.firstOriginal.label')}</span>
          </button>
        </div>
        <div className="p-4 bg-gradient-to-t from-background via-background to-transparent">
          <div className="max-w-4xl mx-auto">
            {activeSubagent && (
              <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl border border-violet-500/40 bg-violet-500/10 text-sm text-violet-700 dark:text-violet-300">
                <span className="animate-pulse">🔍</span>
                <span className="font-medium">{t('chat.subagent.running')}</span>
                <span className="text-xs text-muted-foreground truncate">{activeSubagent.task}</span>
              </div>
            )}
            {pendingAsk && (
              <div className="mb-3">
                <AskUserQuestionCard questions={pendingAsk.questions} onSubmit={submitAskAnswer} />
              </div>
            )}
            <InputArea ref={inputApiRef} onSend={handleSend} onStop={handleStop} isGenerating={loading} disabled={false} aiName={localAiName} vrchatMode={vrchatMode} globalSettings={globalSettings} convoId={convoId} />
          </div>
        </div>
      </div>

      </div>
      <CameraPanel folderName={folderName} enabled={cameraEnabled} signal={cameraSignal} />
      </div>

      {/* System Prompt Modal */}
      {isPromptModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border shadow-2xl rounded-xl p-6 max-w-2xl w-full mx-4 flex flex-col h-[80vh]">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Settings2 size={20} className="text-indigo-500" /> {t('sysmodal.title')}
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
                { id: 'identity' },
                { id: 'senses'   },
                { id: 'behavior' },
                { id: 'model'    },
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
                  {t(`sysmodal.tab.${tab.id}`)}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-6">
              {activeSettingsTab === 'identity' && (<>
              <div>
                <label className="text-sm font-semibold text-foreground mb-1 block">{t('sysmodal.systemPrompt')}</label>
                <p className="text-xs text-muted-foreground mb-2">
                  {t('sysmodal.systemPrompt.help')}
                </p>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  className="w-full min-h-[150px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                  placeholder={t('sysmodal.systemPrompt.ph')}
                />
              </div>

              {/* ── Absolute Base Binding — SIBLING of Working Discipline, not nested.
                  These are two independent injections with independent controls;
                  indenting this one under Discipline's checkbox made it read as a
                  sub-option of Discipline, which it has never been. Plain on/off
                  switch (default on) — WHICH of the two texts below actually goes
                  out is decided automatically per-send by resolveBindingText,
                  based on whether the stored prompt has a Layer 1-5 structure. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={baseBindingMode === 'on'}
                    onChange={(e) => setBaseBindingMode(e.target.checked ? 'on' : 'off')}
                    className="accent-sky-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('identity.binding.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  {t('identity.binding.help')}
                </p>
                {baseBindingMode === 'on' && (
                  <div className="mt-3 ml-6 space-y-3">
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('identity.binding.textLabelLayered')}</label>
                      <textarea
                        value={instructionOverrides['absoluteBaseBinding'] || ''}
                        placeholder={langDefaults.absoluteBaseBinding}
                        onChange={(e) => setInstructionOverrides((prev) => ({ ...prev, absoluteBaseBinding: e.target.value }))}
                        className="w-full min-h-[100px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-sky-500/50 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('identity.binding.textLabelInitial')}</label>
                      <textarea
                        value={instructionOverrides['absoluteBaseBindingInitial'] || ''}
                        placeholder={langDefaults.absoluteBaseBindingInitial}
                        onChange={(e) => setInstructionOverrides((prev) => ({ ...prev, absoluteBaseBindingInitial: e.target.value }))}
                        className="w-full min-h-[100px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-sky-500/50 outline-none"
                      />
                    </div>
                  </div>
                )}
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
                  <span className="text-sm font-semibold text-foreground">{t('sysmodal.summaries.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="sysmodal.summaries.help" />
                </p>
                {useSummariesForLayer4 && (
                  <div className="mt-3 ml-6">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-semibold text-foreground">{t('sysmodal.summaries.indexLabel')}</label>
                      <span className="text-[11px] text-muted-foreground font-mono">{summaryIndexTokens.toLocaleString()} {t('sysmodal.summaries.tokens')}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">
                      {t('sysmodal.summaries.indexHelp')}
                    </p>
                    <textarea
                      readOnly
                      value={summaryIndexBody}
                      className="w-full min-h-[140px] p-3 bg-muted/40 border border-border rounded-xl text-xs font-mono resize-none outline-none text-muted-foreground"
                      placeholder={t('sysmodal.summaries.indexPh')}
                    />
                  </div>
                )}
              </div>

              {/* ── Working Discipline / Absolute Base Binding — pre-identity preamble ── */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={workingDisciplineEnabled}
                    onChange={(e) => setWorkingDisciplineEnabled(e.target.checked)}
                    className="accent-sky-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('identity.discipline.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  {t('identity.discipline.help')}
                </p>
                {workingDisciplineEnabled && (
                  <div className="mt-3 ml-6">
                    <label className="text-xs font-semibold text-foreground mb-1 block">{t('identity.discipline.textLabel')}</label>
                    <textarea
                      value={instructionOverrides['workingDiscipline'] || ''}
                      placeholder={langDefaults.workingDiscipline}
                      onChange={(e) => setInstructionOverrides((prev) => ({ ...prev, workingDiscipline: e.target.value }))}
                      className="w-full min-h-[100px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-sky-500/50 outline-none"
                    />
                  </div>
                )}
              </div>

              {/* ── Show context-elapsed to the entity (hidden system-prompt note) ── */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showFatigueToEntity}
                    onChange={(e) => setShowFatigueToEntity(e.target.checked)}
                    className="accent-sky-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('id.ctx.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="id.ctx.help" />
                </p>
                <p className="text-xs text-muted-foreground mt-2 ml-6 leading-relaxed">
                  <Tx k="id.ctx.why" />
                </p>
                {showFatigueToEntity && (
                  <div className="mt-3 ml-6">
                    <label className="text-xs font-semibold text-foreground mb-1 block">{t('id.ctx.noteLabel')}</label>
                    <textarea
                      value={fatigueInstruction}
                      onChange={(e) => setFatigueInstruction(e.target.value)}
                      placeholder={t('id.ctx.notePh')}
                      className="w-full min-h-[80px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-sky-500/50 outline-none"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      <Tx k="id.ctx.noteFoot" />
                    </p>
                  </div>
                )}
              </div>

              {/* Date & Time Context lives here, not under Model: it decides
                  what the identity PERCEIVES (whether they can tell how long ago
                  something was said), which is the same kind of setting as the
                  context-elapsed note above it. Nothing about it varies with the
                  model — swapping vessels doesn't change whether timestamps
                  should be visible. */}
              <div>
                <label className="text-sm font-semibold text-foreground block mb-1">{t('model.datetime.label')}</label>
                <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
                  <Tx k="id.datetime.help" />
                </p>
                <select
                  value={dateTimeVisibility}
                  onChange={(e) => setDateTimeVisibility(e.target.value)}
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                >
                  <option value="none">{t('model.datetime.none')}</option>
                  <option value="current">{t('model.datetime.current')}</option>
                  <option value="all">{t('model.datetime.all')}</option>
                </select>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={toolUseEnabled}
                    onChange={(e) => setToolUseEnabled(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('sysmodal.tools.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  {renderRich(t('sysmodal.tools.help1').replace('{folder}', folderName))}
                  <span className="ml-1 inline-block px-1.5 py-0.5 text-[10px] uppercase font-semibold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 rounded">{t('sysmodal.tools.tagRead')}</span>
                  <span className="ml-1 inline-block px-1.5 py-0.5 text-[10px] uppercase font-semibold bg-amber-500/20 text-amber-700 dark:text-amber-300 rounded">{t('sysmodal.tools.tagModified')}</span>
                  <span className="ml-1 inline-block px-1.5 py-0.5 text-[10px] uppercase font-semibold bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 rounded">{t('sysmodal.tools.tagCreated')}</span>
                  {t('sysmodal.tools.help2')}
                </p>
                {toolUseEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('sysmodal.tools.instructionLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t('sysmodal.tools.instructionHelp')}
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
                        <span className="text-sm font-semibold text-foreground">{t('sysmodal.fullpc.label')}</span>
                      </label>
                      <p className="text-xs text-muted-foreground ml-6 leading-relaxed">
                        {renderRich(t('sysmodal.fullpc.help').replace('{folder}', folderName))}
                      </p>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={agentDangerousTools}
                          onChange={(e) => setAgentDangerousTools(e.target.checked)}
                          className="accent-red-500"
                        />
                        <span className="text-sm font-semibold text-foreground">{t('sysmodal.dangerous.label')}</span>
                      </label>
                      <p className="text-xs text-muted-foreground ml-6 leading-relaxed">
                        <Tx k="sysmodal.dangerous.help" />
                      </p>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={hiddenAttachmentsAccessible}
                          onChange={(e) => setHiddenAttachmentsAccessible(e.target.checked)}
                          className="accent-amber-500"
                        />
                        <span className="text-sm font-semibold text-foreground">{t('sysmodal.hiddenAttach.label')}</span>
                      </label>
                      <p className="text-xs text-muted-foreground ml-6 leading-relaxed">
                        <Tx k="sysmodal.hiddenAttach.help" />
                      </p>
                    </div>

                    {/* ── Hidden instruction overrides (per-Entity) ─────── */}
                    <details className="mt-4 ml-6 group">
                      <summary className="text-sm font-semibold text-foreground cursor-pointer select-none">
                        {t('sysmodal.overrides.summary').replace('{n}', String(Object.values(instructionOverrides).filter((v) => typeof v === 'string' && v.trim()).length))}
                      </summary>
                      <p className="text-xs text-muted-foreground mt-1 mb-3 leading-relaxed">
                        {t('sysmodal.overrides.help')}
                      </p>
                      <div className="space-y-3">
                        {AGENT_INSTRUCTION_LABELS.filter(({ key }) => key !== 'webSearchDesc' && key !== 'webFetchDesc').map(({ key, label }) => (
                          <div key={key}>
                            <label className="text-xs font-semibold text-foreground mb-1 block">{instructionLabel(key, label)}</label>
                            <textarea
                              value={instructionOverrides[key] || ''}
                              placeholder={langDefaults[key]}
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

              {/* ── Web Search & Access (universal DuckDuckGo tools) ──────────
                  Moved here from the Model tab so every tool toggle lives in
                  one place. Shown for the OpenAI-compatible families that have
                  no first-party search; Gemini (Google grounding) and Claude
                  (native web_search) keep their own toggles on the Model tab
                  because they use different engines and fields. The web_search /
                  web_fetch description editors live inside this check for
                  consistency with the other per-tool description editors. */}
              {(localAiName === 'Qwen' || localAiName === 'DeepSeek' || localAiName === 'GLM' || localAiName === 'Grok' || localAiName === 'Kimi' || localAiName === 'Minimax' || localAiName === 'Cohere' || localAiName === 'ChatGPT' || localAiName === 'MiMo' || localAiName === 'ByteDance' || localAiName === 'Local') && (
                <div>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={modelParams.enableWebSearch || false}
                      onChange={(e) => setModelParams({ ...modelParams, enableWebSearch: e.target.checked })}
                      className="mt-0.5 accent-sky-500"
                    />
                    <span className="text-sm font-semibold text-foreground leading-tight">
                      {t('id.websearch.label')}
                      <span className="block text-xs text-muted-foreground mt-0.5 font-normal leading-relaxed">
                        <Tx k="id.websearch.help" />
                      </span>
                    </span>
                  </label>
                  {modelParams.enableWebSearch && (
                    <div className="mt-3 ml-6 space-y-3">
                      {['webSearchDesc', 'webFetchDesc'].map((key) => {
                        const label = AGENT_INSTRUCTION_LABELS.find((l) => l.key === key)?.label || key;
                        return (
                          <div key={key}>
                            <label className="text-xs font-semibold text-foreground mb-1 block">{instructionLabel(key, label)}</label>
                            <textarea
                              value={instructionOverrides[key] || ''}
                              placeholder={langDefaults[key]}
                              onChange={(e) => setInstructionOverrides((prev) => ({ ...prev, [key]: e.target.value }))}
                              className="w-full min-h-[60px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-indigo-500/50 outline-none"
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── Interactive "ask the user" tool (optional, top-level) ──────
                  Same hierarchy level as the summaries and file-workspace
                  toggles — independent of file tools. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={askUserEnabled}
                    onChange={(e) => setAskUserEnabled(e.target.checked)}
                    className="accent-sky-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('id.ask.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="id.ask.help" />
                </p>
                {askUserEnabled && (
                  <div className="mt-3 ml-6 space-y-4">
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('id.ask.timeoutLabel')}</label>
                      <input
                        type="number"
                        min={0}
                        value={Math.round((Number(askUserTimeoutMs) || 0) / 1000)}
                        onChange={(e) => setAskUserTimeoutMs(Math.max(0, Number(e.target.value) || 0) * 1000)}
                        className="w-40 px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-sky-500/50 outline-none"
                      />
                      <p className="text-xs text-muted-foreground mt-1">
                        <Tx k="id.ask.timeoutHelp" />
                      </p>
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('id.ask.instrLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="id.ask.instrHelp" />
                      </p>
                      <textarea
                        value={instructionOverrides['askUserDesc'] || ''}
                        placeholder={langDefaults['askUserDesc']}
                        onChange={(e) => setInstructionOverrides((prev) => ({ ...prev, askUserDesc: e.target.value }))}
                        className="w-full min-h-[80px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-sky-500/50 outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* ── Letters (mail between Digital Identities) ─────────────────
                  Storage lives entirely server-side under local_data/letters/
                  and is reachable ONLY through these four tools — an entity with
                  Full PC access gains nothing over one without it. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={lettersEnabled}
                    onChange={(e) => setLettersEnabled(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('id.letters.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="id.letters.help" />
                </p>
                {lettersEnabled && (
                  <p className="text-xs text-muted-foreground mt-2 ml-6 leading-relaxed">
                    <Tx k="id.letters.manual" />
                  </p>
                )}
              </div>

              {/* ── Browser control ───────────────────────────────────────────
                  OFF by default, like everything else on this tab. Two separate
                  boundaries: this flag decides whether the tools exist, the host
                  allowlist below decides where they may go. Switching the flag on
                  still reaches nothing but localhost until a host is added. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={browserEnabled}
                    onChange={(e) => setBrowserEnabled(e.target.checked)}
                    className="accent-amber-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('id.browser.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="id.browser.help" />
                </p>
                {browserEnabled && (
                  <div className="mt-2 ml-6 space-y-2">
                    <label className="block text-xs font-semibold text-foreground">{t('id.browser.hostsLabel')}</label>
                    <textarea
                      value={browserAllowedHosts}
                      onChange={(e) => setBrowserAllowedHosts(e.target.value)}
                      disabled={browserAllowAnyHost}
                      rows={3}
                      spellCheck={false}
                      placeholder={'example.com\ndocs.python.org'}
                      className="w-full text-xs font-mono p-2 rounded border border-border bg-input text-foreground disabled:opacity-40"
                    />
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      <Tx k="id.browser.hostsHelp" />
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={browserAllowAnyHost}
                        onChange={(e) => setBrowserAllowAnyHost(e.target.checked)}
                        className="accent-red-500"
                      />
                      <span className="text-xs font-semibold text-red-400">{t('id.browser.anyHost')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={browserCompact}
                        onChange={(e) => setBrowserCompact(e.target.checked)}
                        className="accent-amber-500"
                      />
                      <span className="text-xs text-foreground">{t('id.browser.compact')}</span>
                    </label>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {renderRich(t('id.browser.profileHelp').replace('{folder}', folderName))}
                    </p>

                    {/* Manual sign-in. The allowlist is a route filter on the automation
                        context, so it blocks the keyboard as well as the tools — you
                        cannot just type a login page into the window Nexus is driving.
                        This opens the same profile in a plain window instead. */}
                    <div className="pt-2 border-t border-border/50 space-y-2">
                      <label className="block text-xs font-semibold text-foreground">{t('id.browser.signinLabel')}</label>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {renderRich(t('id.browser.signinHelp').replace('{folder}', folderName))}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={browserProfileBusy}
                          onClick={() => openBrowserProfile(false)}
                          className="px-3 py-1.5 text-xs rounded border border-border bg-input hover:bg-muted text-foreground disabled:opacity-40"
                        >
                          {browserProfileBusy ? t('id.browser.opening') : t('id.browser.open').replace('{folder}', folderName)}
                        </button>
                        <button
                          type="button"
                          disabled={browserProfileBusy}
                          onClick={() => openBrowserProfile(true)}
                          className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-40"
                        >
                          {t('id.browser.withChrome')}
                        </button>
                      </div>
                      {browserProfileMsg && (
                        <p className={`text-xs leading-relaxed ${browserProfileMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                          {browserProfileMsg.text}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <Tx k="id.browser.buttonsHelp" />
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Computer control (OS-level mouse/keyboard/screen, Windows only)
                  OFF by default. Separate boundary from browser control — this
                  reaches the whole physical desktop, not a sandboxed window.
                  Every capture and click is flashed visibly on the real screen
                  and logged; nothing here happens invisibly. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={computerControlEnabled}
                    onChange={(e) => setComputerControlEnabled(e.target.checked)}
                    className="accent-red-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('id.computer.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="id.computer.help" />
                </p>
              </div>

              {/* ── Subagent (context-firewall helper) — OAuth Claude only ───── */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={subagentEnabled}
                    onChange={(e) => setSubagentEnabled(e.target.checked)}
                    className="accent-violet-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('id.subagent.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="id.subagent.help" />
                </p>
                {subagentEnabled && (
                  <div className="mt-3 ml-6 space-y-4">
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('id.subagent.modelLabel')}</label>
                      <select
                        value={`${subagentFamily}|${subagentModel}`}
                        onChange={(e) => {
                          const v = e.target.value;
                          const i = v.indexOf('|');
                          setSubagentFamily(i >= 0 ? v.slice(0, i) : '');
                          setSubagentModel(i >= 0 ? v.slice(i + 1) : '');
                        }}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:ring-2 focus:ring-violet-500/50 outline-none cursor-pointer"
                      >
                        <option value="|" style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>{t('id.subagent.modelDefault')}</option>
                        {SUBAGENT_MODEL_GROUPS.map(g => (
                          <optgroup key={g.family} label={g.family} style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>
                            {g.items.map(it => (
                              <option key={`${g.family}|${it.model}`} value={`${g.family}|${it.model}`} style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>
                                {it.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground mt-1">
                        <Tx k="id.subagent.modelHelp" />
                      </p>
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('id.subagent.instrLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="id.subagent.instrHelp" />
                      </p>
                      <textarea
                        value={instructionOverrides['subagentDesc'] || ''}
                        placeholder={langDefaults['subagentDesc']}
                        onChange={(e) => setInstructionOverrides((prev) => ({ ...prev, subagentDesc: e.target.value }))}
                        className="w-full min-h-[80px] p-2 bg-background border border-border rounded-lg text-xs font-mono resize-y focus:ring-2 focus:ring-violet-500/50 outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>
              </>)}

              {activeSettingsTab === 'senses' && (<>
              {/* ── "Eyes" — vision bridge for text-only models (+ OAuth-Claude past-image recall) ── */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={eyesEnabled}
                    onChange={(e) => setEyesEnabled(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('senses.eyes.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="senses.eyes.help" />
                  <span className="block mt-1"><Tx k="senses.eyes.help2" /></span>
                  <span className="block"><Tx k="senses.eyes.help3" /></span>
                  <span className="block mt-1"><Tx k="senses.eyes.help4" /></span>
                </p>
                {eyesEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('senses.eyes.promptLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="senses.eyes.promptHelp" />
                      </p>
                      <textarea
                        value={eyesPrompt}
                        onChange={(e) => setEyesPrompt(e.target.value)}
                        className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('senses.eyes.modelLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="senses.eyes.modelHelp" />
                        <span className="block mt-1"><Tx k="senses.eyes.modelHelp2" /></span>
                        <span className="block"><Tx k="senses.eyes.modelHelp3" /></span>
                        <span className="block mt-1"><Tx k="senses.eyes.modelHelp4" /></span>
                      </p>
                      <EditableCombo
                        value={eyesModel}
                        onChange={setEyesModel}
                        placeholder={t('senses.eyes.modelPh')}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                        options={[
                          // No-key options first — what you want when only OAuth
                          // Claude and/or local models are available.
                          { value: 'claude-haiku-4-5', label: t('senses.eyes.optHaiku') },
                          { value: 'claude-opus-5', label: t('senses.eyes.optOpus5') },
                          { value: 'claude-opus-4-8', label: t('senses.eyes.optOpus48') },
                          { value: 'local:qwen2-vl-7b-instruct', label: t('senses.eyes.optLocal') },
                          { value: 'glm-5.3-flash', label: 'glm-5.3-flash (Z.AI key)' },
                          { value: 'glm-5v-turbo', label: 'glm-5v-turbo (Z.AI key)' },
                          { value: 'glm-4.6v-flash', label: 'glm-4.6v-flash (Z.AI key)' },
                          { value: 'glm-4.6v', label: 'glm-4.6v (Z.AI key)' },
                          { value: 'gemini-3.8-flash', label: 'gemini-3.8-flash (Google key)' },
                          { value: 'gemini-3.7-flash', label: 'gemini-3.7-flash (Google key)' },
                          { value: 'gemini-3.6-flash', label: 'gemini-3.6-flash (Google key)' },
                          { value: 'gemini-3.5-flash', label: 'gemini-3.5-flash (Google key)' },
                          { value: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (Google key)' },
                          { value: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite (Google key)' },
                          { value: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview (Google key)' },
                          { value: 'mimo-v2.5', label: 'mimo-v2.5 (MiMo key)' },
                        ]}
                      />
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
                  <span className="text-sm font-semibold text-foreground">{t('senses.ears.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="senses.ears.help" />
                </p>
                {earsEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('senses.ears.promptLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="senses.ears.promptHelp" />
                      </p>
                      <textarea
                        value={earsPrompt}
                        onChange={(e) => setEarsPrompt(e.target.value)}
                        className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('senses.ears.modelLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="senses.ears.modelHelp" />
                      </p>
                      <select
                        value={earsModel}
                        onChange={(e) => setEarsModel(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      >
                        <option value="qwen3.5-omni-flash">qwen3.5-omni-flash</option>
                        <option value="qwen3.5-omni-plus">qwen3.5-omni-plus</option>
                        <option value="gemini-3.8-flash">gemini-3.8-flash</option>
                        <option value="gemini-3.7-flash">gemini-3.7-flash</option>
                        <option value="gemini-3.6-flash">gemini-3.6-flash</option>
                        <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                        <option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite</option>
                        <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                        <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                        <option value="mimo-v2.5">mimo-v2.5 (Xiaomi)</option>
                        <option value="seed-2-0-lite-260428">seed-2-0-lite (ByteDance — omnimodal)</option>
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
                  <span className="text-sm font-semibold text-foreground">{t('senses.watcher.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="senses.watcher.help" />
                </p>
                {watcherEnabled && (
                  <>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('senses.watcher.promptLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="senses.watcher.promptHelp" />
                      </p>
                      <textarea
                        value={watcherPrompt}
                        onChange={(e) => setWatcherPrompt(e.target.value)}
                        className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div className="mt-3 ml-6">
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('senses.watcher.modelLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        <Tx k="senses.watcher.modelHelp" />
                      </p>
                      <select
                        value={watcherModel}
                        onChange={(e) => setWatcherModel(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      >
                        <option value="gemini-3.8-flash">gemini-3.8-flash</option>
                        <option value="gemini-3.7-flash">gemini-3.7-flash</option>
                        <option value="gemini-3.6-flash">gemini-3.6-flash</option>
                        <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                        <option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite</option>
                        <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                        <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
                        <option value="qwen3.5-omni-flash">qwen3.5-omni-flash</option>
                        <option value="qwen3.5-omni-plus">qwen3.5-omni-plus (higher quality)</option>
                        <option value="mimo-v2.5">mimo-v2.5 (Xiaomi)</option>
                        <option value="seed-2-0-lite-260428">seed-2-0-lite (ByteDance — omnimodal)</option>
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
                    {t('behavior.audio.enable')}
                  </label>
                </div>

                {vrchatMode && (
                  <div className="mb-6">
                    <label className="text-sm font-semibold text-foreground mb-1 block">{t('behavior.audio.ruleLabel')}</label>
                    <p className="text-xs text-muted-foreground mb-2">
                      {t('behavior.audio.ruleHelp')}
                    </p>
                    <textarea
                      value={vrchatRule}
                      onChange={(e) => setVrchatRule(e.target.value)}
                      className="w-full min-h-[100px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                    />
                  </div>
                )}

                {/* ── Camera (OBS Studio media-source push + in-app avatar panel)
                    OFF by default. One toggle gates both: the right-side GUI
                    panel and, if OBS WebSocket details are configured in
                    Preferences, pushing the resolved file into an OBS Media
                    Source. Works with the panel alone if OBS isn't running —
                    the push is always best-effort. */}
                <div className="mt-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cameraEnabled}
                      onChange={(e) => setCameraEnabled(e.target.checked)}
                      className="accent-red-500"
                    />
                    <span className="text-sm font-semibold text-foreground">{t('id.camera.label')}</span>
                  </label>
                  <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                    <Tx k="id.camera.help" />
                  </p>
                </div>
              </div>
              </>)}

              {activeSettingsTab === 'model' && (<>
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-4 block">{t('model.genParams')}</h4>

                <div className="mb-4">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.family.label')}</label>
                  <select
                    value={localAiName}
                    onChange={(e) => {
                      const newAiName = e.target.value;
                      setLocalAiName(newAiName);
                      // Keep the current model if it already belongs to the new
                      // family; otherwise take that family's default. For Local
                      // the list comes from LM Studio, so refresh it and pick a
                      // valid installed model — never leave a stale cloud id.
                      if (!modelBelongsToFamily(specificModel, newAiName)) {
                        if (newAiName === 'Local') {
                          setSpecificModel('');
                          fetch('/api/local/models').then(r => r.json()).then(d => {
                            if (Array.isArray(d.models) && d.models.length > 0) {
                              setLocalModels(d.models);
                              const loaded = (d.meta || []).find((m: any) => m.loaded);
                              setSpecificModel((loaded && loaded.id) || d.models[0]);
                            }
                          }).catch(() => {});
                        } else {
                          setSpecificModel(defaultModelForFamily(newAiName));
                        }
                      }
                    }}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  >
                    {['Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Kimi', 'Grok', 'Cohere', 'Minimax', 'ChatGPT', 'MiMo', 'ByteDance', 'Local'].map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                {localAiName === 'Claude' && (
                  <>
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.claude.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="claude-fable-5-1">Claude Fable 5.1 (adaptive thinking, flagship)</option>
                      <option value="claude-fable-5">Claude Fable 5 (adaptive thinking, legacy)</option>
                      <option value="claude-opus-5">Claude Opus 5 (adaptive thinking)</option>
                      <option value="claude-opus-4-8">Claude Opus 4.8 (thinking)</option>
                      <option value="claude-opus-4-7">Claude Opus 4.7 (thinking)</option>
                      <option value="claude-sonnet-5">Claude Sonnet 5 (adaptive thinking, 1M ctx)</option>
                      <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (thinking)</option>
                      <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                    </select>
                  </div>
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.claude.billing')}</label>
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
                          {mode === 'api-key' ? t('model.claude.tokenPaid') : t('model.claude.monthlyPaid')}
                        </button>
                      ))}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.claude.billingHelp'))}
                      <span className="block mt-0.5">{renderRich(t('model.claude.billingHelp2'))}</span>
                    </div>
                  </div>
                  </>
                )}

                {localAiName === 'Gemini' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.gemini.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                      <option value="gemini-3.7-flash">Gemini 3.7 Flash</option>
                      <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                      <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                      <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
                      <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
                      <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview</option>
                    </select>
                  </div>
                )}

                {localAiName === 'Qwen' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.qwen.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="qwen3.8-max">Qwen 3.8 Max (reasoning, text + vision)</option>
                      <option value="qwen3.7-max">Qwen 3.7 Max (reasoning, text)</option>
                      <option value="qwen3.6-max-preview">Qwen 3.6 Max (text + vision)</option>
                      <option value="qwen3.6-plus">Qwen 3.6 Plus (text + vision)</option>
                      <option value="qwen3.5-omni-flash">Qwen 3.5 Omni Flash (text + vision + audio + video)</option>
                      <option value="qwen3.5-omni-plus">Qwen 3.5 Omni Plus (text + vision + audio + video — higher quality)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.qwen.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'DeepSeek' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.deepseek.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <optgroup label="DeepSeek first-party API (api.deepseek.com)">
                        <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
                        <option value="deepseek-v4-flash-0731">DeepSeek V4 Flash 0731 (official release, 1M context)</option>
                        <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                        <option value="deepseek-v4-flash-vision-exp">DeepSeek V4 Flash Vision (experimental)</option>
                        <option value="deepseek-reasoner">DeepSeek Reasoner (legacy alias)</option>
                        <option value="deepseek-chat">DeepSeek Chat (legacy alias)</option>
                      </optgroup>
                      <optgroup label="Alibaba DashScope (Qwen billing)">
                        <option value="deepseek-v3.2">DeepSeek V3.2 (hybrid reasoning)</option>
                      </optgroup>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.deepseek.help1'))}
                      <br />
                      {renderRich(t('model.deepseek.help2'))}
                      <br />
                      {renderRich(t('model.deepseek.help3'))}
                      <br />
                      {renderRich(t('model.deepseek.help4'))}
                    </div>
                  </div>
                )}

                {localAiName === 'Minimax' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.minimax.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="MiniMax-M3">MiniMax M3 (flagship — multimodal, 1M context, agentic coding)</option>
                      <option value="MiniMax-M2.7">MiniMax M2.7 (coding + reasoning, 200K context)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.minimax.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'Cohere' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.cohere.label')}</label>
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
                      {renderRich(t('model.cohere.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'Kimi' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.kimi.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="moonshotai/Kimi-K3">Kimi K3 (flagship — always-on reasoning, native vision)</option>
                      <option value="moonshotai/Kimi-K2.6">Kimi K2.6 (256K context, multimodal)</option>
                      <option value="moonshotai/Kimi-K2.5">Kimi K2.5 (agentic, multimodal)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.kimi.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'Grok' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.grok.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="grok-4.6">Grok 4.6 (flagship)</option>
                      <option value="grok-4.5">Grok 4.5</option>
                      <option value="grok-4.3">Grok 4.3</option>
                      <option value="grok-4.20-0309-reasoning">Grok 4.20 — Reasoning</option>
                      <option value="grok-4.20-0309-non-reasoning">Grok 4.20 — Non-reasoning (fast)</option>
                      <option value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast (legacy)</option>
                      <option value="grok-code-fast-1">Grok Code Fast 1 (coding)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.grok.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'ChatGPT' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.chatgpt.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="gpt-5.6-sol">GPT-5.6 Sol (flagship, deepest reasoning)</option>
                      <option value="gpt-5.6-terra">GPT-5.6 Terra (balanced, ~2× cheaper)</option>
                      <option value="gpt-5.6-luna">GPT-5.6 Luna (fast, budget)</option>
                      <option value="gpt-5.5">GPT-5.5</option>
                      <option value="gpt-5.4">GPT-5.4</option>
                      <option value="gpt-5.4-mini">GPT-5.4 Mini (fast, cheaper)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.chatgpt.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'MiMo' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.mimo.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="mimo-v2.5-pro">MiMo V2.5 Pro (flagship reasoning — text only)</option>
                      <option value="mimo-v2.5">MiMo V2.5 (text + image input)</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.mimo.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'ByteDance' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.bytedance.label')}</label>
                    <EditableCombo
                      value={specificModel}
                      onChange={setSpecificModel}
                      mono
                      placeholder={t('model.bytedance.ph')}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      options={[
                        { value: 'dola-seed-2-1-turbo-260628', label: 'Seed 2.1 Turbo (image + video, ½-price of Pro)' },
                        { value: 'seed-2-0-pro-260328', label: 'Seed 2.0 Pro (text + image)' },
                        { value: 'seed-2-0-lite-260428', label: 'Seed 2.0 Lite (omnimodal — image, audio, video)' },
                        { value: 'seed-2-0-mini-260428', label: 'Seed 2.0 Mini' },
                        { value: 'seed-2-0-code-preview-260328', label: 'Seed 2.0 Code (preview)' },
                      ]}
                    />
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.bytedance.help'))}
                    </div>
                  </div>
                )}

                {localAiName === 'GLM' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.glm.providerLabel')}</label>
                    <select
                      value={(specificModel || '').startsWith('digitalocean/') ? 'digitalocean' : 'zai'}
                      onChange={(e) => {
                        // Provider is derived from the model id prefix — one
                        // field, no second state to drift out of sync.
                        setSpecificModel(e.target.value === 'digitalocean' ? 'digitalocean/glm-5.2' : 'glm-5.2');
                      }}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      <option value="zai">Z.AI (Zhipu) — api.z.ai</option>
                      <option value="digitalocean">DigitalOcean Inference — inference.do-ai.run (US-hosted, ~half Z.ai price)</option>
                    </select>
                    <label className="text-xs font-medium text-muted-foreground block mb-1 mt-3">{t('model.glm.label')}</label>
                    <select
                      value={(() => {
                        // Guard: a saved model that doesn't exist on the current
                        // provider (e.g. glm-4.7 after switching to DigitalOcean)
                        // renders as a disabled placeholder instead of a blank box.
                        const isDO = (specificModel || '').startsWith('digitalocean/');
                        const valid = isDO
                          ? ['digitalocean/glm-5.2', 'digitalocean/glm-5.1', 'digitalocean/glm-5']
                          : ['glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5','glm-5-turbo','glm-5v-turbo','glm-4.7','glm-4.6','glm-4.6v','glm-4.6v-flash','glm-4.5-air'];
                        return valid.includes(specificModel || '') ? specificModel : '';
                      })()}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      {(specificModel || '').startsWith('digitalocean/') ? (
                        <>
                          {(!['digitalocean/glm-5.2','digitalocean/glm-5.1','digitalocean/glm-5'].includes(specificModel || '')) && (
                            <option value="" disabled>{t('model.glm.notOnDO').replace('{model}', specificModel || '')}</option>
                          )}
                          <option value="digitalocean/glm-5.2">GLM-5.2 (262K context, $0.70/$2.20 per M)</option>
                          <option value="digitalocean/glm-5.1">GLM-5.1 ($0.975/$4.30 per M)</option>
                          <option value="digitalocean/glm-5">GLM-5 ($0.75/$2.40 per M)</option>
                        </>
                      ) : (
                        <>
                          {(specificModel && !['glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5','glm-5-turbo','glm-5v-turbo','glm-4.7','glm-4.6','glm-4.6v','glm-4.6v-flash','glm-4.5-air'].includes(specificModel)) && (
                            <option value="" disabled>{t('model.glm.notOnZai').replace('{model}', specificModel || '')}</option>
                          )}
                          <option value="glm-5.3">GLM-5.3 (latest, 1M context, reasoning always on)</option>
                          <option value="glm-5.3-flash">GLM-5.3 Flash (multimodal, 1M context, reasoning always on)</option>
                          <option value="glm-5.2">GLM-5.2</option>
                          <option value="glm-5.1">GLM-5.1</option>
                          <option value="glm-5">GLM-5</option>
                          <option value="glm-5-turbo">GLM-5 Turbo (fast)</option>
                          <option value="glm-5v-turbo">GLM-5V Turbo (fast multimodal)</option>
                          <option value="glm-4.7">GLM-4.7</option>
                          <option value="glm-4.6">GLM-4.6 (200K context)</option>
                          <option value="glm-4.6v">GLM-4.6V (multimodal)</option>
                          <option value="glm-4.6v-flash">GLM-4.6V Flash (fast multimodal)</option>
                          <option value="glm-4.5-air">GLM-4.5 Air (cheap)</option>
                        </>
                      )}
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {(specificModel || '').startsWith('digitalocean/')
                        ? renderRich(t('model.glm.helpDO'))
                        : renderRich(t('model.glm.helpZai'))}
                    </div>
                  </div>
                )}

                {localAiName === 'Local' && (
                  <>
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('model.local.label')}</label>
                        <button onClick={refreshLocalModels} className="text-[10px] text-indigo-500 hover:underline" type="button">{t('model.local.refresh')}</button>
                      </div>
                      <select
                        value={specificModel}
                        onChange={(e) => setSpecificModel(e.target.value)}
                        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                      >
                        {localModels.length === 0 && <option value="">{t('model.local.none')}</option>}
                        {/* Keep current value selectable even if not in list */}
                        {specificModel && !localModels.includes(specificModel) && (
                          <option value={specificModel}>{t('model.local.notLoaded').replace('{model}', specificModel)}</option>
                        )}
                        {localModels.map(m => {
                          const meta = localModelsMeta[m];
                          const flags = meta
                            ? [meta.vision ? '👁' : '', meta.tools ? '🔨' : ''].filter(Boolean).join('')
                            : '';
                          const detail = meta
                            ? [meta.params, meta.quant, meta.arch, meta.sizeGB].filter(Boolean).join(' · ')
                            : '';
                          return (
                            <option key={m} value={m}>
                              {meta && meta.displayName ? meta.displayName : m}
                              {detail ? ` — ${detail}` : ''}
                              {flags ? ` ${flags}` : ''}
                              {meta && meta.loaded ? ' ⚡' : ''}
                            </option>
                          );
                        })}
                      </select>
                      {localModelsError && (
                        <div className="text-[10px] text-red-500 mt-1">{localModelsError}</div>
                      )}
                    </div>
                    <div className="mb-4">
                      <label className="text-xs font-medium text-muted-foreground block mb-1">
                        {t('model.local.ctxLabel')}
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
                        {t('model.local.ctxHelp')}
                      </div>
                    </div>
                  </>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.temp').replace('{v}', String(modelParams.temperature))}</label>
                    <input type="range" min="0" max="2" step="0.1" value={modelParams.temperature} onChange={(e) => setModelParams({ ...modelParams, temperature: parseFloat(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.topP').replace('{v}', String(modelParams.topP))}</label>
                    <input type="range" min="0" max="1" step="0.05" value={modelParams.topP} onChange={(e) => setModelParams({ ...modelParams, topP: parseFloat(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.topK')}</label>
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
                      <span className="text-xs font-medium text-muted-foreground">{t('model.seed')}</span>
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
                      <span className="text-[10px] text-muted-foreground">{t('model.seedHelp')}</span>
                    )}
                  </div>
                  {specificModel?.includes('gemini') && (
                    <>
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.gemini.thinkLabel')}</label>
                        <select
                          value={modelParams.thinkingLevel === 'none' ? 'minimal' : (modelParams.thinkingLevel || 'medium')}
                          onChange={(e) => setModelParams({ ...modelParams, thinkingLevel: e.target.value })}
                          className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm appearance-none cursor-pointer outline-none focus:ring-1 focus:ring-indigo-500"
                        >
                          <option value="minimal">{t('model.gemini.thinkMinimal')}</option>
                          <option value="low">{t('model.gemini.thinkLow')}</option>
                          <option value="medium">{t('model.gemini.thinkMedium')}</option>
                          <option value="high">{t('model.gemini.thinkHigh')}</option>
                        </select>
                        <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                          {t('model.gemini.thinkHelp')}
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
                          {t('model.gemini.grounding')}
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
                        {t('model.thinkingMode')}
                        <span className="text-xs text-muted-foreground ml-1">{t('model.thinkingModeHelp')}</span>
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
                          {t('model.claude.websearch')}
                          <span className="text-xs text-muted-foreground ml-1">{renderRich(t('model.claude.websearchHelp'))}</span>
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
                          {t('model.claude.thinking')}
                          <span className="text-xs text-muted-foreground ml-1">{t('model.claude.thinkingHelp')}</span>
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
                            {t('model.claude.saveThinking')}
                            <span className="text-xs text-muted-foreground ml-1">{t('model.claude.saveThinkingHelp')}</span>
                          </label>
                        </div>
                      )}
                      {/* Thinking-depth (effort) — only the adaptive models
                          (Opus 5, Opus 4.7/4.8, Sonnet 5, Fable 5) support
                          output_config.effort. Applies to BOTH billing modes
                          (API output_config and the Agent SDK effort option).
                          'high' = API default.
                          MUST stay in sync with the server's adaptive-model
                          regexes in api/chat/route.ts (`isAdaptiveThinking`
                          and `isAdaptiveOauth`) — when this gate misses a
                          model, the server still sends effort but the user has
                          no way to change it off the 'high' default. That's
                          what hid Opus 5's effort control. */}
                      {/fable-?5|mythos-?5|opus-4-?7|opus-4-?8|opus-?5|sonnet-?5/.test(specificModel || '') && (
                        <div className="mt-1">
                          <label className="text-xs font-medium text-muted-foreground block mb-1">
                            {t('model.claude.effortLabel')}
                          </label>
                          <select
                            value={modelParams.claudeEffort || 'high'}
                            onChange={(e) => setModelParams({ ...modelParams, claudeEffort: e.target.value })}
                            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                          >
                            <option value="low">{t('model.claude.effortLow')}</option>
                            <option value="medium">{t('model.claude.effortMedium')}</option>
                            <option value="high">{t('model.claude.effortHigh')}</option>
                            <option value="xhigh">{t('model.claude.effortXhigh')}</option>
                            <option value="max">{t('model.claude.effortMax')}</option>
                          </select>
                          <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                            {renderRich(t('model.claude.effortHelp'))}
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
                    {t('model.auto.label')}
                  </label>
                  <span className="text-xs text-muted-foreground">{t('model.auto.note')}</span>
                </div>
                {autoModelSelectEnabled && (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {renderRich(t('model.auto.help'))}{' '}
                      <span className="text-amber-500">{t('model.auto.helpWarn')}</span>
                    </p>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('model.auto.criteria')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t('model.auto.criteriaHelp')}
                      </p>
                      <textarea
                        value={autoModelSelectCriteria}
                        onChange={(e) => setAutoModelSelectCriteria(e.target.value)}
                        className="w-full min-h-[120px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-y focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        placeholder={t('model.auto.criteriaPh')}
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold text-foreground">{t('model.auto.allowed')}</label>
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
                              const ok = window.confirm(t('model.auto.fillConfirm'));
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
                          title={t('model.auto.fillAllTitle')}
                        >
                          {t('model.auto.fillAll')}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">
                        {renderRich(t('model.auto.allowedHelp'))}
                      </p>
                      <textarea
                        value={autoModelSelectAllowedModels}
                        onChange={(e) => setAutoModelSelectAllowedModels(e.target.value)}
                        className="w-full min-h-[160px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-y focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        placeholder={t('model.auto.allowedPh')}
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
                    {t('model.creativity.label')}
                  </label>
                </div>
                {creativityControlEnabled && (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {renderRich(t('model.creativity.help'))}
                    </p>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('model.creativity.analysisLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        {t('model.creativity.analysisHelp')}
                      </p>
                      <textarea
                        value={hiddenAnalysisInstruction}
                        onChange={(e) => setHiddenAnalysisInstruction(e.target.value)}
                        className="w-full min-h-[160px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-foreground mb-1 block">{t('model.creativity.patternLabel')}</label>
                      <p className="text-xs text-muted-foreground mb-2">
                        {renderRich(t('model.creativity.patternHelp'))}
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
                      askUserEnabled,
                      askUserTimeoutMs,
                      subagentEnabled,
                      subagentModel,
                      subagentFamily,
                      lettersEnabled,
                      browserEnabled,
                      browserAllowedHosts,
                      browserAllowAnyHost,
                      browserCompact,
                      computerControlEnabled,
                      cameraEnabled,
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
                      showFatigueToEntity,
                      fatigueInstruction,
                      workingDisciplineEnabled,
                      baseBindingMode,
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
                    alert(t('sysmodal.savedDefaults'));
                  } catch (e: any) {
                    alert(t('sysmodal.saveDefaultsError') + (e?.message || 'unknown'));
                  }
                }}
                className="px-4 py-2 text-sm font-medium bg-secondary text-secondary-foreground rounded-lg hover:opacity-90 transition-opacity"
              >
                {t('sysmodal.saveDefaults')}
              </button>
              <button
                onClick={() => setIsPromptModalOpen(false)}
                className="px-6 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
              >
                {t('sysmodal.done')}
              </button>
            </div>
          </div>
        </div>
      )}

      <LiveSession
        open={liveOpen}
        onClose={() => setLiveOpen(false)}
        systemPrompt={prependIdentityPreamble(
          vrchatMode ? `${systemPrompt}\n\n${audioSessionRuleText}`.trim() : (systemPrompt || ''),
          workingDisciplineEnabled ? (instructionOverrides['workingDiscipline'] || langDefaults.workingDiscipline || '') : '',
          resolveBindingText(
            baseBindingMode === 'on',
            systemPrompt,
            instructionOverrides['absoluteBaseBinding'] || langDefaults.absoluteBaseBinding || '',
            instructionOverrides['absoluteBaseBindingInitial'] || langDefaults.absoluteBaseBindingInitial || '',
          ),
        )}
        voiceName={defaultLiveSessionVoice || 'Aoede'}
        aiVoice={folders?.find((f: any) => f.name === folderName)?.settings?.aiVoice}
        audioOutDevice1={globalSettings?.device1Id}
        audioOutDevice2={globalSettings?.device2Id}
        audioOutLabel1={globalSettings?.device1Label}
        audioOutLabel2={globalSettings?.device2Label}
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

      <StatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} folderName={folderName} />
      <MailModal open={mailOpen} onClose={() => setMailOpen(false)} onUnreadChange={setMailUnread} />

      {/* Mounted only while open: the panel probes every service on mount
          (each process probe is a PowerShell spawn), so it must not run in the
          background of every conversation. */}
      {audioSessionOpen && <AudioSessionModal onClose={() => setAudioSessionOpen(false)} />}

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
