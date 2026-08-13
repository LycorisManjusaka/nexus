import fs from 'fs/promises';
import path from 'path';
import { resolveSummaryHint } from './summaryHint';

// ───────────────────────────────────────────────────────────────────────────
// Per-conversation summary storage. Each summary is a small Markdown file that
// captures the gist of one conversation, written by the "Summary Writer" agent
// (or hand-edited). The aggregate of all an entity's summaries — sorted to
// match the sidebar's conversation order — becomes the live Layer 4 index that
// is injected into the system prompt at send time (replacing the old, baked
// Layer 4 block).
//
// Layout: local_data/summaries/<folderName>/<title>.md
//
// Files are keyed by the conversation TITLE (e.g. "先輩_46.md"), so they are
// human-readable and line up with the "<base>_<index>.md" layer-file naming.
// The index route pairs each summary with the live conversation by sanitizing
// the title the same way (see summaryKey).
// ───────────────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const SUMMARIES_DIR = path.join(DATA_DIR, 'summaries');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

// Mirror the folder-name sanitization used elsewhere so the same entity maps
// to the same directory across features.
function sanitizeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

// Turn a conversation title into a safe filename stem. Keeps CJK, digits, and
// the "_" separator; strips path-hostile characters and "..". Exported so the
// API route can match listSummaries() keys against live titles.
export function summaryKey(title: string): string {
  return String(title || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.\.+/g, '_').trim();
}

function summaryDir(folderName: string): string {
  return path.join(SUMMARIES_DIR, sanitizeFolderName(folderName));
}

function summaryFilePath(folderName: string, title: string): string {
  return path.join(summaryDir(folderName), `${summaryKey(title)}.md`);
}

async function atomicWriteFile(filePath: string, data: string) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }
}

export async function readSummary(folderName: string, title: string): Promise<string | null> {
  try {
    return await fs.readFile(summaryFilePath(folderName, title), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeSummary(folderName: string, title: string, content: string): Promise<string> {
  const dir = summaryDir(folderName);
  await fs.mkdir(dir, { recursive: true });
  const p = summaryFilePath(folderName, title);
  await atomicWriteFile(p, content ?? '');
  return p;
}

export async function deleteSummary(folderName: string, title: string): Promise<void> {
  try { await fs.unlink(summaryFilePath(folderName, title)); } catch {}
}

// Read every summary file in an entity folder into a { titleKey -> content }
// map (key = summaryKey(title) = filename stem). The route pairs these with
// the live conversation list by sanitizing each title the same way.
export async function listSummaries(folderName: string): Promise<Record<string, string>> {
  const dir = summaryDir(folderName);
  const out: Record<string, string> = {};
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return out;
    throw e;
  }
  await Promise.all(
    entries
      .filter((f) => !f.startsWith('.') && f.endsWith('.md'))
      .map(async (f) => {
        const key = f.replace(/\.md$/, '');
        try {
          out[key] = await fs.readFile(path.join(dir, f), 'utf-8');
        } catch {}
      }),
  );
  return out;
}

// ── Bulk replace, with a snapshot taken first ───────────────────────────────
// The "Redistribute Layers 1-4" mode rewrites MANY summaries in one go from a
// single agent output. That is the one operation here that can destroy real
// work, so it is never done without a full copy of the folder taken first:
//
//   local_data/summaries/<entity>/  →  local_data/backups/<entity>/summaries/<YYYY-MM-DD_HH-MM-SS>/
//
// Backup and writes happen inside ONE request so they cannot be half-applied,
// and the backup is a hard precondition — if the copy fails, nothing is
// written. Files present on disk but absent from the agent output are left
// untouched: a truncated run must never delete a summary.

function timeStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Copy every file in an entity's summaries folder into a timestamped backup
 * directory. Returns the absolute backup path and how many files were copied.
 * An entity with no summaries yet yields `{ dir: null, files: 0 }` — nothing to
 * protect, so no empty directory is created.
 */
export async function backupSummaries(folderName: string): Promise<{ dir: string | null; files: number }> {
  const src = summaryDir(folderName);
  let names: string[] = [];
  try {
    names = await fs.readdir(src);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { dir: null, files: 0 };
    throw e;
  }
  // Skip dotfiles (including our own .tmp-* write scratch files).
  const files: string[] = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const st = await fs.stat(path.join(src, n)).catch(() => null);
    if (st?.isFile()) files.push(n);
  }
  if (files.length === 0) return { dir: null, files: 0 };

  const dest = path.join(BACKUPS_DIR, sanitizeFolderName(folderName), 'summaries', timeStamp());
  await fs.mkdir(dest, { recursive: true });
  for (const n of files) {
    await fs.copyFile(path.join(src, n), path.join(dest, n));
  }
  return { dir: dest, files: files.length };
}

export interface SummaryReplacement { title: string; content: string; }
export interface ReplaceManyResult {
  backupDir: string | null;
  backedUp: number;
  replaced: string[];
  created: string[];
  skipped: Array<{ title: string; reason: string }>;
}

/**
 * Back up the folder, then write every supplied entry. Entries whose file
 * already exists are reported as `replaced`; the rest as `created` (a title the
 * agent invented, or a conversation renamed since — surfaced so the user can
 * see it rather than silently accumulating).
 */
export async function replaceManySummaries(
  folderName: string,
  entries: SummaryReplacement[],
): Promise<ReplaceManyResult> {
  const backup = await backupSummaries(folderName);
  const existing = await listSummaries(folderName);

  const replaced: string[] = [];
  const created: string[] = [];
  const skipped: Array<{ title: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const e of entries) {
    const title = String(e?.title || '').trim();
    const content = String(e?.content ?? '').trim();
    const key = summaryKey(title);
    if (!key) { skipped.push({ title, reason: 'empty title' }); continue; }
    if (!content) { skipped.push({ title, reason: 'empty body' }); continue; }
    if (seen.has(key)) { skipped.push({ title, reason: 'duplicate title in output' }); continue; }
    seen.add(key);
    await writeSummary(folderName, title, content + '\n');
    if (Object.prototype.hasOwnProperty.call(existing, key)) replaced.push(title);
    else created.push(title);
  }

  return { backupDir: backup.dir, backedUp: backup.files, replaced, created, skipped };
}

// ── Layer-4 index assembly ──────────────────────────────────────────────────
// Build the injected Layer-4 body from an ordered list of conversations. Each
// entry the caller supplies carries the live title, the convoId, whether the
// conversation is active, and (optionally) its summary text. Inactive
// ("non-public") conversations are omitted ENTIRELY — not even a title
// placeholder — so the AI never learns they exist. The caller is expected to
// pre-filter inactive entries; this is a defensive second guard.

export interface SummaryIndexEntry {
  convoId: string;
  title: string;
  active: boolean;
  summary?: string | null;
}

// `hintOverride` is the per-folder editable hint (folder.settings.summaryIndexHint).
// When undefined, the language-matched default hint is used (`lang`, default
// 'ja' for backward compatibility); the {example} token in either is
// substituted with the first real title. Pass '' to omit the hint entirely.
export function assembleSummaryIndex(
  entries: SummaryIndexEntry[],
  hintOverride?: string,
  lang: 'en' | 'ja' = 'ja',
): string {
  const blocks: string[] = [];
  let firstTitle = '';
  for (const e of entries) {
    // Skip inactive conversations completely — they must not appear in the
    // index in any form (privacy contract).
    if (!e.active) continue;
    const title = (e.title || 'Untitled').trim();
    if (!firstTitle) firstTitle = title;
    const body = (e.summary || '').trim();
    if (body) {
      blocks.push(`### ${title}\n${body}`);
    } else {
      blocks.push(`### ${title}\n_(no summary yet)_`);
    }
  }
  if (blocks.length === 0) return '';

  // Editable hint, prepended to the index, telling the entity how to pull a
  // past conversation into context. The {example} token uses a REAL title from
  // this entity so the model copies the current naming format verbatim
  // (previously it guessed the old "＃<full-width>" form, e.g. 先輩＃46, which
  // no longer matches the renamed "<base>_<index>" titles). When the resolved
  // hint is empty (folder cleared the field), no hint block is prepended.
  const hint = resolveSummaryHint(hintOverride, firstTitle, lang);
  if (!hint) return blocks.join('\n\n');
  return [hint, ...blocks].join('\n\n');
}
