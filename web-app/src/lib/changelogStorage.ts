import fs from 'fs/promises';
import path from 'path';
import { beingChangelogsDir } from './beingPaths';

// ───────────────────────────────────────────────────────────────────────────
// Per-conversation changelog storage. When the System Prompt Updater agent
// finishes, everything ABOVE the first "## Layer 1" heading is treated as a
// changelog (a human-readable account of what the update changed). It is split
// off the layer content, shown read-only in the UI, and archived here. It is
// NEVER fed back into any context window (entity prompt or updater agent).
//
// Layout: local_data/beings/<folderName>/changelogs/<title>.md  (mirrors summaries).
// ───────────────────────────────────────────────────────────────────────────

// Safe filename stem from a conversation title (keeps CJK/digits/_; strips
// path-hostile chars and ".."). Matches the summary key convention.
function changelogKey(title: string): string {
  return String(title || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.\.+/g, '_').trim();
}
function changelogDir(folderName: string): string {
  return beingChangelogsDir(folderName);
}
function changelogFilePath(folderName: string, title: string): string {
  return path.join(changelogDir(folderName), `${changelogKey(title)}.md`);
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

export async function readChangelog(folderName: string, title: string): Promise<string | null> {
  try {
    return await fs.readFile(changelogFilePath(folderName, title), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeChangelog(folderName: string, title: string, content: string): Promise<string> {
  const dir = changelogDir(folderName);
  await fs.mkdir(dir, { recursive: true });
  const p = changelogFilePath(folderName, title);
  await atomicWriteFile(p, content ?? '');
  return p;
}
