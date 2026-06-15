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
// When undefined, the default hint is used; the {example} token in either is
// substituted with the first real title. Pass '' to omit the hint entirely.
export function assembleSummaryIndex(entries: SummaryIndexEntry[], hintOverride?: string): string {
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
  const hint = resolveSummaryHint(hintOverride, firstTitle);
  if (!hint) return blocks.join('\n\n');
  return [hint, ...blocks].join('\n\n');
}
