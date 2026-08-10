import fs from 'fs/promises';
import path from 'path';

// Resolves to <repo-root>/local_data/...
const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const SP_ROOT = path.join(DATA_DIR, 'system_prompts');           // per-entity layer files
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
// Mirrors the convention from fsStorage.ts so the same folder maps to the
// same directory across features.
export function sanitizeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

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
// Layout: local_data/system_prompts/<folder>/<folder>_<index>.md
// One file per conversation index; the contents are the four `### **Layer N:`
// blocks concatenated (NO header/footer/deletions — those are applied later).

function entityDir(folderName: string): string {
  return path.join(SP_ROOT, sanitizeFolderName(folderName));
}

function entityFilePath(folderName: string, index: number): string {
  const safe = sanitizeFolderName(folderName);
  return path.join(entityDir(folderName), `${safe}_${index}.md`);
}

export async function readSystemPromptFile(
  folderName: string,
  index: number
): Promise<string | null> {
  try {
    const p = entityFilePath(folderName, index);
    return await fs.readFile(p, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeSystemPromptFile(
  folderName: string,
  index: number,
  contents: string
): Promise<string> {
  const dir = entityDir(folderName);
  await fs.mkdir(dir, { recursive: true });
  const p = entityFilePath(folderName, index);
  await fs.writeFile(p, contents, 'utf-8');
  return p;
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

// List subdirectories of AGENTS_DIR — each one is a selectable "agent type"
// in the System Prompt Updater (e.g. "Entities", "Technical"). Loose files
// at the AGENTS_DIR root are ignored; only directories count.
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
// non-summary, non-underscore .md file in the type folder so a type can name
// its agent freely (e.g. an English/Technical variant).
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

// Deletion patterns are now stored per-agent-type (alongside the agent files)
// rather than in `system_prompts/_deletion_patterns.txt`. Different agent types
// (e.g. Entities vs. Technical) have different finalization-time cleanup needs.
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
