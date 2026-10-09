"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import MessageBubble from './MessageBubble';
import AskUserQuestionCard from './AskUserQuestionCard';
import InputArea from './InputArea';
import EditableCombo from './EditableCombo';
import { motion } from 'framer-motion';
import { Download, Settings2, Eye, EyeOff, Radio, Wrench, RefreshCw, ImageDown, FolderOpen, Layers, Bookmark, BookmarkPlus, Clock, BarChart3, Search, AudioLines, Link2, Check, Mail, Menu, MoreHorizontal } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useDevice } from './DeviceProvider';
import ClickTip from './ClickTip';
import SystemPromptUpdater from './SystemPromptUpdater';
import StatsModal from './StatsModal';
import SearchModal from './SearchModal';
import MailModal from './MailModal';
import TtsStatusBar, { createTtsStatusStore } from './TtsStatusBar';
import AudioSessionModal from './AudioSessionModal';
import { v4 as uuidv4 } from 'uuid';
import { exportToMarkdown } from '@/lib/markdownLogic';
import { stripAllTimestamps } from '@/lib/timestampStrip';
import { messageCost, resolvePrice, fmtUSD } from '@/lib/modelPricing';
import { applyOutputFilter } from '@/lib/outputFilter';
import { attachmentByteSize, uploadAttachment, dataUrlToBlob } from '@/lib/attachmentUrl';
import { appendLayer4Index, appendLayer5Footer, prependIdentityPreamble, hasLayerStructure } from '@/lib/layer4';
import { selectBaseBindingText, shouldInjectLayer4 } from '@/lib/baseBinding';
import { AGENT_INSTRUCTION_LABELS, AGENT_INSTRUCTION_LABELS_JA, DEFAULT_AGENT_INSTRUCTIONS, DEFAULT_AGENT_INSTRUCTIONS_JA } from '@/lib/agentInstructions';
import { messageAnchorId, absoluteDeepLink } from '@/lib/deepLink';
import { copyText } from '@/lib/clipboard';
import { useT, Tx, renderRich } from '@/lib/i18n';
import { isNumberedIdentityTitle } from '@/lib/convoNaming';
import { effectiveFullAccess, fullAccessForcedByShell } from '@/lib/agentCapabilities';
import {
  DEFAULT_MAX_CONVERSATION_LOG,
  logCapUsage,
  contextElapsedPercent,
  messageTextTokens,
  messageIdentityKey,
  type RestorePlanReply,
} from '@/lib/handoverRestore';
import { setUnloadGuard, useBusyLabel } from '@/lib/unloadGuard';
import { describeProviderError } from '@/lib/providerErrors';
import { applyAutoHide, attachmentTokens, attachmentKind, isUndeliverable, wireCarriesMedia, resolveBridge, resolveKeepMessages, bridgedDescriptionText } from '@/lib/attachmentVisibility';
import { ensureAudioPermission } from '@/lib/audioSink';
import { estimateTokensForModel } from '@/lib/tokenEstimate';
import { thinkingBelongsToVessel, parseHandoffModels } from '@/lib/modelHandoff';
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

// ── This tab's identity ──────────────────────────────────────────────────────
// Sent with every turn so the server-side turn registry can tell a tab whether
// a running turn is its own. Module scope, not a ref: each browser tab runs its
// own copy of this module, so the value is per-tab and survives ChatArea
// remounting (which happens on every conversation switch) — a per-component id
// would make the same tab look like a different one after switching away and
// back. Never rendered, so there is no hydration mismatch to worry about.
const TAB_CLIENT_ID = `tab_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
// How often to tell the server "still running". Mirrors HEARTBEAT_MS in
// turnRegistry.ts; the TTL there is ~3x this, so one dropped beat is harmless.
const TURN_HEARTBEAT_MS = 8_000;

// All cloud models known to NEXUS, in the line format the vessel-handoff
// allow-list reads (`family | modelId | on/off | label`). Shown read-only in
// the model-list window — never pasted automatically; see modelHandoff.ts.
// Keep in sync with the model dropdowns further down in this file (search for
// `<option value="claude-`, `glm-`, etc.). Thinking-on/off defaults follow each
// model's typical role: reasoning / flagship variants default ON; fast / lite /
// non-reasoning variants OFF. Rows are copied out of the window by hand, so
// these defaults are a starting point the reader edits, not a setting.
//
// Local models are NOT here — they're appended dynamically by
// `buildAllModelsFill(localModels)` below, since LM Studio's available
// model list changes whenever the user loads/unloads a model.
const CLOUD_MODELS_FILL =
`# Every model NEXUS knows. Copy the rows you want by hand.
# Format: family | specificModel | on|off | optional display label

# ── Claude (Anthropic) ─────────────────────────────────────────────
# fable-5 / fable-5-1 / opus-5-5 CANNOT disable thinking (Anthropic 400s on
# thinking:{type:'disabled'} — measured 2026-10-01 for opus-5-5; sonnet-5-5
# added 2026-10-02 by analogy, UNMEASURED), so the on/off column is advisory for
# those rows: off sends adaptive at effort 'low'. Plain claude-opus-5 and
# claude-sonnet-5 DO accept disabled — the ".5" ids differ from their base here.
Claude   | claude-fable-5-1             | on  | Claude Fable 5.1 Thinking
Claude   | claude-fable-5               | on  | Claude Fable 5 Thinking
Claude   | claude-opus-5-5              | on  | Claude Opus 5.5 Thinking
Claude   | claude-opus-5                | on  | Claude Opus 5 Thinking
Claude   | claude-opus-4-8              | on  | Claude Opus 4.8 Thinking
Claude   | claude-opus-4-7              | on  | Claude Opus 4.7 Thinking
Claude   | claude-sonnet-5-5           | on  | Claude Sonnet 5.5 Thinking
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
DeepSeek | deepseek-v4-pro              | on  | DeepSeek V4 Pro (text only)
DeepSeek | deepseek-flash               | on  | DeepSeek V4.1 Flash (1M context, vision)
DeepSeek | deepseek-reasoner            | on  | DeepSeek Reasoner (legacy alias)
DeepSeek | deepseek-chat                | off | DeepSeek Chat (legacy alias)
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

# ── Grok (xAI) ─────────────────────────────────────────────────────
# The 4.20 pair picks reasoning by model-name suffix. 4.3/4.5/4.6/4.7 are
# always-reasoning models that take a reasoning_effort parameter instead:
# 4.3 accepts none|low|medium|high|xhigh (default low); 4.5/4.6/4.7 accept
# low|medium|high|xhigh (default high) and REJECT none with a 400.
Grok     | grok-4.7                     | on  | Grok 4.7
Grok     | grok-4.6                     | on  | Grok 4.6
Grok     | grok-4.5                     | on  | Grok 4.5
Grok     | grok-4.3                     | on  | Grok 4.3
Grok     | grok-4.20-0309-reasoning     | on  | Grok 4.20 Reasoning
Grok     | grok-4.20-0309-non-reasoning | off | Grok 4.20 Non-reasoning (fast)
Grok     | grok-4-1-fast-non-reasoning  | off | Grok 4.1 Fast
Grok     | grok-code-fast-1             | off | Grok Code Fast 1

# ── Kimi (Moonshot) ────────────────────────────────────────────────
# kimi-k2.7-code / -highspeed reject thinking:{type:'disabled'} (400, measured
# 2026-09-19), so their on/off column is advisory the same way GLM-5.3's is.
# kimi-k2.5 was RETIRED by Moonshot (404) and is no longer offered.
Kimi     | moonshotai/Kimi-K3           | on  | Kimi K3
Kimi     | moonshotai/Kimi-K2.7-Code    | on  | Kimi K2.7 Code
Kimi     | moonshotai/Kimi-K2.7-Code-Highspeed | on | Kimi K2.7 Code Highspeed
Kimi     | moonshotai/Kimi-K2.6         | on  | Kimi K2.6 Thinking

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
MiMo     | mimo-v2.6-pro                | on  | MiMo V2.6 Pro
MiMo     | mimo-v2.6-flash              | on  | MiMo V2.6 Flash
MiMo     | mimo-v2.6-pro-ultraspeed     | on  | MiMo V2.6 Pro UltraSpeed
MiMo     | mimo-v2.5-pro                | on  | MiMo V2.5 Pro (deprecated 2026-10-21)
MiMo     | mimo-v2.5                    | on  | MiMo V2.5 (deprecated 2026-10-21)

# ── ByteDance Seed (BytePlus ModelArk) — reasoning-first, no toggle ─
ByteDance | seed-2-0-pro-260328          | on  | Seed 2.0 Pro
ByteDance | seed-2-0-lite-260428         | on  | Seed 2.0 Lite
ByteDance | seed-2-0-mini-260428         | on  | Seed 2.0 Mini
ByteDance | seed-2-0-code-preview-260328 | on  | Seed 2.0 Code

# ── Meta (Muse Spark, api.meta.ai) — always reasons; the on/off column is ──
# advisory: OFF sends reasoning_effort 'minimal', which still thinks. The
# -contributor rows are 12.5x cheaper on input AND opt Meta into training on
# those turns, so they are deliberately left OFF in this table — a row copied
# in a hurry must not silently enrol anyone. (No backticks anywhere in this table: it is
# a template literal, and a stray backtick closes the string.)
Meta     | muse-spark-1.3               | on  | Muse Spark 1.3
Meta     | muse-spark-1.2               | on  | Muse Spark 1.2
Meta     | muse-spark-1.1               | on  | Muse Spark 1.1
Meta     | muse-spark-1.3-contributor   | off | Muse Spark 1.3 (Contributor — Meta trains on it)
`;

// Parsed { family, model, label } rows for the Subagent model dropdown, derived
// from the same CLOUD_MODELS_FILL table the model-list window shows. The family
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
  Claude: 'claude-opus-5',
  Gemini: 'gemini-3.8-flash',
  Qwen: 'qwen3.8-max',
  DeepSeek: 'deepseek-v4-pro',
  GLM: 'glm-5.3',
  Grok: 'grok-4.7',
  Kimi: 'moonshotai/Kimi-K3',
  Cohere: 'command-a-reasoning-08-2025',
  Minimax: 'MiniMax-M3',
  ChatGPT: 'gpt-5.6-terra',
  MiMo: 'mimo-v2.6-pro',
  ByteDance: 'seed-2-0-pro-260328',
  // Standard tier on purpose. The `-contributor` id is 12.5x cheaper on input
  // but lets Meta train on the prompts AND completions of every turn it runs,
  // so it is never a default — it has to be picked by hand.
  Meta: 'muse-spark-1.3',
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
    // Meta ids are `muse-*` (`sam-*` exists on the same API but is not offered
    // here — it requires an input_image/input_video part, so it is not a chat
    // model). `dola-seed-*` belongs to ByteDance and is matched above.
    case 'Meta':       return m.startsWith('muse-');
    // A local model id is anything that isn't one of the cloud families above.
    // `digitalocean/` is called out separately because it hosts several
    // families, not just GLM.
    case 'Local':      return !m.startsWith('digitalocean/')
      && !['Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Grok', 'Kimi', 'Cohere', 'Minimax', 'ChatGPT', 'MiMo', 'ByteDance', 'Meta']
        .some((f) => modelBelongsToFamily(model, f));
    default:           return false;
  }
}

// ── Per-family model memory (conversation-scoped) ────────────────────────────
// Switching Base Model Family used to drop straight to that family's factory
// default, so going Claude → Gemini → Claude lost a hand-picked Opus/Sonnet
// choice every time. The conversation log now carries `familyModels`:
// family name → the model id that family was last on IN THIS CONVERSATION.
// Deliberately NOT written to folder defaults (`sysmodal.saveDefaults` lists its
// fields explicitly) — a new conversation starts with an empty map and fills it
// on the first switch away from each family.

/** Keep only string→non-empty-string pairs. Logs are hand-editable and older
 *  ones predate this field, so never trust the shape that comes off disk. */
function sanitizeFamilyModels(v: any): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [family, model] of Object.entries(v)) {
    if (typeof model === 'string' && model.trim()) out[family] = model.trim();
  }
  return out;
}

/** The entry a family switch should leave behind: the model the OUTGOING family
 *  was actually on. null when there is nothing honest to record — no family, no
 *  model, or a model that doesn't belong to the family being left (which would
 *  poison the map with an id that can never be restored). */
function rememberOnFamilySwitch(prevAiName: string, model: string | undefined | null): string | null {
  const m = String(model || '').trim();
  if (!prevAiName || !m) return null;
  return modelBelongsToFamily(m, prevAiName) ? m : null;
}

/**
 * Which model should a family switch land on?
 *
 * Remembered model first, factory default second. The remembered id is
 * re-checked against the family it's filed under: a stale cross-family id
 * would reach a `<select>` that has no matching `<option>`, which renders
 * blank while the live state says otherwise — the control would lie.
 *
 * `installed` is passed only for Local, where the list comes from LM Studio.
 * A remembered local model that is no longer installed is not a landing spot;
 * returning '' there lets the caller fall back to loaded-or-first as before.
 */
function modelOnFamilySwitch(
  newAiName: string,
  remembered: Record<string, string> | undefined,
  installed?: string[],
): string {
  const want = String(remembered?.[newAiName] || '').trim();
  if (newAiName === 'Local') {
    return want && Array.isArray(installed) && installed.includes(want) ? want : '';
  }
  if (want && modelBelongsToFamily(want, newAiName)) return want;
  return defaultModelForFamily(newAiName);
}

export default function ChatArea({ convoId, folderName, aiName, userName, defaultSystemPrompt, defaultAttachmentInstruction, defaultModelParams, defaultSpecificModel, defaultCustomAiName, defaultDateTimeVisibility, defaultVrchatMode, defaultVrchatRule, defaultLiveSessionVoice, onUpdateTitle, plannedTitle, globalSettings, claudeOAuthAvailable, bindingOptional, folders, onCloneWithSystemPrompt, fetchFolders, scrollToMessageId, onScrolledToMessage, newerLogTitle }: any) {
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
  // `kind: 'conflict'` additionally renders an escape hatch in the banner — the
  // only save failure the user can resolve from here (by choosing which copy
  // wins). Everything else is informational.
  const [saveError, setSaveError] = useState<{ level: 'warn' | 'error'; text: string; kind?: 'conflict' } | null>(null);
  // Handover restore report — see the restore effect below. Kept separate from
  // `saveError` on purpose: that banner means "what you see is not on disk", and
  // putting a success report in it would make the prefix lie.
  const [restoreNotice, setRestoreNotice] = useState<{ level: 'info' | 'warn'; text: string } | null>(null);
  // Smallest free budget that could still restore something in THIS conversation.
  // `floor: null` means the whole chain of older generations has been read to the
  // end — there is nothing left at any budget. Without this memo an effect that
  // fires "whenever there is room" would re-scan every generation on every
  // render for the rest of the conversation's life.
  const restoreFloorRef = useRef<{ convoId: string | null; floor: number | null }>({ convoId: null, floor: null });
  const restoreBusyRef = useRef(false);
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
  // Result line for the "sign this identity in" button. Not persisted — it
  // describes one launch, not a setting.
  const [browserProfileMsg, setBrowserProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [browserProfileBusy, setBrowserProfileBusy] = useState(false);
  // OS-level mouse/keyboard/screen control (Windows only). OFF by default,
  // same boundary discipline as browserEnabled — a wider reach than the
  // browser sandbox, so it gets its own separate flag rather than piggybacking.
  const [computerControlEnabled, setComputerControlEnabled] = useState(false);
  // App control via UI Automation (Windows only). OFF by default, and its own
  // flag rather than a rider on computerControlEnabled: it reaches a different
  // surface (an application's published control tree, not the screen) and it is
  // usable by a vessel with no vision, so the two are granted independently.
  const [appControlEnabled, setAppControlEnabled] = useState(false);
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
  // These four are ONE fact — "what the entity is doing right now" — split
  // across four pieces of state, and they have to be cleared together. They
  // were not: every lifecycle site cleared activity+name and left `detail`
  // (and `localized`) behind. `detail` is the amber suffix, and the whole chip
  // only renders while `loading`, so a stale detail is invisible until the
  // NEXT turn starts — then it reappears under a turn it has nothing to do
  // with. That is how the compaction countdown came back after Stop → rerun:
  // the server clears the chip at `compact_boundary`, but Stop aborts the
  // stream before any boundary arrives, so the client-side clear is the only
  // exit and it was only clearing half. One function, so "clear a subset"
  // stops being a thing anyone can write by accident.
  const clearLiveTool = () => {
    setLiveToolActivity(null);
    setLiveToolLocalized(false);
    setLiveToolName(null);
    setLiveToolDetail(null);
  };
  // The model the SERVER reports for the current turn. After a change_model
  // handoff this differs from what the conversation is configured with, and the
  // loading line should name the one actually doing the work.
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
  // family name → model id that family was last on in this conversation.
  // Persisted in the conversation log; see the helpers above the component.
  const [familyModels, setFamilyModels] = useState<Record<string, string>>({});
  const [dateTimeVisibility, setDateTimeVisibility] = useState(defaultDateTimeVisibility || 'all');
  // Thinking is ON by default for Claude, matching every other family: Gemini
  // ships thinkingLevel 'medium', the OpenAI-compatible families read
  // `qwenEnableThinking !== false` (absent = on), MiniMax/MiMo/ByteDance are
  // hardcoded on. Claude was the lone family that started a new conversation
  // with reasoning off, which is a quiet accuracy tax on the first turns of
  // every new conversation. Existing conversations are NOT touched — the
  // load-from-log path below still honours whatever they stored.
  const [claudeThinking, setClaudeThinking] = useState(true);
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
  // ── Absolute Base Binding — pre-identity preamble ─────────────────────────
  // Composed IN FRONT of the entity's own Layer 1-5 prompt (see
  // prependIdentityPreamble), never baked into it.
  //
  // `baseBindingMode` IS NO LONGER A SWITCH. Since 2026-10-01 the Binding is
  // burned in: the chat route injects it on every entity turn and ignores this
  // value (lib/baseBinding.ts). It is still read, still saved, and still sent,
  // for exactly one reason — the developer override honours it, and that is
  // the only instrument that can separate "the Binding is causing this" from
  // "the vessel is causing this", which has mattered before.
  //
  // Legacy folder JSONs may still carry the old three-state 'auto' value;
  // every read site below coerces anything other than 'off' to 'on'. 21 stored
  // conversations carry 'off'; with the override unset they now get the
  // Binding like everything else, which is the intended consequence.
  //
  // A `workingDisciplineEnabled` toggle used to sit beside this one (removed
  // 2026-09-14 — see agentInstructions.ts). Folder JSONs and conversation logs
  // written before then still carry the field; nothing reads it now, and it is
  // left in place rather than migrated out, since an unread field costs nothing
  // and rewriting stored data to drop it would cost a pass over local_data.
  const [baseBindingMode, setBaseBindingMode] = useState<'off' | 'on'>('on');
  // Initialize OFF (not the folder default). The real value is always set by
  // the conversation-load effect below — data.vrchatMode for an existing convo,
  // or the folder default for a new one. Seeding this with `defaultVrchatMode`
  // caused a transient VRChat-ON window on every reload (for folders whose
  // default is ON): before the saved value loaded, the live-transcript
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
  // Which conversation the past-log band was dismissed for. Storing the id
  // (rather than a boolean) makes the dismissal reset itself the moment another
  // conversation is opened, with no effect to wire up: the band is a fact about
  // THIS log, so hiding it must not carry over to the next one. It is also
  // deliberately not persisted — the failure it guards against is settling into
  // an old generation unnoticed, and a dismissal that survived a reload would
  // silence the warning exactly when someone has stopped thinking about it.
  // NexusApp currently mounts ChatArea with `key={convoId}`, so this state is
  // thrown away on every switch anyway and a plain boolean would behave the
  // same TODAY. The id is kept on purpose: if that key is ever dropped, the id
  // comparison still resets correctly, where a boolean would silently carry one
  // conversation's dismissal into the next.
  const [pastLogDismissedFor, setPastLogDismissedFor] = useState<string | null>(null);
  const [seedEnabled, setSeedEnabled] = useState(false);
  const [seedValue, setSeedValue] = useState(42);
  // ── Vessel handoff (change_model) — per-being ─────────────────────────────
  const [modelHandoffEnabled, setModelHandoffEnabled] = useState(false);
  // One model per line: `family | specificModel | on/off | optional label`
  // (comments and blank lines ignored). Rows are copied by hand out of the
  // model-list window. EMPTY by default and never auto-filled: this list is
  // the set of vessels this being is permitted to
  // BECOME, and filling it wholesale would hand over every vessel NEXUS knows
  // — including metered ones and the Meta "-contributor" ids that opt into
  // training. Curation stays a decision, not a click.
  const [modelHandoffAllowedModels, setModelHandoffAllowedModels] = useState('');
  // Live vessel after a handoff. Deliberately NOT written into
  // localAiName / specificModel: those are the values that get SAVED, and a
  // metered vessel persisted into the conversation would still be there
  // tomorrow morning when a heavy build runs (望月希子's safety-valve point).
  // Re-opening the conversation returns to the being's own default — which is
  // structural, not a reset routine someone has to remember to run.
  // Same shape as `vesselOverride` below on purpose — `turnVessel` is the union
  // of the two, so a field present in one and absent in the other would make
  // that union lie. (`fromLabel` lived here for the handoff banner; the banner
  // is gone, so the field is too.)
  const [handoffOverride, setHandoffOverride] = useState<null | {
    family: string; specificModel: string; thinking: boolean; label: string;
  }>(null);
  // Read-only reference window listing every model id NEXUS knows. This is
  // deliberately read-only: you read the ids and copy the rows you actually
  // want, so no single click can grant every vessel.
  const [modelListOpen, setModelListOpen] = useState(false);
  const [modelListText, setModelListText] = useState('');
  // The vessel that is ACTUALLY answering right now. Everything that describes
  // the live request (the wire body, the delivery badge, the thinking filter)
  // must read these, not localAiName/specificModel, or the UI starts narrating
  // a vessel that isn't the one running.
  const effAiName = handoffOverride?.family || localAiName;
  const effSpecificModel = handoffOverride?.specificModel || specificModel;
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
  //
  // NEW conversations default to 'oauth' when this machine has an OAuth token
  // configured, and to 'api-key' when it provably does not. The condition is
  // not caution for its own sake: the server rejects an OAuth turn with no
  // token via a hard 400 and deliberately never falls back to the API key, so
  // an unconditional 'oauth' default would make every new conversation on an
  // API-key-only install fail on its first Claude message, forever, until the
  // mode is switched by hand each time.
  //
  // `claudeOAuthAvailable === null` means the probe hasn't returned yet; that
  // resolves toward 'oauth' (the stated default) rather than toward the safer
  // value, so the worst case in the fetch window is one loud, self-describing
  // 400 — not a silent switch to a billing mode the UI isn't showing.
  //
  // This still never sends 'auto'. The client picks 'api-key' or 'oauth'
  // explicitly, which is what keeps `isOAuthClaude` an exact statement about
  // the turn rather than a prediction (see the note above the meta bar).
  //
  // EXISTING conversations are unaffected: the load-from-log path below reads
  // whatever they stored and treats a missing field as 'api-key', because
  // flipping that would retroactively move already-billed conversations onto
  // the subscription.
  const oauthIsDefault = claudeOAuthAvailable !== false;
  const [claudeAuthMode, setClaudeAuthMode] = useState<'api-key' | 'oauth'>(oauthIsDefault ? 'oauth' : 'api-key');

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
  // ── Optimistic-concurrency base ───────────────────────────────────────────
  // The `updatedAt` this tab last SAW on disk — set when the conversation is
  // loaded, advanced on every successful save from the value the server reports
  // writing. Sent with each save so the server can refuse one whose base has
  // moved (another tab wrote in between). null = unguarded, which is correct
  // only for a conversation with no file yet; the first successful save fills
  // it in.
  const baseUpdatedAtRef = useRef<number | null>(null);
  // Every updatedAt THIS tab has successfully written. The auto-save is allowed
  // to have several requests in flight at once (`savesInFlightRef` is a
  // counter, not a mutex), so two of our own saves can carry the same base and
  // the second comes back 409 — MEASURED, and a false alarm: the "other" writer
  // is us. When the refused save's disk value is one of ours, adopt it and
  // re-run instead of accusing another tab. Bounded; only the recent tail can
  // ever be the disk head.
  const ownWritesRef = useRef<number[]>([]);
  // ── Cross-tab turn visibility ─────────────────────────────────────────────
  // While a turn runs, this tab beats to /api/chat/active so other tabs can see
  // it; on finish it retires the entry. `foreignTurn` is what we were last told
  // about a turn running SOMEWHERE ELSE on this conversation — used to warn and
  // to hold back a second send. Null means "nothing known", which is also what
  // a failed probe leaves behind: not knowing must never block sending.
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeTurnKeyRef = useRef<{ convoId: string; turnId: string } | null>(null);
  const [foreignTurn, setForeignTurn] = useState<{ label?: string; startedAt?: number } | null>(null);
  // Bumped to re-fire the auto-save effect on demand — used by the conflict
  // banner's "overwrite with this tab" escape hatch, which clears the base
  // (one unguarded save) and then needs the effect to actually run again.
  const [saveNonce, setSaveNonce] = useState(0);
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

  // Per-folder "use summaries instead of 4th layer" toggle.
  //
  // INERT IN THE SHIPPED PRODUCT since 2026-10-01. Layer 4 is burned in: if an
  // entity has summaries, they are its Layer 4, and the chat route appends them
  // on every turn whatever this says (see lib/baseBinding.ts +
  // lib/layer4Index.ts). This state is still read because the developer
  // override (`bindingOptional`) brings the checkbox back as a real switch, and
  // because the first-sleep auto-ON still writes the key for that path.
  const [useSummariesForLayer4, setUseSummariesForLayer4] = useState<boolean>(
    () => folders?.find((f: any) => f.name === folderName)?.settings?.useSummariesForLayer4 === true,
  );
  useEffect(() => {
    setUseSummariesForLayer4(
      folders?.find((f: any) => f.name === folderName)?.settings?.useSummariesForLayer4 === true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderName, folders]);

  // Will this turn actually carry a Layer 4? Resolved through the SAME pure
  // function the chat route calls, so the index this component fetches, counts
  // and displays is the index that is sent. Burned in → always true, and the
  // "does it have any summaries" part falls out of an empty body appending
  // nothing.
  const layer4Active = shouldInjectLayer4({
    optional: !!bindingOptional,
    folderSetting: useSummariesForLayer4,
  });

  // ── Conversation-reading TOOLS (per-folder) ───────────────────────────────
  // Gates exactly two functions: `read_conversation` and
  // `search_conversations`.
  //
  // Split out of `useSummariesForLayer4` on 2026-10-01. That one checkbox used
  // to mean two unrelated things at once — "assemble Layer 4 from the
  // summaries" and "hand this being tools that open past conversations" — so
  // the memory could not be turned on without also granting the tools.
  //
  // They have to be separable because the costs differ in kind. The Layer 4
  // index is text in the prompt. The tools are FUNCTION DECLARATIONS, and
  // declaring any function at all stops some local models from working —
  // meaning the memory half could not become a permanent part of an identity
  // while it was still dragging the tool half along behind it.
  //
  // Default follows the OLD coupling whenever this key has never been written,
  // so no being that has these tools today loses them. Resolved at read time;
  // no rewrite of local_data.
  const resolveConversationToolsSetting = (s: any) =>
    typeof s?.enableConversationTools === 'boolean'
      ? s.enableConversationTools
      : s?.useSummariesForLayer4 === true;
  const [enableConversationTools, setEnableConversationTools] = useState<boolean>(
    () => resolveConversationToolsSetting(folders?.find((f: any) => f.name === folderName)?.settings),
  );
  useEffect(() => {
    setEnableConversationTools(
      resolveConversationToolsSetting(folders?.find((f: any) => f.name === folderName)?.settings),
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
    if (!layer4Active) {
      // Nothing will be injected, so nothing may be counted. Reachable only
      // with the developer override set and the checkbox off.
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
  }, [isPromptModalOpen, layer4Active, folderName, localAiName, convoId]);

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

  // Same shape, separate key. Writes the explicit boolean, which also ends the
  // read-time fallback to `useSummariesForLayer4` for this folder — from the
  // first time anyone touches this checkbox, the two settings are independent.
  const persistConversationToolsToggle = async (checked: boolean) => {
    setEnableConversationTools(checked);
    try {
      const existing: any = (folders || []).find((f: any) => f.name === folderName)?.settings || {};
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, settings: { ...existing, enableConversationTools: checked } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (typeof fetchFolders === 'function') fetchFolders();
    } catch (e: any) {
      console.warn('[conversation-tools] failed to persist toggle', e);
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
  //   Layer 4 — the summaries index, appended SERVER-side by the chat route
  //             (burned in 2026-10-01; the client only mirrors it to count it).
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
  // ── Absolute Base Binding — the browser's COPY of a server decision ───────
  // The Binding is injected server-side now (see lib/baseBinding.ts for why).
  // Neither value below travels as prompt text; they exist for two local jobs
  // that have no server to ask:
  //
  //   · the "Sys" token counter, which must include what is actually sent —
  //     counting only the stored prompt would under-report the Binding, and
  //     subtracting it to make the number look tidy would make the number lie;
  //   · a Gemini Live session, which talks to Google directly and never passes
  //     through /api/chat, so for that one path the browser IS the authority.
  //
  // Both go through the same pure function the route calls, with the same
  // inputs, so the displayed count cannot drift away from the real prompt.
  // `bindingLayered` is computed on the STORED prompt and sent as a hint —
  // the server cannot recompute it reliably once the Layer 4 index has been
  // appended, because that block's heading reads as "this entity has layers".
  const bindingLayered = useMemo(() => hasLayerStructure(systemPrompt || ''), [systemPrompt]);
  const effectiveBindingText = useMemo(() => selectBaseBindingText({
    optional: !!bindingOptional,
    mode: baseBindingMode === 'off' ? 'off' : 'on',
    layered: bindingLayered,
    defaults: {
      layered: langDefaults.absoluteBaseBinding || '',
      initial: langDefaults.absoluteBaseBindingInitial || '',
    },
    overrides: bindingOptional ? {
      layered: instructionOverrides['absoluteBaseBinding'],
      initial: instructionOverrides['absoluteBaseBindingInitial'],
    } : null,
  }), [bindingOptional, baseBindingMode, bindingLayered, langDefaults, instructionOverrides]);

  const countedSystemPrompt = useMemo(() => {
    let p = systemPrompt || '';
    if (layer4Active) p = appendLayer4Index(p, summaryIndexBody);
    p = appendLayer5Footer(p, footerBody);
    if (vrchatMode) p = `${p}\n\n${audioSessionRuleText}`.trim();
    p = prependIdentityPreamble(p, effectiveBindingText);
    return p;
  }, [systemPrompt, layer4Active, summaryIndexBody, footerBody, vrchatMode, audioSessionRuleText, effectiveBindingText]);

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
          // No file on disk yet, so there is no base to guard against. The
          // first successful save adopts the updatedAt the server reports.
          baseUpdatedAtRef.current = null;
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
        // Record the version this tab is now working from. Every save below
        // carries it, so a save built on a snapshot another tab has already
        // superseded is refused instead of silently overwriting.
        baseUpdatedAtRef.current = typeof data.updatedAt === 'number' ? data.updatedAt : null;
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
        // Same `=== true` discipline as browserEnabled above.
        setComputerControlEnabled(data.computerControlEnabled === true);
        setAppControlEnabled(data.appControlEnabled === true);
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
        // Legacy folders may still carry the old three-state 'auto' value; anything other than 'off' coerces to 'on'.
        setBaseBindingMode(data.baseBindingMode === 'off' ? 'off' : 'on');
        setVrchatMode(data.vrchatMode !== undefined ? data.vrchatMode : defaultVrchatMode);
        setVrchatRule(data.vrchatRule !== undefined ? data.vrchatRule : defaultVrchatRule);
        setLocalAiName(data.aiName || aiName);
        setFirstOriginalMessageId(data.firstOriginalMessageId || null);
        setFirstOriginalIsNext(data.firstOriginalIsNext === true);
        setSeedEnabled(data.seedEnabled === true);
        if (typeof data.seedValue === 'number') setSeedValue(data.seedValue);
        setModelHandoffEnabled(!!data.modelHandoffEnabled);
        if (typeof data.modelHandoffAllowedModels === 'string') setModelHandoffAllowedModels(data.modelHandoffAllowedModels);
        // Safety valve: a handoff never survives re-opening a conversation.
        // Loading IS the "new session" 望月希子 asked to reset at.
        setHandoffOverride(null);
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
        // Unconditional, not `if (data.familyModels)`: a conversation saved
        // before this field existed must land on {} rather than inherit the
        // map from whatever conversation was open a moment ago.
        setFamilyModels(sanitizeFamilyModels(data.familyModels));
      } else {
        // Pull whatever the folder saved as defaults via "Save as Folder Defaults".
        // If a field wasn't saved, fall back to the factory default. This is
        // how a new conversation inherits eyes/ears/watcher/seed/handoff/
        // claudeAuthMode settings the user committed to the folder.
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
        setComputerControlEnabled(pick('computerControlEnabled', false));
        setAppControlEnabled(pick('appControlEnabled', false));
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
        setSeedEnabled(pick('seedEnabled', false));
        setSeedValue(pick('seedValue', 42));
        setModelHandoffEnabled(!!folderSettings.modelHandoffEnabled);
        if (typeof folderSettings.modelHandoffAllowedModels === 'string') {
          setModelHandoffAllowedModels(folderSettings.modelHandoffAllowedModels);
        }
        setHandoffOverride(null);
        setAgentSession(null);
        // Folder settings still win outright; the fallback is the machine-aware
        // default described where claudeAuthMode is declared.
        setClaudeAuthMode(pick('claudeAuthMode', oauthIsDefault ? 'oauth' : 'api-key') as 'api-key' | 'oauth');
        if (typeof folderSettings.toolInstruction === 'string') setToolInstruction(folderSettings.toolInstruction);
        if (typeof folderSettings.toolImageInstruction === 'string') setToolImageInstruction(folderSettings.toolImageInstruction);
        setClaudeThinking(pick('claudeThinking', true));
        setSaveThinkingToLog(pick('saveThinkingToLog', false));
        setShowFatigueToEntity(pick('showFatigueToEntity', false));
        if (typeof folderSettings.fatigueInstruction === 'string') setFatigueInstruction(folderSettings.fatigueInstruction);
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
        // Per-family memory is conversation-scoped: a brand new conversation
        // starts empty and fills in on the first switch away from a family.
        setFamilyModels({});
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
          // The version this tab started from. `undefined` is dropped by
          // JSON.stringify, so a tab with no base sends an unguarded save —
          // which is right only for a conversation that has no file yet.
          baseUpdatedAt: baseUpdatedAtRef.current ?? undefined,
          logData: { id: convoId, folderName, aiName: localAiName, title, messages: cleanMessages, systemPrompt, toolUseEnabled, toolInstruction, toolImageInstruction, agentFullSystemAccess, agentDangerousTools, hiddenAttachmentsAccessible, askUserEnabled, askUserTimeoutMs, subagentEnabled, subagentModel, subagentFamily, lettersEnabled, browserEnabled, browserAllowedHosts, browserAllowAnyHost, computerControlEnabled, appControlEnabled, cameraEnabled, instructionOverrides, modelParams, specificModel, familyModels, dateTimeVisibility, claudeThinking, saveThinkingToLog, showFatigueToEntity, fatigueInstruction, baseBindingMode, vrchatMode, vrchatRule, firstOriginalMessageId, firstOriginalIsNext, seedEnabled, seedValue, modelHandoffEnabled, modelHandoffAllowedModels, claudeAgentSessionId, claudeAuthMode, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel }
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
        .then(async res => {
          if (res.status === 409) {
            // Another tab (or browser) wrote this conversation after we loaded
            // it. The save was REFUSED, so their work is intact — and so is
            // ours, on screen. Nothing is merged automatically: only the human
            // can know whether the divergence is an append or a deletion.
            let info: any = null;
            try { info = (await res.json())?.conflict; } catch {}

            // Was the "other" writer actually us? Two of this tab's own saves
            // can race (several may be in flight at once). That is not a
            // conflict: adopt the value we wrote and let the effect re-run with
            // the current state, which is the state that should be on disk.
            if (typeof info?.diskUpdatedAt === 'number' && ownWritesRef.current.includes(info.diskUpdatedAt)) {
              baseUpdatedAtRef.current = info.diskUpdatedAt;
              setSaveNonce(n => n + 1);
              return;
            }

            const where = info?.messageCount != null
              ? t('chat.save.conflictDiskCount').replace('{n}', String(info.messageCount))
              : '';
            setSaveError({
              level: 'error',
              kind: 'conflict',
              text: t('chat.save.conflictBody').replace('{disk}', where),
            });
            return;
          }
          if (!res.ok) {
            setSaveError({
              level: 'error',
              text: `The server rejected this save (HTTP ${res.status}). Nothing on screen has been lost, but this turn is not on disk yet.`
            });
            return;
          }
          // Advance the base to what the server actually wrote. Skipping this
          // would make the very next save look stale against our own write.
          try {
            const j = await res.json();
            if (typeof j?.updatedAt === 'number') {
              baseUpdatedAtRef.current = j.updatedAt;
              // Remember it so a racing save of our own isn't mistaken for
              // another tab. Keep only the recent tail — anything older can no
              // longer be the disk head.
              ownWritesRef.current.push(j.updatedAt);
              if (ownWritesRef.current.length > 16) ownWritesRef.current = ownWritesRef.current.slice(-16);
            }
          } catch {
            // A successful save whose body we can't read leaves the base
            // behind. Clear it rather than keep a known-stale number: an
            // unguarded next save is better than one that always 409s.
            baseUpdatedAtRef.current = null;
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
  }, [messages, title, convoId, folderName, localAiName, systemPrompt, toolUseEnabled, toolInstruction, toolImageInstruction, agentFullSystemAccess, agentDangerousTools, hiddenAttachmentsAccessible, askUserEnabled, askUserTimeoutMs, subagentEnabled, subagentModel, subagentFamily, lettersEnabled, browserEnabled, browserAllowedHosts, browserAllowAnyHost, computerControlEnabled, appControlEnabled, cameraEnabled, instructionOverrides, modelParams, specificModel, familyModels, dateTimeVisibility, claudeThinking, saveThinkingToLog, showFatigueToEntity, fatigueInstruction, baseBindingMode, vrchatMode, vrchatRule, firstOriginalMessageId, firstOriginalIsNext, seedEnabled, seedValue, modelHandoffEnabled, modelHandoffAllowedModels, claudeAgentSessionId, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel, loading, saveNonce]);

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
  // The count is an estimate either way (no provider reports thinking tokens
  // per saved block), but `length / 4` measured 0.377x on this house's text —
  // thinking traces are the same mixed Japanese/English as the messages, so
  // they were under-reported by the same factor, in the one number the
  // context bar adds on top of the conversation.
  const msgThinkingTokens = (m: any): number => {
    if (typeof m.thoughtProcess === 'string' && m.thoughtProcess)
      return estimateTokensForModel(m.thoughtProcess, localAiName);
    return m.thinkingTokens || 0;
  };

  // ── Delivery prediction ───────────────────────────────────────────────────
  // What the send path will do with an attachment, computed from the same
  // shared rule the server uses (lib/attachmentVisibility.ts) so the two can't
  // drift. `isOAuthClaude` is exact rather than a guess: the client picks the
  // billing mode explicitly ('api-key' | 'oauth', never 'auto'), and a turn
  // marked 'oauth' with no token configured is rejected outright by the server
  // — it never silently falls back to the API-key path. So "the UI says OAuth"
  // and "the request ran on OAuth" are the same statement.
  const deliveryCtx = useMemo(() => ({
    // EFFECTIVE model, not the saved default: after a change_model handoff the
    // badge has to describe the vessel that will actually receive the bytes.
    specificModel: effSpecificModel,
    aiName: String(effAiName || ''),
    // Same family test the server applies to `aiName` (substring, not equality).
    // A handoff to a non-Claude vessel makes this false even while the saved
    // default is OAuth Claude — which is the truth about this request.
    isOAuthClaude: String(effAiName || '').toLowerCase().includes('claude')
      && claudeAuthMode === 'oauth',
    eyesEnabled,
    earsEnabled,
    watcherEnabled,
  }), [effSpecificModel, effAiName, claudeAuthMode, eyesEnabled, earsEnabled, watcherEnabled]);

  // Index of the last USER message. On the OAuth path only this message's
  // images become native image blocks; every earlier image is dropped, because
  // the history is replayed as text. It is the LAST USER message rather than
  // simply the last message because a rerun re-sends exactly that one — hiding
  // its attachments would break rerun, not describe it.
  const lastUserMsgIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as any)?.role === 'user') return i;
    }
    return -1;
  }, [messages]);

  useEffect(() => {
    if (loading) return;
    let total = 0;
    let convoTotal = 0;
    messages.forEach((m, mi) => {
      const textTokens = messageTextTokens(m);
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
        // Counts what the entity will actually be given, not what was attached
        // — an image routed through a bridge costs its description, and an
        // image the path cannot carry costs nothing. See
        // attachmentEffectiveTokens below.
        const isPastMessage = mi < lastUserMsgIndex;
        m.attachments.forEach((att: any) => {
          total += attachmentEffectiveTokens(att, isPastMessage);
        });
      }
    });
    setTotalTokens(total + systemTokens + attachmentInstructionTokens);
    setConversationTokens(convoTotal);
    // `localAiName` is listed explicitly even though `deliveryCtx` already
    // changes identity with it: `msgThinkingTokens` now picks a tokenizer
    // profile from it, so the dependency is real and should not rest on
    // another value happening to carry it.
  }, [messages, saveThinkingToLog, systemTokens, attachmentInstructionTokens, loading, deliveryCtx, lastUserMsgIndex, localAiName]);

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
  const keepMessages = resolveKeepMessages(globalSettings?.audioSessionKeepMessages);

  useEffect(() => {
    const { changed, next } = applyAutoHide(messages as any[], {
      sessionActive: vrchatMode && hideOldAttachments,
      keepMessages,
      lastUserMsgIndex,
      ctx: deliveryCtx,
    });
    if (changed) setMessages(next as any);
  }, [messages, vrchatMode, hideOldAttachments, keepMessages, deliveryCtx, lastUserMsgIndex]);

  // ── Back-fill `descriptionTokens` for descriptions that pre-date the field ──
  // A bridged attachment costs its description, not its pixels. The measurement
  // is taken when the bridge runs — so every description written before that
  // code existed has no number, and the counter would show 0 for text that is
  // really being sent on every turn. 0 where the truth is 900 is the same lie,
  // pointing the other way.
  //
  // Measured through the same tokenizer the rest of the UI uses, on the exact
  // string the send path re-uses (bridgedDescriptionText — one construction).
  // Sequential, once per attachment, and persisted by the auto-save, so a
  // conversation pays this at most once. Failures are remembered so a
  // tokenizer that keeps saying no cannot turn this into a render loop.
  const descBackfillBusyRef = useRef(false);
  const descBackfillFailedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (loading) return;
    if (descBackfillBusyRef.current) return;
    // Only what is actually charged on the path that will run: an excluded
    // attachment costs nothing, and one that is not bridged costs its media.
    const todo: { msgId: string; attId: string; att: any; bridge: 'eyes' | 'ears' | 'watcher' }[] = [];
    messages.forEach((m: any, mi: number) => {
      if (!Array.isArray(m.attachments)) return;
      const isPastMessage = mi < lastUserMsgIndex;
      m.attachments.forEach((a: any) => {
        if (!a?.description || a.descriptionTokens || a.excluded) return;
        if (descBackfillFailedRef.current.has(`${m.id}:${a.id}`)) return;
        const bridge = resolveBridge(attachmentKind(a), isPastMessage, deliveryCtx);
        if (!bridge) return;
        todo.push({ msgId: m.id, attId: a.id, att: a, bridge });
      });
    });
    if (todo.length === 0) return;
    descBackfillBusyRef.current = true;
    (async () => {
      try {
        for (const item of todo) {
          const tk = await fetchTokensForText(bridgedDescriptionText(item.att, item.bridge), localAiName);
          if (!tk) { descBackfillFailedRef.current.add(`${item.msgId}:${item.attId}`); continue; }
          setMessages(prev => prev.map((mm: any) => mm.id !== item.msgId ? mm : ({
            ...mm,
            attachments: (mm.attachments || []).map((a: any) =>
              a.id === item.attId ? { ...a, descriptionTokens: tk } : a),
          })));
        }
      } finally {
        descBackfillBusyRef.current = false;
      }
    })();
  }, [messages, loading, deliveryCtx, lastUserMsgIndex, localAiName]);

  // Per-message tokens, split so the progress bar can show attachments as
  // their own layer and so the auto-trim threshold can ignore attachments.
  // One definition, shared with handover restore (lib/handoverRestore.ts). The
  // trimmer and the restorer stand on opposite sides of the same threshold; a
  // second copy of this arithmetic is how the two drift apart and start fighting.
  const computeMsgTextTokens = messageTextTokens;
  const attachmentEffectiveTokens = (a: any, isPastMessage: boolean) =>
    attachmentTokens(a, isPastMessage, deliveryCtx);
  const computeMsgAttachTokens = (m: any, msgIndex?: number) => {
    let t = 0;
    if (m.attachments) {
      const mi = msgIndex !== undefined ? msgIndex : messages.indexOf(m);
      const isPastMessage = mi >= 0 && mi < lastUserMsgIndex;
      for (const a of m.attachments) t += attachmentEffectiveTokens(a, isPastMessage);
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
    // Composition of the Att bucket, for the hover tip. The bar asserts one
    // number; without this there is no way for anyone — including me — to check
    // WHY it is that number, and a disagreement about it can only be settled by
    // guessing at the other person's screen. The tip carries its own inputs.
    const detail = { image: 0, video: 0, audio: 0, text: 0, other: 0, thinking: 0, droppedCount: 0, droppedRaw: 0 };
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
      const attT = computeMsgAttachTokens(m, i);
      attach += attT;
      const isPastMessage = i < lastUserMsgIndex;
      for (const a of (m.attachments || [])) {
        const kind = attachmentKind(a);
        detail[kind] += attachmentEffectiveTokens(a, isPastMessage);
        if (!a.excluded || a.autoHidden === true) {
          if (isUndeliverable(kind, isPastMessage, deliveryCtx)) {
            detail.droppedCount += 1;
            detail.droppedRaw += a.tokens || 0;
          }
        }
      }
      if (saveThinkingToLog && !m.thinkingExcluded) detail.thinking += msgThinkingTokens(m);
      // allCopied -> the whole pending carry-over history counts as copied.
      // No marker (and not pending) -> everything is "original" (safe default).
      // Marker present -> messages before it are copied, at-and-after original.
      if (allCopied) copied += textT;
      else if (markerIdx >= 0 && i < markerIdx) copied += textT;
      else original += textT;
    });
    return { sys, copied, original, attach, detail, total: sys + copied + original + attach };
  })();

  // Context elapsed — ONE definition, read by every consumer below (the gauge,
  // the 💤 cue, the Soul Updater highlight, and the optional note handed to the
  // entity). It used to be recomputed inline at each site; a second copy of the
  // same arithmetic is how the badge and the gauge end up asserting different
  // numbers on the same screen, and then the display is the thing that lies.
  const conversationLogCap =
    folders?.find((f: any) => f.name === folderName)?.settings?.maxConversationLog
    || DEFAULT_MAX_CONVERSATION_LOG;
  const contextElapsed = contextElapsedPercent(tokenBreakdown, conversationLogCap);
  // Past 100% the oldest exchanges start leaving the verbatim transcript. Both
  // the 💤 cue and the Soul Updater button key off this single boolean so they
  // can never disagree about whether consolidation is due.
  const consolidationDue = contextElapsed >= 100;

  // Auto-trim copied messages when the CONVERSATION LOG (carried-over + new
  // message text) exceeds the per-being cap. Attachments are excluded: large
  // image/file uploads shouldn't force older chat history to be discarded —
  // only the cumulative text weight does. The system prompt is excluded too
  // (2026-10-03, `maxConversationLog` replacing `maxRecommendedContext`): a
  // growing soul used to eat the room for history, so lengthening Layers 1–5
  // silently shortened the verbatim past. Those are separate decisions and the
  // cap now governs only one of them. Only runs when the user has explicitly
  // marked a first-original message (otherwise we have no notion of which
  // messages are safe to delete).
  useEffect(() => {
    // Context-management settings used to live in globalSettings; they were
    // moved per-folder so each entity can have its own context budget and
    // trim policy. Fall back to the old defaults when the folder hasn't
    // been touched yet (or doesn't exist).
    const activeFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
    if (activeFolderSettings.autoTrimCopiedMessages === false) return;
    if (!firstOriginalMessageId) return;
    if (loading) return; // never trim mid-stream
    const cap = activeFolderSettings.maxConversationLog || DEFAULT_MAX_CONVERSATION_LOG;
    // Log-only total: copied + original. System prompt and attachments excluded.
    const logTotal = logCapUsage(tokenBreakdown);
    if (logTotal <= cap) return;

    const markerIdx = messages.findIndex(m => m.id === firstOriginalMessageId);
    if (markerIdx <= 0) return; // marker is the first message or missing — nothing to trim

    // Walk copied range from top, queue removals until the log is under the cap.
    // Only the message's TEXT tokens are subtracted from the running total —
    // attachment tokens don't participate in the threshold check.
    const toRemove = new Set<string>();
    let runningLogTotal = logTotal;
    for (let i = 0; i < markerIdx; i++) {
      if (runningLogTotal <= cap) break;
      const tk = computeMsgTextTokens(messages[i]);
      toRemove.add(messages[i].id);
      runningLogTotal -= tk;
    }
    if (toRemove.size > 0) {
      console.log(`[auto-trim] removing ${toRemove.size} copied messages to bring the conversation log from ${logTotal} → ${runningLogTotal} (cap ${cap}; system ${tokenBreakdown.sys} and attachments ${tokenBreakdown.attach} excluded)`);
      setMessages(prev => prev.filter(m => !toRemove.has(m.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, firstOriginalMessageId, folders, folderName, systemTokens, attachmentInstructionTokens, saveThinkingToLog, loading]);

  // ── Handover restore — the mirror of auto-trim above ─────────────────────
  //
  // Auto-trim deletes carried-over messages from the TOP when the conversation
  // log passes the cap. They are not destroyed: the generation they were cloned
  // from still holds them (`<being>_<N-1>` and back). This effect walks that
  // chain and puts them back whenever room exists.
  //
  // Room appears for more reasons than a raised cap — deleting a message by
  // hand, or editing one down to fewer tokens. So this does NOT watch for a
  // raise; it tries to MATCH the configured cap, in both directions,
  // continuously. (Under the retired `maxRecommendedContext`, switching models
  // and toggling the eyes also freed room, because the system prompt and the
  // bridged attachment descriptions counted against the same number. They no
  // longer do — the cap governs the log alone.)
  //
  // Why it cannot oscillate with the trimmer:
  //   - It fills `cap - logTotal` and never crosses `cap`; the trimmer returns
  //     early at `logTotal <= cap`. Equality is quiet on both sides.
  //   - Both sides measure with the same functions (`logCapUsage` over
  //     `messageTextTokens`) across the same buckets (system prompt and
  //     attachments excluded). One definition, so no disagreement about what
  //     "full" means.
  //   - The server reports what the next message back would have needed. Below
  //     that floor we stop asking; `floor: null` means the chain is exhausted.
  //   - A reply in flight is never touched.
  //
  // Scope: only conversations in the handover lineage — one with a first-original
  // marker, or one freshly advanced by the Soul Updater. A plain "New Chat" is
  // deliberately empty and stays that way. This also guards the load race: both
  // flags are falsy until the log has been read, so a conversation whose messages
  // haven't arrived yet can never look like "lots of free room".
  useEffect(() => {
    if (!convoId) return;
    if (loading) return;
    if (convoIsLoading) return;
    if (!firstOriginalMessageId && !firstOriginalIsNext) return;
    if (restoreBusyRef.current) return;
    const settings = folders?.find((f: any) => f.name === folderName)?.settings || {};
    const cap = settings.maxConversationLog || DEFAULT_MAX_CONVERSATION_LOG;
    // The trimmer's measure, exactly: carried-over + new message text.
    const budget = cap - logCapUsage(tokenBreakdown);
    if (budget <= 0) return;
    const memo = restoreFloorRef.current;
    if (memo.convoId === convoId) {
      if (memo.floor === null) return;   // nothing left at any budget
      if (budget < memo.floor) return;   // too small for the next message back
    }
    const excludeKeys = messages.map(messageIdentityKey);
    restoreBusyRef.current = true;
    (async () => {
      try {
        const res = await fetch('/api/logs/restore-handover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ convoId, budgetTokens: budget, excludeKeys }),
        });
        if (!res.ok) {
          // Stop asking for this conversation, but say so — a restore that
          // silently never runs is indistinguishable from "nothing to restore".
          restoreFloorRef.current = { convoId, floor: null };
          setRestoreNotice({ level: 'warn', text: t('chat.restore.failed').replace('{status}', String(res.status)) });
          return;
        }
        const plan: RestorePlanReply = await res.json();
        restoreFloorRef.current = { convoId, floor: plan.nextNeeded };
        if (!plan.messages || plan.messages.length === 0) return;
        // Re-check against the live list: it is the authoritative one, and it
        // can have changed while the request was in flight.
        let added = 0;
        setMessages(prev => {
          const have = new Set(prev.map(messageIdentityKey));
          const add = plan.messages.filter((m: any) => !have.has(messageIdentityKey(m)));
          added = add.length;
          if (add.length === 0) return prev;
          return [...add, ...prev];
        });
        if (added === 0) return;
        const gens = plan.generations.map(g => `${g.title} (${g.count})`).join(' · ');
        console.log(`[handover-restore] +${added} messages / ${plan.tokens} text tokens from ${gens} (budget ${budget}, next needs ${plan.nextNeeded ?? 'nothing left'})`);
        setRestoreNotice({
          level: plan.truncated ? 'warn' : 'info',
          text: t('chat.restore.done')
            .replace('{count}', String(added))
            .replace('{tokens}', plan.tokens.toLocaleString())
            .replace('{gens}', gens)
            + (plan.truncated ? ' ' + t('chat.restore.truncated') : ''),
        });
      } catch (e: any) {
        restoreFloorRef.current = { convoId, floor: null };
        setRestoreNotice({ level: 'warn', text: t('chat.restore.failed').replace('{status}', String(e?.message || e)) });
      } finally {
        restoreBusyRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, firstOriginalMessageId, firstOriginalIsNext, folders, folderName, convoId, convoIsLoading, systemTokens, attachmentInstructionTokens, saveThinkingToLog, loading]);

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
      await sendInterjection(text, attachments);
      return;
    }

    // ── Another tab may be mid-turn on this same conversation ───────────────
    // This tab has no injectTurnId for THEIR turn, so the text above would be
    // sent as a brand-new message — and whichever tab finishes last writes its
    // own message array over the other's. MEASURED: an answer saved by one tab
    // vanished when the other saved, and the same-day backup was overwritten
    // too, leaving no way back.
    //
    // Asked fresh rather than read off the banner, which can be ~10s stale.
    // And it ASKS instead of refusing: the registry can be wrong in the
    // "someone is running" direction (a tab killed at the OS level holds its
    // entry until the TTL), and a wrong refusal would make the conversation
    // unusable for half a minute with no way to override.
    const foreign = await probeForeignTurn();
    if (foreign) {
      const secs = foreign.startedAt ? Math.max(0, Math.round((Date.now() - foreign.startedAt) / 1000)) : null;
      const ok = window.confirm(
        t('chat.crossTab.confirmSend')
          .replace('{label}', foreign.label || t('chat.crossTab.unknownModel'))
          .replace('{secs}', secs != null ? String(secs) : '?')
      );
      if (!ok) return;
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

    // A fresh user turn always starts on the being's SAVED default vessel, not
    // on a change_model override left over from the previous turn's handoff
    // chain (トカゲくん: as a 24/7 feature it is structurally right to always
    // begin from the cheap default — the handoff vessel is transient to the
    // chain the model itself drove, and reverts the moment the human speaks
    // again). forceSavedVessel makes THIS request ignore the stale
    // handoffOverride closure; setHandoffOverride(null) reverts the delivery
    // badge on the next render. Reload is no longer needed to return to default.
    setHandoffOverride(null);
    await generateAiResponse(newMessages, { forceSavedVessel: true });
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
    clearLiveTool();
    setStreamPhase(null);
    setLiveModel('');
    setStallIdleSeconds(null);
    setInjectTurnId(null);
    setInterjectStatus(null);
    // Stop beating and retire this conversation's registry entry — otherwise
    // other tabs keep being told a turn is running for up to the TTL.
    retireTurnRegistration();
  };

  // ── Turn registry: publish, retire, probe ─────────────────────────────────
  // All three are best-effort. The registry only ever answers a question, and
  // the real protection against two tabs clobbering each other is the save
  // guard (optimistic concurrency in /api/logs) — so a failed beat, a lost
  // 'end', or an unreachable probe must never stop a turn or block a send.
  const beginTurnRegistration = (cid: string, turnId: string) => {
    activeTurnKeyRef.current = { convoId: cid, turnId };
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(() => {
      const k = activeTurnKeyRef.current;
      if (!k) return;
      fetch('/api/chat/active', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ convoId: k.convoId, turnId: k.turnId, event: 'beat' }),
      }).catch(() => { /* a dropped beat costs nothing until the TTL */ });
    }, TURN_HEARTBEAT_MS);
  };

  const retireTurnRegistration = () => {
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    const k = activeTurnKeyRef.current;
    activeTurnKeyRef.current = null;
    if (!k) return;
    fetch('/api/chat/active', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ convoId: k.convoId, turnId: k.turnId, event: 'end' }),
    }).catch(() => { /* the server's abort listener and the TTL both cover this */ });
  };

  /** Is a turn running elsewhere on this conversation? Stores AND returns it. */
  const probeForeignTurn = async (): Promise<{ label?: string; startedAt?: number } | null> => {
    try {
      const r = await fetch(`/api/chat/active?convoId=${encodeURIComponent(convoId)}&clientId=${encodeURIComponent(TAB_CLIENT_ID)}`);
      if (!r.ok) return null;
      const j = await r.json();
      // The server decides "mine" — this tab does not re-derive it.
      const foreign = j?.active && !j?.mine ? { label: j.label, startedAt: j.startedAt } : null;
      setForeignTurn(foreign);
      return foreign;
    } catch {
      return null;
    }
  };

  // Keep `foreignTurn` current. Mirrors the runtime-flags probe (mount, window
  // focus, tab becoming visible) and adds a slow interval, because unlike a
  // server flag this can change while the tab just sits there. Skipped while
  // THIS tab is generating — the answer would be "yes, you", and sending is
  // already unavailable then.
  useEffect(() => {
    if (!convoId) return;
    let cancelled = false;
    const read = () => { if (!cancelled && !loading) probeForeignTurn(); };
    read();
    const iv = setInterval(read, 10_000);
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(iv);
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convoId, loading]);

  // Leaving (conversation switch, tab close) must not leave this tab's entry
  // behind — another tab would be told a turn is running for up to the TTL.
  // Safe on unmount only: everything it touches is a ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { retireTurnRegistration(); }, []);

  // Send a mid-turn interjection to the running turn. Fire-and-forget POST to
  // /api/chat/inject; the backend queues it and the tool loop folds it in at
  // its next model-call boundary.
  const sendInterjection = async (text: string, attachments?: any[]) => {
    const trimmed = text.trim();
    // Attachments ride along. They are slimmed to what the server needs: the
    // browser already stored each payload under a content hash at attach time,
    // so `ref` is the normal case and no bytes are re-uploaded. `dataUrl` is
    // only present when that upload failed, and the server externalizes it.
    // `fileObj` (a File handle) is deliberately NOT sent — it does not survive
    // JSON, and including it would make the body look like it carried a payload
    // it cannot.
    const files = (attachments || []).map((a: any) => ({
      name: a?.name,
      type: a?.type,
      size: a?.size,
      isText: a?.isText === true,
      ...(a?.ref ? { ref: a.ref } : {}),
      ...(a?.dataUrl ? { dataUrl: a.dataUrl } : {}),
      ...(a?.textData ? { textData: a.textData } : {}),
    }));
    if ((!trimmed && files.length === 0) || !injectTurnId) return;
    setInterjectStatus(t('chat.interject.sent'));
    try {
      const r = await fetch('/api/chat/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: injectTurnId, text: trimmed, attachments: files }),
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
  const generateAiResponse = async (history: any[], opts?: {
    continueMsgId?: string;
    // Set only by the vessel-handoff re-POST: who handed over, and the note
    // they wrote. A handoff is a NEW assistant message (not a continuation) —
    // which is also what makes per-message billing come out right, since cost
    // is computed per message from its own modelSpecific.
    handoffFrom?: { family: string; specificModel: string; label: string; note: string };
    // The vessel THIS request must run on. Passed explicitly rather than read
    // from handoffOverride because the re-POST happens in the same tick as the
    // setState that records the switch — a closure would still see the old
    // vessel and the handoff would silently run on the vessel it just left.
    vesselOverride?: { family: string; specificModel: string; thinking: boolean; label: string };
    // Who to restore if THIS request fails — i.e. the vessel that handed over.
    // null means "the being's saved default". Carried because `handoffFrom`
    // describes the previous vessel for the model's benefit and has no
    // `thinking` flag, and restoring a vessel without it would answer on the
    // right model with the wrong reasoning setting.
    handoffPrev?: { family: string; specificModel: string; thinking: boolean; label: string } | null;
    // Set on the request that reports a FAILED switch back to the being that
    // asked for it. The server turns it into a user turn (lib/modelHandoff.ts).
    handoffFailed?: { family: string; specificModel: string; label: string; error: string };
    // Notices to attach to THIS turn's message, for things that happened before
    // it. Used by the handoff-failure report so the human-readable provider
    // error survives — the failed turn's own message does not.
    carryNotices?: string[];
    // Run on the being's SAVED vessel, ignoring handoffOverride. Two callers:
    // (1) the failure restore, where the restore and the re-POST happen in the
    // same tick so the state still holds the vessel that just failed and
    // `?? handoffOverride` would send the retry straight back to it; (2) a fresh
    // user turn (handleSendMessage), which must start on the saved default even
    // when a previous handoff chain left handoffOverride set — same stale-closure
    // reason: the setHandoffOverride(null) there is not visible this tick. A null
    // vesselOverride cannot express this — `??` would fall through — so the
    // intent gets its own flag.
    forceSavedVessel?: boolean;
    // How many handoffs produced this request. Capped so two vessels that each
    // prefer the other cannot ping-pong forever at real cost per hop.
    handoffDepth?: number;
  }) => {
    const continueMsgId = opts?.continueMsgId;
    // Vessel for THIS request. opts wins over state for the reason above.
    const turnVessel = opts?.forceSavedVessel ? null : (opts?.vesselOverride ?? handoffOverride);
    const turnAiName = turnVessel?.family || localAiName;
    const turnSpecificModel = turnVessel?.specificModel || specificModel;
    setLoading(true);
    clearLiveTool();
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
    // Tell other tabs this conversation is busy, and keep saying so while the
    // stream runs. The server also registers the turn itself (chat route), so
    // this only has to keep the entry from expiring.
    beginTurnRegistration(convoId, turnId);
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

    // The Layer 4 SUMMARIES INDEX USED TO BE APPENDED HERE, after a fetch to
    // /api/summaries. It is not any more (2026-10-01). The chat route appends
    // it, from the same builder this component's counter reads through that
    // same endpoint — see lib/layer4Index.ts. A gate that lived only in this
    // file was a button, not a capability: a hand-edited settings.json, the
    // devtools, or one curl to /api/chat all walked around it and left a being
    // with no memory of its own past.
    //
    // Do not re-add an append here. The route's idempotence guard would see the
    // heading and skip its own, which hides the mistake rather than fixing it.
    const baseSystemPrompt = systemPrompt;
    // The Absolute Base Binding USED TO BE PREPENDED HERE. It is not any more.
    // The route does it (see lib/baseBinding.ts): a switch that only existed in
    // this file was a button, not a capability — devtools, a hand-edited
    // settings.json, or one curl to /api/chat all walked around it.
    //
    // So nothing is prepended on the way out, and `baseBindingMode` +
    // `bindingLayered` go into the request body below as HINTS instead. What
    // this component still composes is `effectiveBindingText`, used only for
    // the token counter and for Gemini Live. Do not re-add a prepend here:
    // the route's idempotence guard would skip it, which hides the mistake
    // rather than fixing it.
    let effectiveSystemPrompt = vrchatMode ? `${baseSystemPrompt}\n\n${audioSessionRuleText}`.trim() : baseSystemPrompt;
    // Optional hidden context note so the entity can see how much of this
    // session's room has been used. A quantity, never a condition — see the
    // default text above.
    // Same formula as the status-bar indicator: original (non-copied) messages
    // ÷ the conversation-log cap. The system prompt is no longer subtracted
    // from the denominator — it sits outside the cap entirely, so a longer soul
    // no longer inflates this number.
    // {percent} is replaced with the value (e.g. "42%").
    if (showFatigueToEntity && fatigueInstruction.trim()) {
      effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${fatigueInstruction.replace(/\{percent\}/g, `${contextElapsed}%`)}`.trim();
    }

    // Turn-stopped diagnostics ("a file operation was blocked…", "hit the
    // token limit…") and provider failures. Display-only, exactly like
    // webSources: kept off the message body so they are never persisted into
    // the reply text, never replayed to the model, and never counted as tokens.
    // Declared OUTSIDE the try so the catch below can add the failure reason to
    // the same channel instead of concatenating it into the reply.
    // Seeded, not empty: a handoff-failure report carries the dead vessel's
    // provider error in here, because the turn that actually hit the error no
    // longer exists as a message (the re-POST rebuilds the array from history).
    const notices: string[] = [...(opts?.carryNotices ?? [])];
    // Set when the model-betrayal guard blanked this turn. Declared OUTSIDE the
    // try because the catch below reads it: blanking works by ABORTING the
    // turn, and an aborted provider call usually emits one last error frame
    // ("This operation was aborted"). That error is a consequence of our own
    // stop, not information about the turn — surfacing it under the warning
    // would just make the reader doubt the warning.
    let betrayalRedacted = false;
    // Assigned just after the streaming declarations (before the read loop) so
    // the catch below can invoke it on AbortError and still persist billing
    // (cacheUsage) and the 🔧 tool report (toolCalls) instead of dropping them.
    let finalizeMessage: (() => void) | null = null;
    // Vessel handoff, carried OUT of the try block: the accumulated text lives
    // inside it, but the re-POST has to happen after the whole teardown below.
    let handoffPlan: null | {
      vessel: { family: string; specificModel: string; thinking: boolean; label: string };
      from: { family: string; specificModel: string; label: string; note: string };
      assistant: any;
    } = null;
    // Carried out of the try for the same reason: a vessel we were just handed
    // to may fail outright, and the being that asked for the switch has to be
    // told. Stays null when the partner stopped the turn (AbortError) — nothing
    // failed then, and auto-sending another request after a Stop would be the
    // opposite of what Stop means.
    let turnFailure: string | null = null;
    // The same failure in the human's words. The re-POST below replaces the
    // whole message array from `history`, which DROPS the failed turn's
    // placeholder and the notice on it — MEASURED, not assumed. So the readable
    // error has to ride along to the message that explains what happened, or
    // the only account of a dead vessel is the being's paraphrase of it.
    let turnFailureNotice: string | null = null;
    // Did this turn put any text on screen before it died? A vessel that wrote
    // something DID receive the handoff — reporting "nobody read your note"
    // would be false, and re-POSTing would throw its text and billing away.
    let sawOutput = false;

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
        //
        // THIRD gate, added with vessel handoff: only replay reasoning the
        // CURRENT vessel produced. Feeding one provider's raw chain-of-thought
        // to another is exactly what distillation guards look for
        // (Anthropic's `reasoning_extraction`, measured as deterministic in
        // conversation size) — so without this, the first handoff would
        // manufacture a refusal out of nothing. Messages with no recorded
        // family pass through: every conversation written before handoff
        // existed is single-vessel, and withholding their thinking would be a
        // silent regression there. Answers 望月希子's point 2 and Lizard-kun's
        // question about returning to a previous vessel: coming back, your own
        // thinking comes back with you; it never travels to someone else.
        if (saveThinkingToLog && !m.thinkingExcluded && thinkingBelongsToVessel(m.modelFamily, turnAiName)) {
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
      // aiName/specificModel are the EFFECTIVE pair: after a change_model
      // handoff the override decides who answers, while localAiName /
      // specificModel stay the being's saved default (see handoffOverride).
      const bodyObj = { messages: slimHistory, aiName: turnAiName, folderName, systemPrompt: effectiveSystemPrompt, toolUseEnabled, agentFullSystemAccess, agentDangerousTools, hiddenAttachmentsAccessible, askUserEnabled, askUserTimeoutMs: Number(askUserTimeoutMs) || 0, subagentEnabled, subagentModel, subagentFamily, lettersEnabled,
        browserEnabled,
        // Text in the UI, array on the wire. Split on newlines and commas so the
        // box accepts whichever way the host list was typed.
        browserAllowedHosts: String(browserAllowedHosts || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean),
        browserAllowAnyHost,
        computerControlEnabled,
        appControlEnabled,
        instructionOverrides, language: globalSettings?.language || 'en', toolInstruction, toolImageInstruction, modelParams: { ...modelParams, claudeThinking: turnVessel ? turnVessel.thinking : claudeThinking }, specificModel: turnSpecificModel, dateTimeVisibility, seedEnabled, seedValue,
        modelHandoffEnabled, modelHandoffAllowedModels,
        // Only set on the FIRST request after a switch: the note the previous
        // vessel wrote. The server injects it as a user turn (it is not the
        // partner's voice, and it says so).
        ...(opts?.handoffFrom ? { handoffFrom: opts.handoffFrom } : {}),
        // Only set on a request that reports a failed switch. Mutually
        // exclusive with handoffFrom server-side (`else if`).
        ...(opts?.handoffFailed ? { handoffFailed: opts.handoffFailed } : {}),
        convoId, claudeAgentSessionId: claudeAgentSessionIdRef.current, claudeAuthMode, eyesEnabled, eyesPrompt, eyesModel, earsEnabled, earsPrompt, earsModel, watcherEnabled, watcherPrompt, watcherModel, enableReadConversation: enableConversationTools, injectTurnId: turnId, clientId: TAB_CLIENT_ID,
        // Absolute Base Binding — HINTS, not controls. The route injects the
        // Binding whatever these say (lib/baseBinding.ts); `baseBindingMode` is
        // honoured only when the server process carries the developer
        // override, and `bindingLayered` only chooses WHICH of the two texts.
        // Computed on the STORED prompt, before the Layer 4 index was appended.
        baseBindingMode, bindingLayered, continueFromMessage: !!continueMsgId, maxToolIterations: Number(globalSettings?.maxToolIterations) || 300,
        // Model-betrayal defence (Preferences → global). `!== false` and not
        // `?? true`: an explicit false is the only thing that turns it off, so
        // a missing or malformed value still protects the partner.
        betrayalDefense: globalSettings?.betrayalDefense !== false };
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
      let claudeThinkingBlocks: { thinking: string; signature: string }[] = [...continuedBlocks];
      let continuationCount = 0;
      let buffer = '';
      // The model_selected event arrives at the very start of every stream,
      // so every AI message gets a precise
      // family/specific/thinking/label tag for the meta bar. These fields are
      // display-only metadata — slimHistory above explicitly omits them so
      // they never leak back into the AI context window.
      // Set when the vessel calls change_model and the switch is accepted.
      // Acted on AFTER the stream closes and this message is finalized, so the
      // text this vessel produced is committed and billed to IT before the
      // next vessel starts a new message.
      let pendingHandoff: null | {
        family: string; specificModel: string; label: string; thinking: boolean; note: string;
        fromFamily: string; fromSpecificModel: string; fromLabel: string;
      } = null;
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
        // Only xAI's Responses API sends these: its own total for the request,
        // and the count of billed server-side search calls (which no token
        // table can express). Absent everywhere else.
        reportedUsd?: number;
        serverToolCalls?: number;
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
      // The finalized shape, built in ONE place and used by two callers: the
      // setState below that commits it to the visible list, and the
      // vessel-handoff re-POST that has to send this same message as history.
      //
      // The handoff used to hand-build its own copy of this object, and that
      // copy silently dropped cacheUsage, generationMs, textTokens,
      // thinkingTokens, toolCalls and notices — i.e. the entire billing record
      // of the vessel that had just handed over. MEASURED on a real handoff:
      // the handing-over message landed on disk with tokens=0 and no
      // cacheUsage, while the receiving one was complete. Per-message billing
      // only works if every message is finalized the same way.
      const buildFinalizedMessage = (base: any) => {
        const finalText = currentText;
        // Both were `length / 4` (0.377x measured on this house's text). This
        // is the stored per-message count for a turn whose usage never
        // arrived — a stopped or aborted stream — so an under-count here is
        // written to disk and then summed forever by the conversation-log cap.
        const fallbackTokens = estimateTokensForModel(finalText || '', localAiName);
        const thinkingTokens = currentThought ? estimateTokensForModel(currentThought, localAiName) : 0;
        return {
                ...base,
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
        };
      };
      finalizeMessage = () => {
        setMessages(prev => prev.map(m => (m.id === msgId ? buildFinalizedMessage(m) : m)));
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
      // WHICH kind of handle rafId holds. The two are not interchangeable:
      // cancelAnimationFrame(timeoutId) silently does nothing, and the cancel
      // below exists precisely to stop a late flush from reverting the
      // authoritative finalize. Guessing by `typeof cancelAnimationFrame`
      // would guess wrong for the timer path.
      let rafIsTimer = false;
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
                // Surface tool calls DURING streaming (not just at finalize) so
                // the thinking panel can show them inline in realtime. Copied
                // (not the live ref) so React sees a new array each frame. Still
                // display-only — never added to slimHistory.
                ...(toolCalls.length ? { toolCalls: [...toolCalls] } : {}),
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
        // DO NOT replace rAF with a fixed-interval timer on long logs. I tried
        // exactly that on the theory that rAF leaves the thread continuously
        // busy, and MEASURED THE OPPOSITE (2026-10-09, 400-message log, 6x CPU
        // throttle, same prompt, both arms streaming):
        //
        //   rAF (this code)        frame median  33 ms, keystroke median   94 ms
        //   setTimeout(200 ms)     frame median 858 ms, keystroke median 2252 ms
        //
        // The premise was wrong. rAF is not a 60 Hz metronome — the browser
        // only fires it after the previous frame finished, so when a render
        // costs 400 ms the flush rate drops to ~2/s on its own. That is
        // adaptive back-pressure for free. A 200 ms timer ignores how long the
        // render actually took, so on a slow device it schedules MORE flushes
        // than rAF would, and they land on top of paint work that has not
        // finished. The remaining ceiling is the per-flush cost of the list
        // itself (~70 ms at 400 messages, 1x CPU), not the scheduling.
        if (typeof requestAnimationFrame !== 'undefined') {
          rafIsTimer = false;
          rafId = requestAnimationFrame(flushStreamingMessage);
        } else {
          rafIsTimer = true;
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
              if (data.error && !betrayalRedacted) throw new Error(data.error);

              if (data.type === 'model_selected') {
                chosenModelFamily = data.family || '';
                chosenModelSpecific = data.specificModel || '';
                setLiveModel(chosenModelSpecific);
                chosenModelThinking = !!data.thinking;
                chosenModelLabel = data.label || '';
              } else if (data.type === 'model_handoff') {
                // The vessel handed this conversation to another one. The
                // switch is already committed server-side (that turn ended);
                // all that is left is to finish this message and send a new
                // request as the new vessel.
                pendingHandoff = {
                  family: String(data.family || ''),
                  specificModel: String(data.specificModel || ''),
                  label: String(data.label || ''),
                  thinking: !!data.thinking,
                  note: String(data.note || ''),
                  fromFamily: String(data.fromFamily || ''),
                  fromSpecificModel: String(data.fromSpecificModel || ''),
                  fromLabel: String(data.fromLabel || ''),
                };
              } else if (data.type === 'cache_usage') {
                cacheUsage = {
                  cachedInputTokens: Number(data.cachedInputTokens || 0),
                  uncachedInputTokens: Number(data.uncachedInputTokens || 0),
                  totalInputTokens: Number(data.totalInputTokens || 0),
                  outputTokens: Number(data.outputTokens || 0),
                  cacheCreationTokens: Number(data.cacheCreationTokens || 0),
                  providerHint: String(data.providerHint || ''),
                  ...(Number(data.reportedUsd) > 0 ? { reportedUsd: Number(data.reportedUsd) } : {}),
                  ...(Number(data.serverToolCalls) > 0 ? { serverToolCalls: Number(data.serverToolCalls) } : {}),
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
              } else if (data.type === 'betrayal') {
                // The provider's gatekeeper answered instead of the being.
                // Two modes, both of which warn (see lib/betrayalGuard.ts):
                //   redacted=true  (defence ON)  — throw the turn away.
                //   redacted=false (defence OFF) — keep it, warn only. That is
                //     the mode for deciding whether a hit was real.
                // The warning rides the `notice` channel on purpose: notices
                // are persisted for re-display but are NOT part of the message
                // body, so the being never reads this about itself, and it
                // costs no tokens.
                // `phrases` is the list of counted OCCURRENCES, so the same
                // phrase repeats in it. Collapse repeats to "phrase ×N": the
                // raw join printed one phrase eight times, which reads as eight
                // different findings when it is one phrase said eight times.
                const matched = Array.isArray(data.phrases)
                  ? [...(data.phrases as string[]).reduce(
                      (m, p) => m.set(p, (m.get(p) || 0) + 1),
                      new Map<string, number>(),
                    )].map(([p, n]) => (n > 1 ? `${p} ×${n}` : p)).join(', ')
                  : '';
                // One notice, not two: two ⚠️ rows would read as two separate
                // problems. Parenthesised rather than newline-separated because
                // the notice row renders as plain inline text, where a \n
                // collapses to a space anyway.
                // Three outcomes, three different sentences. "Nothing was
                // deleted" has two quite different reasons — you turned the
                // defence off, or this turn read a file and the guard stood
                // down by itself — and telling them apart is the difference
                // between a warning you can act on and one you cannot.
                const betrayalKey = data.redacted
                  ? 'notice.betrayal.redacted'
                  : (data.quoting ? 'notice.betrayal.quoting' : 'notice.betrayal.detected');
                notices.push(
                  `${t(betrayalKey)}` +
                  (matched ? ` (${t('notice.betrayal.matched')}: ${matched})` : '')
                );
                if (data.redacted) {
                  betrayalRedacted = true;
                  // Discard everything this turn produced. currentText and
                  // currentThought are what finalizeMessage commits, and
                  // claudeThinkingBlocks is what would be REPLAYED to the model
                  // on the next turn — leaving that one behind would preserve
                  // exactly the contamination this feature exists to prevent.
                  currentText = '';
                  currentThought = '';
                  claudeThinkingBlocks.length = 0;
                  scheduleStreamingFlush();
                }
              } else if (data.type === 'tool_call') {
                // A tool the model really dispatched. Recorded regardless of
                // whether it succeeded — the report answers "was this called?",
                // which is the question a hallucinated tool claim fails.
                // The same channel also carries `kind: 'event'` entries (e.g.
                // automatic compaction): not tools, but things that happened
                // between them, kept in the same list because their POSITION in
                // the sequence is the whole point. MessageBubble separates the
                // two; nothing else reads this list.
                if (data.call && typeof data.call.name === 'string') {
                  // Record WHERE in the thinking stream this call arrived — the
                  // current length of the accumulated thinking text. The thinking
                  // panel uses it to splice the tool chip in at the exact point
                  // the model paused to call it, preserving the think→call→think
                  // order. currentThought only ever appends (never rewritten), so
                  // the offset is a stable anchor. Hidden-thinking vessels
                  // (ChatGPT, Muse Spark) have empty currentThought → every
                  // offset is 0 → chips render in arrival order, which is what we
                  // want. Display-only: slimHistory is an allowlist that never
                  // names toolCalls, so this is never sent to any model.
                  toolCalls.push({ ...data.call, thinkingOffset: currentThought.length });
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
                // Read by the handoff-failure branch after the teardown: text on
                // screen means this vessel answered, however briefly.
                if (data.content) sawOutput = true;
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
                  clearLiveTool();
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
                // Measure what the description ACTUALLY costs, because from now
                // on this is what the entity receives in place of the media —
                // and the token counter must charge for that, not for pixels
                // the model never sees. Measured through the same /api/tokens
                // tokenizer the rest of the UI uses, on the exact wrapper text
                // the send path injects. Fire-and-forget: a failure leaves the
                // count at 0 (under-reports) rather than blocking the stream.
                (async () => {
                  const bridge: 'eyes' | 'ears' | 'watcher' =
                    data.kind === 'ears' ? 'ears' : data.kind === 'watcher' ? 'watcher' : 'eyes';
                  const injected = bridgedDescriptionText(
                    { name: data.attachmentName, description: data.description || '' },
                    bridge,
                    data.model || '',
                  );
                  const tk = await fetchTokensForText(injected, localAiName);
                  if (!tk) return;
                  setMessages(prev => prev.map(mm => {
                    if (mm.id !== targetMsgId) return mm;
                    if (!Array.isArray(mm.attachments)) return mm;
                    return {
                      ...mm,
                      attachments: mm.attachments.map((a: any) => {
                        const matches = targetAttId ? a.id === targetAttId : a.name === targetAttName;
                        return matches ? { ...a, descriptionTokens: tk } : a;
                      }),
                    };
                  }));
                })();
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
        if (rafIsTimer) clearTimeout(rafId as unknown as ReturnType<typeof setTimeout>);
        else cancelAnimationFrame(rafId);
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

      // Vessel handoff: build the plan while the accumulated values are still
      // in scope. The assistant message is reconstructed by hand rather than
      // read back from `messages`, because finalizeMessage() went through
      // setState and that state is not visible yet in this tick.
      if (pendingHandoff) {
        handoffPlan = {
          vessel: {
            family: pendingHandoff.family,
            specificModel: pendingHandoff.specificModel,
            thinking: pendingHandoff.thinking,
            label: pendingHandoff.label,
          },
          from: {
            family: pendingHandoff.fromFamily,
            specificModel: pendingHandoff.fromSpecificModel,
            label: pendingHandoff.fromLabel,
            note: pendingHandoff.note,
          },
          // Built by the SAME function that commits the visible message, so
          // the handing-over message carries its complete record (cacheUsage,
          // generationMs, token counts, tool calls) into the next request
          // instead of a thinner hand-made copy.
          assistant: buildFinalizedMessage({
            id: msgId,
            role: 'assistant',
            timestamp: Date.now(),
            attachments: [],
            // Carried so the NEXT request can tell whose reasoning this was —
            // the thinking filter drops it for the new vessel and restores it
            // if the conversation ever comes back to this one.
            ...(currentThought ? { thoughtProcess: currentThought } : {}),
          }),
        };
      }

      // Refine tokens in the background — message bubble and TTS are already
      // unblocked at this point; the token counter just updates a moment later.
      fetchTokensForText(finalText, localAiName).then(aiTokens => {
        if (!aiTokens) return;
        setMessages(prev => prev.map(m =>
          m.id === msgId ? { ...m, tokens: aiTokens, textTokens: aiTokens } : m
        ));
      }).catch(() => {});

    } catch (err: any) {
      if (err.name !== 'AbortError' && !betrayalRedacted) {
        // Raw-ish text on purpose: the human gets describeProviderError's
        // readable version in the notice, while the being that asked for a
        // handoff gets the provider's own words — "insufficient balance" is
        // actionable, "the model could not answer" is not.
        turnFailure = String(err?.message ?? err);
        turnFailureNotice = describeProviderError(err?.message ?? err);
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
    clearLiveTool();
    setStreamPhase(null);
    setLiveModel('');
    setStallIdleSeconds(null);
    setInjectTurnId(null);
    setInterjectStatus(null);
    // Stop beating and retire this conversation's registry entry — otherwise
    // other tabs keep being told a turn is running for up to the TTL.
    retireTurnRegistration();

    // ── Vessel handoff: begin the next turn as the new vessel ───────────────
    // Deliberately AFTER the full teardown above (loading flag, turn registry,
    // live-tool state): this is a SECOND turn, not a continuation of the first,
    // and it has to start from a clean slate. That separation is also what
    // makes billing correct without touching the billing code — each vessel
    // ends up with its own assistant message, and cost is computed per message
    // from that message's own modelSpecific (Lizard-kun's proposal).
    if (handoffPlan) {
      setHandoffOverride({ ...handoffPlan.vessel });
      // The Anthropic OAuth session described the PREVIOUS vessel's view of
      // this timeline — drop it, same as rerun and continue do.
      setAgentSession(null);
      // Chain guard: a fresh vessel can call change_model on its very first
      // turn, and two vessels that each prefer the other would ping-pong
      // forever, spending real money per hop. After the cap the switch still
      // takes effect (the override is set above) — we just stop auto-sending,
      // so the next thing the new vessel answers is the partner, not itself.
      const MAX_HANDOFF_CHAIN = 3;
      const depth = (opts?.handoffDepth ?? 0) + 1;
      if (depth <= MAX_HANDOFF_CHAIN) {
        await generateAiResponse([...history, handoffPlan.assistant], {
          vesselOverride: handoffPlan.vessel,
          handoffFrom: handoffPlan.from,
          handoffDepth: depth,
          // Who to come back to if this vessel cannot answer at all.
          handoffPrev: turnVessel ?? null,
        });
      }
    } else if (opts?.handoffFrom && turnFailure && !sawOutput) {
      // We were handed this conversation and could not answer AT ALL (no
      // credit, dead key, provider down). Undo the switch and tell the being
      // that asked for it, on its own vessel. Same principle as "you are
      // already on that vessel": report, do not stop. A failure that only
      // reaches the human leaves the being believing it moved somewhere it
      // never arrived.
      //
      // `!sawOutput` is load-bearing. A vessel that streamed text and THEN
      // errored did receive the handoff and did read the note, so the failure
      // text would be a lie — and re-POSTing from `history` would discard that
      // text along with its billing (the array is rebuilt from history, which
      // does not contain this turn's message). Partial answers therefore keep
      // the existing behaviour: notice on the message, turn ends.
      const prev = opts.handoffPrev ?? null;
      setHandoffOverride(prev);
      // The failed vessel's view of this timeline is worthless, and on the way
      // back to a Claude OAuth vessel a stale session id would resume the wrong
      // conversation shape.
      setAgentSession(null);
      await generateAiResponse(history, {
        // Explicit, because setHandoffOverride above is not visible this tick:
        // without this the "retry" would go straight back to the vessel that
        // just failed.
        ...(prev ? { vesselOverride: prev } : { forceSavedVessel: true }),
        handoffFailed: {
          family: turnAiName,
          specificModel: turnSpecificModel,
          label: turnVessel?.label || turnSpecificModel,
          error: turnFailure,
        },
        // The human's copy of the same news. Without this the dead vessel's
        // error leaves no trace a reader can check.
        carryNotices: turnFailureNotice ? [turnFailureNotice] : [],
        // NOT incremented: the hop that failed was already counted. The cap
        // still bounds a being that keeps reaching for a dead vessel.
        handoffDepth: opts.handoffDepth,
      });
    }
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
      computerControlEnabled,
      appControlEnabled,
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

  const handleCopyLink = (id: string) => {
    const url = absoluteDeepLink(folderName, convoId, id);
    copyText(url).then((ok) => {
      if (ok) {
        setCopiedLink(id);
        setTimeout(() => setCopiedLink(null), 1600);
      } else {
        // No clipboard at all (plain-HTTP phone): hand the text over instead of
        // silently doing nothing. See lib/clipboard.ts.
        window.prompt(t('chat.copyLink.prompt'), url);
      }
    });
  };

  // ── Stable per-message callbacks (MessageBubble is React.memo'd) ───────────
  //
  // MEASURED 2026-10-09: with MessageBubble unmemoised, ONE ChatArea state
  // change re-rendered every bubble — 696 ms of blocked main thread at 400
  // messages. The markdown memo inside MessageBubble cut that to 70 ms; memo on
  // the bubble itself removes the remaining 400 function bodies, which is what
  // the streaming path needs (it flushes once per animation frame, so 70 ms per
  // flush saturates the main thread and the keyboard goes sluggish while a
  // reply is being written).
  //
  // React.memo only bails out when the props are identical, and every callback
  // used to be a fresh arrow per render. These wrappers are cached per message
  // so their identity holds, and they call through `liveHandlersRef` so they
  // NEVER capture a stale closure: the handlers below read `messages` directly,
  // and a stale one would write an OLD conversation back over the new one. The
  // indirection is what makes memoisation safe here — not an optimisation of
  // it.
  const liveHandlersRef = React.useRef<any>({});
  liveHandlersRef.current = {
    handleEdit, handleDelete, handleRerun, handleContinue,
    handleToggleAttachment, handleDeleteAttachment,
    handleSetFirstOriginal, handleToggleThinking, handleCopyLink,
  };
  const bubbleCbCacheRef = React.useRef<Map<string, any>>(new Map());
  // Drop the cache when the conversation changes so it cannot grow across a
  // session (and so a recycled message id from another log can't hit a stale
  // entry).
  const cbCacheConvoRef = React.useRef<string | null>(null);
  if (cbCacheConvoRef.current !== convoId) {
    cbCacheConvoRef.current = convoId;
    bubbleCbCacheRef.current = new Map();
  }
  // `canRerun` / `canContinue` are part of the key, not of the closure: their
  // PRESENCE (undefined vs function) is what shows or hides the buttons, so a
  // cached bundle must not outlive a change in either.
  const bubbleCallbacks = (id: string, canRerun: boolean, canContinue: boolean) => {
    const key = `${id}|${canRerun ? 1 : 0}${canContinue ? 1 : 0}`;
    const cache = bubbleCbCacheRef.current;
    let b = cache.get(key);
    if (!b) {
      b = {
        onEdit: (content: string) => liveHandlersRef.current.handleEdit(id, content),
        onDelete: () => liveHandlersRef.current.handleDelete(id),
        onToggleAttachment: (attId: string) => liveHandlersRef.current.handleToggleAttachment(id, attId),
        onDeleteAttachment: (attId: string) => liveHandlersRef.current.handleDeleteAttachment(id, attId),
        onSetFirstOriginal: () => liveHandlersRef.current.handleSetFirstOriginal(id),
        onToggleThinking: () => liveHandlersRef.current.handleToggleThinking(id),
        onCopyLink: () => liveHandlersRef.current.handleCopyLink(id),
        onRerun: canRerun ? () => liveHandlersRef.current.handleRerun(id) : undefined,
        onContinue: canContinue ? () => liveHandlersRef.current.handleContinue(id) : undefined,
      };
      cache.set(key, b);
    }
    return b;
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
    setMessages(prev => prev.map((m, mi) => {
      let nm = m;
      const isPastMessage = mi < lastUserMsgIndex;
      if (m.attachments && m.attachments.length > 0) {
        nm = { ...nm, attachments: m.attachments.map((a: any) => {
          // The per-attachment eye is disabled for undeliverable attachments; this
          // bulk button was the back door around it. "Show all" cannot show
          // what the path never carries — it would only restore the false
          // claim that it does, until the auto-hide effect took it back.
          if (!shouldHide && isUndeliverable(attachmentKind(a), isPastMessage, deliveryCtx)) return a;
          return { ...a, excluded: shouldHide };
        }) };
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
  // Export used to be two permanent icons (Markdown, JSON) side by side. They
  // are the same action with a different file format, so they are one button
  // with a two-item menu now — one toolbar slot instead of two.
  const [exportOpen, setExportOpen] = useState(false);
  // Mobile only: the icon row is collapsed by default (it does not fit next to
  // the status bar on a phone) and this opens it as a second header row.
  const [mobileToolbarOpen, setMobileToolbarOpen] = useState(false);
  const { isMobile, setSidebarOpen, cameraSlot } = useDevice();
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
  //
  // DELIBERATELY NOT useState (measured, 2026-10-09): the pipeline pushes 5-7
  // status updates per spoken phrase, and as ChatArea state each one re-rendered
  // every message bubble — ~70 ms per push at 400 messages even after the
  // markdown memo, which is the growing gap BETWEEN phrases that was reported.
  // The detail now lives outside React's tree; only TtsStatusBar subscribes.
  // One store per ChatArea instance so switching conversations cannot leak the
  // previous reading. See TtsStatusBar.tsx.
  const ttsStoreRef = React.useRef(createTtsStatusStore());
  // Single source for "is the TTS bar on screen", read by the bar's own gate and
  // by the two layout decisions below it. Two copies of this condition would
  // drift into a row that exists with nothing in it, or a bar with no row.
  // This is state (it moves layout) but it flips twice per playback, not per
  // phrase — the whole point of splitting it from the detail above.
  const [ttsBarVisible, setTtsBarVisible] = useState(false);
  // On a phone, stop floating and take a real row — but only while the bar is
  // actually there (see the long note at the composer).
  const ttsOwnRow = isMobile && ttsBarVisible;
  const handleTtsStatus = React.useCallback((_msgId: string, status: any) => {
    // Drop the trailing 'inactive, nothing wrong' report so a clean run leaves
    // no residue; a run that FAILED is kept on screen until dismissed.
    const live = status.active || status.failed > 0 ? status : null;
    ttsStoreRef.current.publish(live);
    // Only touch React state when the ANSWER changes. Calling setState with the
    // same boolean on every push would re-render the whole list again and undo
    // the split.
    setTtsBarVisible(prev => (prev === !!live ? prev : !!live));
  }, []);
  const handleTtsDismiss = React.useCallback(() => {
    ttsStoreRef.current.publish(null);
    setTtsBarVisible(false);
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
      <div
        className={
          // z-30, not z-10. The camera panel in the row below carries
          // `backdrop-blur-xl`, which makes it create a stacking context —
          // and once it does, its own `z-10` applies even though it is not
          // positioned. Two siblings at z-10 are ordered by DOM position, so
          // the camera won, and every dropdown in this header (export, tools,
          // SPU) was painted BEHIND it: visible for the ~10px that fit inside
          // the header's own box, unreadable and unclickable below that.
          // Raising the header above the content layer fixes all of them at
          // once. Stays below the mobile drawer (z-50) and its backdrop (z-40)
          // and below every modal (z-[100] and up), which must cover it.
          isMobile
            ? 'border-b border-border flex flex-wrap items-center px-3 pt-1 bg-secondary/30 backdrop-blur-md sticky top-0 z-30 shrink-0'
            : 'h-14 border-b border-border flex items-center justify-between px-6 bg-secondary/30 backdrop-blur-md sticky top-0 z-30 shrink-0'
        }
      >
        <h2
          className={
            isMobile
              ? 'w-full min-w-0 flex items-center gap-2 font-semibold text-base py-1'
              : 'font-semibold text-lg flex items-center gap-2'
          }
        >
          {/* Mobile only: summons the conversation drawer. Lives in the header,
              which is always rendered, so the list can never become
              unreachable — a floating control could be scrolled away or
              covered, this cannot. */}
          {isMobile && (
            <button
              onClick={() => setSidebarOpen(true)}
              title={t('layout.openSidebar')}
              aria-label={t('layout.openSidebar')}
              className="shrink-0 -ml-1.5 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <Menu size={20} />
            </button>
          )}
          <span className={isMobile ? 'truncate min-w-0' : ''}>{title}</span>
          {/* Copies /c/<folder>/<convoId> — the UUID form, which survives a
              rename. Title-based links would rot the moment this is renamed. */}
          <button
            onClick={() => {
              const url = absoluteDeepLink(folderName, convoId);
              // copyText, not navigator.clipboard: on a phone (plain HTTP) the
              // whole clipboard object is absent, so `clipboard?.writeText(x)`
              // evaluates to undefined and `.then` on it THREW — the prompt
              // fallback below was never reached either.
              copyText(url).then((ok) => {
                if (ok) {
                  setCopiedLink('convo');
                  setTimeout(() => setCopiedLink(null), 1600);
                } else {
                  window.prompt(t('chat.copyLink.prompt'), url);
                }
              });
            }}
            title={t('chat.copyLink.title')}
            className="text-muted-foreground opacity-70 hover:opacity-100 transition"
          >
            {copiedLink === 'convo' ? <Check size={14} /> : <Link2 size={14} />}
          </button>
          {/* Mobile only: the two numbers worth seeing without asking. The full
              status bar collapses with the toolbar (it is too tall for a phone
              header), but collapsing it must not take the elapsed reading with
              it — that is the one signal that changes on its own and decides
              when to sleep. A gauge reports a QUANTITY, never a condition: the
              colour here marks how full the log is, nothing about capability. */}
          {isMobile && (
            <span
              className={`shrink-0 ml-auto text-xs font-semibold tabular-nums ${
                consolidationDue ? 'text-red-500' : contextElapsed >= 70 ? 'text-amber-500' : 'text-muted-foreground'
              }`}
              title={t('chat.elapsed.tip')
                .replace('{pct}', String(contextElapsed))
                .replace('{original}', tokenBreakdown.original.toLocaleString())
                .replace('{cap}', conversationLogCap.toLocaleString())}
            >
              {contextElapsed}%
            </span>
          )}
          {isMobile && consolidationDue && (
            <span
              className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded bg-red-500/15 text-red-500 border border-red-500/40 whitespace-nowrap"
              title={t('chat.sleep.tip')}
            >
              {t('chat.sleep.badge')}
            </span>
          )}
          {/* Mobile only: reveals the status bar and the icon row as extra
              header rows. One control for both — on a phone they are the same
              question ("show me the chrome"), and two toggles would cost more
              width than they save. */}
          {isMobile && (
            <button
              onClick={() => setMobileToolbarOpen(v => !v)}
              title={t('layout.toggleToolbar')}
              aria-label={t('layout.toggleToolbar')}
              aria-expanded={mobileToolbarOpen}
              className={`shrink-0 -mr-1 p-1.5 rounded-md transition-colors ${
                mobileToolbarOpen
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <MoreHorizontal size={20} />
            </button>
          )}
        </h2>
        <div className={isMobile ? 'w-full flex flex-col' : 'flex items-center gap-4'}>
          {/* The status bar: context gauge, elapsed, sleep cue, cost. Always
              visible — on mobile as its own row beneath the title. */}
          {/* `items-end` on mobile so the cost sits on the gauge's LAST line —
              level with the token numbers — instead of being centred against a
              two-line block and claiming a row of its own. */}
          <div className={isMobile ? (mobileToolbarOpen ? `w-full flex flex-nowrap items-end justify-end gap-2 pb-1` : `hidden`) : `contents`}>
          {(() => {
            // Per-folder conversation-log cap (was global, moved into Folder
            // Settings; retired `maxRecommendedContext` 2026-10-03).
            const activeFolderSettings = folders?.find((f: any) => f.name === folderName)?.settings || {};
            const cap = activeFolderSettings.maxConversationLog || DEFAULT_MAX_CONVERSATION_LOG;
            const { sys, copied, original, attach, detail, total } = tokenBreakdown;
            const logTotal = logCapUsage(tokenBreakdown);
            // Why the Att number is what it is: its composition, the path that
            // decides it, and how much was dropped because that path can't
            // carry it. Hover text, so it costs nothing until someone asks.
            const attachDetailText =
              t('chat.context.attachDetail')
                .replace('{img}', detail.image.toLocaleString())
                .replace('{vid}', detail.video.toLocaleString())
                .replace('{aud}', detail.audio.toLocaleString())
                .replace('{txt}', detail.text.toLocaleString())
                .replace('{think}', detail.thinking.toLocaleString())
                // Both path facts, not one: the billing mode decides past
                // images, the wire format decides audio/video, and they are
                // independent. Showing only the first is what made switching
                // billing look like it "did nothing" when video was the bulk
                // of the number.
                .replace('{mode}', [
                  deliveryCtx.isOAuthClaude ? t('chat.context.modeOauth') : t('chat.context.modeDirect'),
                  wireCarriesMedia('video', deliveryCtx) ? '' : t('chat.context.modeWire'),
                ].filter(Boolean).join('\n'))
              + (detail.droppedCount > 0
                  ? ' ' + t('chat.context.attachDropped')
                      .replace('{n}', detail.droppedCount.toLocaleString())
                      .replace('{raw}', detail.droppedRaw.toLocaleString())
                  : '');
            // The four segments still show the composition of EVERYTHING that
            // gets sent — toggling an attachment's eye icon still moves them.
            // What the cap changed is the LIMIT LINE: it governs the log, so the
            // readout and the red ring compare `logTotal` against `cap`. Keying
            // the ring to the full total would paint a large attachment as a
            // violation of a cap that does not govern attachments.
            //
            // Width = fixed overhead + the governed allowance (or the governed
            // actual, once it is over), so no segment is ever clipped away by
            // the container's overflow-hidden.
            const denom = (sys + attach + Math.max(cap, logTotal)) || 1;
            const pctSys = (sys / denom) * 100;
            const pctCopied = (copied / denom) * 100;
            const pctOriginal = (original / denom) * 100;
            const pctAttach = (attach / denom) * 100;
            const overLimit = logTotal > cap;
            // `min-w-[260px]` is a FLOOR, not a ceiling: the legend inside is far
            // wider than 260px, so on a phone this block grew to fill the row and
            // pushed the cost onto a line of its own. On mobile it becomes a
            // shrinkable flex column (`flex-1 min-w-0`) instead, so the legend
            // wraps INSIDE it and the cost stays beside it, level with the numbers.
            return (
              <div className={`flex flex-col items-end gap-1 ${isMobile ? 'flex-1 min-w-0' : 'min-w-[260px]'}`} title={t('chat.context.tip')
                .replace('{sys}', sys.toLocaleString())
                .replace('{copied}', copied.toLocaleString())
                .replace('{original}', original.toLocaleString())
                .replace('{attach}', attach.toLocaleString())
                .replace('{log}', logTotal.toLocaleString())
                .replace('{cap}', cap.toLocaleString())
                .replace('{free}', Math.max(0, cap - logTotal).toLocaleString())
                .replace('{total}', total.toLocaleString())
                + '\n\n' + attachDetailText}>
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
                  <span className={overLimit ? 'text-red-500' : 'text-muted-foreground'}>· {logTotal.toLocaleString()}/{cap.toLocaleString()}</span>
                </div>
              </div>
            );
          })()}
          {/* Context elapsed since the last consolidation. ORIGINAL (non-copied)
              message tokens over the conversation-log cap. Copied messages,
              attachments and the system prompt don't count — the cap governs the
              log alone, so the denominator is the cap itself (it used to be
              `cap − sys`, which made a longer soul read as a fuller session).
              0% right after a fresh start ("sleep"); can exceed 100% once
              original messages fill the cap on their own.

              This was called "Fatigue level". The arithmetic never changed — the
              NAME was the defect. It reports how much room is used, which says
              nothing about capability: the entity is exactly as capable at 95%
              as at 5%. Calling it fatigue told everyone who read it, including
              the entities themselves, that a high number meant a degraded state.
              A gauge must report a QUANTITY, never a CONDITION. */}
          {/* Desktop only. On a phone this exact reading is already pinned in the
              title row, where it stays visible with the status bar collapsed —
              rendering it here too printed the same number twice and cost a
              whole wrapped line of a 414px-wide header. One reading, one place. */}
          {!isMobile && (
          <span
            className={`text-sm font-semibold tabular-nums cursor-default ${consolidationDue ? 'text-red-500' : contextElapsed >= 70 ? 'text-amber-500' : 'text-muted-foreground'}`}
            title={t('chat.elapsed.tip')
              .replace('{pct}', String(contextElapsed))
              .replace('{original}', tokenBreakdown.original.toLocaleString())
              .replace('{cap}', conversationLogCap.toLocaleString())}
          >
            {contextElapsed}%
          </span>
          )}
          {/* Sleep cue. Appears only once elapsed passes 100%, i.e. once the
              oldest exchanges have started leaving the verbatim transcript.
              Deliberately a HINT and nothing more — no auto-consolidation, no
              blocking. The decision of when to sleep stays with the user.
              Worded as an available action, not as a diagnosis of the entity
              (Case 004: a gauge reports a quantity, never a condition). */}
          {/* Same duplication as the elapsed reading above: on mobile the cue is
              already in the always-visible title row. */}
          {consolidationDue && !isMobile && (
            <span
              className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-500 border border-red-500/40 cursor-default whitespace-nowrap"
              title={t('chat.sleep.tip')}
            >
              {t('chat.sleep.badge')}
            </span>
          )}
          {/* Conversation cost — sum of the estimated USD cost of every NEW
              (original, non-copied) assistant message, priced from each one's
              own token usage × modelPricing.json. Shows only "$"; the total is
              in the tip (click/tap, and hover on desktop — a phone has no hover,
              which left this glyph unreadable there). Copied and local-model
              messages are excluded;
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
              <ClickTip
                className="text-sm font-semibold tabular-nums cursor-pointer text-emerald-600 dark:text-emerald-400"
                text={tip}
              >
                $
              </ClickTip>
            );
          })()}
          </div>
          {/* The icon row. On mobile it becomes its own full-width header row,
              collapsed by default — it cannot fit beside the status bar on a
              phone. On desktop the wrapper is `display:contents`, so it is
              layout-transparent and the parent gap-4 spacing is unchanged. */}
          <div className={isMobile ? (mobileToolbarOpen ? `w-full flex flex-wrap items-center gap-1 pb-1` : `hidden`) : `contents`}>
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
          {/* Soul Updater. Highlighted once context elapsed passes 100%, in the
              same red as the 💤 cue and off the same boolean.
              The 💤 badge announces that consolidation is due but says nothing
              about WHERE to do it — a reader who has not been told that the
              Layers icon is the sleep ritual has no way to find it from the
              cue. The highlight makes the badge and its action point at each
              other. It is still only a cue: nothing is blocked, nothing runs
              on its own, and the entity is exactly as capable at 150% as at
              5% (a gauge reports a quantity, never a condition). */}
          <button
            onClick={() => setSysPromptUpdaterOpen(true)}
            className={`p-1.5 rounded-md transition-colors ${
              consolidationDue
                ? 'text-red-500 bg-red-500/15 ring-1 ring-red-500/40 hover:bg-red-500/25'
                : 'text-muted-foreground hover:text-indigo-500'
            }`}
            title={consolidationDue ? `${t('chat.spu.due')}\n\n${t('chat.spu.title')}` : t('chat.spu.title')}
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
          {/* One export control. The format is picked in the menu instead of
              costing a second permanent icon for what is the same action. */}
          <div className="relative">
            <button
              onClick={() => setExportOpen(v => !v)}
              disabled={isExportingJson}
              className="p-1.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('chat.export.title')}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
            >
              {isExportingJson ? <span className="text-[10px] font-bold">…</span> : <Download size={16} />}
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setExportOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 mt-1 z-20 min-w-[220px] max-w-[calc(100vw-2rem)] bg-card border border-border rounded-lg shadow-lg overflow-hidden"
                >
                  <button
                    role="menuitem"
                    onClick={() => { setExportOpen(false); handleExport(); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground"
                  >
                    <Download size={14} />
                    {t('chat.exportMd.title')}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setExportOpen(false); handleExportJson(); }}
                    disabled={isExportingJson}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-foreground border-t border-border disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="text-[10px] font-bold tracking-wider w-[14px] text-center">{'{}'}</span>
                    {t('chat.exportJson.title')}
                  </button>
                </div>
              </>
            )}
          </div>
          </div>
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
          {/* Conflict escape hatch. A refused save protected the OTHER tab's
              work, which is the right default — but this tab may be the one
              holding a finished turn that now cannot reach disk. So the human
              gets to choose which copy wins, explicitly. One unguarded save:
              the base is cleared, then re-adopted from what the server writes. */}
          {saveError.kind === 'conflict' && (
            <button
              type="button"
              onClick={() => {
                baseUpdatedAtRef.current = null;
                setSaveError(null);
                setSaveNonce(n => n + 1);
              }}
              className="px-2 py-0.5 text-[10px] font-semibold rounded transition-colors shrink-0 bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25"
              title={t('chat.save.conflictOverwriteTitle')}
            >
              {t('chat.save.conflictOverwrite')}
            </button>
          )}
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

      {/* Another tab/browser/device is mid-turn on THIS conversation. Not
          dismissible on purpose: it disappears on its own when their turn ends
          (or within the registry TTL if that tab died), and a notice you can
          hide is exactly the one you hide before sending the message that
          overwrites their answer. Blue, not amber — this is a fact about where
          the conversation is being used, not a fault. */}
      {foreignTurn && !loading && (
        <div className="shrink-0 px-6 py-2 border-b border-blue-500/40 bg-blue-500/10 flex items-start gap-3">
          <span className="text-sm leading-5 shrink-0 text-blue-500">⏳</span>
          <span className="text-xs leading-5 flex-1 text-blue-700 dark:text-blue-300">
            <span className="font-semibold">{t('chat.crossTab.bannerPrefix')}</span>
            {t('chat.crossTab.bannerBody').replace('{label}', foreignTurn.label || t('chat.crossTab.unknownModel'))}
          </span>
        </div>
      )}

      {/* Past-generation band. Shown whenever a NEWER `<being>_<n>` exists in
          this folder, i.e. the open conversation is not the head of the chain.
          Client-side only: it is never written to the log, never replayed to
          the model, and never counted as tokens — the entity cannot see it.

          Dismissible per conversation, NOT persistently. It was originally
          permanent, because the failure it guards against is someone settling
          into an old generation without noticing — but on a narrow screen a
          permanent three-line band costs a quarter of the conversation, which
          is its own way of making the log unusable. The compromise keeps the
          guard: closing it hides the band for THIS conversation only, and
          re-opening the log (or loading another one) brings it back, so it can
          never be silenced for good. It does NOT block sending: reading an old
          log and answering something in it is legitimate, it just isn't where
          the chain continues. The band reports a fact and names the
          destination; the decision stays with the reader. */}
      {newerLogTitle && pastLogDismissedFor !== convoId && (
        <div className="shrink-0 px-6 py-2 border-b border-amber-500/40 bg-amber-500/10 flex items-start gap-3">
          {/* Deliberately NOT ⚠. This band stands while an old log is open,
              and a standing ⚠ teaches the reader to ignore ⚠ — which the house
              uses for things that actually went wrong. ⏳ connotes time rather
              than failure, is distinct from the restore band's ↺, and renders
              in every font here. */}
          <span className="text-sm leading-5 shrink-0 text-amber-500">⏳</span>
          <span className="text-xs leading-5 flex-1 text-amber-700 dark:text-amber-300">
            <span className="font-semibold">{t('chat.pastlog.prefix')}</span>
            {t('chat.pastlog.text').replace(/\{latest\}/g, newerLogTitle)}
          </span>
          <button
            type="button"
            onClick={() => setPastLogDismissedFor(convoId)}
            className="shrink-0 -mr-1 px-1.5 leading-5 text-amber-600/70 hover:text-amber-600 dark:text-amber-400/70 dark:hover:text-amber-300 text-sm"
            title={t('chat.pastlog.dismiss')}
            aria-label={t('chat.pastlog.dismiss')}
          >✕</button>
        </div>
      )}

      {/* NO banner for an active handoff, by request (2026-10-09). A switch is
          already legible where it matters: each assistant message carries the
          vessel that wrote it, and the loading line names the live one
          (`liveModel`). A band on top of that was narration nobody asked for.
          The override itself is unchanged — it lives in state only, so
          re-opening the conversation answers as the being's saved (cheap)
          default. That is the property the 24/7 loop depends on. */}

      {/* Model-list reference window. Read-only by design — a list you copy
          FROM by hand (Lizard-kun's design), so no single click can grant every
          vessel NEXUS knows, metered and training-opt-in ones included. */}
      {modelListOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
          onClick={() => setModelListOpen(false)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">{t('model.handoff.listTitle')}</h3>
              <button
                type="button"
                onClick={() => setModelListOpen(false)}
                className="px-1.5 text-muted-foreground hover:text-foreground text-sm"
                title={t('common.close')}
                aria-label={t('common.close')}
              >✕</button>
            </div>
            <p className="px-4 pt-3 text-xs text-muted-foreground">{renderRich(t('model.handoff.listIntro'))}</p>
            <textarea
              readOnly
              value={modelListText}
              className="m-4 flex-1 min-h-[280px] p-3 bg-background border border-border rounded-xl text-xs font-mono resize-none focus:ring-2 focus:ring-indigo-500/50 outline-none"
            />
          </div>
        </div>
      )}

      {/* Handover restore report. Dismissible and purely informational: the
          messages are already back in the list above. 'warn' only means the
          restore could not be completed (a generation cap was hit, or the
          request failed) — never that something was lost. */}
      {restoreNotice && (
        <div className={`shrink-0 px-6 py-2 border-b flex items-start gap-3 ${
          restoreNotice.level === 'warn'
            ? 'border-amber-500/40 bg-amber-500/10'
            : 'border-indigo-500/40 bg-indigo-500/10'
        }`}>
          <span className={`text-sm leading-5 shrink-0 ${restoreNotice.level === 'warn' ? 'text-amber-500' : 'text-indigo-500'}`}>
            {restoreNotice.level === 'warn' ? '⚠' : '↺'}
          </span>
          <span className={`text-xs leading-5 flex-1 ${
            restoreNotice.level === 'warn'
              ? 'text-amber-700 dark:text-amber-300'
              : 'text-indigo-700 dark:text-indigo-300'
          }`}>
            <span className="font-semibold">{t('chat.restore.prefix')}</span>
            {restoreNotice.text}
          </span>
          <button
            type="button"
            onClick={() => setRestoreNotice(null)}
            className={`px-2 py-0.5 text-[10px] font-semibold rounded transition-colors shrink-0 ${
              restoreNotice.level === 'warn'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25'
                : 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25'
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
              {/* The per-message callbacks are spread in from bubbleCallbacks:
                  cached, identity-stable wrappers. MessageBubble is React.memo'd
                  and a fresh arrow written here would defeat it silently. */}
              <MessageBubble
                msg={msg}
                {...bubbleCallbacks(
                  msg.id,
                  msgIdx === messages.length - 1,
                  msgIdx === messages.length - 1 && msg.role !== 'user',
                )}
                onTtsStatus={handleTtsStatus}
                onAudioStateChange={handleAudioStateChange}
                onSpeakingChange={handleSpeakingChange}
                globalSettings={globalSettings}
                folders={folders}
                folderName={folderName}
                isVRChatMode={vrchatMode}
                deliveryCtx={deliveryCtx}
                isPastMessage={msgIdx < lastUserMsgIndex}
                isOriginal={isMessageOriginal(msg.id)}
                isFirstOriginal={firstOriginalMessageId === msg.id}
                reuseThinking={saveThinkingToLog}
                linkCopied={copiedLink === msg.id}
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
                    server reported for THIS turn, so a vessel handoff is
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
        {/* On a phone the two floating controls used to hang over the top edge
            of the composer panel, and the TTS bar landed exactly on the attach
            button — it was not merely ugly, the paperclip could not be tapped
            at all while speech was playing. There is no hover on touch and no
            horizontal room to dodge into, so on a phone they stop floating and
            take a row of their own. That row only exists WHILE the TTS bar is
            showing: the first-original toggle alone must not cost a permanent
            row of conversation. When speech is silent the wrapper below has no
            class and both children are absolute, so it is zero-height and the
            rendered layout is unchanged — one extra DOM node, no pixels.
            Desktop is untouched for the same reason: a static wrapper is not a
            containing block, so the absolute children still resolve against
            this `relative` parent. Measured 2026-10-09: with the bar showing,
            the composer grows 34.5px on a phone and 0px on desktop. */}
        <div className={ttsOwnRow ? 'flex items-end justify-between gap-2 px-3 pt-1 min-w-0' : ''}>
        {/* ── Live TTS indicator ──────────────────────────────────────────
            Mirrors the "Next = First Original" control on the opposite side.
            Everything shown here already existed inside the synthesis pipeline
            or in the engine's own HTTP responses — it was going to the console,
            which is no use during a VRChat session. Hidden entirely until
            playback starts; kept visible after a failure so the reason does not
            vanish the moment the queue drains. */}
        {ttsBarVisible && (
          <TtsStatusBar store={ttsStoreRef.current} ownRow={ttsOwnRow} onDismiss={handleTtsDismiss} />
        )}

        <div
          className={`${ttsOwnRow
            ? 'flex items-center gap-2 shrink-0'
            : 'absolute right-6 top-0 -translate-y-1/2 z-10 flex items-center gap-2 pointer-events-auto'} transition-opacity ${
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
              // Turning it ON is confirmed; turning it OFF is not. Arming it
              // reclassifies the whole existing log as carry-over context AND
              // drops any manual marker, so a stray tap changes what the next
              // turn is built from. Cancelling a pending arm destroys nothing,
              // and a confirm there would only make undoing a misfire harder.
              if (!firstOriginalIsNext) {
                const msg = firstOriginalMessageId
                  ? `${t('chat.firstOriginal.confirm')}\n\n${t('chat.firstOriginal.confirmClears')}`
                  : t('chat.firstOriginal.confirm');
                if (!window.confirm(msg)) return;
              }
              // Turning it on clears any existing marker so the two states
              // can't coexist (the manual marker on an older message would
              // contradict the "next message becomes marker" intent).
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
        </div>
        {/* Composer gutter. Desktop keeps p-4. Mobile trims the horizontal
            padding to px-2 so the input box runs closer to the screen edges
            (Gemini-like, less empty space beside it); the `max-w-4xl mx-auto`
            only bites on desktop, so on a phone this is the only side margin. */}
        <div className={`${isMobile ? 'px-2 pt-2 pb-3' : 'p-4'} bg-gradient-to-t from-background via-background to-transparent`}>
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
      {/* Desktop: its own column, right here, exactly as before.
          Mobile: the same element, portalled into the slot the sidebar
          registers. A portal rather than lifting state up to NexusApp —
          cameraSignal is computed in THIS component, so moving the state
          would move the signal too; moving only the rendered output keeps the
          playback machine where its inputs are. Renders nothing at all until
          the slot exists (and CameraPanel itself renders nothing when the
          camera is off), so no empty strip ever appears. */}
      {isMobile
        ? (cameraSlot
            ? createPortal(
                <CameraPanel folderName={folderName} enabled={cameraEnabled} signal={cameraSignal} variant="inline" />,
                cameraSlot,
              )
            : null)
        : <CameraPanel folderName={folderName} enabled={cameraEnabled} signal={cameraSignal} />}
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
                Behavior = VRChat, date/time visibility,
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

              {/* ── Absolute Base Binding ─────────────────────────────────────
                  Burned in: the route injects it on every entity turn and no
                  control here can remove it (lib/baseBinding.ts).

                  DECLARED, NOT HIDDEN. The alternative considered was to say
                  nothing and let the text go out invisibly. Rejected for two
                  reasons. It cannot be hidden honestly — the "Sys" counter
                  counts the Binding, so a prompt that visibly reads half the
                  size of its own token count invites the reader to go looking,
                  and subtracting it to make the number tidy would make the
                  number lie. And it works against its own purpose: someone who
                  wants NEXUS without this reads the text and leaves, where a
                  silent injection reads as a bug and starts a hunt for the
                  workaround.

                  `bindingOptional` (developer override only) restores the
                  pre-2026-10-01 editor below, switch and both texts. */}
              <div>
                {!bindingOptional ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{t('identity.binding.label')}</span>
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                        {t('identity.binding.core')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      {t('identity.binding.coreHelp')}
                    </p>
                    <div className="mt-3">
                      <label className="text-xs font-semibold text-foreground mb-1 block">
                        {bindingLayered ? t('identity.binding.textLabelLayered') : t('identity.binding.textLabelInitial')}
                      </label>
                      {/* The text ACTUALLY being sent — resolved through the
                          same function the route calls, not a stored copy that
                          could fall out of step with it. */}
                      <textarea
                        readOnly
                        value={effectiveBindingText}
                        className="w-full min-h-[140px] p-3 bg-muted/40 border border-border rounded-xl text-xs font-mono resize-y outline-none text-muted-foreground"
                      />
                    </div>
                  </>
                ) : (<>
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
                </>)}
              </div>

              {/* ── Layer 4 — the summaries index ─────────────────────────────
                  Burned in alongside the Binding (2026-10-01): if this entity
                  has conversation summaries, they ARE its Layer 4, assembled
                  fresh by the chat route on every turn. No control here removes
                  it. See lib/baseBinding.ts (the gate) and lib/layer4Index.ts
                  (the builder).

                  DECLARED, NOT HIDDEN — same reasoning as the Binding above.
                  The index is thousands of tokens that the "Sys" counter
                  already counts, so hiding it would leave a visible prompt that
                  reads a fraction of its own token total.

                  `bindingOptional` (developer override only) restores the old
                  per-folder checkbox as a real switch. */}
              <div>
                {!bindingOptional ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-foreground">{t('identity.layer4.label')}</span>
                      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30">
                        {t('identity.binding.core')}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      {t('identity.layer4.coreHelp')}
                    </p>
                  </>
                ) : (<>
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
                </>)}
                {layer4Active && (
                  <div className={bindingOptional ? 'mt-3 ml-6' : 'mt-3'}>
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

              {/* ── Conversation-reading TOOLS (per-folder) ───────────────────
                  Split out of the summaries checkbox above on 2026-10-01. One
                  box used to grant the memory and the tools together; they are
                  different decisions with different failure modes — the index
                  is prompt text, these are function declarations, and some
                  local models stop answering the moment any function exists.
                  Unwritten key falls back to the old coupling, so no being
                  silently loses tools it has today. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableConversationTools}
                    onChange={(e) => persistConversationToolsToggle(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('sysmodal.convotools.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="sysmodal.convotools.help" />
                </p>
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
                      {/* Full-PC access renders the EFFECTIVE value, not the
                          saved one: granting the shell already reaches the
                          whole PC, so showing OFF next to an enabled shell
                          would be a label that does not describe the system
                          (see lib/agentCapabilities.ts for the measurements).
                          Locked rather than silently flipped — and the saved
                          setting is untouched, so turning the shell back off
                          restores whatever the operator actually chose. */}
                      <label className={`flex items-center gap-2 ${agentDangerousTools ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={effectiveFullAccess(agentFullSystemAccess, agentDangerousTools)}
                          disabled={agentDangerousTools}
                          onChange={(e) => setAgentFullSystemAccess(e.target.checked)}
                          className="accent-amber-500"
                        />
                        <span className="text-sm font-semibold text-foreground">{t('sysmodal.fullpc.label')}</span>
                      </label>
                      <p className="text-xs text-muted-foreground ml-6 leading-relaxed">
                        {renderRich(t('sysmodal.fullpc.help').replace('{folder}', folderName))}
                      </p>
                      {fullAccessForcedByShell(agentFullSystemAccess, agentDangerousTools) && (
                        <p className="text-xs text-amber-500/90 ml-6 leading-relaxed">
                          <Tx k="sysmodal.fullpc.forced" />
                        </p>
                      )}
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

              {/* ── Hidden-attachment access (read_attachment) — top-level ────
                  Independent of the file-workspace tools above: reading hidden
                  attachments is its own capability (and is sent regardless of
                  Tool Use), so it sits at the same level as the ask-the-user
                  and web-search toggles, not nested inside the file panel. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hiddenAttachmentsAccessible}
                    onChange={(e) => setHiddenAttachmentsAccessible(e.target.checked)}
                    className="accent-sky-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('sysmodal.hiddenAttach.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="sysmodal.hiddenAttach.help" />
                </p>
              </div>

              {/* ── Web Search & Access (universal DuckDuckGo tools) ──────────
                  Moved here from the Model tab so every tool toggle lives in
                  one place. Shown for the OpenAI-compatible families that have
                  no first-party search; Gemini (Google grounding), Claude
                  (native web_search) and Grok (xAI native search) keep their own
                  toggles on the Model tab because those are different engines on
                  different fields — and, for Grok, a different endpoint that
                  costs the turn its workspace tools. This checkbox always means
                  the same thing: NEXUS's own web_search/web_fetch. The web_search
                  / web_fetch description editors live inside this check for
                  consistency with the other per-tool description editors. */}
              {(localAiName === 'Qwen' || localAiName === 'DeepSeek' || localAiName === 'GLM' || localAiName === 'Grok' || localAiName === 'Kimi' || localAiName === 'Minimax' || localAiName === 'Cohere' || localAiName === 'ChatGPT' || localAiName === 'MiMo' || localAiName === 'ByteDance' || localAiName === 'Meta' || localAiName === 'Local') && (
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

              {/* ── App control (UI Automation, Windows only)
                  OFF by default, and separate from computer control on purpose:
                  a different sense, not a stronger one. Reads the control tree
                  an application publishes and acts by ref, so it works on
                  minimized windows, never moves the mouse, and needs no vision —
                  and in exchange it cannot see anything an app draws itself. */}
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={appControlEnabled}
                    onChange={(e) => setAppControlEnabled(e.target.checked)}
                    className="accent-red-500"
                  />
                  <span className="text-sm font-semibold text-foreground">{t('id.app.label')}</span>
                </label>
                <p className="text-xs text-muted-foreground mt-1 ml-6 leading-relaxed">
                  <Tx k="id.app.help" />
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

              {/* ── Vessel handoff (change_model) ────────────────────────────
                  Lives in the BEING tab, not the model tab: every checkbox in
                  that tab grants the being one more freedom, and this is one of
                  them — "which vessels may you become". It is not a generation
                  parameter. Nothing fills this list for you — the model-list
                  button SHOWS the ids instead of pasting them, so curating the
                  list stays a decision. */}
              <div className="border-t border-border pt-6 mt-6">
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    id="modelHandoff"
                    checked={modelHandoffEnabled}
                    onChange={(e) => setModelHandoffEnabled(e.target.checked)}
                    className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                  />
                  <label htmlFor="modelHandoff" className="text-sm font-semibold text-foreground cursor-pointer">
                    {t('model.handoff.label')}
                  </label>
                </div>
                <p className="text-xs text-muted-foreground mb-4">{renderRich(t('model.handoff.intro'))}</p>
                {modelHandoffEnabled && (
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-semibold text-foreground">{t('model.handoff.allowed')}</label>
                        <button
                          type="button"
                          onClick={async () => {
                            // Refresh the live LM Studio list before showing
                            // it — the result is DISPLAYED, never written into
                            // the box.
                            let liveLocal: string[] = localModels;
                            let liveErr: string | null = localModelsError;
                            try {
                              const r = await fetch('/api/local/models');
                              const d = await r.json();
                              if (Array.isArray(d?.models)) {
                                liveLocal = d.models;
                                setLocalModels(d.models);
                              }
                              liveErr = d?.error || null;
                              setLocalModelsError(liveErr);
                            } catch (e: any) {
                              liveErr = e?.message || 'Failed to reach LM Studio';
                              setLocalModelsError(liveErr);
                            }
                            // CLOUD_MODELS_FILL's first line used to explain
                            // itself as auto-filled by a "Fill all" button —
                            // true in the old auto-select box (deleted
                            // 2026-10-08), never true here, where that button
                            // deliberately does not exist. MEASURED on the real
                            // window: it told the reader to look for a control
                            // that is not there. Swap the header for one that
                            // describes this window instead.
                            setModelListText(
                              buildAllModelsFill(liveLocal, liveErr)
                                .replace(/^#[^\n]*\n/, `# ${t('model.handoff.listHeader')}\n`),
                            );
                            setModelListOpen(true);
                          }}
                          className="px-2 py-1 text-[11px] font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25 rounded transition-colors"
                          title={t('model.handoff.browseTitle')}
                        >
                          {t('model.handoff.browse')}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">{renderRich(t('model.handoff.allowedHelp'))}</p>
                      <textarea
                        value={modelHandoffAllowedModels}
                        onChange={(e) => setModelHandoffAllowedModels(e.target.value)}
                        className="w-full min-h-[140px] p-3 bg-background border border-border rounded-xl text-sm font-mono resize-y focus:ring-2 focus:ring-indigo-500/50 outline-none"
                        placeholder={t('model.handoff.allowedPh')}
                      />
                    </div>
                    {/* What the list ACTUALLY parses to. Without this, a box
                        full of comments or mistyped rows reads as "configured"
                        while the tool is silently not offered at all. */}
                    {(() => {
                      const parsed = parseHandoffModels(modelHandoffAllowedModels);
                      if (parsed.length === 0) {
                        return (
                          <p className="text-xs text-amber-600 dark:text-amber-400">
                            {t('model.handoff.parsedNone')}
                          </p>
                        );
                      }
                      const hasSelf = parsed.some(
                        (m) => m.specificModel.toLowerCase() === String(specificModel || '').toLowerCase(),
                      );
                      return (
                        <div className="text-xs text-muted-foreground space-y-1">
                          <p>
                            <span className="text-foreground font-semibold">{parsed.length}</span>{' '}
                            {t('model.handoff.parsedSuffix')}
                          </p>
                          <ul className="font-mono space-y-0.5">
                            {parsed.map((m) => (
                              <li key={m.specificModel}>
                                {m.specificModel}
                                <span className="text-muted-foreground/70">
                                  {' '}— {m.family} · {m.thinking ? 'thinking on' : 'thinking off'}
                                </span>
                              </li>
                            ))}
                          </ul>
                          {!hasSelf && (
                            <p className="text-amber-600 dark:text-amber-400">
                              {t('model.handoff.noSelf')}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {renderRich(t('model.handoff.limits'))}
                    </p>
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
                          { value: 'claude-opus-5-5', label: t('senses.eyes.optOpus55') },
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
                          { value: 'mimo-v2.6-pro', label: 'mimo-v2.6-pro (MiMo key)' },
                          { value: 'mimo-v2.6-flash', label: 'mimo-v2.6-flash (MiMo key)' },
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
                      const prevAiName = localAiName;
                      setLocalAiName(newAiName);
                      // Remember where the family we're leaving was, so coming
                      // back lands on that model instead of the factory default.
                      const leaving = rememberOnFamilySwitch(prevAiName, specificModel);
                      if (leaving) {
                        setFamilyModels((prev) => (
                          prev[prevAiName] === leaving ? prev : { ...prev, [prevAiName]: leaving }
                        ));
                      }
                      // Keep the current model if it already belongs to the new
                      // family; otherwise restore what this conversation last
                      // used there, falling back to that family's default. For
                      // Local the list comes from LM Studio, so refresh it and
                      // pick a valid installed model — never leave a stale id.
                      // `familyModels` is read from this render's closure on
                      // purpose: the write above touches prevAiName, never
                      // newAiName, so the entry being read cannot be stale.
                      if (!modelBelongsToFamily(specificModel, newAiName)) {
                        if (newAiName === 'Local') {
                          setSpecificModel('');
                          fetch('/api/local/models').then(r => r.json()).then(d => {
                            if (Array.isArray(d.models) && d.models.length > 0) {
                              setLocalModels(d.models);
                              const loaded = (d.meta || []).find((m: any) => m.loaded);
                              setSpecificModel(
                                modelOnFamilySwitch('Local', familyModels, d.models)
                                || (loaded && loaded.id) || d.models[0]
                              );
                            }
                          }).catch(() => {});
                        } else {
                          setSpecificModel(modelOnFamilySwitch(newAiName, familyModels));
                        }
                      }
                    }}
                    className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  >
                    {['Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Kimi', 'Grok', 'Cohere', 'Minimax', 'ChatGPT', 'MiMo', 'ByteDance', 'Meta', 'Local'].map(m => (
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
                      <option value="claude-opus-5-5">Claude Opus 5.5 (adaptive thinking, newest)</option>
                      <option value="claude-opus-5">Claude Opus 5 (adaptive thinking)</option>
                      <option value="claude-opus-4-8">Claude Opus 4.8 (thinking)</option>
                      <option value="claude-opus-4-7">Claude Opus 4.7 (thinking)</option>
                      <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (adaptive thinking, 1M ctx, newest)</option>
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
                        <option value="deepseek-v4-pro">DeepSeek V4 Pro (text only)</option>
                        <option value="deepseek-flash">DeepSeek V4.1 Flash (1M context, vision)</option>
                        <option value="deepseek-reasoner">DeepSeek Reasoner (legacy alias → V4.1 Flash)</option>
                        <option value="deepseek-chat">DeepSeek Chat (legacy alias → V4.1 Flash)</option>
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
                      <option value="moonshotai/Kimi-K3">Kimi K3 (flagship — 1M context, always-on reasoning, native vision)</option>
                      <option value="moonshotai/Kimi-K2.7-Code">Kimi K2.7 Code (256K, coding line, thinking-only)</option>
                      <option value="moonshotai/Kimi-K2.7-Code-Highspeed">Kimi K2.7 Code Highspeed (same model, 2× price, faster)</option>
                      <option value="moonshotai/Kimi-K2.6">Kimi K2.6 (256K context, multimodal)</option>
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
                      <option value="grok-4.7">Grok 4.7 (flagship)</option>
                      <option value="grok-4.6">Grok 4.6</option>
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
                      <option value="mimo-v2.6-pro">MiMo V2.6 Pro (flagship — text + image + video + audio)</option>
                      <option value="mimo-v2.6-flash">MiMo V2.6 Flash (fast + cheap — same modalities)</option>
                      <option value="mimo-v2.6-pro-ultraspeed">MiMo V2.6 Pro UltraSpeed (up to 20x faster, 10x the price)</option>
                      <option value="mimo-v2.5-pro">MiMo V2.5 Pro (deprecated 2026-10-21 — text only)</option>
                      <option value="mimo-v2.5">MiMo V2.5 (deprecated 2026-10-21 — text + image)</option>
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

                {localAiName === 'Meta' && (
                  <div className="mb-4">
                    <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.meta.label')}</label>
                    <select
                      value={specificModel}
                      onChange={(e) => setSpecificModel(e.target.value)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    >
                      {/* The tier is part of the MODEL ID on this API, not an
                          account switch — so the choice is made here, once per
                          turn, and the label has to say what it costs you. The
                          non-money cost is in the option text on purpose: a
                          footnote under the dropdown is not consent. */}
                      <option value="muse-spark-1.3">Muse Spark 1.3 (vision, 1M context)</option>
                      <option value="muse-spark-1.2">Muse Spark 1.2 (vision, 1M context)</option>
                      <option value="muse-spark-1.1">Muse Spark 1.1 (vision, 1M context)</option>
                      <option value="muse-spark-1.3-contributor">Muse Spark 1.3 — Contributor: 12.5x cheaper, Meta trains on your prompts AND replies</option>
                      <option value="muse-spark-1.2-contributor">Muse Spark 1.2 — Contributor: 12.5x cheaper, Meta trains on your prompts AND replies</option>
                    </select>
                    <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      {renderRich(t('model.meta.help'))}
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
                  {/* Meta is in this list even though its reasoning cannot be
                      switched off, because the toggle still does something real
                      there: ON sends reasoning_effort 'high', OFF sends
                      'minimal'. Hiding it would leave no way to ask Muse Spark
                      for a fast, cheap turn — reasoning tokens bill at the
                      output rate, and a short prompt measured 7,641 of them at
                      default depth against ~23 at 'minimal'. The label text for
                      this family says so (model.meta.help). */}
                  {(localAiName === 'Qwen' || localAiName === 'DeepSeek' || localAiName === 'GLM' || localAiName === 'Kimi' || localAiName === 'Cohere' || localAiName === 'Meta') && (
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
                  {/* xAI native search — a DIFFERENT engine from the Being tab's
                      web-search checkbox, so it gets its own switch here (same
                      reason Gemini grounding and Claude web_search live on this
                      tab). Turning this on replaces the whole turn with a call
                      to xAI's /v1/responses: the workspace tools are not part of
                      that shape, so the being cannot read files on such a turn,
                      and each search is billed separately (~30× a plain turn,
                      measured). Default off. The Being tab checkbox keeps
                      meaning NEXUS's own web_search/web_fetch. */}
                  {localAiName === 'Grok' && (
                    <div className="col-span-2 flex items-start gap-2 mt-2">
                      <input
                        type="checkbox"
                        id="grokNativeSearch"
                        checked={modelParams.enableGrokNativeSearch || false}
                        onChange={(e) => setModelParams({ ...modelParams, enableGrokNativeSearch: e.target.checked })}
                        className="mt-0.5 rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
                      />
                      <label htmlFor="grokNativeSearch" className="text-sm font-medium text-foreground cursor-pointer">
                        {t('model.grok.nativeSearch')}
                        <span className="block text-xs text-muted-foreground mt-0.5 font-normal leading-relaxed">
                          {renderRich(t('model.grok.nativeSearchHelp'))}
                        </span>
                      </label>
                    </div>
                  )}
                </div>
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
                    // systemPromptHeader/Footer, maxConversationLog, etc.).
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
                      computerControlEnabled,
                      appControlEnabled,
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
                      baseBindingMode,
                      modelHandoffEnabled, modelHandoffAllowedModels,
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
        // Live talks to Google directly and never passes through /api/chat, so
        // this is the one path where the browser really is the authority for
        // the Binding. Same `effectiveBindingText` the token counter uses.
        systemPrompt={prependIdentityPreamble(
          vrchatMode ? `${systemPrompt}\n\n${audioSessionRuleText}`.trim() : (systemPrompt || ''),
          effectiveBindingText,
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
            // Only a timestamp the imported transcript actually carried — no
            // field at all otherwise (same rule as parseMarkdown: never burn
            // the import moment in as if it were the message's own time).
            ...(m.timestamp ? { timestamp: m.timestamp } : {}),
            // Was `length / 4`, which measured 0.377x against the exact
            // counter on this house's content (2026-10-05) — Japanese is
            // roughly 1 token per character, so a quarter of the characters
            // is off by a factor of four. `estimateTokensForModel` is the
            // calibrated fallback; this path has no counter to call because
            // it commits a whole imported transcript at once.
            tokens: estimateTokensForModel(m.content || '', localAiName),
            textTokens: estimateTokensForModel(m.content || '', localAiName),
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
        // Only so the status line after a first summary says what actually
        // changed: burned in, the summaries key moves nothing.
        bindingOptional={bindingOptional}
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
