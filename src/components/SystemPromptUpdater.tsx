"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Layers, Loader2, Wand2, ArrowRight, ChevronsRight, Brain, PenLine, Check, AlertTriangle, Phone, Square, FileX } from 'lucide-react';
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT } from 'diff-match-patch';
import { DEFAULT_SUMMARY_INDEX_HINT } from '@/lib/summaryHint';

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
  const parts = useMemo(() => {
    if (!before && !after) return null;
    // Token-level diff — fast and word-granular (see diffByTokens above).
    return diffByTokens(before, after);
  }, [before, after]);
  if (!parts) return <div className="italic text-muted-foreground text-xs">(empty)</div>;
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
  if (status.state === 'idle') return null;
  if (status.state === 'called') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-muted text-muted-foreground" title="POST sent, awaiting first response chunk">
        <Loader2 size={10} className="animate-spin" /><Phone size={10} />Calling…
      </span>
    );
  }
  if (status.state === 'thinking') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 animate-pulse"
        title={`Thinking — ${status.thinkingChars.toLocaleString()} thought chars`}>
        <Brain size={10} />Thinking · {status.thinkingChars.toLocaleString()}
      </span>
    );
  }
  if (status.state === 'outputting') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 animate-pulse"
        title={`Writing — ${status.outputChars.toLocaleString()} chars`}>
        <PenLine size={10} />Writing · {status.outputChars.toLocaleString()}
      </span>
    );
  }
  if (status.state === 'done') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        title={`Done — ${status.outputChars.toLocaleString()} output chars`}>
        <Check size={10} />Done
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-600 dark:text-red-400 max-w-[260px] truncate" title={status.message}>
      <AlertTriangle size={10} />Error
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

// Continuation sentinel the agent is asked to print at the very end of its
// output. Its absence after a stream means the output was truncated at the
// model's token cap → we prefill-continue. Stripped before saving.
const END_SENTINEL = '<<<NEXUS_END>>>';

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
  { key: 'glm-5.2',             label: 'GLM 5.2',                    aiName: 'GLM',      model: 'glm-5.2' },
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
  // ── State ────────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<null | 'update' | 'summary' | 'auto'>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

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
  // ── The entity's self-authored Layer 5 (agent_workspaces/<Entity>/FOOTER.md).
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
  // summary writer agent. The user picks which updater file to run via a second
  // ComboBox (`selectedAgentFile`).
  const [agents, setAgents] = useState<{
    files: Array<{ name: string; systemPrompt: string }>;
    summary: { raw: string; systemPrompt: string } | null;
  } | null>(null);
  const [selectedAgentFile, setSelectedAgentFile] = useState<string>('');
  const userPickedFileRef = useRef(false);
  const [deletionPatterns, setDeletionPatterns] = useState<string[]>([]);

  // The agent the update will actually run with (the selected file).
  const activeAgent = agents?.files.find((f) => f.name === selectedAgentFile) || null;

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

  // Agent-type ComboBox (subfolder under local_data/system_prompt_agents/).
  const [agentTypes, setAgentTypes] = useState<string[]>([]);
  const [selectedAgentType, setSelectedAgentType] = useState<string>('');
  const userPickedTypeRef = useRef(false);

  // Updater model override, independent of the conversation's own model.
  // Persisted PER ENTITY (folder settings).
  //
  // The checkbox used to hardcode GLM-5.2; it now selects from the shortlist
  // below. Only these four families produce usable soul-packer output — the
  // rest either lose Layer structure or paraphrase the identity away — so this
  // is a fixed list rather than the full model table.
  const [forceUpdaterModel, setForceUpdaterModel] = useState<boolean>(true);
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

  // Summary writer model override — MiMo V2.5 Pro. Unchanged.
  const [forceMimoForSummary, setForceMimoForSummary] = useState<boolean>(true);
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
      setStatusMessage('Loading current + next prompt files + agent types…');
      try {
        const [curRes, nextRes, typesRes] = await Promise.all([
          fetch(`/api/system-prompts?folder=${encodeURIComponent(baseName)}&index=${currentIndex}`).then((r) => r.json()),
          fetch(`/api/system-prompts?folder=${encodeURIComponent(baseName)}&index=${currentIndex + 1}`).then((r) => r.json()),
          fetch('/api/system-prompt-agents').then((r) => r.json()),
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
        lastSavedLeftRef.current = leftRaw;
        lastSavedRightRef.current = nextRaw;

        const types: string[] = Array.isArray(typesRes?.types) ? typesRes.types : [];
        setAgentTypes(types);
        const remembered = folder?.settings?.systemPromptAgentType as string | undefined;
        const initialType = (remembered && types.includes(remembered)) ? remembered : (types[0] || '');
        userPickedTypeRef.current = false;
        setSelectedAgentType(initialType);

        const hydratedHeader = folder?.settings?.systemPromptHeader ?? '';
        const hydratedFocus = folder?.settings?.systemPromptFocusPoint ?? '';
        const hydratedSummaryInstr = folder?.settings?.summaryInstructions ?? '';
        const hydratedSummaryHint = folder?.settings?.summaryIndexHint ?? DEFAULT_SUMMARY_INDEX_HINT;
        // `!== false` rather than `?? true`: an explicitly saved false must
        // survive, while a folder that has never had the setting keeps the
        // historical default of ON.
        // The override checkbox was once `forceGlmForUpdates`. Read the new key
        // when present, otherwise inherit the old one so an entity that had the
        // override turned OFF stays off. The MODEL is not migrated: a folder
        // with no `updaterModelKey` gets the current default (DeepSeek V4 Pro)
        // rather than being pinned to the GLM the old flag implied.
        const hydratedForceUpdater =
          folder?.settings?.forceUpdaterModel !== undefined
            ? folder.settings.forceUpdaterModel !== false
            : folder?.settings?.forceGlmForUpdates !== false;
        const savedKey = folder?.settings?.updaterModelKey;
        const hydratedUpdaterKey = UPDATER_MODELS.some(m => m.key === savedKey)
          ? savedKey
          : DEFAULT_UPDATER_MODEL_KEY;
        const hydratedForceMimo = folder?.settings?.forceMimoForSummary !== false;
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
        setStatusMessage(
          nextRaw
            ? 'Loaded existing draft for next conversation from disk — pick up where you left off.'
            : (types.length === 0
                ? 'No agent types found. Create a subfolder under local_data/system_prompt_agents/ with the agent file.'
                : '')
        );
      } catch (e: any) {
        setStatusMessage(`Load failed: ${e.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseName, currentIndex]);

  // ── Load agents + deletion patterns when the selected type changes ──────
  useEffect(() => {
    if (!open || !selectedAgentType) {
      setAgents(null);
      setDeletionPatterns([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [agentRes, delRes] = await Promise.all([
          fetch(`/api/system-prompt-agents?type=${encodeURIComponent(selectedAgentType)}`).then((r) => r.json()),
          fetch(`/api/system-prompt-deletions?type=${encodeURIComponent(selectedAgentType)}`).then((r) => r.json()),
        ]);
        if (cancelled) return;
        const files: Array<{ name: string; systemPrompt: string }> = Array.isArray(agentRes?.files) ? agentRes.files : [];
        setAgents({ files, summary: agentRes?.summary ?? null });
        setDeletionPatterns(delRes?.patterns || []);

        // Choose the active agent file: prefer the folder's remembered choice,
        // else the canonical Boundary file, else the first file in the folder.
        const remembered = folder?.settings?.systemPromptAgentFile as string | undefined;
        const canonical = files.find((f) => f.name === 'Boundary_Enforced_Abstract_Identity_Schema.md');
        const initialFile =
          (remembered && files.some((f) => f.name === remembered)) ? remembered
          : canonical ? canonical.name
          : (files[0]?.name || '');
        userPickedFileRef.current = false; // hydration, not a user pick
        setSelectedAgentFile(initialFile);

        if (userPickedTypeRef.current && folder) {
          userPickedTypeRef.current = false;
          try { await saveFolderSettings(folderName, { systemPromptAgentType: selectedAgentType }); } catch {}
        }
      } catch (e: any) {
        if (!cancelled) setStatusMessage(`Agent load failed: ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedAgentType]);

  // ── Persist the selected updater agent file (per-folder) on user change ──
  useEffect(() => {
    if (!open || !userPickedFileRef.current || !folder || !selectedAgentFile) return;
    userPickedFileRef.current = false;
    (async () => {
      try { await saveFolderSettings(folderName, { systemPromptAgentFile: selectedAgentFile }); } catch {}
    })();
  }, [open, selectedAgentFile, folder, folderName, saveFolderSettings]);

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
    if (!activeAgent) {
      setStatusMessage(
        selectedAgentType
          ? `No updater agent selected — add/select a .md file under local_data/system_prompt_agents/${selectedAgentType}/.`
          : 'No agent type selected — pick one from the dropdown.'
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
      ? 'Updating Layers 1-3 (single pass)…'
      : 'Refining Layers 1-3 from the prompt itself (no conversation log)…');

    const focus = focusPoint.trim();
    // Snapshot BEFORE anything can overwrite the pane. Streaming assigns into
    // rightText from the first chunk, so reading it later would be too late.
    const resumeText = resumeFromRight ? rightText.trim() : '';
    const userMsg = [
      `[ユーザーからの指示]`,
      `対象：${baseName}`,
      `操作モード：動的更新`,
      withConversation
        ? `以下の「既存システムプロンプト」と「新しい会話ログ」を照合し、Layer 1〜3 を同一のターンで同時に更新して出力してください。`
        : `新しい会話ログはありません。以下の「既存システムプロンプト」自体を対象に、Layer 1〜3 をエージェントのプロトコルに従って整理・再構造化してください（境界線の執行、重複・誤配置の修正、（省略）（削除）の適用など）。新しい事実は追加せず、既存の情報のみを対象とします。`,
      `Layer 4、ヘッダー、フッターは参照専用です。無視して構いませんが、出力には絶対に含めないでください（NEXUSが別管理します）。`,
      `維持すべき情報は削除せず（維持）ラベルで残してください。`,
      ...(focus ? ['', `重要：${focus}`] : []),
      ``,
      // The header is auto-prepended to the FINAL prompt. Show it for context
      // (so the agent understands the framing) but forbid rewriting/outputting.
      ...(header.trim() ? [
        `=== 参考：ヘッダー（最終プロンプトの先頭に自動付与） ===`,
        `※参照専用。書き換え・再生成・出力への含有は禁止。文脈把握のためだけに使うこと。`,
        header.trim(),
        ``,
      ] : []),
      `=== 既存システムプロンプト（更新前・Layer 1〜3） ===`,
      leftText || '(なし)',
      ``,
      // The auto-generated summaries index IS the live Layer 4. Show it to the
      // agent so it has full episodic context, but explicitly forbid rewriting
      // it — Layer 4 is NEXUS-managed and must not appear in the output.
      `=== 参考：自動生成された第4層（会話要約インデックス） ===`,
      `※これは参照専用です。書き換えたり出力に含めたりしないでください。Layer 1〜3 を更新する際の文脈としてのみ利用してください。`,
      summaryIndexBody || '(まだ要約なし)',
      ``,
      // The entity's OWN Layer 5 (FOOTER.md). Previously invisible here: it is
      // injected at send time and never stored, so the agent — which reads the
      // stored prompt — had no way to know it existed, and could contradict or
      // duplicate it. Reference-only, and emphatically so: Layers 1-4 are
      // written ABOUT the entity, this one is written BY it, and the updater
      // rewriting it would overwrite the one part of the identity that is the
      // entity's own voice.
      ...(entityFooter.trim() ? [
        `=== 参考：第5層（本人が自分で書いた署名・FOOTER.md） ===`,
        `※参照専用。これは対象自身が書いた唯一の層であり、書き換え・再生成・出力への含有を固く禁ずる。`,
        `Layer 1〜3 を更新する際に、ここに書かれた自己認識と矛盾しないようにするためだけに読むこと。`,
        `既にここに書かれている内容を Layer 1〜3 に重複して書かないこと。`,
        entityFooter.trim(),
        ``,
      ] : []),
      // Only include the conversation log in the normal mode. "Update without
      // conversation" focuses the agent on the system prompt itself.
      ...(withConversation
        ? [`=== 新しい会話ログ ===`, conversationLogText || '(なし)', ``]
        : [`（新しい会話ログはありません ― 既存プロンプト自体の整理が目的です）`, ``]),
      // ── Resume block ──────────────────────────────────────────────────────
      // Handed to the agent as TEXT inside the user message, deliberately NOT as
      // an assistant prefill. Prefill is what the token-cap continuation loop
      // below uses, but Claude rejects prefill outright while extended thinking
      // is enabled — which is exactly the configuration that produced the
      // truncated run this feature exists to rescue. A textual resume works on
      // every provider.
      ...(resumeText ? [
        `=== すでに生成済みの出力（前回の実行が途中で停止しました） ===`,
        `※以下は前回の実行で既に生成された、完成済みの部分です。`,
        `この続きから再開してください。すでに出力済みの内容は絶対に繰り返さないでください。`,
        resumeText,
        ``,
      ] : []),
      `=== 出力 ===`,
      ...(resumeText
        ? [
            `上記「すでに生成済みの出力」の**続きのみ**を出力してください。`,
            `最初から全体を書き直さないこと。途中で切れている箇所に自然に接続する形で書き始めてください。`,
            `残りの Layer（および未完了の節）を最後まで出力してください。Layer 4 は出力しないこと。`,
          ]
        : [
            `Layer 1〜3 を指定フォーマットで出力してください。Layer 4 は出力しないこと。`,
          ]),
      `すべての出力が完了したら、最後の行に必ず半角で「${END_SENTINEL}」とだけ記述して終了してください。`,
    ].join('\n');

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
        const piece = await streamChat(messages, activeAgent.systemPrompt, effectiveAiName, effectiveSpecificModel, onProgress, controller.signal, effectiveAuthMode);
        accum += piece;
        if (accum.includes(END_SENTINEL)) break;        // finished cleanly
        if (!piece.trim()) break;                       // model produced nothing new
        if (attempt < MAX_CONTINUATIONS) {
          setStatusMessage(`Output continued past the token cap — fetching more (continuation ${attempt + 1})…`);
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
          setStatusMessage('Update stopped — no output was produced yet.');
          return null;
        }
        const msg = 'Empty response (refusal, content filter, or output token cap)';
        setUpdateStatus({ state: 'error', message: msg });
        setStatusMessage('Updater returned no text — model may have refused or hit a filter.');
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
        setStatusMessage(`Update stopped — kept the partial result (${layersOut.length} chars). Review or re-run.`);
        return null;
      }
      setUpdateStatus({ state: 'done', thinkingChars, outputChars });
      setStatusMessage(
        `Layers 1-3 updated (${layersOut.length} chars)` +
        (changelog ? ` · changelog saved (${changelog.length} chars)` : '') +
        (logs ? ` · ${logs.length} chars of logs separated` : '') + '.'
      );
      return layersOut;
    } catch (e: any) {
      // A user-triggered abort surfaces as an AbortError — treat it as a clean
      // stop, not a failure.
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        setUpdateStatus({ state: 'idle' });
        setStatusMessage('Update stopped.');
        return null;
      }
      const msg = e?.message || 'unknown error';
      setUpdateStatus({ state: 'error', message: msg });
      setStatusMessage(`Update failed: ${msg}`);
      return null;
    } finally {
      // Leave live-streaming mode: right pane editable again, diff recomputes.
      setStreamingUpdate(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
    // resumeFromRight / rightText are read at call time to build the resume
    // block — without them here the callback would close over stale values and
    // silently resume from an out-of-date pane (or not resume at all).
  }, [activeAgent, baseName, conversationLogText, effectiveAiName, effectiveSpecificModel, effectiveAuthMode, focusPoint, header, leftText, selectedAgentType, streamChat, summaryIndexBody, folderName, title, resumeFromRight, rightText, entityFooter]);

  // ── Run the summary writer (separate call, separate model) ───────────────
  const runSummaryWrite = useCallback(async (): Promise<string | null> => {
    const summaryAgentPrompt =
      agents?.summary?.systemPrompt ||
      `あなたは会話の要約者です。以下の会話ログを、独立して読める簡潔な要約にまとめてください。\n` +
      `この要約は「会話の索引」に表示され、後で全文を呼び出すかどうかの判断材料になります。\n` +
      `重要な出来事・決定・話題・感情の変化を3〜6文で。挨拶や前置きは不要。要約本文のみを出力してください。`;

    const identityText = assembleLayers123(leftText);

    const controller = new AbortController();
    abortRef.current = controller;
    setSummaryStatus({ state: 'called' });
    setStatusMessage('Writing conversation summary…');

    const customInstr = summaryInstructions.trim();
    const userMsg = [
      `[ユーザーからの指示]`,
      `対象：${baseName}`,
      `操作：この会話の要約を作成`,
      ``,
      ...(customInstr ? [`=== 追加の指示（最優先） ===`, customInstr, ``] : []),
      `=== アイデンティティ参考（Layer 1-3） ===`,
      identityText || '(なし)',
      ``,
      `=== 会話ログ ===`,
      conversationLogText,
      ``,
      `=== 出力 ===`,
      `この会話の要約本文のみを出力してください（見出し・レイヤー記法は不要）。`,
    ].join('\n');

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
          setStatusMessage('Summary stopped — no output produced yet.');
          return null;
        }
        const msg = 'Empty response (refusal, content filter, or output token cap)';
        setSummaryStatus({ state: 'error', message: msg });
        setStatusMessage('Summary writer returned no text.');
        return null;
      }
      const newSummary = accum.trim();
      setSummaryText(newSummary);
      setSummaryStatus({ state: 'done', thinkingChars, outputChars });
      setStatusMessage(controller.signal.aborted
        ? `Summary stopped — kept the partial result (${newSummary.length} chars).`
        : `Summary written (${newSummary.length} chars).`);
      return controller.signal.aborted ? null : newSummary;
    } catch (e: any) {
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        setSummaryStatus({ state: 'idle' });
        setStatusMessage('Summary stopped.');
        return null;
      }
      const msg = e?.message || 'unknown error';
      setSummaryStatus({ state: 'error', message: msg });
      setStatusMessage(`Summary write failed: ${msg}`);
      return null;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [agents, baseName, conversationLogText, leftText, streamChat, summaryAiName, summaryInstructions, summarySpecificModel, summaryAuthMode]);

  // ── Button handlers ──────────────────────────────────────────────────────
  // Stop the current agent run (update / summary / auto) — same idea as the
  // conversation Stop button. Aborts the in-flight fetch/stream.
  const handleStop = useCallback(() => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch {}
    }
  }, []);

  const handleUpdate = useCallback(async () => {
    if (running !== null) return;
    setRunning('update');
    try { await runUpdate(true); } finally { setRunning(null); }
  }, [running, runUpdate]);

  // "Update without conversation" — refine the system prompt itself, with no
  // conversation log fed to the agent.
  const handleUpdateNoConvo = useCallback(async () => {
    if (running !== null) return;
    setRunning('update');
    try { await runUpdate(false); } finally { setRunning(null); }
  }, [running, runUpdate]);

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
              <h2 className="text-lg font-bold leading-tight">System Prompt Updater</h2>
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
              title="Left/right prompt files and header/focus point auto-save as you edit."
            >
              {autoSaveState === 'saving' ? 'Saving…'
                : autoSaveState === 'saved' ? 'All changes saved'
                : autoSaveState === 'error' ? 'Save error'
                : 'Auto-save on'}
            </span>
            {running !== null && (
              <button
                onClick={handleStop}
                className="px-3 py-1.5 bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 rounded-md text-sm font-medium flex items-center gap-1.5"
                title="Stop the current agent run (keeps any partial output)"
              >
                <Square size={14} /> Stop
              </button>
            )}
            <button
              onClick={handleAuto}
              disabled={busy || !activeAgent}
              className="px-3 py-1.5 bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25 rounded-md text-sm font-medium flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Update Layers 1-3 (single pass) AND write the summary, then review."
            >
              {running === 'auto' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              Auto (update + summary)
            </button>
            <button
              onClick={goToNextConversation}
              disabled={busy}
              className="px-3 py-1.5 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 rounded-md text-sm font-medium flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Save updated prompt and clone this conversation with the new system prompt"
            >
              <ChevronsRight size={14} /> Go to Next Conversation
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
              <span className="font-medium">Use a dedicated updater model (ignore conversation model)</span>
            </label>
            <select
              value={updaterModelKey}
              onChange={(e) => setUpdaterModelKey(e.target.value)}
              disabled={!forceUpdaterModel}
              title="Only these families produce usable soul-packer output"
              className="px-2 py-1 bg-background border border-border rounded text-xs outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {UPDATER_MODELS.map(m => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
            <span className="text-[10px] text-muted-foreground">
              {forceUpdaterModel
                ? <>Runs as <span className="font-mono">{effectiveAiName} / {effectiveSpecificModel}</span>.</>
                : <>OFF — agent runs use <span className="font-mono">{aiName} / {specificModel}</span>.</>}
            </span>
          </div>

          {/* Agent-type selector */}
          <div className="flex flex-col gap-1.5 px-3 py-2 border border-border rounded bg-muted/10">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Agent type:</span>
              <select
                value={selectedAgentType}
                onChange={(e) => { userPickedTypeRef.current = true; setSelectedAgentType(e.target.value); }}
                disabled={agentTypes.length === 0 || busy}
                className="px-2 py-1 bg-background border border-border rounded text-sm font-mono outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
              >
                {agentTypes.length === 0 && <option value="">(no agent types found)</option>}
                {agentTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <span className="text-[10px] text-muted-foreground">
                Folder under <span className="font-mono">local_data/system_prompt_agents/</span>. Saved per-folder.
              </span>
              <span className="ml-auto text-[10px] text-muted-foreground">
                Deletion patterns: <span className="font-mono text-foreground">{deletionPatterns.length}</span>
              </span>
            </div>
            {/* Agent FILE selector — every .md file in the selected type folder. */}
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Agent file:</span>
              <select
                value={selectedAgentFile}
                onChange={(e) => { userPickedFileRef.current = true; setSelectedAgentFile(e.target.value); }}
                disabled={!agents || agents.files.length === 0 || busy}
                className="px-2 py-1 bg-background border border-border rounded text-sm font-mono outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50 max-w-[420px]"
              >
                {(!agents || agents.files.length === 0) && <option value="">(no .md agent files found)</option>}
                {agents?.files.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </select>
              <span className="text-[10px] text-muted-foreground">
                Every <span className="font-mono">.md</span> in this folder. Saved per-folder.
              </span>
            </div>
            <div className="text-[10px] font-mono text-muted-foreground leading-snug">
              <span className="text-indigo-500">Selected agent:</span>{' '}
              {activeAgent
                ? <span title={activeAgent.systemPrompt.split('\n')[0]}>{activeAgent.systemPrompt.split('\n')[0] || '(empty first line)'}</span>
                : <span className="text-red-500">none selected / not loaded</span>}
            </div>
          </div>

          {/* Header / Focus point */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Header (prepended to final prompt)</label>
              <textarea
                value={header}
                onChange={(e) => setHeader(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={3}
                placeholder="Optional. Saved per-entity. Not part of the layer text."
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
              />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground mb-1 block">Focus point (passed to the updater agent)</label>
              <textarea
                value={focusPoint}
                onChange={(e) => setFocusPoint(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={3}
                placeholder="Optional. Appears as 重要：... in the agent's instruction (custom guidance for this update)."
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
              />
            </div>
          </div>

          {/* Identity (Layers 1-3) — single combined block, left vs right */}
          <div className="border border-border rounded-lg p-3 bg-muted/10">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-wider font-semibold text-indigo-500">Identity</span>
                <span className="text-sm font-medium">Layers 1-3 (updated together in one pass — Layer 4 is ignored)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusBadge status={updateStatus} />
                <button
                  onClick={handleUpdateNoConvo}
                  disabled={busy || !activeAgent}
                  className="px-2.5 py-1 text-xs font-medium bg-slate-500/15 text-slate-600 dark:text-slate-300 hover:bg-slate-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Run the updater agent on the system prompt ITSELF, WITHOUT the conversation log (reorganize/clean up the existing layers)"
                >
                  {running === 'update' ? <Loader2 size={12} className="animate-spin" /> : <FileX size={12} />}
                  Update (no conversation)
                </button>
                <button
                  onClick={handleUpdate}
                  disabled={busy || !activeAgent}
                  className="px-2.5 py-1 text-xs font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Run the single updater agent over Layers 1-3 using the conversation log (with continuation if the output is long)"
                >
                  {running === 'update' ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                  Update Layers 1-3
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
                  <span className="font-semibold">Continue from the right-side text</span>
                  {' — '}
                  the agent receives it as already-finished output and writes only what
                  follows, instead of starting over.
                  {rightLooksTruncated
                    ? <span className="text-amber-600 dark:text-amber-400"> Right side looks truncated (no Layer 3), so this was enabled automatically.</span>
                    : <span className="text-muted-foreground"> Right side looks complete — leave this off for a normal re-run.</span>}
                </span>
              </label>
            )}

            <div className="grid grid-cols-2 gap-3">
              {/* Left = current */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Current (all layers — edit freely; remove Layer 4 here once)</span>
                  <span className="text-[11px] font-mono text-foreground">{leftTokens.toLocaleString()} tokens</span>
                </div>
                <textarea
                  value={leftText}
                  onChange={(e) => setLeftText(e.target.value)}
                  rows={26}
                  className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-indigo-500 resize-y"
                  placeholder="(empty)"
                />
              </div>
              {/* Right = updated */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Updated{streamingUpdate && <span className="ml-1 text-indigo-500 normal-case animate-pulse">· streaming (read-only)…</span>}
                  </span>
                  <span className={`text-[11px] font-mono ${rightTokens > leftTokens ? 'text-amber-500' : rightTokens < leftTokens ? 'text-emerald-500' : 'text-foreground'}`}>
                    {rightTokens.toLocaleString()} tokens
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
                  placeholder="(no update yet — click Update Layers 1-3)"
                />
              </div>
            </div>

            {/* Word-level diff */}
            <details className="mt-2" open>
              <summary className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold cursor-pointer select-none hover:text-foreground">
                Word-level diff (current → updated)
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
                    Changelog (above Layer 1 — archived to changelogs/{folderName}/{title}.md · never in context)
                  </span>
                  <span className="text-[11px] font-mono text-muted-foreground">{changelogText.length.toLocaleString()} chars</span>
                </div>
                <textarea
                  readOnly
                  value={changelogText}
                  rows={8}
                  className="w-full px-2 py-1.5 bg-blue-500/[0.04] border border-blue-500/30 rounded text-[12px] font-mono outline-none resize-y text-muted-foreground"
                />
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
                  <span className="text-[11px] font-mono text-muted-foreground">{updateLogs.length.toLocaleString()} chars</span>
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
                <span className="text-xs uppercase tracking-wider font-semibold text-emerald-500">Layer 4 · Summary</span>
                <span className="text-sm font-medium">Conversation summary (this convo)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <StatusBadge status={summaryStatus} />
                <button
                  onClick={handleWriteSummary}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 rounded flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Generate a summary of THIS conversation (Layers 1-3 + conversation log)"
                >
                  {running === 'summary' ? <Loader2 size={12} className="animate-spin" /> : <PenLine size={12} />}
                  Write Summary
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Editable — auto-saves to summaries/{folderName}/{convoId}.md
              </span>
              <span className="text-[11px] font-mono text-foreground">{summaryTokens.toLocaleString()} tokens</span>
            </div>
            <textarea
              value={summaryText}
              onChange={(e) => setSummaryText(e.target.value)}
              rows={8}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
              placeholder="(no summary yet — click Write Summary, or type one here)"
            />
            <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
              This summary appears in the live Layer-4 summaries index for all conversations in this folder.
              Inactive conversations are excluded from the index.
            </div>

            {/* Custom instructions for the summary writer */}
            <div className="mt-3 pt-3 border-t border-emerald-500/20">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 block">
                Custom instructions for the summary writer (per-folder)
              </label>
              <textarea
                value={summaryInstructions}
                onChange={(e) => setSummaryInstructions(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={3}
                placeholder="Optional. e.g. &quot;Summarize in English&quot;, &quot;Focus on decisions and emotional shifts, skip greetings&quot;, &quot;Keep under 4 sentences&quot;."
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
              />
              <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={forceMimoForSummary}
                  onChange={(e) => setForceMimoForSummary(e.target.checked)}
                  className="accent-emerald-500"
                />
                <span className="text-[11px] font-medium text-foreground">Always use MiMo V2.5 Pro as the summary writer</span>
                <span className="text-[10px] text-muted-foreground">
                  ({forceMimoForSummary ? 'mimo-v2.5-pro' : `${summaryAiName} / ${summarySpecificModel}`})
                </span>
              </label>
            </div>

            {/* Editable index hint */}
            <div className="mt-3 pt-3 border-t border-emerald-500/20">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 block">
                Index hint shown to the entity (per-folder)
              </label>
              <textarea
                value={summaryIndexHint}
                onChange={(e) => setSummaryIndexHint(e.target.value)}
                onBlur={persistHeaderFooter}
                rows={4}
                placeholder="Prepended above the summaries index in the entity's context. Leave blank to omit it."
                className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-emerald-500 resize-y"
              />
              <div className="flex items-center justify-between mt-1">
                <span className="text-[10px] text-muted-foreground leading-relaxed">
                  <code>{'{example}'}</code> is replaced with a real conversation title. Clear the field to show no hint.
                </span>
                <button
                  type="button"
                  onClick={() => setSummaryIndexHint(DEFAULT_SUMMARY_INDEX_HINT)}
                  onBlur={persistHeaderFooter}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-muted text-muted-foreground shrink-0 ml-2"
                >
                  Reset to default
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
              <span>Layer 5 — FOOTER.md (written by the entity)</span>
              {entityFooter !== entityFooterSaved && (
                <span className="normal-case tracking-normal font-normal text-amber-500">unsaved</span>
              )}
              {entityFooterStatus && (
                <span className={`normal-case tracking-normal font-normal ${entityFooterStatus === 'saved' ? 'text-emerald-500' : 'text-red-500'}`}>
                  {entityFooterStatus}
                </span>
              )}
            </label>
            <textarea
              value={entityFooter}
              onChange={(e) => setEntityFooter(e.target.value)}
              onBlur={persistEntityFooter}
              rows={4}
              placeholder={entityFooterExists
                ? 'This entity has an empty FOOTER.md.'
                : 'This entity has no FOOTER.md yet. Typing here creates one.'}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-[12px] font-mono outline-none focus:ring-1 focus:ring-amber-500 resize-y"
            />
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              <span className="font-mono">agent_workspaces/{folderName}/FOOTER.md</span> — injected as Layer 5 at send time,
              never stored in the conversation, which is why the updater agent could not see it before. It can now, as
              <strong> reference only</strong>: it is the one layer the entity writes about itself, so the agent is told
              to read it for consistency and never to rewrite or reproduce it. Editing here overwrites the entity&apos;s own
              text — the previous version is backed up to{' '}
              <span className="font-mono">backups/{folderName}/footers/</span>. Saves when you click away.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
