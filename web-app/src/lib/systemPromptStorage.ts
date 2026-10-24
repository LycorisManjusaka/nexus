import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR, sanitizeBeingName, beingSoulDir, beingSoulBackupsDir } from './beingPaths';
import { GENERATION_LABEL_RE } from './soulGeneration';

// ── Generation labels ───────────────────────────────────────────────────────
// A soul file is `<being>_<label>.md`, and until 2026-10-24 `label` was a
// `number` on every path from the client down to `path.join` — which made a
// traversal unrepresentable for free. It is a STRING now (a split archive
// numbers its generations `1-1`, `1-2`, … — see soulGeneration.ts), so the one
// guarantee the type used to give has to be stated.
//
// Throwing rather than sanitizing, on purpose: a sanitized label would write a
// real file under a name nobody asked for, which is the "operation succeeded,
// artifact was wrong" shape this house keeps getting bitten by. A 500 with the
// offending value in it points at the caller.
function assertGenerationLabel(label: unknown): string {
  const s = String(label ?? '').trim();
  if (!GENERATION_LABEL_RE.test(s)) {
    throw new Error(`invalid soul generation label: ${JSON.stringify(label)}`);
  }
  return s;
}

// AGENTS_DIR is operator-owned (not per-being) — stays at local_data root.
const AGENTS_DIR = path.join(DATA_DIR, 'system_prompt_agents');  // operator-owned overrides (preferred)
// Repo-bundled defaults, shipped so a fresh checkout works with zero setup.
// `process.cwd()` is the web-app repo root (same base `DATA_DIR` resolves against).
const BUNDLED_AGENTS_DIR = path.resolve(process.cwd(), 'defaults', 'system_prompt_agents');

// Agent type = subdirectory under the resolved agents root. Each type folder
// contains its own copy of `identity_abstract_schema_standard.md`,
// `identity_abstract_schema_dynamic_compression.md`, and `_deletion_patterns.txt`.
// The user selects the type via the System Prompt Updater UI (ComboBox).
const STANDARD_AGENT_NAME = 'identity_abstract_schema_standard.md';
const COMPRESSION_AGENT_NAME = 'identity_abstract_schema_dynamic_compression.md';
const SUMMARY_AGENT_NAME = 'summary_writer.md';
const DELETIONS_NAME = '_deletion_patterns.txt';

function sanitizeAgentType(t: string): string {
  // Same character class as folder sanitization; also reject path traversal.
  return t.replace(/[\\/:*?"<>|]+/g, '_').replace(/\.\.+/g, '_');
}

// AGENTS_DIR (local_data/system_prompt_agents) wins whenever the operator has
// populated it with at least one type folder — that is the "custom agents"
// path from the user's own instruction. An empty or missing AGENTS_DIR falls
// back to the repo-bundled defaults, so a fresh checkout needs no setup and
// `local_data` can stay entirely out of git. Re-checked on every call (cheap:
// one readdir) rather than cached, so adding/removing the override folder
// takes effect without a server restart.
async function resolveAgentsRoot(): Promise<string> {
  try {
    const entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory())) return AGENTS_DIR;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  return BUNDLED_AGENTS_DIR;
}

async function agentTypeDir(type: string): Promise<string> {
  const root = await resolveAgentsRoot();
  return path.join(root, sanitizeAgentType(type));
}

// ── Filesystem-safe folder names ────────────────────────────────────────────
// Re-exported for backward compatibility with anything still importing this
// name from here; the actual sanitizer now lives in beingPaths.ts so every
// subsystem agrees on one on-disk key per being.
export const sanitizeFolderName = sanitizeBeingName;

// ── Full-width <-> half-width digit conversion ──────────────────────────────
// Conversation titles in NEXUS use the CJK convention "＃<full-width number>"
// for ordinal numbering (e.g. "先輩＃４６"). On disk we use plain digits for
// portability.
const FW_TO_HW_OFFSET = 0xfee0;
export function fwDigitsToInt(s: string): number {
  return parseInt(
    s.replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - FW_TO_HW_OFFSET)
    ),
    10
  );
}
export function intToFwDigits(n: number): string {
  return String(n).replace(/[0-9]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + FW_TO_HW_OFFSET)
  );
}

// Pull "先輩" and 46 out of "先輩＃４６". Returns { base, index } or null if
// the title doesn't follow the convention.
export function parseTitleNumber(
  title: string
): { base: string; index: number } | null {
  // Tolerate trailing whitespace and "＃" or ASCII "#" with full-width digits
  // (the canonical NEXUS form uses ＃ + ０-９ but we accept both).
  const m = title.match(/^(.*?)[\s]*[#＃]([0-9０-９]+)\s*$/);
  if (!m) return null;
  const base = m[1].replace(/\s+$/, '');
  const rawNum = m[2];
  // Normalize either kind of digit
  const normalized = rawNum.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - FW_TO_HW_OFFSET)
  );
  const n = parseInt(normalized, 10);
  if (isNaN(n)) return null;
  return { base, index: n };
}

// ── Per-entity layer file storage ───────────────────────────────────────────
// Layout: local_data/beings/<folder>/soul/<folder>_<index>.md
// One file per conversation index; the contents are the four `### **Layer N:`
// blocks concatenated (NO header/footer/deletions — those are applied later).

function entityDir(folderName: string): string {
  return beingSoulDir(folderName);
}

function entityFilePath(folderName: string, label: string): string {
  const safe = sanitizeFolderName(folderName);
  return path.join(entityDir(folderName), `${safe}_${assertGenerationLabel(label)}.md`);
}

export async function readSystemPromptFile(
  folderName: string,
  label: string
): Promise<string | null> {
  try {
    const p = entityFilePath(folderName, label);
    return await fs.readFile(p, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeSystemPromptFile(
  folderName: string,
  label: string,
  contents: string
): Promise<string> {
  const p = entityFilePath(folderName, label);   // validates the label FIRST
  await fs.mkdir(entityDir(folderName), { recursive: true });
  await fs.writeFile(p, contents, 'utf-8');
  return p;
}

// ── SPU working copy of the LEFT pane ──────────────────────────────────────
// `<name>_<N>.md` is the FINISHED soul of conversation N — the record of what
// that generation actually ran with. The SPU's left pane used to be wired
// straight to it, which made three separate paths (left auto-save, the
// right→left shift, and the commit's "persist LEFT") write over a closed
// generation. Lizard-kun hit the shift one: starting a run while the right
// pane held a finished draft rewrote `Cairn_41.md` with the draft for 42.
// Nothing was lost (the BEFORE/AFTER snapshots caught it) but the chain had to
// be restored by hand, and a history you have to repair is not a history.
//
// So the left pane now edits a WORKING COPY, seeded from the real soul the
// first time an index is opened. The real file is only ever written by (a) the
// commit, which writes the RIGHT pane as `<N+1>.md`, and (b) one explicit,
// confirmed "write the working copy into the real soul" action. Separate
// functions rather than a `scope` argument on the existing pair: a mis-plumbed
// parameter is exactly how the working text would land back on the real soul,
// and this route cannot express that write at all.
//
// Keyed by the same `folderName`/index the real file uses, so a working copy
// always sits beside the thing it is a copy of. Lives in a subdirectory, which
// `retitleNumberedFiles` skips (it only touches `*.md` entries, not dirs) — so
// renaming a being leaves working copies behind under the old stem, the lookup
// misses, and the pane re-seeds from the real soul. That failure mode points at
// the truth, which is the right direction for it to fail in.
function spuWorkDir(folderName: string): string {
  return path.join(entityDir(folderName), 'spu_work');
}

function spuWorkFilePath(folderName: string, label: string): string {
  const safe = sanitizeFolderName(folderName);
  return path.join(spuWorkDir(folderName), `${safe}_${assertGenerationLabel(label)}_left.md`);
}

// `null` means "no working copy exists for this generation" — the caller seeds from
// the real soul. An EMPTY working copy is NOT null: emptying the left pane on
// purpose has to survive a reopen, otherwise the pane would silently refill.
export async function readSpuWorkFile(
  folderName: string,
  label: string
): Promise<string | null> {
  try {
    return await fs.readFile(spuWorkFilePath(folderName, label), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeSpuWorkFile(
  folderName: string,
  label: string,
  contents: string
): Promise<string> {
  const p = spuWorkFilePath(folderName, label);   // validates the label FIRST
  await fs.mkdir(spuWorkDir(folderName), { recursive: true });
  await fs.writeFile(p, contents, 'utf-8');
  return p;
}

// ── Shift right pane -> left pane (SPU "start of a new run" contract) ──────
// Called right before any of the four update buttons begins writing into the
// right pane, whenever the right pane already holds a finished draft. Backs
// up the current left content (best-effort — a backup hiccup must not block
// the shift), writes the old right content into the left pane's WORKING COPY
// for the current index (NOT `<name>_<N>.md` — see writeSpuWorkFile above),
// and clears the right (next) index so the new run starts from a blank slate.
function soulBackupStamp(d = new Date()): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

// ── Soul backups (restorable snapshots of an update stage) ────────────────
// Each "update stage" is the transition from conversation N to N+1. When a
// stage commits we capture two snapshots of the soul:
//   BEFORE — the soul as it was at index N (before the update)
//   AFTER  — the soul as it became at index N+1 (the result)
// The filename encodes the whole stage plus a sortable timestamp, so the
// System Prompt Updater can list and restore them with no sidecar files:
//
//   <folder>_<N>__<folder>_<N+1>__<BEFORE|AFTER>__<timestamp>.md
//
// The field separator is a DOUBLE underscore. Identity names may contain
// single underscores (the <name>_<n> convention) and hyphens; a name that
// literally contains "__" is not supported for backup parsing.
export type SoulBackupPhase = 'BEFORE' | 'AFTER';

export interface SoulBackupInfo {
  filename: string;
  fromTitle: string;   // e.g. "Cairn_24"
  toTitle: string;     // e.g. "Cairn_25"
  // Generation LABELS, not numbers: `"24"`, or `"1-5"` for a split archive.
  fromLabel: string;
  toLabel: string;
  phase: SoulBackupPhase;
  stamp: string;       // sortable YYYY-MM-DD_HH-MM-SS-mmm
}

export function soulBackupFilename(
  folderName: string,
  fromLabel: string,
  toLabel: string,
  phase: SoulBackupPhase,
  stamp: string
): string {
  const safe = sanitizeFolderName(folderName);
  const from = assertGenerationLabel(fromLabel);
  const to = assertGenerationLabel(toLabel);
  return `${safe}_${from}__${safe}_${to}__${phase}__${stamp}.md`;
}

export async function backupSoulSnapshot(
  folderName: string,
  fromLabel: string,
  toLabel: string,
  phase: SoulBackupPhase,
  contents: string
): Promise<string | null> {
  try {
    const bdir = beingSoulBackupsDir(folderName);
    await fs.mkdir(bdir, { recursive: true });
    const filename = soulBackupFilename(folderName, fromLabel, toLabel, phase, soulBackupStamp());
    await fs.writeFile(path.join(bdir, filename), contents, 'utf-8');
    return filename;
  } catch {
    return null;
  }
}

// Extract the trailing generation LABEL from a title of the form "<name>_<n>",
// "<name>#<n>" / "<name>＃<n>" (half- or full-width digits), or the
// hyphen-segmented form a split archive uses ("<name>_1-5").
//
// Returns the label as a STRING. It used to parse to a number, which meant
// `parseSoulBackupFilename` rejected every backup of a hyphenated generation —
// and since that parser doubles as the read guard, those snapshots were both
// invisible in the list AND unreadable. Nothing wrote them before today, so
// there is nothing to migrate; this is what keeps them writable now.
function soulLabelFromTitle(title: string): string | null {
  const m = title.match(/[_#＃]([0-9０-９]+(?:-[0-9０-９]+)*)\s*$/);
  if (!m) return null;
  const label = m[1].replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  return GENERATION_LABEL_RE.test(label) ? label : null;
}

export function parseSoulBackupFilename(filename: string): SoulBackupInfo | null {
  if (!filename.endsWith('.md')) return null;
  const stem = filename.slice(0, -3);
  const parts = stem.split('__');
  // Expect exactly [fromTitle, toTitle, phase, stamp].
  if (parts.length !== 4) return null;
  const [fromTitle, toTitle, phase, stamp] = parts;
  if (phase !== 'BEFORE' && phase !== 'AFTER') return null;
  const fromLabel = soulLabelFromTitle(fromTitle);
  const toLabel = soulLabelFromTitle(toTitle);
  if (fromLabel === null || toLabel === null) return null;
  return { filename, fromTitle, toTitle, fromLabel, toLabel, phase, stamp };
}

export async function listSoulBackups(folderName: string): Promise<SoulBackupInfo[]> {
  const bdir = beingSoulBackupsDir(folderName);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(bdir);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  const out: SoulBackupInfo[] = [];
  for (const f of entries) {
    const info = parseSoulBackupFilename(f);
    if (info) out.push(info);
  }
  // Newest first — the stamp is zero-padded and lexicographically sortable.
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

export async function readSoulBackup(folderName: string, filename: string): Promise<string | null> {
  // Reject anything that doesn't parse — this doubles as a path-traversal
  // guard: only names matching the strict backup scheme are ever read.
  if (!parseSoulBackupFilename(filename)) return null;
  try {
    return await fs.readFile(
      path.join(beingSoulBackupsDir(folderName), filename),
      'utf-8'
    );
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function shiftRightToLeft(
  folderName: string,
  currentLabel: string,
  // The next generation's label is PASSED IN, not derived. It used to be
  // `currentIndex + 1`, and arithmetic stopped answering the question when a
  // generation could be labelled `1-5` (its successor is `2-1`, decided by the
  // folder's order — see soulGeneration.ts). Deriving it here would give this
  // function a second, dumber opinion about the chain.
  nextLabel: string,
  previousLeftContents: string,
  newLeftContents: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Best-effort backup of what the left pane held before the shift — the
    // "BEFORE" snapshot of this session's stage (N → N+1). A backup hiccup
    // must not block the shift.
    if (previousLeftContents.trim()) {
      await backupSoulSnapshot(folderName, currentLabel, nextLabel, 'BEFORE', previousLeftContents);
    }
    // The promoted draft becomes the left pane's WORKING COPY, not the finished
    // soul of conversation N. This is the write that used to clobber a closed
    // generation; the shift's intent was always "this draft is now the basis
    // for the next pass", which is a working-copy operation by definition.
    await writeSpuWorkFile(folderName, currentLabel, newLeftContents);
    // The right pane IS the real `<N+1>.md` draft, so clearing it stays a real
    // write — the new run starts from a blank next-generation file.
    await writeSystemPromptFile(folderName, nextLabel, '');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'could not shift right pane to left' };
  }
}

// ── Layer parsing/assembly ──────────────────────────────────────────────────
// A "layer" is anything bounded by `### **Layer N:` headers. We tolerate
// missing layers (return empty content for those indices) so the user can
// start an entity from scratch.

export interface Layer {
  index: number;     // 1..4
  name: string;      // "Identity Profile" etc — the header tail after "Layer N:"
  content: string;   // body BELOW the header line, excluding the trailing newline before next header
}

// Accepts `##` or `###` heading prefix. NEXUS now writes `##` (the user's
// preferred form); the looser match keeps already-saved `###` files readable.
const LAYER_HEADER_RE = /^#{2,3}\s*\*\*Layer\s*(\d+)\s*[:：]\s*(.+?)(?:\*\*)?\s*$/gm;

// Parse a system prompt file into 1..N layers. Order in the file is
// preserved; missing indices are filled with empty content + default names.
export function parseLayers(text: string): Layer[] {
  const matches: Array<{ index: number; name: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  LAYER_HEADER_RE.lastIndex = 0;
  while ((m = LAYER_HEADER_RE.exec(text)) !== null) {
    matches.push({
      index: parseInt(m[1], 10),
      // Strip trailing ** if the regex didn't catch a balanced pair.
      name: m[2].replace(/\*+$/, '').trim(),
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }

  const layers: Layer[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const next = matches[i + 1];
    const body = text.slice(cur.bodyStart, next ? next.start : text.length);
    layers.push({
      index: cur.index,
      name: cur.name,
      // Trim ONE leading newline (between header and body) and any trailing
      // blank lines, but preserve internal whitespace.
      content: body.replace(/^\n/, '').replace(/\s+$/, ''),
    });
  }

  // Fill missing layers 1..4 with empty stubs so the UI can render all four.
  const byIdx = new Map(layers.map((l) => [l.index, l]));
  const DEFAULT_NAMES = [
    'Identity Profile（自己定義・属性）',
    'Relational Topology（関係性と世界観）',
    'Functional Assets & Protocols（能力・手順・所持品）',
    'Episode Chronicles（エピソード・事象記録）',
  ];
  const result: Layer[] = [];
  for (let i = 1; i <= 4; i++) {
    const existing = byIdx.get(i);
    if (existing) result.push(existing);
    else result.push({ index: i, name: DEFAULT_NAMES[i - 1], content: '' });
  }
  return result;
}

// Reassemble a layer array into the canonical on-disk form.
// Always writes `##` (the user's preferred heading level — was `###`
// initially; the parser still reads both so old files continue to work).
export function assembleLayers(layers: Layer[]): string {
  return layers
    .filter((l) => l.content || l.name) // skip fully empty layers
    .map((l) => `## **Layer ${l.index}: ${l.name}**\n${l.content}`)
    .join('\n\n');
}

// ── Agent loading ───────────────────────────────────────────────────────────
// Each agent file is "<system prompt definition>---<user instruction template>".
// For execution we only need the system-prompt definition; the user message is
// composed dynamically with the entity's actual data.

// List subdirectories of AGENTS_DIR. Each one is a UI-language code ("en",
// "ja") holding one complete set of agent files; the System Prompt Updater
// picks the folder matching the current interface language rather than asking.
// Loose files at the AGENTS_DIR root are ignored; only directories count.
export async function listAgentTypes(): Promise<string[]> {
  const root = await resolveAgentsRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

// The new single-call updater uses ONE agent file per type that updates all of
// Layers 1-3 in a single pass (replacing the old standard + dynamic-compression
// pair). Prefer the canonical filename; otherwise fall back to the first
// non-summary, non-underscore .md file in the language folder, so a language
// set can name its agent freely.
const MAIN_AGENT_NAME = 'Boundary_Enforced_Abstract_Identity_Schema.md';
export async function readMainAgent(type: string): Promise<string | null> {
  if (!type) return null;
  const dir = await agentTypeDir(type);
  try {
    // Canonical name first.
    return await fs.readFile(path.join(dir, MAIN_AGENT_NAME), 'utf-8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
  }
  // Fall back to the first suitable .md in the folder.
  try {
    const entries = await fs.readdir(dir);
    const pick = entries.find(
      (f) =>
        f.endsWith('.md') &&
        f !== SUMMARY_AGENT_NAME &&
        f !== STANDARD_AGENT_NAME &&
        f !== COMPRESSION_AGENT_NAME &&
        !f.startsWith('_') &&
        !f.startsWith('.'),
    );
    if (!pick) return null;
    return await fs.readFile(path.join(dir, pick), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

// List + read EVERY `.md` agent file in a type subfolder. Each one is a
// selectable updater agent in the UI (the user picks which to run). Returns
// filename + raw contents, sorted by name. (`_deletion_patterns.txt` is not
// `.md` so it's naturally excluded; dotfiles are skipped.)
export async function readAllAgentFiles(type: string): Promise<Array<{ name: string; content: string }>> {
  if (!type) return [];
  const dir = await agentTypeDir(type);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  const mdFiles = entries
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b));
  const out: Array<{ name: string; content: string }> = [];
  for (const f of mdFiles) {
    try {
      out.push({ name: f, content: await fs.readFile(path.join(dir, f), 'utf-8') });
    } catch { /* skip unreadable */ }
  }
  return out;
}

export async function readStandardAgent(type: string): Promise<string | null> {
  if (!type) return null;
  try {
    return await fs.readFile(path.join(await agentTypeDir(type), STANDARD_AGENT_NAME), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function readCompressionAgent(type: string): Promise<string | null> {
  if (!type) return null;
  try {
    return await fs.readFile(path.join(await agentTypeDir(type), COMPRESSION_AGENT_NAME), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

// The summary-writer agent condenses one conversation into a short standalone
// summary for the Layer-4 summaries index (used when a folder opts into
// "summaries instead of the 4th layer"). Optional per type — returns null if
// the type doesn't define one, in which case the client falls back to a
// built-in default instruction.
export async function readSummaryAgent(type: string): Promise<string | null> {
  if (!type) return null;
  try {
    return await fs.readFile(path.join(await agentTypeDir(type), SUMMARY_AGENT_NAME), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

// Splits the agent file at the first horizontal-rule separator (`---` on its
// own line) and returns just the system-prompt definition above it.
export function extractAgentSystemPrompt(agentFile: string): string {
  const sepIdx = agentFile.search(/^---\s*$/m);
  if (sepIdx < 0) return agentFile.trim();
  return agentFile.slice(0, sepIdx).trim();
}

// ── Deletion patterns ───────────────────────────────────────────────────────
// One pattern per line in _deletion_patterns.txt. Patterns are matched against
// the assembled system prompt and removed verbatim. Two forms supported:
//   - "literal text here"   → matches that exact substring (case-sensitive)
//   - "/regex/flags"        → JS regex (e.g. /^\s*##\s*Defense.*$/gmi)
// Comments (lines starting with `#`) and blank lines are ignored.

// Deletion patterns are stored per-language folder (alongside the agent files)
// rather than in `system_prompts/_deletion_patterns.txt`, because each language
// set uses its own processing labels — （維持） in ja, [preserved] in en.
export async function readDeletionPatterns(type: string): Promise<string[]> {
  if (!type) return [];
  try {
    const raw = await fs.readFile(path.join(await agentTypeDir(type), DELETIONS_NAME), 'utf-8');
    return raw
      .split(/\r?\n/)
      .map((s) => s.replace(/\s+$/, ''))
      .filter((s) => s && !s.startsWith('#'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

// Apply each pattern to the assembled prompt. Regex form is "/<body>/<flags>".
export function applyDeletionPatterns(text: string, patterns: string[]): string {
  let out = text;
  for (const raw of patterns) {
    const m = raw.match(/^\/(.+)\/([a-z]*)$/);
    if (m) {
      try {
        const re = new RegExp(m[1], m[2]);
        out = out.replace(re, '');
      } catch {
        // Bad regex — treat as literal
        out = out.split(raw).join('');
      }
    } else {
      out = out.split(raw).join('');
    }
  }
  // Collapse runs of 3+ blank lines that the deletions may have left behind.
  return out.replace(/\n{3,}/g, '\n\n');
}
