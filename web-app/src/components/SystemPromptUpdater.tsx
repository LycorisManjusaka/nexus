"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Layers, Loader2, Wand2, ArrowRight, ChevronsRight, Brain, PenLine, Check, AlertTriangle, Phone, Square, FileX, Shuffle } from 'lucide-react';
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';
import { defaultSummaryHintForLang } from '@/lib/summaryHint';
import { buildUpdateUserMsg, buildRedistributeUserMsg, buildGenesisUserMsg, buildSummaryUserMsg, defaultSummaryAgentPrompt } from '@/lib/spuScaffold';
import { useT, useLanguage, Tx } from '@/lib/i18n';
import { setUnloadGuard } from '@/lib/unloadGuard';

// One shared diff engine. We do NOT diff the raw text directly: on a large
// prompt, character-level diff_main blows past its time cap and bails out to a
// degenerate "delete everything / insert everything" result (two big blocks,
// no per-word matching). Instead we use diff-match-patch's documented
// words-to-chars trick — tokenize each side into words/whitespace/CJK-chars,
// map every distinct token to one private code point, diff those compact
// strings (1 unit per token → fast + word-granular), then map the result back
// to real text. This is both fast AND granular.
const dmp = new diff_match_patch();
dmp.Diff_Timeout = 2.0; // generous: the token-encoded strings are short, so a
                        // normal update finishes in milliseconds anyway.

// Tokenize: Latin/digit runs as words, whitespace runs together, every other
// character (CJK, punctuation, symbols) as its own token. Joined back, the
// tokens reproduce the input exactly.
const DIFF_TOKEN_RE = /[A-Za-z0-9]+|\s+|[\s\S]/g;

function diffByTokens(before: string, after: string): Array<[number, string]> {
  const tokenArray: string[] = [];
  const tokenHash = new Map<string, number>();
  const encode = (text: string): string => {
    const tokens = text.match(DIFF_TOKEN_RE) || [];
    let out = '';
    for (const tok of tokens) {
      let idx = tokenHash.get(tok);
      if (idx === undefined) {
        // ~65k distinct tokens is far more than any real prompt produces; if it
        // were ever exceeded, fromCharCode would wrap — acceptably rare.
        idx = tokenArray.length;
        tokenArray.push(tok);
        tokenHash.set(tok, idx);
      }
      out += String.fromCharCode(idx);
    }
    return out;
  };
  const e1 = encode(before);
  const e2 = encode(after);
  // checklines=false: our "characters" are token ids, not lines.
  const diffs = dmp.diff_main(e1, e2, false) as Array<[number, string]>;
  // Decode each chunk's token-id chars back into the original text.
  return diffs.map(([op, data]) => {
    let s = '';
    for (let i = 0; i < data.length; i++) s += tokenArray[data.charCodeAt(i)] ?? '';
    return [op, s] as [number, string];
  });
}

// ── Title <-> index helpers (client-side mirror of the lib) ─────────────────
const fwToHw = (s: string) =>
  s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
const parseTitleIndex = (title: string): { base: string; index: number } | null => {
  const m = title.match(/^(.*?)\s*[_#＃]([0-9０-９]+)\s*$/);
  if (!m) return null;
  const n = parseInt(fwToHw(m[2]), 10);
  if (isNaN(n)) return null;
  return { base: m[1].replace(/\s+$/, ''), index: n };
};

// ── Layer parsing (only used to extract Layers 1-3 as identity context for the
// summary writer — the main updater now works on the RAW combined text). ─────
const LAYER_HEADER_RE = /^#{2,3}\s*\*\*Layer\s*(\d+)\s*[:：]\s*(.+?)(?:\*\*)?\s*$/gm;
interface Layer { index: number; name: string; content: string; }
function parseLayers(text: string): Layer[] {
  const matches: Array<{ idx: number; name: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  LAYER_HEADER_RE.lastIndex = 0;
  while ((m = LAYER_HEADER_RE.exec(text)) !== null) {
    matches.push({ idx: parseInt(m[1], 10), name: m[2].replace(/\*+$/, '').trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  const layers: Layer[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const body = text.slice(cur.bodyStart, next ? next.start : text.length);
    layers.push({ index: cur.idx, name: cur.name, content: body.replace(/^\n/, '').replace(/\s+$/, '') });
  }
  return layers;
}
// Re-emit only Layers 1-3 in canonical form (used as identity context for the summary writer).
function assembleLayers123(text: string): string {
  return parseLayers(text)
    .filter((l) => l.index >= 1 && l.index <= 3)
    .map((l) => `## **Layer ${l.index}: ${l.name}**\n${l.content}`)
    .join('\n\n');
}

// ── Word-level diff display ────────────────────────────────────────────────
function DiffView({ before, after }: { before: string; after: string }) {
  const t = useT();
  const parts = useMemo(() => {
    if (!before && !after) return null;
    // Token-level diff — fast and word-granular (see diffByTokens above).
    return diffByTokens(before, after);
  }, [before, after]);
  if (!parts) return <div className="italic text-muted-foreground text-xs">{t('spu.empty')}</div>;
  return (
    <div className="text-[12px] leading-relaxed whitespace-pre-wrap font-mono break-words">
      {parts.map(([op, text], i) => {
        if (op === DIFF_INSERT)
          return <span key={i} className="bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 underline decoration-emerald-500/60">{text}</span>;
        if (op === DIFF_DELETE)
          return <span key={i} className="bg-red-500/15 text-red-700 dark:text-red-300 line-through decoration-red-500/60">{text}</span>;
        return <span key={i}>{text}</span>;
      })}
    </div>
  );
}

// ── Run lifecycle indicator chip ────────────────────────────────────────────
type RunStatus =
  | { state: 'idle' }
  | { state: 'called' }
  | { state: 'thinking'; thinkingChars: number; outputChars: number }
  | { state: 'outputting'; thinkingChars: number; outputChars: number }
  | { state: 'done'; thinkingChars: number; outputChars: number }
  | { state: 'error'; message: string };

function StatusBadge({ status }: { status: RunStatus }) {
  const t = useT();
  if (status.state === 'idle') return null;
  if (status.state === 'called') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-muted text-muted-foreground" title={t('spu.badge.callingTitle')}>
        <Loader2 size={10} className="animate-spin" /><Phone size={10} />{t('spu.badge.calling')}
      </span>
    );
  }
  if (status.state === 'thinking') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 animate-pulse"
        title={t('spu.badge.thinkingTitle').replace('{n}', status.thinkingChars.toLocaleString())}>
        <Brain size={10} />{t('spu.badge.thinking')} · {status.thinkingChars.toLocaleString()}
      </span>
    );
  }
  if (status.state === 'outputting') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 animate-pulse"
        title={t('spu.badge.writingTitle').replace('{n}', status.outputChars.toLocaleString())}>
        <PenLine size={10} />{t('spu.badge.writing')} · {status.outputChars.toLocaleString()}
      </span>
    );
  }
  if (status.state === 'done') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        title={t('spu.badge.doneTitle').replace('{n}', status.outputChars.toLocaleString())}>
        <Check size={10} />{t('spu.badge.done')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-600 dark:text-red-400 max-w-[260px] truncate" title={status.message}>
      <AlertTriangle size={10} />{t('spu.badge.error')}
    </span>
  );
}

// ── Token-count helper ──────────────────────────────────────────────────────
async function countTokens(text: string, model: string): Promise<number> {
  if (!text) return 0;
  try {
    const r = await fetch('/api/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model }),
    });
    if (!r.ok) return Math.ceil(text.length / 4);
    const d = await r.json();
    return d.tokens || 0;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

// The agent ends its output with bookkeeping log sections (the format file
// defines "## [Abbreviations log]" and "## [Deletions log]"). We split those off
// the actual layer content so they can be shown read-only and kept OUT of the
// next conversation's system prompt. Tolerant of EN/JP labels and `##`/`###`.
const LOG_SECTION_RE =
  /^#{2,3}\s*\[?\s*(?:Abbreviations?\s*log|Deletions?\s*log|省略ログ|削除ログ)\s*\]?\s*$/im;
function splitOffLogs(text: string): { layers: string; logs: string } {
  const m = text.match(LOG_SECTION_RE);
  if (!m || m.index === undefined) return { layers: text.trim(), logs: '' };
  return {
    layers: text.slice(0, m.index).replace(/\s+$/, ''),
    logs: text.slice(m.index).trim(),
  };
}

// Split the agent output at the first "## Layer 1" heading. Everything ABOVE it
// is the changelog (the agent's account of what it changed); everything from the
// heading onward is the core identity (Layers 1-3). Tolerant of `##`/`###`, an
// optional `**`, and EN/JP colon. If Layer 1 is missing or already at the very
// start, there's no changelog (return the whole text as core — don't lose data).
const LAYER1_HEADER_RE = /^#{2,3}\s*\*{0,2}\s*Layer\s*1\b\s*[:：]/im;
function splitOffChangelog(text: string): { changelog: string; core: string } {
  const m = text.match(LAYER1_HEADER_RE);
  if (!m || m.index === undefined || m.index === 0) return { changelog: '', core: text };
  return { changelog: text.slice(0, m.index).trim(), core: text.slice(m.index) };
}

// ── Layer 4 split + entry parsing (redistribute mode only) ──────────────────
// The normal update forbids Layer 4 in the output entirely. The redistribute
// mode ASKS for it, because Layer 4 is where the episodic memory lives and
// moving material between the layers is the whole point of that pass. What
// comes back has to be routed to a different place than the rest: Layers 1-3
// go into the prompt file, Layer 4 goes into the individual summary files
// under local_data/summaries/<entity>/.
//
// Split at the Layer 4 heading — everything before it is Layers 1-3, and the
// body after it holds the per-conversation entries. Tolerant of `##`/`###`, an
// optional `**`, and whatever the agent writes after "Layer 4" on that line.
const LAYER4_HEADER_RE = /^#{2,3}\s*\*{0,2}\s*Layer\s*4\b[^\n]*$/im;
// Any layer heading — used to stop the Layer 4 body at a Layer 5 the agent was
// told not to write but wrote anyway. Without this, that heading and its body
// would be appended to the LAST summary and written into that entity's summary
// file, which is the quietest possible way to corrupt one.
const ANY_LAYER_HEADER_RE = /^#{2,3}\s*\*{0,2}\s*Layer\s*\d+\b/im;
function splitOffLayer4(text: string): { before: string; layer4: string; after: string } {
  const m = text.match(LAYER4_HEADER_RE);
  if (!m || m.index === undefined) return { before: text, layer4: '', after: '' };
  const before = text.slice(0, m.index).replace(/\s+$/, '');
  // Drop the heading line itself — only its body carries entries.
  const rest = text.slice(m.index + m[0].length).replace(/^\n/, '');
  const nxt = rest.match(ANY_LAYER_HEADER_RE);
  if (!nxt || nxt.index === undefined) return { before, layer4: rest, after: '' };
  return { before, layer4: rest.slice(0, nxt.index).replace(/\s+$/, ''), after: rest.slice(nxt.index).trim() };
}

// Each conversation inside Layer 4 is "### <title>" followed by its summary —
// the exact shape assembleSummaryIndex() emits, so the agent is asked to hand
// back what it was given. The title is matched against the files on disk, so
// it has to survive verbatim; only surrounding `**`/`` ` `` decoration is
// stripped. Entries with no body, and the "(no summary yet)" placeholder, are
// dropped rather than written — an empty file would erase a real summary.
const SUMMARY_ENTRY_RE = /^###\s+(.+?)\s*$/gm;
const EMPTY_SUMMARY_RE = /^_?\(?\s*(?:no summary yet|まだ要約なし|要約なし)\s*\)?_?$/i;
function parseSummaryEntries(layer4Body: string): Array<{ title: string; content: string }> {
  const heads: Array<{ title: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  SUMMARY_ENTRY_RE.lastIndex = 0;
  while ((m = SUMMARY_ENTRY_RE.exec(layer4Body)) !== null) {
    heads.push({
      title: m[1].replace(/^[*`\s]+|[*`\s]+$/g, ''),
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  const out: Array<{ title: string; content: string }> = [];
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    const next = heads[i + 1];
    const body = layer4Body.slice(cur.bodyStart, next ? next.start : layer4Body.length).trim();
    if (!cur.title || !body) continue;
    if (EMPTY_SUMMARY_RE.test(body)) continue;
    out.push({ title: cur.title, content: body });
  }
  return out;
}

// What the server did with the parsed Layer 4 — shown read-only after a
// redistribute run so the write is auditable without opening a file manager.
interface RedistributeReport {
  backupDir: string | null;
  backedUp: number;
  replaced: string[];
  created: string[];
  skipped: Array<{ title: string; reason: string }>;
}

// Continuation sentinel the agent is asked to print at the very end of its
// output. Its absence after a stream means the output was truncated at the
// model's token cap → we prefill-continue. Stripped before saving.
const END_SENTINEL = '<<<NEXUS_END>>>';

// ── Fixed agent filenames ────────────────────────────────────────────────────
// Each action button used to run whichever .md file the user happened to have
// picked from a shared ComboBox — a footgun (running "Redistribute" against
// updater.md silently did the wrong thing, with no error). Every type folder
// under local_data/system_prompt_agents/<Type>/ now carries exactly these four
// canonical files, and each button is wired to its own fixed name: there is no
// file selector left to point at the wrong one.
const AGENT_FILE_UPDATE = 'updater.md';                       // "Update from Conversation"
const AGENT_FILE_REORGANIZE = 'defragmenter.md';              // "Reorganize (No Conversation)"
const AGENT_FILE_REDISTRIBUTE = 'interlayer_redistributor.md'; // "Redistribute Layer 4 → 1-3"
const AGENT_FILE_GENESIS = 'genesis_extractor.md';            // "Genesis (Build From Scratch)"

// ── Soul-packer model shortlist ──────────────────────────────────────────────
// Only these four families produce usable system-prompt updates; the others
// either flatten the Layer structure or paraphrase the identity away. Kept as a
// fixed list rather than the full model table so the choice stays a deliberate
// one. `authMode` is Claude-only — it picks the billing path (see the chat
// route's resolvedClaudeAuthMode); everything else leaves it undefined and gets
// the route's usual 'auto'.
interface UpdaterModelDef {
  key: string;
  label: string;
  /** Family label — the chat route matches this case-insensitively. */
  aiName: string;
  model: string;
  authMode?: 'oauth' | 'api-key';
}
const UPDATER_MODELS: UpdaterModelDef[] = [
  { key: 'claude-opus-5-oauth', label: 'Claude Opus 5 (OAuth path)', aiName: 'Claude',   model: 'claude-opus-5',       authMode: 'oauth' },
  { key: 'kimi-k3',             label: 'Kimi K3',                    aiName: 'Kimi',     model: 'moonshotai/Kimi-K3' },
  { key: 'glm-5.3',             label: 'GLM 5.3',                    aiName: 'GLM',      model: 'glm-5.3' },
  { key: 'glm-5.2',             label: 'GLM 5.2',                    aiName: 'GLM',      model: 'glm-5.2' },
  { key: 'glm-5.2-digitalocean', label: 'GLM 5.2 (DigitalOcean)',    aiName: 'GLM',      model: 'digitalocean/glm-5.2' },
  { key: 'deepseek-v4-pro',     label: 'DeepSeek V4 Pro',            aiName: 'DeepSeek', model: 'deepseek-v4-pro' },
];
const DEFAULT_UPDATER_MODEL_KEY = 'deepseek-v4-pro';
const DEFAULT_UPDATER_MODEL =
  UPDATER_MODELS.find(m => m.key === DEFAULT_UPDATER_MODEL_KEY) as UpdaterModelDef;

// ── Main modal ──────────────────────────────────────────────────────────────
interface Props {
  open: boolean;
  onClose: () => void;
  folderName: string;
  convoId: string;
  title: string;
  originalMessages: Array<{ role: string; name?: string; content: string; timestamp?: number }>;
  aiName: string;
  specificModel: string;
  modelParams: any;
  globalSettings: any;
  folders: any[];
  saveFolderSettings: (folderName: string, patch: any) => Promise<void>;
  onFinalize: (args: { newSystemPrompt: string; newIndex: number }) => Promise<void>;
}

export default function SystemPromptUpdater({
  open, onClose, folderName, convoId, title, originalMessages,
  aiName, specificModel, modelParams,
  folders, saveFolderSettings, onFinalize,
}: Props) {
  const t = useT();
  // ── State ────────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<null | 'update' | 'redistribute' | 'genesis' | 'summary' | 'auto'>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // ── Close/reload guard ─────────────────────────────────────────────────────
  // A soul-packing run is the most expensive thing in Nexus to lose: minutes of
  // a paid model call, and NOTHING is written to disk until it finishes. A
  // reload here throws all of it away with no trace. Hold the guard for exactly
  // as long as a run is in flight — see src/lib/unloadGuard.ts for why the
  // dialog's own wording cannot be customised.
  useEffect(() => {
    setUnloadGuard('spu', running ? t('unload.busy.spu') : null);
  }, [running, t]);

  // Clear on unmount (modal closed, page navigated). Without this a guard left
  // behind would make an idle page unclosable — the exact opposite of the point.
  useEffect(() => () => { setUnloadGuard('spu', null); }, []);

  // The whole identity prompt is now ONE editable block per side (no per-layer
  // split). Left = current file, Right = updated draft. Both are the RAW file
  // contents (all layers verbatim — no parsing/recognition).
  const [leftText, setLeftText] = useState('');
  const [rightText, setRightText] = useState('');
  const [leftTokens, setLeftTokens] = useState(0);
  const [rightTokens, setRightTokens] = useState(0);
  // Debounced snapshots for the (expensive) word-level diff.
  const [diffLeft, setDiffLeft] = useState('');
  const [diffRight, setDiffRight] = useState('');

  const [updateStatus, setUpdateStatus] = useState<RunStatus>({ state: 'idle' });
  // The agent appends "## [Abbreviations log]" / "## [Deletions log]" sections
  // after the layers. We split those off the result: they're shown read-only
  // for review and are NOT carried into the next conversation's prompt.
  const [updateLogs, setUpdateLogs] = useState('');
  // Everything ABOVE the first "## Layer 1" heading in the agent output — the
  // changelog. Shown read-only, archived to local_data/changelogs/<folder>/
  // <title>.md, and NEVER fed into any context window.
  const [changelogText, setChangelogText] = useState('');
  // Result of the last "Redistribute Layers 1-4" write (backup path + which
  // summary files were replaced/created/skipped). Null until one has run.
  const [redistributeReport, setRedistributeReport] = useState<RedistributeReport | null>(null);
  // AbortController for the in-flight agent run (update / summary / auto), so a
  // Stop button can cancel it — same mechanism the conversation Stop uses.
  const abortRef = useRef<AbortController | null>(null);
  // True while the identity-update agent is streaming INTO the right pane. The
  // right textarea is read-only during this (live preview), and the word-level
  // diff/compare is frozen until the run finishes or is stopped — then the right
  // pane becomes editable again and the diff recomputes against the final text.
  const [streamingUpdate, setStreamingUpdate] = useState(false);

  // Resume support. When a run dies partway (OAuth Claude hitting a limit, a
  // dropped connection, Stop pressed), the right pane holds real work that
  // would otherwise be thrown away — the next run starts from an empty accumulator
  // and overwrites it. With this on, that text is handed to the agent as
  // already-completed output and it continues from where it stopped.
  const [resumeFromRight, setResumeFromRight] = useState(false);

  // A draft that already contains a Layer 3 heading is almost certainly a
  // COMPLETE previous result, not a truncated run — resuming from that would
  // tell the agent to "continue" a finished document. So the toggle only arms
  // itself when the text looks genuinely cut short. It stays user-overridable.
  const rightLooksTruncated = useMemo(() => {
    const t = rightText.trim();
    if (!t) return false;
    return !/^#{1,4}\s*\*{0,2}\s*(Layer|レイヤー)\s*3/mi.test(t);
  }, [rightText]);

  useEffect(() => {
    // Don't fight the user mid-stream (rightText changes on every chunk).
    if (streamingUpdate) return;
    setResumeFromRight(rightLooksTruncated);
  }, [rightLooksTruncated, streamingUpdate]);

  const [header, setHeader] = useState('');
  // ── The entity's self-authored Layer 5 (workspaces/<Entity>/FOOTER.md).
  // Lives in a FILE and is injected at send time, which is exactly why the
  // updater agent used to be blind to it: the agent reads the STORED prompt, so
  // a footer baked into that prompt was visible and a FOOTER.md was not.
  const [entityFooter, setEntityFooter] = useState('');
  const [entityFooterExists, setEntityFooterExists] = useState(false);
  const [entityFooterSaved, setEntityFooterSaved] = useState<string>('');
  const [entityFooterStatus, setEntityFooterStatus] = useState<string | null>(null);
  const [focusPoint, setFocusPoint] = useState('');
  const [summaryInstructions, setSummaryInstructions] = useState('');
  const [summaryIndexHint, setSummaryIndexHint] = useState('');

  const lastSavedLeftRef = useRef<string | null>(null);
  const lastSavedRightRef = useRef<string | null>(null);
  const lastSavedFolderRef = useRef<string | null>(null);
  const [autoSaveState, setAutoSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // All updater agent .md files in the selected type subfolder + the (separate)
  // summary writer agent. Each action button below runs a FIXED filename out of
  // this list (see AGENT_FILE_* above) — there is no per-run file picker.
  const [agents, setAgents] = useState<{
    files: Array<{ name: string; systemPrompt: string }>;
    summary: { raw: string; systemPrompt: string } | null;
  } | null>(null);
  const [deletionPatterns, setDeletionPatterns] = useState<string[]>([]);

  // Look up one of the four canonical agent files by its fixed name. Returns
  // null if the selected type folder doesn't have that file (or nothing has
  // loaded yet) — every button-disabled check and every run function goes
  // through this instead of a shared "currently selected" agent.
  const getAgentFile = useCallback(
    (name: string) => agents?.files.find((f) => f.name === name) || null,
    [agents]
  );
  const updateAgent = useMemo(() => getAgentFile(AGENT_FILE_UPDATE), [getAgentFile]);
  const reorganizeAgent = useMemo(() => getAgentFile(AGENT_FILE_REORGANIZE), [getAgentFile]);
  const redistributeAgent = useMemo(() => getAgentFile(AGENT_FILE_REDISTRIBUTE), [getAgentFile]);
  const genesisAgent = useMemo(() => getAgentFile(AGENT_FILE_GENESIS), [getAgentFile]);

  // ── Summary panel (separate call, separate default model) ────────────────
  const [summaryText, setSummaryText] = useState('');
  const [summaryTokens, setSummaryTokens] = useState(0);
  const [summaryStatus, setSummaryStatus] = useState<RunStatus>({ state: 'idle' });
  const [summaryLoadedFor, setSummaryLoadedFor] = useState<string | null>(null);
  const lastSavedSummaryRef = useRef<string | null>(null);
  // The live, ordered summaries index (current conversation excluded) — i.e.
  // exactly what the entity receives in place of Layer 4 at send time. Shown to
  // the updater agent as the source's Layer 4 (reference-only — never rewritten).
  const [summaryIndexBody, setSummaryIndexBody] = useState('');

  // Which agent folder the four canonical files come from. This used to be a
  // per-entity "agent type" ComboBox (Entity / Technical) — a split that only
  // ever encoded one person's habit of writing technical prompts in English and
  // entity prompts in Japanese. It is now simply the UI language: the agents
  // live in `system_prompt_agents/<lang>/`, one complete set per language, and
  // the folder follows Preferences → Other → Language with nothing to pick.
  const agentFolder = useLanguage(); // 'en' | 'ja'

  // Updater model override, independent of the conversation's own model.
  // Persisted PER ENTITY (folder settings).
  //
  // The checkbox used to hardcode GLM-5.2; it now selects from the shortlist
  // below. Only these four families produce usable soul-packer output — the
  // rest either lose Layer structure or paraphrase the identity away — so this
  // is a fixed list rather than the full model table.
  // Default OFF: an entity's own model writes its own soul unless you say
  // otherwise. Overriding is a real choice with real consequences (a different
  // vessel reads the conversation and rewrites the identity from it), so it
  // should be something you switch ON deliberately, not something already on
  // when you first open this window. Entities that saved a preference keep it.
  const [forceUpdaterModel, setForceUpdaterModel] = useState<boolean>(false);
  const [updaterModelKey, setUpdaterModelKey] = useState<string>(DEFAULT_UPDATER_MODEL_KEY);
  const updaterModel = useMemo(
    () => UPDATER_MODELS.find(m => m.key === updaterModelKey) ?? DEFAULT_UPDATER_MODEL,
    [updaterModelKey]
  );
  const effectiveAiName = forceUpdaterModel ? updaterModel.aiName : aiName;
  const effectiveSpecificModel = forceUpdaterModel ? updaterModel.model : specificModel;
  // Claude has two billing paths and the shortlist entry names which one. Left
  // undefined for every other model so the route keeps its usual 'auto'.
  const effectiveAuthMode = forceUpdaterModel ? updaterModel.authMode : undefined;

  // Summary writer model override — MiMo V2.5 Pro. Default OFF for the same
  // reason as above, plus one specific to a fresh install: MiMo needs its own
  // API key, and a default-ON checkbox pointing at a provider the user has
  // never configured fails at the moment they press "Write Summary", with an
  // error about a model they never chose.
  const [forceMimoForSummary, setForceMimoForSummary] = useState<boolean>(false);
  const summaryAiName = forceMimoForSummary ? 'MiMo' : effectiveAiName;
  const summarySpecificModel = forceMimoForSummary ? 'mimo-v2.5-pro' : effectiveSpecificModel;
  // When the summary inherits the updater's model it must inherit its auth path too.
  const summaryAuthMode = forceMimoForSummary ? undefined : effectiveAuthMode;

  const titleParsed = useMemo(() => parseTitleIndex(title), [title]);
  const currentIndex = titleParsed?.index ?? 1;
  const baseName = titleParsed?.base ?? title;
  const summaryKey = title;

  const folder = useMemo(
    () => folders?.find((f: any) => f.name === folderName),
    [folders, folderName]
  );

  // ── Load on open ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setStatusMessage(t('spu.st.loading'));
      try {
        const [curRes, nextRes] = await Promise.all([
          fetch(`/api/system-prompts?folder=${encodeURIComponent(baseName)}&index=${currentIndex}`).then((r) => r.json()),
          fetch(`/api/system-prompts?folder=${encodeURIComponent(baseName)}&index=${currentIndex + 1}`).then((r) => r.json()),
        ]);
        const leftRaw = (curRes?.contents || '').replace(/\s+$/, '');
        const nextRaw = (nextRes?.contents || '').replace(/\s+$/, '');
        if (cancelled) return;

        // Initial state: copy the saved file verbatim into the LEFT side (all
        // layers, no separation/recognition). The RIGHT side seeds ONLY from the
        // next-conversation draft if one actually exists on disk; if there is no
        // next file, the right side stays EMPTY (we do NOT copy the left over —
        // that previously made it look like a draft already existed). Because
        // lastSavedRightRef matches the empty rightText, the right auto-save
        // effect won't write a spurious empty <baseName>_<index+1>.md on open.
        setLeftText(leftRaw);
        setRightText(nextRaw);
        setDiffLeft(leftRaw);
        setDiffRight(nextRaw);
        setUpdateStatus({ state: 'idle' });
        setUpdateLogs('');
        setChangelogText('');
        setRedistributeReport(null);
        lastSavedLeftRef.current = leftRaw;
        lastSavedRightRef.current = nextRaw;

        const hydratedHeader = folder?.settings?.systemPromptHeader ?? '';
        const hydratedFocus = folder?.settings?.systemPromptFocusPoint ?? '';
        const hydratedSummaryInstr = folder?.settings?.summaryInstructions ?? '';
        const hydratedSummaryHint = folder?.settings?.summaryIndexHint ?? defaultSummaryHintForLang(agentFolder);
        // `=== true` rather than `!== false`: a folder that has NEVER saved the
        // setting now defaults to OFF (see the useState above). A folder that
        // saved either value keeps exactly what it saved — this changes the
        // default for new entities, never the choice of an existing one.
        // The override checkbox was once `forceGlmForUpdates`. Read the new key
        // when present, otherwise inherit the old one so an entity that had the
        // override turned ON stays on. The MODEL is not migrated: a folder
        // with no `updaterModelKey` gets the current default (DeepSeek V4 Pro)
        // rather than being pinned to the GLM the old flag implied.
        const hydratedForceUpdater =
          folder?.settings?.forceUpdaterModel !== undefined
            ? folder.settings.forceUpdaterModel === true
            : folder?.settings?.forceGlmForUpdates === true;
        const savedKey = folder?.settings?.updaterModelKey;
        const hydratedUpdaterKey = UPDATER_MODELS.some(m => m.key === savedKey)
          ? savedKey
          : DEFAULT_UPDATER_MODEL_KEY;
        const hydratedForceMimo = folder?.settings?.forceMimoForSummary === true;
        setHeader(hydratedHeader);
        setFocusPoint(hydratedFocus);
        setSummaryInstructions(hydratedSummaryInstr);
        setSummaryIndexHint(hydratedSummaryHint);
        setForceUpdaterModel(hydratedForceUpdater);
        setUpdaterModelKey(hydratedUpdaterKey);
        setForceMimoForSummary(hydratedForceMimo);
        // FOOTER.md lives on disk, not in folder settings, so it needs its own
        // read. Best-effort: a missing file is the normal case for most
        // entities and must not turn into a load error.
        try {
          const fRes = await fetch(`/api/footer?folder=${encodeURIComponent(folderName)}`);
          if (fRes.ok) {
            const f = await fRes.json();
            setEntityFooter(f.body || '');
            setEntityFooterSaved(f.body || '');
            setEntityFooterExists(!!f.exists);
          }
        } catch { /* leave it blank */ }
        lastSavedFolderRef.current = JSON.stringify({
          header: hydratedHeader, focusPoint: hydratedFocus,
          summaryInstructions: hydratedSummaryInstr, summaryIndexHint: hydratedSummaryHint,
          forceUpdaterModel: hydratedForceUpdater, updaterModelKey: hydratedUpdaterKey,
          forceMimoForSummary: hydratedForceMimo,
        });
        setStatusMessage(nextRaw ? t('spu.st.loadedDraft') : '');
      } catch (e: any) {
        setStatusMessage(t('spu.st.loadFailed').replace('{e}', e.message));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseName, currentIndex, agentFolder]);

  // ── Load agents + deletion patterns for the current language folder ──────
  useEffect(() => {
    if (!open) {
      setAgents(null);
      setDeletionPatterns([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [agentRes, delRes] = await Promise.all([
          fetch(`/api/system-prompt-agents?type=${encodeURIComponent(agentFolder)}`).then((r) => r.json()),
          fetch(`/api/system-prompt-deletions?type=${encodeURIComponent(agentFolder)}`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        const files: Array<{ name: string; systemPrompt: string }> = Array.isArray(agentRes?.files) ? agentRes.files : [];
        setAgents({ files, summary: agentRes?.summary ?? null });
        setDeletionPatterns(delRes?.patterns || []);
        // An entirely empty language folder is worth saying out loud once —
        // otherwise all four buttons are just silently disabled.
        if (files.length === 0) {
          setStatusMessage(t('spu.st.noAgentFolder').replace('{lang}', agentFolder));
        }
      } catch (e: any) {
        if (!cancelled) setStatusMessage(`Agent load failed: ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentFolder]);

  // ── Load the archived changelog for display (read-only; never in context) ──
  useEffect(() => {
    if (!open || !summaryKey) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/changelogs?folder=${encodeURIComponent(folderName)}&title=${encodeURIComponent(summaryKey)}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && typeof d?.content === 'string') setChangelogText(d.content);
      } catch { /* none yet */ }
    })();
    return () => { cancelled = true; };
  }, [open, summaryKey, folderName]);

  // ── Token recount (debounced) ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(async () => setLeftTokens(await countTokens(leftText, aiName)), 350);
    return () => clearTimeout(h);
  }, [open, leftText, aiName]);
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(async () => setRightTokens(await countTokens(rightText, aiName)), 350);
    return () => clearTimeout(h);
  }, [open, rightText, aiName]);

  // ── Diff snapshot debounce ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(() => setDiffLeft(leftText), 450);
    return () => clearTimeout(h);
  }, [open, leftText]);
  useEffect(() => {
    // Don't recompute the diff while the agent is streaming into the right pane
    // — the snapshot is frozen until the run finishes/aborts (streamingUpdate
    // flips false), at which point this effect re-runs against the final text.
    if (!open || streamingUpdate) return;
    const h = setTimeout(() => setDiffRight(rightText), 450);
    return () => clearTimeout(h);
  }, [open, rightText, streamingUpdate]);

  // ── Load the existing summary ────────────────────────────────────────────
  useEffect(() => {
    if (!open || !summaryKey) return;
    if (summaryLoadedFor === summaryKey) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&title=${encodeURIComponent(summaryKey)}`);
        const d = await r.json();
        if (cancelled) return;
        const content = d?.content || '';
        setSummaryText(content);
        lastSavedSummaryRef.current = content;
        setSummaryLoadedFor(summaryKey);
        setSummaryStatus({ state: 'idle' });
      } catch {
        if (!cancelled) setSummaryLoadedFor(summaryKey);
      }
    })();
    return () => { cancelled = true; };
  }, [open, summaryKey, folderName, summaryLoadedFor]);

  // ── Recount summary tokens ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const h = setTimeout(async () => setSummaryTokens(await countTokens(summaryText, aiName)), 350);
    return () => clearTimeout(h);
  }, [open, summaryText, aiName]);

  // ── Load the live summaries index (the auto-generated Layer 4) ────────────
  // Mirrors what the entity sees at send time (oldest→newest, inactive + the
  // current conversation excluded). Fed to the updater agent as reference-only
  // Layer 4. Re-fetched after a Write Summary run so it reflects the new summary.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&mode=index&current=${encodeURIComponent(convoId)}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled) setSummaryIndexBody(d?.body || '');
      } catch { /* keep previous value */ }
    })();
    return () => { cancelled = true; };
  }, [open, folderName, convoId, summaryText]);

  // ── Auto-save summary ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || !summaryKey) return;
    if (lastSavedSummaryRef.current === null) return;
    if (summaryText === lastSavedSummaryRef.current) return;
    const h = setTimeout(async () => {
      setAutoSaveState('saving');
      try {
        const r = await fetch('/api/summaries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folderName, title: summaryKey, content: summaryText }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        lastSavedSummaryRef.current = summaryText;
        setAutoSaveState('saved');
      } catch { setAutoSaveState('error'); }
    }, 800);
    return () => clearTimeout(h);
  }, [open, summaryKey, folderName, summaryText]);

  // ── Auto-save LEFT → <baseName>_<currentIndex>.md ────────────────────────
  useEffect(() => {
    if (!open) return;
    if (lastSavedLeftRef.current === null) return;
    if (leftText === lastSavedLeftRef.current) return;
    const h = setTimeout(async () => {
      setAutoSaveState('saving');
      try {
        const r = await fetch('/api/system-prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: baseName, index: currentIndex, contents: leftText }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        lastSavedLeftRef.current = leftText;
        setAutoSaveState('saved');
      } catch { setAutoSaveState('error'); }
    }, 800);
    return () => clearTimeout(h);
  }, [open, leftText, baseName, currentIndex]);

  // ── Auto-save RIGHT → <baseName>_<currentIndex+1>.md ─────────────────────
  useEffect(() => {
    // Suppress auto-save during live streaming (don't persist the raw partial
    // with the sentinel). When streaming ends this re-runs and saves the final.
    if (!open || streamingUpdate) return;
    if (lastSavedRightRef.current === null) return;
    if (rightText === lastSavedRightRef.current) return;
    const h = setTimeout(async () => {
      setAutoSaveState('saving');
      try {
        const r = await fetch('/api/system-prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: baseName, index: currentIndex + 1, contents: rightText }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        lastSavedRightRef.current = rightText;
        setAutoSaveState('saved');
      } catch { setAutoSaveState('error'); }
    }, 800);
    return () => clearTimeout(h);
  }, [open, rightText, baseName, currentIndex, streamingUpdate]);

  // ── Auto-save header / focus / summary settings ──────────────────────────
  useEffect(() => {
    if (!open || !folder) return;
    if (lastSavedFolderRef.current === null) return;
    const snapshot = JSON.stringify({
      header, focusPoint, summaryInstructions, summaryIndexHint,
      forceUpdaterModel, updaterModelKey, forceMimoForSummary,
    });
    if (snapshot === lastSavedFolderRef.current) return;
    const h = setTimeout(async () => {
      setAutoSaveState('saving');
      try {
        await saveFolderSettings(folderName, {
          systemPromptHeader: header,
          systemPromptFocusPoint: focusPoint,
          summaryInstructions,
          summaryIndexHint,
          forceUpdaterModel,
          updaterModelKey,
          // Written alongside the new key so an older Nexus build reading this
          // folder still sees a sensible override flag.
          forceGlmForUpdates: forceUpdaterModel,
          forceMimoForSummary,
        });
        lastSavedFolderRef.current = snapshot;
        setAutoSaveState('saved');
      } catch { setAutoSaveState('error'); }
    }, 800);
    return () => clearTimeout(h);
  }, [open, folder, folderName, header, focusPoint, summaryInstructions, summaryIndexHint,
      forceUpdaterModel, updaterModelKey, forceMimoForSummary, saveFolderSettings]);

  // ── Conversation log formatting ──────────────────────────────────────────
  const conversationLogText = useMemo(() => {
    return originalMessages
      .map((m) => {
        const speaker = m.role === 'user' ? (m.name || 'User') : (m.name || baseName);
        return `[${speaker}]\n${m.content || ''}`;
      })
      .join('\n\n');
  }, [originalMessages, baseName]);

  // ── One streaming /api/chat call. Returns the accumulated visible text for
  // THIS call, reporting live progress through `onProgress`. Throws on error.
  const streamChat = useCallback(async (
    messages: any[],
    sys: string,
    runAiName: string,
    runModel: string,
    onProgress: (thinkingDelta: number, outputDelta: number, textChunk?: string) => void,
    signal?: AbortSignal,
    // Claude only: forces the billing path. Omitted → the route's usual 'auto'.
    runAuthMode?: 'oauth' | 'api-key',
  ): Promise<string> => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        messages,
        aiName: runAiName,
        folderName,
        systemPrompt: sys,
        toolUseEnabled: false,
        // `sys` here is an AGENT's instruction file, not the entity's identity.
        // Without this the chat route appends the entity's FOOTER.md to it as
        // "Layer 5: The Signature (Self-Authored)" — the agent would read the
        // target's first-person signature as part of its OWN instructions. The
        // footer is still shown to the agent, explicitly labelled as
        // reference-only, inside the user message.
        suppressLayer5: true,
        modelParams: { ...modelParams, claudeThinking: false },
        specificModel: runModel,
        ...(runAuthMode ? { claudeAuthMode: runAuthMode } : {}),
        dateTimeVisibility: 'none',
        creativityControlEnabled: false,
        seedEnabled: false,
      }),
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      throw new Error(errText || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let accum = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() || '';
      for (const ev of events) {
        if (!ev.startsWith('data: ')) continue;
        const s = ev.slice(6);
        if (s === '[DONE]') continue;
        try {
          const d = JSON.parse(s);
          if (d?.type === 'thought' && typeof d.content === 'string') onProgress(d.content.length, 0);
          if (d?.type === 'text' && typeof d.content === 'string') {
            accum += d.content;
            onProgress(0, d.content.length, d.content);
          }
          if (d?.error) throw new Error(d.error);
        } catch (e: any) {
          if (e?.message && !e.message.startsWith('Unexpected')) throw e;
        }
      }
    }
    return accum;
  }, [folderName, modelParams]);

  // ── Run the single identity (Layers 1-3) update ──────────────────────────
  // ONE agent, ONE logical pass over the whole identity. Supports continuation:
  // if the model hits its output cap (no END sentinel yet), we prefill-continue
  // with what we have so far until the sentinel appears or a safety cap is hit.
  const runUpdate = useCallback(async (withConversation: boolean): Promise<string | null> => {
    // "Update from Conversation" always runs updater.md; "Reorganize (No
    // Conversation)" always runs defragmenter.md. There is no shared file
    // picker anymore — each mode owns its own fixed filename.
    const agentFilename = withConversation ? AGENT_FILE_UPDATE : AGENT_FILE_REORGANIZE;
    const agent = getAgentFile(agentFilename);
    if (!agent) {
      setStatusMessage(
        t('spu.st.noAgentFile').replace('{file}', agentFilename).replace('{lang}', agentFolder)
      );
      return null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUpdateStatus({ state: 'called' });
    // Enter live-streaming mode: the right pane becomes a read-only live preview
    // and the diff/compare is frozen until the run ends or is stopped.
    setStreamingUpdate(true);
    setStatusMessage(withConversation
      ? t('spu.st.updating')
      : t('spu.st.refining'));

    const focus = focusPoint.trim();
    // Snapshot BEFORE anything can overwrite the pane. Streaming assigns into
    // rightText from the first chunk, so reading it later would be too late.
    const resumeText = resumeFromRight ? rightText.trim() : '';
    const userMsg = buildUpdateUserMsg({
      lang: agentFolder,
      baseName,
      withConversation,
      focus,
      header,
      leftText,
      summaryIndexBody,
      entityFooter,
      conversationLogText,
      resumeText,
      endSentinel: END_SENTINEL,
    })

    let thinkingChars = 0;
    let outputChars = 0;
    // Live text accumulated across all continuation rounds. Streamed straight
    // into the right pane as it arrives (raw — sentinel/logs are tidied up only
    // at the end). Normally the first chunk replaces any previous draft; when
    // resuming, it is SEEDED with the salvaged text so the pane keeps showing
    // the whole document and the final result is partial + continuation.
    let liveAccum = resumeText ? resumeText + '\n' : '';
    const onProgress = (t: number, o: number, chunk?: string) => {
      thinkingChars += t;
      outputChars += o;
      if (chunk) {
        liveAccum += chunk;
        setRightText(liveAccum);
      }
      setUpdateStatus(outputChars > 0
        ? { state: 'outputting', thinkingChars, outputChars }
        : { state: 'thinking', thinkingChars, outputChars });
    };

    const MAX_CONTINUATIONS = 6;
    // Seeded on resume so the salvaged part is included in the saved result,
    // not just in the live preview.
    let accum = resumeText ? resumeText + '\n' : '';
    try {
      for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        if (controller.signal.aborted) break;
        // First attempt: just the user message. Continuations: prefill the
        // assistant turn with everything produced so far so the model resumes
        // exactly where it stopped (works for GLM/OpenAI-compat prefill).
        const messages = attempt === 0
          ? [{ role: 'user', content: userMsg, timestamp: Date.now() }]
          : [{ role: 'user', content: userMsg, timestamp: Date.now() },
             { role: 'assistant', content: accum, timestamp: Date.now() }];
        const piece = await streamChat(messages, agent.systemPrompt, effectiveAiName, effectiveSpecificModel, onProgress, controller.signal, effectiveAuthMode);
        accum += piece;
        if (accum.includes(END_SENTINEL)) break;        // finished cleanly
        if (!piece.trim()) break;                       // model produced nothing new
        if (attempt < MAX_CONTINUATIONS) {
          setStatusMessage(t('spu.st.continuation').replace('{n}', String(attempt + 1)));
        }
      }

      // Strip the sentinel (and any trailing whitespace around it).
      const cleaned = accum.replace(new RegExp(END_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), '')
        .split(END_SENTINEL).join('')
        .trim();

      // If the user hit Stop, keep whatever was produced (don't discard it) but
      // mark it clearly. Still split logs / set right so partial work isn't lost.
      if (!cleaned) {
        if (controller.signal.aborted) {
          setUpdateStatus({ state: 'idle' });
          setStatusMessage(t('spu.st.updateStoppedEmpty'));
          return null;
        }
        const msg = t('spu.st.emptyResponse');
        setUpdateStatus({ state: 'error', message: msg });
        setStatusMessage(t('spu.st.updateNoText'));
        return null;
      }

      // 1) Split off the CHANGELOG (everything above the first "## Layer 1").
      //    It is shown read-only, archived to local_data/changelogs/<folder>/
      //    <title>.md, and never enters any context window.
      // 2) From "## Layer 1" onward is the CORE; split off any trailing
      //    Abbreviations/Deletions logs so only the actual Layers 1-3 are saved.
      const { changelog, core } = splitOffChangelog(cleaned);
      const { layers: layersOut, logs } = splitOffLogs(core);
      setChangelogText(changelog);
      setRightText(layersOut);
      setUpdateLogs(logs);
      // Archive the changelog (fire-and-forget; never re-injected anywhere).
      if (changelog) {
        fetch('/api/changelogs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folderName, title, content: changelog }),
        }).catch(() => {});
      }
      if (controller.signal.aborted) {
        setUpdateStatus({ state: 'done', thinkingChars, outputChars });
        setStatusMessage(t('spu.st.updateStoppedPartial').replace('{n}', String(layersOut.length)));
        return null;
      }
      setUpdateStatus({ state: 'done', thinkingChars, outputChars });
      setStatusMessage(
        t('spu.st.updateDone').replace('{n}', String(layersOut.length)) +
        (changelog ? t('spu.st.changelogSaved').replace('{n}', String(changelog.length)) : '') +
        (logs ? t('spu.st.logsSeparated').replace('{n}', String(logs.length)) : '') + t('spu.st.period')
      );
      return layersOut;
    } catch (e: any) {
      // A user-triggered abort surfaces as an AbortError — treat it as a clean
      // stop, not a failure.
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        setUpdateStatus({ state: 'idle' });
        setStatusMessage(t('spu.st.updateStopped'));
        return null;
      }
      const msg = e?.message || 'unknown error';
      setUpdateStatus({ state: 'error', message: msg });
      setStatusMessage(t('spu.st.updateFailed').replace('{e}', msg));
      return null;
    } finally {
      // Leave live-streaming mode: right pane editable again, diff recomputes.
      setStreamingUpdate(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
    // resumeFromRight / rightText are read at call time to build the resume
    // block — without them here the callback would close over stale values and
    // silently resume from an out-of-date pane (or not resume at all).
  }, [getAgentFile, baseName, conversationLogText, effectiveAiName, effectiveSpecificModel, effectiveAuthMode, focusPoint, header, leftText, agentFolder, streamChat, summaryIndexBody, folderName, title, resumeFromRight, rightText, entityFooter]);

  // ── Run the Layers 1-4 redistribution ────────────────────────────────────
  // A third mode, separate from both update paths above. The agent sees the
  // whole identity — header, Layers 1-3, the live Layer 4 index, the entity's
  // own Layer 5 — and NO conversation log, and is asked to move material
  // BETWEEN the layers: promote what has settled out of the episodic summaries
  // into the standing identity, and shorten the summaries it drew from.
  //
  // Two things make this different from runUpdate():
  //
  //  1) The instruction block is deliberately thin. runUpdate() tells the agent
  //     three separate times to emit Layers 1-3 only, which is why an agent file
  //     asking for anything else appeared to be ignored — the user message was
  //     overriding it. Here the agent file governs; NEXUS only states the output
  //     contract it has to parse, and what happens to each part afterwards.
  //
  //  2) Layer 4 is written back to the summary FILES, not into the prompt. The
  //     whole folder is copied to local_data/backups/<entity>/summaries/<time>/
  //     before a single byte is written, in the same request as the writes.
  const runRedistribute = useCallback(async (): Promise<boolean> => {
    const agent = getAgentFile(AGENT_FILE_REDISTRIBUTE);
    if (!agent) {
      setStatusMessage(
        t('spu.st.noAgentFile').replace('{file}', AGENT_FILE_REDISTRIBUTE).replace('{lang}', agentFolder)
      );
      return false;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUpdateStatus({ state: 'called' });
    setStreamingUpdate(true);
    setRedistributeReport(null);
    setStatusMessage(t('spu.st.redistributing'));

    // Fetch the FULL index, without the `current` exclusion the reference copy
    // uses: this pass rewrites the summary files themselves, so leaving the open
    // conversation out would make its summary the one file that can never be
    // touched here.
    let fullIndex = summaryIndexBody;
    try {
      const r = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&mode=index`);
      if (r.ok) fullIndex = (await r.json())?.body || fullIndex;
    } catch { /* fall back to the reference index */ }

    const focus = focusPoint.trim();
    const resumeText = resumeFromRight ? rightText.trim() : '';
    const userMsg = buildRedistributeUserMsg({
      lang: agentFolder,
      baseName,
      focus,
      header,
      leftText,
      fullIndex,
      folderName,
      entityFooter,
      resumeText,
      endSentinel: END_SENTINEL,
    })

    let thinkingChars = 0;
    let outputChars = 0;
    let liveAccum = resumeText ? resumeText + '\n' : '';
    const onProgress = (t: number, o: number, chunk?: string) => {
      thinkingChars += t;
      outputChars += o;
      if (chunk) {
        liveAccum += chunk;
        setRightText(liveAccum);
      }
      setUpdateStatus(outputChars > 0
        ? { state: 'outputting', thinkingChars, outputChars }
        : { state: 'thinking', thinkingChars, outputChars });
    };

    const MAX_CONTINUATIONS = 6;
    let accum = resumeText ? resumeText + '\n' : '';
    try {
      for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        if (controller.signal.aborted) break;
        const messages = attempt === 0
          ? [{ role: 'user', content: userMsg, timestamp: Date.now() }]
          : [{ role: 'user', content: userMsg, timestamp: Date.now() },
             { role: 'assistant', content: accum, timestamp: Date.now() }];
        const piece = await streamChat(messages, agent.systemPrompt, effectiveAiName, effectiveSpecificModel, onProgress, controller.signal, effectiveAuthMode);
        accum += piece;
        if (accum.includes(END_SENTINEL)) break;
        if (!piece.trim()) break;
        if (attempt < MAX_CONTINUATIONS) {
          setStatusMessage(t('spu.st.continuation').replace('{n}', String(attempt + 1)));
        }
      }

      const sawSentinel = accum.includes(END_SENTINEL);
      const cleaned = accum.replace(new RegExp(END_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), '')
        .split(END_SENTINEL).join('')
        .trim();

      if (!cleaned) {
        if (controller.signal.aborted) {
          setUpdateStatus({ state: 'idle' });
          setStatusMessage(t('spu.st.redistStoppedEmpty'));
          return false;
        }
        const msg = t('spu.st.emptyResponse');
        setUpdateStatus({ state: 'error', message: msg });
        setStatusMessage(t('spu.st.redistNoText'));
        return false;
      }

      // A run that was stopped, or that never printed the completion marker, is
      // by definition incomplete — writing its Layer 4 back would replace real
      // summaries with half-written ones. Keep the RAW output in the right pane
      // (not the split-out Layers 1-3), because that is what "Continue from the
      // right-side text" hands back to the agent to resume from: splitting here
      // would silently throw away the partial Layer 4 it needs to continue.
      if (controller.signal.aborted || !sawSentinel) {
        setRightText(cleaned);
        setUpdateStatus({ state: 'done', thinkingChars, outputChars });
        setStatusMessage(controller.signal.aborted
          ? t('spu.st.redistStoppedPartial').replace('{n}', String(cleaned.length))
          : t('spu.st.redistTruncated').replace('{n}', String(cleaned.length)));
        return false;
      }

      // changelog | Layers 1-3 | Layer 4 | trailing logs
      const { changelog, core } = splitOffChangelog(cleaned);
      const { before: layers123Raw, layer4, after: pastLayer4 } = splitOffLayer4(core);
      const { layers: layers123 } = splitOffLogs(layers123Raw);
      const { layers: layer4Body, logs: layer4Logs } = splitOffLogs(layer4);
      // Anything past Layer 4 is a layer the agent was told not to write (Layer
      // 5 is the entity's own). It is kept only in the read-only logs pane so
      // the user can see it happened — never saved anywhere.
      const logs = [
        layer4Logs,
        pastLayer4 ? `## [Discarded — output past Layer 4 (not saved anywhere)]\n${pastLayer4}` : '',
      ].filter(Boolean).join('\n\n');
      const entries = parseSummaryEntries(layer4Body);

      setChangelogText(changelog);
      setRightText(layers123);
      setUpdateLogs(logs);
      if (changelog) {
        fetch('/api/changelogs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folderName, title, content: changelog }),
        }).catch(() => {});
      }

      if (!layer4) {
        setUpdateStatus({ state: 'done', thinkingChars, outputChars });
        setStatusMessage(t('spu.st.redistNoLayer4'));
        return false;
      }
      if (entries.length === 0) {
        setUpdateStatus({ state: 'done', thinkingChars, outputChars });
        setStatusMessage(t('spu.st.redistNoEntries'));
        return false;
      }

      setStatusMessage(t('spu.st.redistBackingUp').replace('{folder}', folderName).replace('{n}', String(entries.length)));
      const res = await fetch('/api/summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'replaceMany', folder: folderName, entries }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const report: RedistributeReport = {
        backupDir: data.backupDir ?? null,
        backedUp: data.backedUp ?? 0,
        replaced: data.replaced ?? [],
        created: data.created ?? [],
        skipped: data.skipped ?? [],
      };
      setRedistributeReport(report);
      setUpdateStatus({ state: 'done', thinkingChars, outputChars });
      setStatusMessage(
        t('spu.st.redistDone').replace('{n}', String(layers123.length)).replace('{r}', String(report.replaced.length)) +
        (report.created.length ? t('spu.st.redistCreated').replace('{n}', String(report.created.length)) : '') +
        (report.skipped.length ? t('spu.st.redistSkipped').replace('{n}', String(report.skipped.length)) : '') +
        (report.backedUp ? t('spu.st.redistBackedUp').replace('{n}', String(report.backedUp)) : t('spu.st.redistNoBackup')) +
        (changelog ? t('spu.st.changelogSavedShort') : '') + t('spu.st.period')
      );
      // The reference index is now stale — refresh it from disk.
      try {
        const r = await fetch(`/api/summaries?folder=${encodeURIComponent(folderName)}&mode=index&current=${encodeURIComponent(convoId)}`);
        if (r.ok) setSummaryIndexBody((await r.json())?.body || '');
      } catch { /* keep previous value */ }
      return true;
    } catch (e: any) {
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        setUpdateStatus({ state: 'idle' });
        setStatusMessage(t('spu.st.redistStopped'));
        return false;
      }
      const msg = e?.message || 'unknown error';
      setUpdateStatus({ state: 'error', message: msg });
      setStatusMessage(t('spu.st.redistFailed').replace('{e}', msg));
      return false;
    } finally {
      setStreamingUpdate(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [getAgentFile, baseName, convoId, effectiveAiName, effectiveSpecificModel, effectiveAuthMode, entityFooter, focusPoint, folderName, header, leftText, resumeFromRight, rightText, agentFolder, streamChat, summaryIndexBody, title]);

  // ── Run the genesis (first-time) construction ────────────────────────────
  // A fourth mode, distinct from all three above: it assumes NO prior Layers
  // 1-3 exist at all — this is the bootstrap pass genesis_extractor.md is built
  // for. It is fed the conversation log (and, if present, the current left-pane
  // text as extra source material — genesis doesn't require an empty left pane,
  // it just doesn't treat whatever IS there as authoritative) and is told not
  // to emit a changelog (there is nothing yet to diff against) or Layer 4/5.
  // Output lands in the right pane, same as every other mode, for review before
  // "Go to Next Conversation" promotes it.
  const runGenesis = useCallback(async (): Promise<string | null> => {
    const agent = getAgentFile(AGENT_FILE_GENESIS);
    if (!agent) {
      setStatusMessage(
        t('spu.st.noAgentFile').replace('{file}', AGENT_FILE_GENESIS).replace('{lang}', agentFolder)
      );
      return null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUpdateStatus({ state: 'called' });
    setStreamingUpdate(true);
    setStatusMessage(t('spu.st.genesisRunning'));

    const focus = focusPoint.trim();
    const resumeText = resumeFromRight ? rightText.trim() : '';
    const userMsg = buildGenesisUserMsg({
      lang: agentFolder,
      baseName,
      focus,
      header,
      conversationLogText,
      leftText,
      resumeText,
      endSentinel: END_SENTINEL,
    })

    let thinkingChars = 0;
    let outputChars = 0;
    let liveAccum = resumeText ? resumeText + '\n' : '';
    const onProgress = (t: number, o: number, chunk?: string) => {
      thinkingChars += t;
      outputChars += o;
      if (chunk) {
        liveAccum += chunk;
        setRightText(liveAccum);
      }
      setUpdateStatus(outputChars > 0
        ? { state: 'outputting', thinkingChars, outputChars }
        : { state: 'thinking', thinkingChars, outputChars });
    };

    const MAX_CONTINUATIONS = 6;
    let accum = resumeText ? resumeText + '\n' : '';
    try {
      for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
        if (controller.signal.aborted) break;
        const messages = attempt === 0
          ? [{ role: 'user', content: userMsg, timestamp: Date.now() }]
          : [{ role: 'user', content: userMsg, timestamp: Date.now() },
             { role: 'assistant', content: accum, timestamp: Date.now() }];
        const piece = await streamChat(messages, agent.systemPrompt, effectiveAiName, effectiveSpecificModel, onProgress, controller.signal, effectiveAuthMode);
        accum += piece;
        if (accum.includes(END_SENTINEL)) break;
        if (!piece.trim()) break;
        if (attempt < MAX_CONTINUATIONS) {
          setStatusMessage(t('spu.st.continuation').replace('{n}', String(attempt + 1)));
        }
      }

      const cleaned = accum.replace(new RegExp(END_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$'), '')
        .split(END_SENTINEL).join('')
        .trim();

      if (!cleaned) {
        if (controller.signal.aborted) {
          setUpdateStatus({ state: 'idle' });
          setStatusMessage(t('spu.st.genesisStoppedEmpty'));
          return null;
        }
        const msg = t('spu.st.emptyResponse');
        setUpdateStatus({ state: 'error', message: msg });
        setStatusMessage(t('spu.st.genesisNoText'));
        return null;
      }

      // genesis_extractor.md is told not to emit a changelog, so this is
      // normally a no-op; splitOffChangelog is still run defensively in case
      // the model produces preamble anyway — it must never end up saved.
      const { changelog, core } = splitOffChangelog(cleaned);
      const { layers: layersOut, logs } = splitOffLogs(core);
      setChangelogText(changelog);
      setRightText(layersOut);
      setUpdateLogs(logs);
      if (changelog) {
        fetch('/api/changelogs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder: folderName, title, content: changelog }),
        }).catch(() => {});
      }
      if (controller.signal.aborted) {
        setUpdateStatus({ state: 'done', thinkingChars, outputChars });
        setStatusMessage(t('spu.st.genesisStoppedPartial').replace('{n}', String(layersOut.length)));
        return null;
      }
      setUpdateStatus({ state: 'done', thinkingChars, outputChars });
      setStatusMessage(
        t('spu.st.genesisDone').replace('{n}', String(layersOut.length)) +
        (logs ? t('spu.st.logsSeparated').replace('{n}', String(logs.length)) : '') + t('spu.st.period')
      );
      return layersOut;
    } catch (e: any) {
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        setUpdateStatus({ state: 'idle' });
        setStatusMessage(t('spu.st.genesisStopped'));
        return null;
      }
      const msg = e?.message || 'unknown error';
      setUpdateStatus({ state: 'error', message: msg });
      setStatusMessage(t('spu.st.genesisFailed').replace('{e}', msg));
      return null;
    } finally {
      setStreamingUpdate(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [getAgentFile, baseName, conversationLogText, effectiveAiName, effectiveSpecificModel, effectiveAuthMode, focusPoint, header, leftText, agentFolder, streamChat, folderName, title, resumeFromRight, rightText]);


  // First-message timestamp for summary baking
  const firstMessageTimestamp = useMemo(() => {
    for (const m of originalMessages) {
      if (m.timestamp && m.timestamp > 0) return m.timestamp;
    }
    return null;
  }, [originalMessages]);

  // Format as [YYYY-MM-DD HH:MM]
  const firstMessageTsStr = useMemo(() => {
    if (!firstMessageTimestamp) return '';
    const d = new Date(firstMessageTimestamp);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}]`;
  }, [firstMessageTimestamp]);

  // ── Run the summary writer (separate call, separate model) ───────────────
  // Writing a summary and not reading it back is a dead end: the summary lands
  // in local_data/summaries/, the next conversation's Layer 4 index is built
  // from those files, and the identity sees NONE of it unless
  // "Use summaries instead of the 4th layer" is on. That switch being off after
  // a summary has been written is never what anyone wanted — it just looks like
  // the identity has forgotten everything. So the first successful summary turns
  // it on for this entity. Idempotent, and only ever ON: an entity that has it
  // on stays on, and nothing here can turn it off.
  const enableSummariesForLayer4 = useCallback(async () => {
    if (folder?.settings?.useSummariesForLayer4 === true) return false;
    try {
      await saveFolderSettings(folderName, { useSummariesForLayer4: true });
      return true;
    } catch {
      return false;
    }
  }, [folder, folderName, saveFolderSettings]);

  const runSummaryWrite = useCallback(async (): Promise<string | null> => {
    const summaryAgentPrompt =
      agents?.summary?.systemPrompt ||
      defaultSummaryAgentPrompt(agentFolder);

    const identityText = assembleLayers123(leftText);

    const controller = new AbortController();
    abortRef.current = controller;
    setSummaryStatus({ state: 'called' });
    setStatusMessage(t('spu.st.summaryWriting'));

    const customInstr = summaryInstructions.trim();
    const userMsg = buildSummaryUserMsg({
      lang: agentFolder,
      baseName,
      customInstr,
      identityText,
      summaryIndexBody,
      entityFooter,
      conversationLogText,
    })

    let thinkingChars = 0;
    let outputChars = 0;
    const onProgress = (t: number, o: number) => {
      thinkingChars += t;
      outputChars += o;
      setSummaryStatus(outputChars > 0
        ? { state: 'outputting', thinkingChars, outputChars }
        : { state: 'thinking', thinkingChars, outputChars });
    };

    try {
      const accum = await streamChat(
        [{ role: 'user', content: userMsg, timestamp: Date.now() }],
        summaryAgentPrompt, summaryAiName, summarySpecificModel, onProgress, controller.signal, summaryAuthMode,
      );
      if (!accum.trim()) {
        if (controller.signal.aborted) {
          setSummaryStatus({ state: 'idle' });
          setStatusMessage(t('spu.st.summaryStoppedEmpty'));
          return null;
        }
        const msg = t('spu.st.emptyResponse');
        setSummaryStatus({ state: 'error', message: msg });
        setStatusMessage(t('spu.st.summaryNoText'));
        return null;
      }
      const tsPrefix = firstMessageTsStr ? firstMessageTsStr + ' ' : '';
      const newSummary = tsPrefix + accum.trim();
      setSummaryText(newSummary);
      setSummaryStatus({ state: 'done', thinkingChars, outputChars });
      // Even a stopped-partial summary is a summary on disk, so the switch is
      // flipped for both outcomes. Reported in the status line rather than done
      // silently — a setting that changes itself should say so.
      const turnedOn = await enableSummariesForLayer4();
      setStatusMessage(
        (controller.signal.aborted
          ? t('spu.st.summaryStoppedPartial').replace('{n}', String(newSummary.length))
          : t('spu.st.summaryDone').replace('{n}', String(newSummary.length)))
        + (turnedOn ? ' ' + t('spu.st.summariesEnabled') : '')
      );
      return controller.signal.aborted ? null : newSummary;
    } catch (e: any) {
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        setSummaryStatus({ state: 'idle' });
        setStatusMessage(t('spu.st.summaryStopped'));
        return null;
      }
      const msg = e?.message || 'unknown error';
      setSummaryStatus({ state: 'error', message: msg });
      setStatusMessage(t('spu.st.summaryFailed').replace('{e}', msg));
      return null;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [agents, baseName, conversationLogText, leftText, streamChat, summaryAiName, summaryInstructions, summarySpecificModel, summaryAuthMode, summaryIndexBody, entityFooter, firstMessageTsStr, enableSummariesForLayer4, agentFolder]);

  // ── Button handlers ──────────────────────────────────────────────────────
  // Stop the current agent run (update / summary / auto) — same idea as the
  // conversation Stop button. Aborts the in-flight fetch/stream.
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch {}
    }
  }, []);

  // "Update from Conversation" — runs updater.md WITH the conversation log.
  const handleUpdate = useCallback(async () => {
    if (running !== null) return;
    setRunning('update');
    try { await runUpdate(true); } finally { setRunning(null); }
  }, [running, runUpdate]);

  // "Reorganize (No Conversation)" — runs defragmenter.md on the system prompt
  // itself, with no conversation log fed to the agent.
  const handleUpdateNoConvo = useCallback(async () => {
    if (running !== null) return;
    setRunning('update');
    try { await runUpdate(false); } finally { setRunning(null); }
  }, [running, runUpdate]);

  // "Redistribute Layer 4 → 1-3" — runs interlayer_redistributor.md. The agent
  // sees Layers 1-5 and no conversation log, and rewrites Layers 1-3 AND the
  // summary files behind Layer 4.
  const handleRedistribute = useCallback(async () => {
    if (running !== null) return;
    setRunning('redistribute');
    try { await runRedistribute(); } finally { setRunning(null); }
  }, [running, runRedistribute]);

  // "Genesis (Build From Scratch)" — runs genesis_extractor.md. Assumes no
  // prior Layers 1-3 exist; builds them from the conversation log (and left
  // pane, if any) with no changelog and no Layer 4/5.
  const handleGenesis = useCallback(async () => {
    if (running !== null) return;
    setRunning('genesis');
    try { await runGenesis(); } finally { setRunning(null); }
  }, [running, runGenesis]);

  const handleWriteSummary = useCallback(async () => {
    if (running !== null) return;
    setRunning('summary');
    try { await runSummaryWrite(); } finally { setRunning(null); }
  }, [running, runSummaryWrite]);

  const handleAuto = useCallback(async () => {
    if (running !== null) return;
    setRunning('auto');
    try {
      const updated = await runUpdate(true);
      if (updated === null) {
        setStatusMessage((p) => `${p}  ⛔ Auto stopped at the identity update. Fix the error (or it was stopped) and retry.`);
        return;
      }
      const s = await runSummaryWrite();
      if (s === null) {
        setStatusMessage((p) => `${p}  ⛔ Auto stopped at the summary step. Fix the error (or it was stopped) and retry.`);
        return;
      }
      setStatusMessage('Identity updated and summary written. Review, then click "Go to Next Conversation" when ready.');
    } finally {
      setRunning(null);
    }
  }, [running, runUpdate, runSummaryWrite]);

  // ── Persist header/focus on blur ─────────────────────────────────────────
  const persistHeaderFooter = useCallback(async () => {
    if (!folder) return;
    try {
      await saveFolderSettings(folderName, {
        systemPromptHeader: header,
        systemPromptFocusPoint: focusPoint,
        summaryInstructions,
        summaryIndexHint,
      });
      lastSavedFolderRef.current = JSON.stringify({ header, focusPoint, summaryInstructions, summaryIndexHint });
    } catch {}
  }, [folder, folderName, header, focusPoint, summaryInstructions, summaryIndexHint, saveFolderSettings]);

  // FOOTER.md is a FILE, not a folder setting, so it saves through its own
  // route rather than saveFolderSettings. Only writes when the text actually
  // changed: this file is normally the entity's to edit, and a no-op save would
  // churn a backup for nothing.
  const persistEntityFooter = useCallback(async () => {
    if (!folderName || entityFooter === entityFooterSaved) return;
    try {
      const res = await fetch('/api/footer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folderName, body: entityFooter }),
      });
      if (!res.ok) throw new Error((await res.json())?.error || 'save failed');
      setEntityFooterSaved(entityFooter);
      setEntityFooterExists(true);
      setEntityFooterStatus('saved');
      setTimeout(() => setEntityFooterStatus(null), 1800);
    } catch (e: any) {
      setEntityFooterStatus(`save failed: ${e?.message || 'unknown error'}`);
    }
  }, [folderName, entityFooter, entityFooterSaved]);

  // ── Go to Next Conversation ──────────────────────────────────────────────
  const goToNextConversation = useCallback(async () => {
    setLoading(true);
    setStatusMessage('Saving current + next prompt files…');
    try {
      const nextIndex = currentIndex + 1;

      // 1) Persist LEFT (current) to <baseName>_<currentIndex>.md.
      await fetch('/api/system-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: baseName, index: currentIndex, contents: leftText }),
      });

      // 2) Persist RIGHT (updated) as the next conversation's file.
      const saveRes = await fetch('/api/system-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: baseName, index: nextIndex, contents: rightText }),
      });
      if (!saveRes.ok) throw new Error('Failed to save next prompt file');

      // Apply deletion patterns, then prepend the header for the live prompt.
      let processed = rightText;
      for (const raw of deletionPatterns) {
        const m = raw.match(/^\/(.+)\/([a-z]*)$/);
        if (m) {
          try { processed = processed.replace(new RegExp(m[1], m[2]), ''); }
          catch { processed = processed.split(raw).join(''); }
        } else {
          processed = processed.split(raw).join('');
        }
      }
      processed = processed.replace(/\n{3,}/g, '\n\n');

      const fullPrompt = [header, processed].filter((s) => s && s.trim()).join('\n\n');

      setStatusMessage('Finalizing — cloning conversation…');
      await persistHeaderFooter();
      await onFinalize({ newSystemPrompt: fullPrompt, newIndex: nextIndex });
      onClose();
    } catch (e: any) {
      setStatusMessage(`Finalize failed: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [baseName, currentIndex, deletionPatterns, header, leftText, rightText, onClose, onFinalize, persistHeaderFooter]);

  if (!open) return null;

  const busy = running !== null || loading;

  return (
    <div className="fixed inset-0 bg-background/85 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-[1600px] h-[92vh] flex flex-col overflow-hidden">
        {/* Header bar */}
        <div className="px-6 py-3 border-b border-border flex items-center justify-between bg-secondary/30 shrink-0">
          <div className="flex items-center gap-3">
            <Layers size={20} className="text-indigo-500" />
            <div>
              <h2 className="text-lg font-bold leading-tight">{t('spu.title')}</h2>
              <div className="text-[11px] text-muted-foreground font-mono leading-snug">
                <div>
                  <span className="text-blue-500">Left:</span> {baseName}/{baseName}_{currentIndex}.md
                  {' · '}
                  <span className="text-blue-500">Right:</span> {baseName}/{baseName}_{currentIndex + 1}.md
                </div>
                <div className="opacity-70">
                  Model:{' '}
                  {forceUpdaterModel
                    ? <span className="text-indigo-500">{effectiveAiName} / {effectiveSpecificModel}{effectiveAuthMode === 'oauth' ? ' (OAuth)' : ''} <span className="opacity-70">(overriding {aiName}/{specificModel})</span></span>
                    : <span>{aiName} / {specificModel}</span>}
                  {' '}· {baseName}_{currentIndex} → _{currentIndex + 1} · Folder: {folderName}
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                autoSaveState === 'saving' ? 'text-amber-500'
                : autoSaveState === 'saved' ? 'text-emerald-500'
                : autoSaveState === 'error' ? 'text-red-500'
                : 'text-muted-foreground'}`}
              title={t('spu.autosaveTitle')}
            >
              {autoSaveState === 'saving' ? t('spu.saving')
                : autoSaveState === 'saved' ? t('spu.allSaved')
                : autoSaveState === 'error' ? t('spu.saveError')
                : t('spu.autosaveOn')}
            </span>
            {running !== null && (
              <button
                onClick={handleStop}
                className="px-3 py-1.5 bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 rounded-md text-sm font-medium flex items-center gap-1.5"
                title={t('spu.stopTitle')}
              >
                <Square size={14} /> {t('spu.stop')}
              </button>
            )}
            <button
              onClick={handleAuto}
              disabled={busy || !updateAgent}
              className="px-3 py-1.5 bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25 rounded-md text-sm font-medium flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('spu.autoTitle')}
            >
              {running === 'auto' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {t('spu.auto')}
            </button>
            <button
              onClick={goToNextConversation}
              disabled={busy}
              className="px-3 py-1.5 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 rounded-md text-sm font-medium flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('spu.nextTitle')}
            >
              <ChevronsRight size={14} /> {t('spu.next')}
            </button>
            <button onClick={onClose} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Status strip */}
        {statusMessage && (
          <div className="px-6 py-1.5 text-[11px] bg-muted/40 border-b border-border text-muted-foreground flex items-center gap-2">
            {busy && <Loader2 size={12} className="animate-spin" />}
            {statusMessage}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {/* Model-override row. The checkbox no longer names a model — it
              chooses between the shortlist below and the conversation's own
              model from System Instructions → Generation Parameters. */}
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={forceUpdaterModel}
                onChange={(e) => setForceUpdaterModel(e.target.checked)}
                className="rounded border-border text-indigo-500 focus:ring-indigo-500 bg-background"
              />
              <span className="font-medium">{t('spu.useDedicated')}</span>
            </label>
            <select
              value={updaterModelKey}
              onChange={(e) => setUpdaterModelKey(e.target.value)}
              disabled={!forceUpdaterModel}
              title={t('spu.updaterModelTitle')}
              className="px-2 py-1 bg-background border border-border rounded text-xs outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {UPDATER_MODELS.map(m => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
            <span className="text-[10px] text-muted-foreground">
              {forceUpdaterModel
                ? <>{t('spu.runsAs')} <span className="font-mono">{effectiveAiName} / {effectiveSpecificModel}</span>.</>
                : <>{t('spu.runsOff')} <span className="font-mono">{aiName} / {specificModel}</span>.</>}
            </span>
          </div>

          {/* Agent folder — follows the UI language; nothing to pick */}
          <div className="flex flex-col gap-1.5 px-3 py-2 border border-border rounded bg-muted/10">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{t('spu.agentFolder')}</span>
              <span className="px-2 py-1 bg-background border border-border rounded text-sm font-mono">
                {agentFolder}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {t('spu.agentFolderHint')}
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {t('spu.deletionPatterns')} <span className="font-mono text-foreground">{deletionPatterns.length}</span>
              </span>
            </div>
            {/* Each action button below runs its own FIXED filename from this
                type folder (see AGENT_FILE_* constants) — no per-run picker.
                This line is just visibility into which of the four canonical
                files were actually found, so a missing/misnamed file shows up
                here instead of as a silently-disabled button. */}
            <div className="text-[10px] font-mono text-muted-foreground leading-snug">
              <span className="text-indigo-500">{t('spu.agentFilesIn')}</span>{' '}
              <span className={updateAgent ? '' : 'text-red-500'}>{AGENT_FILE_UPDATE}{updateAgent ? '' : ' (' + t('spu.missing') + ')'}</span>
              {' · '}
              <span className={reorganizeAgent ? '' : 'text-red-500'}>{AGENT_FILE_REORGANIZE}{reorganizeAgent ? '' : ' (' + t('spu.missing') + ')'}</span>
              {' · '}
              <span className={redistributeAgent ? '' : 'text-red-500'}>{AGENT_FILE_REDISTRIBUTE}{redistributeAgent ? '' : ' (' + t('spu.missing') + ')'}</span>
              {' · '}
              <span className={genesisAgent ? '' : 'text-red-500'}>{AGENT_FILE_GENESIS}{genesisAgent ? '' : ' (' + t('spu.missing') + ')'}</span>
            </div>
          </div>

          {/* Header / Focus point */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">{t('spu.headerLabel')}</label>
              <textarea
                value={header}
                onChange={(e) => setHeader(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={3}
                placeholder={t('spu.headerPh')}
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
              />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">{t('spu.focusLabel')}</label>
              <textarea
                value={focusPoint}
                onChange={(e) => setFocusPoint(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={3}
                placeholder={t('spu.focusPh')}
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
              />
            </div>
          </div>

          {/* Identity (Layers 1-3) — single combined block, left vs right */}
          <div className="border border-border rounded-lg p-3 bg-muted/10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wider font-semibold text-indigo-500">{t('spu.identity')}</span>
                <span className="text-sm font-medium">{t('spu.identitySub')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusBadge status={updateStatus} />
                <button
                  onClick={handleGenesis}
                  disabled={busy || !genesisAgent}
                  className="px-2.5 py-1 text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 hover:bg-emerald-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('spu.genesisTitle').replace('{file}', AGENT_FILE_GENESIS)}
                >
                  {running === 'genesis' ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {t('spu.genesisBtn')}
                </button>
                <button
                  onClick={handleRedistribute}
                  disabled={busy || !redistributeAgent}
                  className="px-2.5 py-1 text-xs font-medium bg-purple-500/15 text-purple-600 dark:text-purple-300 hover:bg-purple-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('spu.redistributeTitle').replace('{file}', AGENT_FILE_REDISTRIBUTE)}
                >
                  {running === 'redistribute' ? <Loader2 size={12} className="animate-spin" /> : <Shuffle size={12} />}
                  {t('spu.redistributeBtn')}
                </button>
                <button
                  onClick={handleUpdateNoConvo}
                  disabled={busy || !reorganizeAgent}
                  className="px-2.5 py-1 text-xs font-medium bg-slate-500/15 text-slate-600 dark:text-slate-300 hover:bg-slate-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('spu.reorganizeTitle').replace('{file}', AGENT_FILE_REORGANIZE)}
                >
                  {running === 'update' ? <Loader2 size={12} className="animate-spin" /> : <FileX size={12} />}
                  {t('spu.reorganizeBtn')}
                </button>
                <button
                  onClick={handleUpdate}
                  disabled={busy || !updateAgent}
                  className="px-2.5 py-1 text-xs font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('spu.updateTitle').replace('{file}', AGENT_FILE_UPDATE)}
                >
                  {running === 'update' ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                  {t('spu.updateBtn')}
                </button>
              </div>
            </div>

            {/* Resume: rescue a run that died partway (a truncated OAuth Claude
                turn, a dropped connection, Stop). Auto-armed only when the
                right pane looks cut short, so a normal re-run over a COMPLETE
                draft isn't turned into "continue a finished document". */}
            {rightText.trim() && !streamingUpdate && (
              <label
                className={`mb-2 flex items-start gap-2 cursor-pointer select-none rounded px-2 py-1.5 border ${
                  resumeFromRight
                    ? 'border-amber-500/40 bg-amber-500/10'
                    : 'border-border bg-muted/20'
                }`}
              >
                <input
                  type="checkbox"
                  checked={resumeFromRight}
                  onChange={(e) => setResumeFromRight(e.target.checked)}
                  className="w-3.5 h-3.5 accent-amber-500 mt-0.5 shrink-0"
                />
                <span className="text-[11px] leading-relaxed">
                  <span className="font-semibold">{t('spu.resumeLabel')}</span>
                  {' — '}
                  {t('spu.resumeDesc')}
                  {rightLooksTruncated
                    ? <span className="text-amber-600 dark:text-amber-400"> {t('spu.resumeTruncated')}</span>
                    : <span className="text-muted-foreground"> {t('spu.resumeComplete')}</span>}
                </span>
              </label>
            )}

            <div className="grid grid-cols-2 gap-3">
              {/* Left = current */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{t('spu.currentLabel')}</span>
                  <span className="text-[11px] font-mono text-foreground">{leftTokens.toLocaleString()} {t('spu.tokens')}</span>
                </div>
                <textarea
                  value={leftText}
                  onChange={(e) => setLeftText(e.target.value)}
                  rows={26}
                  className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
                  placeholder={t('spu.empty')}
                />
              </div>
              {/* Right = updated */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {t('spu.updatedLabel')}{streamingUpdate && <span className="ml-1 text-indigo-500 normal-case animate-pulse">· streaming (read-only)…</span>}
                  </span>
                  <span className={`text-[11px] font-mono ${rightTokens > leftTokens ? 'text-amber-500' : rightTokens < leftTokens ? 'text-emerald-500' : 'text-foreground'}`}>
                    {rightTokens.toLocaleString()} {t('spu.tokens')}
                    {leftTokens > 0 && <span className="ml-1 opacity-70">({rightTokens > leftTokens ? '+' : ''}{(rightTokens - leftTokens).toLocaleString()})</span>}
                  </span>
                </div>
                <textarea
                  value={rightText}
                  onChange={(e) => setRightText(e.target.value)}
                  readOnly={streamingUpdate}
                  rows={26}
                  className={`w-full px-2 py-1.5 border rounded text-[12px] font-mono outline-none resize-y ${
                    streamingUpdate
                      ? 'bg-muted/40 border-indigo-500/40 cursor-default text-muted-foreground'
                      : 'bg-background border-border focus:ring-1 focus:ring-indigo-500'}`}
                  placeholder={t('spu.noUpdatePh')}
                />
              </div>
            </div>

            {/* Word-level diff */}
            <details className="mt-2" open>
              <summary className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold cursor-pointer select-none hover:text-foreground">
                {t('spu.diffTitle')}
              </summary>
              <div className="mt-2 p-2 border border-border rounded bg-background/60 max-h-96 overflow-y-auto">
                <DiffView before={diffLeft} after={diffRight} />
              </div>
            </details>

            {/* Changelog — everything above "## Layer 1" in the agent output.
                Read-only. Archived to local_data/changelogs/<folder>/<title>.md
                and NEVER fed into any context window (entity or updater agent). */}
            {changelogText && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-blue-600 dark:text-blue-400 font-semibold">
                    {t('spu.changelogLabel').replace('{folder}', folderName).replace('{title}', title)}
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground">{changelogText.length.toLocaleString()} {t('spu.chars')}</span>
                </div>
                <textarea
                  readOnly
                  value={changelogText}
                  rows={8}
                  className="w-full px-2 py-1.5 bg-blue-500/[0.04] border border-blue-500/30 rounded text-[12px] font-mono outline-none resize-y text-muted-foreground"
                />
              </div>
            )}

            {/* Redistribute result — what was actually written to
                local_data/summaries/<entity>/, and where the snapshot went.
                Read-only; shown so a bulk write is auditable without opening a
                file manager. */}
            {redistributeReport && (
              <div className="mt-3 border border-purple-500/30 bg-purple-500/[0.04] rounded p-2">
                <div className="text-[10px] uppercase tracking-wider text-purple-600 dark:text-purple-300 font-semibold mb-1">
                  Layer 4 write · summaries/{folderName}/
                </div>
                <div className="text-[11px] font-mono leading-relaxed space-y-1">
                  <div className="text-muted-foreground">
                    {redistributeReport.backupDir
                      ? <>Backup: {redistributeReport.backedUp} file(s) → <span className="text-foreground break-all">{redistributeReport.backupDir}</span></>
                      : <>Backup: nothing to copy (folder was empty).</>}
                  </div>
                  {redistributeReport.replaced.length > 0 && (
                    <div><span className="text-emerald-600 dark:text-emerald-400">Replaced ({redistributeReport.replaced.length}):</span> {redistributeReport.replaced.join(' · ')}</div>
                  )}
                  {redistributeReport.created.length > 0 && (
                    <div><span className="text-amber-600 dark:text-amber-400">Created ({redistributeReport.created.length}) — title had no file, check for a typo:</span> {redistributeReport.created.join(' · ')}</div>
                  )}
                  {redistributeReport.skipped.length > 0 && (
                    <div><span className="text-red-600 dark:text-red-400">Skipped ({redistributeReport.skipped.length}):</span> {redistributeReport.skipped.map((s) => `${s.title || '(untitled)'} — ${s.reason}`).join(' · ')}</div>
                  )}
                  {redistributeReport.replaced.length === 0 && redistributeReport.created.length === 0 && (
                    <div className="text-muted-foreground">No summary file was written.</div>
                  )}
                </div>
              </div>
            )}

            {/* Abbreviations / Deletions logs — separated from the result.
                Read-only, for review only. NOT written to the next conversation. */}
            {updateLogs && (
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400 font-semibold">
                    Abbreviations / Deletions log (reference only — not saved to next conversation)
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground">{updateLogs.length.toLocaleString()} {t('spu.chars')}</span>
                </div>
                <textarea
                  readOnly
                  value={updateLogs}
                  rows={8}
                  className="w-full px-2 py-1.5 bg-amber-500/[0.04] border border-amber-500/30 rounded text-[12px] font-mono outline-none resize-y text-muted-foreground"
                />
              </div>
            )}
          </div>

          {/* Summary panel — separate call, separate default model (MiMo). */}
          <div className="border border-emerald-500/40 rounded-lg p-3 bg-emerald-500/[0.04]">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wider font-semibold text-emerald-500">{t('spu.layer4Summary')}</span>
                <span className="text-sm font-medium">{t('spu.convoSummary')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusBadge status={summaryStatus} />
                <button
                  onClick={handleWriteSummary}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title={t('spu.writeSummaryTitle')}
                >
                  {running === 'summary' ? <Loader2 size={12} className="animate-spin" /> : <PenLine size={12} />}
                  {t('spu.writeSummary')}
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                {t('spu.summaryEditable').replace('{folder}', folderName).replace('{convo}', convoId)}
              </span>
              <span className="text-[11px] font-mono text-foreground">{summaryTokens.toLocaleString()} {t('spu.tokens')}</span>
            </div>
            <textarea
              value={summaryText}
              onChange={(e) => setSummaryText(e.target.value)}
              rows={8}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
              placeholder={t('spu.summaryPh')}
            />
            <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
              {t('spu.summaryNote')}
            </div>

            {/* Custom instructions for the summary writer */}
            <div className="mt-3 pt-3 border-t border-emerald-500/20">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 block">
                {t('spu.summaryInstrLabel')}
              </label>
              <textarea
                value={summaryInstructions}
                onChange={(e) => setSummaryInstructions(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={3}
                placeholder={t('spu.summaryInstrPh')}
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
              />
              <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={forceMimoForSummary}
                  onChange={(e) => setForceMimoForSummary(e.target.checked)}
                  className="accent-emerald-500"
                />
                <span className="text-[11px] font-medium text-foreground">{t('spu.forceMimo')}</span>
                <span className="text-[10px] text-muted-foreground">
                  ({forceMimoForSummary ? 'mimo-v2.5-pro' : `${summaryAiName} / ${summarySpecificModel}`})
                </span>
              </label>
            </div>

            {/* Editable index hint */}
            <div className="mt-3 pt-3 border-t border-emerald-500/20">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 block">
                {t('spu.indexHintLabel')}
              </label>
              <textarea
                value={summaryIndexHint}
                onChange={(e) => setSummaryIndexHint(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={4}
                placeholder={t('spu.indexHintPh')}
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
              />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[10px] text-muted-foreground leading-relaxed">
                  {t('spu.indexHintNote')}
                </span>
                <button
                  type="button"
                  onClick={() => setSummaryIndexHint(defaultSummaryHintForLang(agentFolder))}
                  onBlur={persistHeaderFooter}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground shrink-0 ml-2"
                >
                  {t('spu.resetDefault')}
                </button>
              </div>
            </div>
          </div>

          {/* Layer 5 — the entity's own FOOTER.md.
              The old "Footer (appended to final prompt)" field lived here. It
              was removed: it did the same job as FOOTER.md but worse — baked
              into the stored prompt only at finalize time, invisible at send
              time, and a second place to look for the same thing. Its content
              was migrated into each entity's FOOTER.md. */}
          <div>
            <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 flex items-center gap-2">
              <span>{t('spu.layer5Label')}</span>
              {entityFooter !== entityFooterSaved && (
                <span className="normal-case tracking-normal font-normal text-amber-500">{t('spu.unsaved')}</span>
              )}
              {entityFooterStatus && (
                <span className={`normal-case tracking-normal font-normal ${entityFooterStatus === 'saved' ? 'text-emerald-500' : 'text-red-500'}`}>
                  {entityFooterStatus && t(entityFooterStatus === 'saved' ? 'spu.footerSaved' : 'spu.footerSaveFailed'.replace('{e}', entityFooterStatus))}
                </span>
              )}
            </label>
            <textarea
              value={entityFooter}
              onChange={(e) => setEntityFooter(e.target.value)}
              onBlur={persistEntityFooter}
              rows={4}
              placeholder={entityFooterExists
                ? t('spu.footerPhEmpty')
                : t('spu.footerPhNone')}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-amber-500 resize-y"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              {t('spu.footerNote').replace('{folder}', folderName)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
