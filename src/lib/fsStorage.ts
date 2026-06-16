import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const SETTINGS_DIR = path.join(DATA_DIR, 'settings');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

const USER_SETTINGS_FILE = path.join(DATA_DIR, 'user_settings.json');

const FOLDERS_DIR = path.join(DATA_DIR, 'folders');
const WORKSPACES_DIR = path.join(DATA_DIR, 'agent_workspaces');

// Per-entity CSS themes live as plain, hand-editable `.css` files here:
//   local_data/themes/<EntityName>.css
// This file is the SOURCE OF TRUTH for a folder's `customCss`:
//   - saveFolder() writes the CSS out to it (and keeps it OUT of the folder JSON),
//   - listFolders() reads it back into settings.customCss,
// so you can open/edit the .css file directly and a reload picks it up.
const THEMES_DIR = path.join(DATA_DIR, 'themes');

/** Absolute path of a folder's theme file (raw name, matching the .json naming). */
function themeCssPath(folderName: string): string {
  return path.join(THEMES_DIR, `${folderName}.css`);
}

/** Read a folder's theme CSS file, or null if none exists. */
async function readThemeCss(folderName: string): Promise<string | null> {
  try {
    return await fs.readFile(themeCssPath(folderName), 'utf-8');
  } catch {
    return null;
  }
}

/** Write (or, when empty, remove) a folder's theme CSS file. */
async function writeThemeCss(folderName: string, css: string | undefined | null): Promise<void> {
  await fs.mkdir(THEMES_DIR, { recursive: true });
  const p = themeCssPath(folderName);
  if (css && css.trim()) {
    await fs.writeFile(p, css);
  } else {
    // No CSS → don't leave an empty file lying around.
    try { await fs.unlink(p); } catch {}
  }
}

// -------- Agent workspace helpers ---------------------------------------
// Each AI entity (Nexus folder) gets its own sandboxed directory under
// agent_workspaces/. Paths inside are relative and bounded — any attempt
// to escape via "../" returns null and the operation refuses.

function sanitizeFolderName(name: string): string {
  // Strip filesystem-hostile chars but keep CJK and reasonable unicode.
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

export async function ensureWorkspace(folderName: string): Promise<string> {
  const dir = path.join(WORKSPACES_DIR, sanitizeFolderName(folderName));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function resolveWorkspacePath(folderName: string, relPath: string): string | null {
  const root = path.resolve(WORKSPACES_DIR, sanitizeFolderName(folderName));
  // Trim any leading slashes — model might emit "/notes.md"
  const cleaned = String(relPath || '').replace(/^[/\\]+/, '');
  const target = path.resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

// Symlink-safe variant. Resolves both the target and the sandbox root via
// fs.realpath so a symlink planted inside the sandbox that points outside
// (e.g. <workspace>/escape → C:\Windows) is caught: realpath surfaces the
// true location and the prefix check fails. For files that don't exist yet
// (Write operations), we realpath the deepest existing ancestor instead.
async function resolveWorkspacePathSafe(folderName: string, relPath: string): Promise<string | null> {
  const target = resolveWorkspacePath(folderName, relPath);
  if (!target) return null;
  const root = path.resolve(WORKSPACES_DIR, sanitizeFolderName(folderName));
  try {
    const realRoot = await fs.realpath(root);
    let realTarget: string;
    try {
      // Target exists — realpath the file/dir itself.
      realTarget = await fs.realpath(target);
    } catch {
      // Target doesn't exist (e.g. Write to a new file). Walk up to the
      // deepest existing ancestor and realpath that, then re-attach the
      // missing tail unchanged. If any of the existing ancestor's links
      // escape, that surfaces here.
      let dir = path.dirname(target);
      let tail = path.basename(target);
      // Defense-in-depth cap: don't loop forever on weird filesystems.
      for (let i = 0; i < 64; i++) {
        try {
          const realDir = await fs.realpath(dir);
          realTarget = path.join(realDir, tail);
          if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
          return realTarget;
        } catch {
          // dir doesn't exist either — go one level up.
          const parent = path.dirname(dir);
          if (parent === dir) return null; // hit filesystem root
          tail = path.join(path.basename(dir), tail);
          dir = parent;
        }
      }
      return null;
    }
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
    return realTarget;
  } catch {
    return null;
  }
}

export async function listWorkspaceFiles(folderName: string): Promise<string[]> {
  const root = await ensureWorkspace(folderName);
  const out: string[] = [];
  async function walk(dir: string, prefix: string) {
    let entries: any[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip hidden + atomic-write tempfiles
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

export async function readWorkspaceFile(folderName: string, relPath: string): Promise<string | null> {
  const target = await resolveWorkspacePathSafe(folderName, relPath);
  if (!target) return null;
  try { return await fs.readFile(target, 'utf-8'); }
  catch { return null; }
}

// Image / binary read. Returns null if the path is invalid or the file is unreadable.
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
export function isImageFilename(p: string): boolean {
  return path.extname(p).toLowerCase() in IMAGE_MIME_BY_EXT;
}
export function imageMimeFor(p: string): string {
  return IMAGE_MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream';
}
export async function readWorkspaceFileBinary(folderName: string, relPath: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const target = await resolveWorkspacePathSafe(folderName, relPath);
  if (!target) return null;
  try {
    const data = await fs.readFile(target);
    return { data, mimeType: imageMimeFor(relPath) };
  } catch { return null; }
}

export async function writeWorkspaceFile(folderName: string, relPath: string, content: string): Promise<{ ok: boolean; existed: boolean; error?: string }> {
  const target = await resolveWorkspacePathSafe(folderName, relPath);
  if (!target) return { ok: false, existed: false, error: 'Path escapes workspace' };
  let existed = false;
  try { await fs.access(target); existed = true; } catch {}
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic write — same pattern as saveLog
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, target);
    return { ok: true, existed };
  } catch (e: any) {
    return { ok: false, existed, error: e?.message || 'write failed' };
  }
}

// Surgical find-and-replace within an existing file. Replaces ONE occurrence
// of `oldString` with `newString` and rejects if oldString is missing or
// occurs multiple times (forces the model to disambiguate by widening the
// match instead of silently replacing the wrong instance).
export async function editWorkspaceFile(folderName: string, relPath: string, oldString: string, newString: string): Promise<{ ok: boolean; error?: string }> {
  const target = await resolveWorkspacePathSafe(folderName, relPath);
  if (!target) return { ok: false, error: 'Path escapes workspace' };
  let original: string;
  try { original = await fs.readFile(target, 'utf-8'); }
  catch (e: any) { return { ok: false, error: e?.message || 'file not found' }; }
  if (!oldString) return { ok: false, error: 'oldString must not be empty' };
  const idx = original.indexOf(oldString);
  if (idx < 0) return { ok: false, error: 'oldString not found in file' };
  if (original.indexOf(oldString, idx + 1) >= 0) {
    return { ok: false, error: 'oldString occurs multiple times — widen the match so it uniquely identifies one location' };
  }
  const next = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
  try {
    const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
    await fs.writeFile(tmp, next);
    await fs.rename(tmp, target);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'edit failed' };
  }
}

// Glob-style file finder. Patterns use `*` (any chars in one path segment)
// and `**` (any chars including path separators). Examples:
//   `*.md`            → top-level Markdown files
//   `memories/*.txt`  → text files directly inside memories/
//   `**/*.json`       → all JSON files anywhere
// Results are returned sorted, capped to a reasonable count to keep
// tool-result payloads small.
export async function globWorkspaceFiles(folderName: string, pattern: string, limit = 500): Promise<string[]> {
  const all = await listWorkspaceFiles(folderName);
  const re = globToRegex(pattern || '**');
  const matched = all.filter((p) => re.test(p));
  return matched.slice(0, limit);
}

function globToRegex(glob: string): RegExp {
  // Escape regex specials, then translate glob wildcards back. `**` becomes
  // `.*` (cross-segment), `*` becomes `[^/]*` (within-segment), `?` becomes
  // `[^/]` (single char in segment). Anchored at both ends.
  // The order matters: replace `**` first as a placeholder, then `*`, then
  // restore `**`.
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 2;
        // Skip a following slash so `**/foo` works for `foo` at root.
        if (glob[i] === '/') i++;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]'; i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      out += '\\' + c; i += 1;
    } else if (c === '/') {
      out += '/'; i += 1;
    } else {
      out += c; i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

// Regex content search across the workspace. Returns at most `limit` matches
// as `{ path, line, text }` triples so the model can decide which file to
// read next without having to ingest entire directories.
export async function grepWorkspaceFiles(folderName: string, pattern: string, opts?: { filePattern?: string; flags?: string; limit?: number }): Promise<{ ok: boolean; matches?: { path: string; line: number; text: string }[]; error?: string }> {
  const limit = opts?.limit ?? 200;
  let re: RegExp;
  try { re = new RegExp(pattern || '', opts?.flags || ''); }
  catch (e: any) { return { ok: false, error: `Invalid regex: ${e?.message || 'unknown'}` }; }
  const fileRe = opts?.filePattern ? globToRegex(opts.filePattern) : null;
  const all = await listWorkspaceFiles(folderName);
  const matches: { path: string; line: number; text: string }[] = [];
  for (const relPath of all) {
    if (fileRe && !fileRe.test(relPath)) continue;
    const text = await readWorkspaceFile(folderName, relPath);
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Reset lastIndex for global regexes so each line gets a clean test.
      re.lastIndex = 0;
      if (re.test(ln)) {
        matches.push({ path: relPath, line: i + 1, text: ln.slice(0, 500) });
        if (matches.length >= limit) return { ok: true, matches };
      }
    }
  }
  return { ok: true, matches };
}

async function migrateOldLogs() {
  try {
    const files = await fs.readdir(LOGS_DIR, { withFileTypes: true });
    let hasRootLogs = false;
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.json')) {
        hasRootLogs = true;
        break;
      }
    }
    if (hasRootLogs) {
      const defaultDir = path.join(LOGS_DIR, 'Default');
      await fs.mkdir(defaultDir, { recursive: true });
      for (const file of files) {
        if (file.isFile() && file.name.endsWith('.json')) {
          await fs.rename(path.join(LOGS_DIR, file.name), path.join(defaultDir, file.name));
        }
      }
    }
  } catch (e) {}
}

async function ensureDirs() {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  await fs.mkdir(FOLDERS_DIR, { recursive: true });
  await fs.mkdir(THEMES_DIR, { recursive: true });
  await migrateOldLogs();
}

export async function listFolders() {
  await ensureDirs();
  try {
    const files = await fs.readdir(FOLDERS_DIR);
    const folders = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readFile(path.join(FOLDERS_DIR, file), 'utf-8');
        try {
          const parsed = JSON.parse(data);
          const name = parsed.name || file.replace('.json', '');
          const settings = parsed.settings || {};
          // The .css theme file is the source of truth — overlay it onto
          // settings.customCss so manual edits to the file are picked up.
          const css = await readThemeCss(name);
          if (css !== null) settings.customCss = css;
          folders.push({ id: file.replace('.json', ''), name, settings });
        } catch (e) {}
      }
    }
    const logDirs = await fs.readdir(LOGS_DIR, { withFileTypes: true });
    for (const dir of logDirs) {
      if (dir.isDirectory() && !folders.find(f => f.name === dir.name)) {
        const css = await readThemeCss(dir.name);
        folders.push({ id: dir.name, name: dir.name, settings: css !== null ? { customCss: css } : {} });
      }
    }
    return folders;
  } catch (e) {
    return [];
  }
}

export async function saveFolder(folderName: string, settings: any) {
  await ensureDirs();
  // Split the CSS out into local_data/themes/<name>.css (the editable source of
  // truth) and keep it out of the folder JSON to avoid a stale duplicate.
  const { customCss, ...rest } = settings || {};
  await writeThemeCss(folderName, customCss);
  const filePath = path.join(FOLDERS_DIR, `${folderName}.json`);
  await fs.writeFile(filePath, JSON.stringify({ name: folderName, settings: rest }, null, 2));
}

export async function renameFolder(oldName: string, newName: string) {
  await ensureDirs();
  try {
    const oldFilePath = path.join(FOLDERS_DIR, `${oldName}.json`);
    const newFilePath = path.join(FOLDERS_DIR, `${newName}.json`);
    const data = await fs.readFile(oldFilePath, 'utf-8');
    const parsed = JSON.parse(data);
    parsed.name = newName;
    await fs.writeFile(newFilePath, JSON.stringify(parsed, null, 2));
    await fs.unlink(oldFilePath);
  } catch (e) {}

  // Move the per-entity CSS theme file alongside the rename.
  try {
    await fs.mkdir(THEMES_DIR, { recursive: true });
    await fs.rename(themeCssPath(oldName), themeCssPath(newName));
  } catch (e) {}

  try {
    const oldLogDir = path.join(LOGS_DIR, oldName);
    const newLogDir = path.join(LOGS_DIR, newName);
    await fs.rename(oldLogDir, newLogDir);
  } catch (e) {}
}

export async function deleteFolder(folderName: string) {
  await ensureDirs();
  try { await fs.unlink(path.join(FOLDERS_DIR, `${folderName}.json`)); } catch (e) {}
  try { await fs.rm(path.join(LOGS_DIR, folderName), { recursive: true, force: true }); } catch (e) {}
  try { await fs.unlink(themeCssPath(folderName)); } catch (e) {}
}

export async function saveUserSettings(settings: any) {
  await ensureDirs();
  await fs.writeFile(USER_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export async function loadUserSettings() {
  await ensureDirs();
  try {
    const data = await fs.readFile(USER_SETTINGS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return { userName: '' };
  }
}

export async function saveSettings(aiName: string, settings: any) {
  await ensureDirs();
  const filePath = path.join(SETTINGS_DIR, `${aiName}.json`);
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2));
}

export async function loadSettings(aiName: string) {
  await ensureDirs();
  const filePath = path.join(SETTINGS_DIR, `${aiName}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

export async function saveKeys(keys: any) {
  await ensureDirs();
  await fs.writeFile(KEYS_FILE, JSON.stringify(keys, null, 2));
}

export async function loadKeys() {
  await ensureDirs();
  try {
    const data = await fs.readFile(KEYS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return {};
  }
}

// In-process write lock per conversation. Two saveLog calls for the same
// convoId chain serially instead of racing on the filesystem. Stored on
// globalThis so hot-reload in dev doesn't reset the locks mid-flight.
const _g = globalThis as any;
if (!_g.__nx_save_locks) _g.__nx_save_locks = new Map<string, Promise<void>>();
const writeLocks: Map<string, Promise<void>> = _g.__nx_save_locks;

async function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(r => { release = r; });
  writeLocks.set(key, prev.then(() => next));
  try { await prev; } catch {}
  try { return await fn(); }
  finally {
    release();
    if (writeLocks.get(key) === next) writeLocks.delete(key);
  }
}

// Atomic write — write to a unique temp file in the SAME directory (so the
// rename is a same-volume atomic operation), then rename onto the target.
// fs.rename on the same filesystem is atomic on Windows (via MoveFileEx
// replace semantics) and POSIX (atomic by spec). If the write is interrupted
// or crashes mid-way, the destination file either retains its old contents
// or contains the full new contents — never a half-overwritten frankenfile.
async function atomicWriteFile(filePath: string, data: string) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  } catch (e) {
    // Clean up tmp on failure so we don't leak .tmp-* files
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }
}

export async function saveLog(convoId: string, logData: any) {
  await ensureDirs();
  const folderName = logData.folderName || 'Default';

  // Serialize all writes to this conversation so two concurrent saves can't
  // interleave bytes on disk. Both the main write and the backup write happen
  // under the same lock.
  return withWriteLock(`log:${convoId}`, async () => {
    // Move-away cleanup: remove old copies of this convoId in any other folder
    const logDirs = await fs.readdir(LOGS_DIR, { withFileTypes: true });
    for (const dir of logDirs) {
      if (dir.isDirectory() && dir.name !== folderName) {
        const oldPath = path.join(LOGS_DIR, dir.name, `${convoId}.json`);
        try { await fs.unlink(oldPath); } catch (e) {}
      }
    }

    const targetDir = path.join(LOGS_DIR, folderName);
    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, `${convoId}.json`);
    logData.updatedAt = logData.updatedAt || Date.now();
    // Preserve the on-disk `active` flag when the incoming payload doesn't
    // mention it. The chat-view auto-save rebuilds logData WITHOUT `active`,
    // which would otherwise silently revert a "Mark inactive" toggle a few
    // seconds later. A save that says nothing about `active` must not change it.
    if (logData.active === undefined) {
      try {
        const fh = await fs.open(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, 4096, 0);
        await fh.close();
        const head = buf.subarray(0, bytesRead).toString('utf-8');
        const m = head.match(/"active"\s*:\s*(true|false)/);
        if (m) logData.active = m[1] === 'true';
      } catch {}
    }
    // Hoist the small metadata fields the header parser cares about to the very
    // FRONT of the object, ahead of large fields like `systemPrompt` and the
    // `messages` array. The header parser (readLogHeaderMetadata) only reads the
    // first 4KB; `systemPrompt` alone can blow past that, so if `active`/`title`
    // sit after it they fall outside the window and a "Mark inactive" toggle
    // silently reverts. Pulling them first guarantees they're always visible.
    const { messages: _msgs, ...headerFields } = logData;
    const { id: _id, folderName: _fn, aiName: _ai, title: _t, active: _act, updatedAt: _ua, ...rest } = headerFields;
    const serialized = {
      id: _id,
      folderName: _fn,
      aiName: _ai,
      title: _t,
      active: _act,
      updatedAt: _ua,
      ...rest,
      messages: _msgs,
    };
    const currentJson = JSON.stringify(serialized, null, 2);
    await atomicWriteFile(filePath, currentJson);

    // --- Auto-Backup ---
    try {
      const currentDate = new Date().toISOString().split('T')[0];
      const backupDir = path.join(BACKUPS_DIR, folderName);
      await fs.mkdir(backupDir, { recursive: true });

      const files = await fs.readdir(backupDir);
      const convoBackups = files.filter(f => f.startsWith(`${convoId}_`)).sort();

      let shouldBackup = true;
      if (convoBackups.length > 0) {
        const latestBackup = convoBackups[convoBackups.length - 1];
        const latestData = await fs.readFile(path.join(backupDir, latestBackup), 'utf-8');
        if (latestData === currentJson) shouldBackup = false;
      }

      if (shouldBackup) {
        await atomicWriteFile(path.join(backupDir, `${convoId}_${currentDate}.json`), currentJson);
      }
    } catch (e) {
      console.error('Backup failed:', e);
    }
  });
}

export async function loadLog(convoId: string) {
  await ensureDirs();
  const logDirs = await fs.readdir(LOGS_DIR, { withFileTypes: true });
  for (const dir of logDirs) {
    if (dir.isDirectory()) {
      const filePath = path.join(LOGS_DIR, dir.name, `${convoId}.json`);
      try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
      } catch (e) {}
    }
  }
  return null;
}

// ── Fast log-listing path ────────────────────────────────────────────────────
// Previously this function fully parsed every log file just to extract
// `title`/`updatedAt`/`aiName`. With image-heavy conversations (megabytes
// each), that pinned the sidebar for many seconds on cold-start.
//
// Optimization: read only the first chunk of each file (HEADER_BYTES below)
// and regex-extract the metadata fields. Logs are saved with title near the
// top of the JSON so the header almost always contains everything we need.
// On regex miss, we fall back to a full parse for THAT FILE ONLY (preserves
// corruption-detection behavior).
//
// `updatedAt` comes from filesystem mtime — saveLog touches the file every
// write, so mtime matches the in-JSON updatedAt by construction. This lets
// us skip parsing for that field entirely and works even on legacy logs
// that lack the field.
//
// All folders + files are stat'd / read in parallel via Promise.all, which
// gives another ~5× speedup on top of the smaller per-file reads.
const HEADER_BYTES = 4096;

async function readLogHeaderMetadata(fullPath: string): Promise<{ title?: string; aiName?: string; active?: boolean; needsFullParse: boolean } | null> {
  let fh: any;
  try {
    fh = await fs.open(fullPath, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    await fh.close(); fh = null;
    const head = buf.subarray(0, bytesRead).toString('utf-8');

    // Regex extract. Field values are JSON strings — supports backslash
    // escapes including \" inside the value. Re-parse via JSON.parse on the
    // matched literal so we get correctly-decoded unicode + escapes.
    const reField = (name: string) => new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`);
    const titleMatch = head.match(reField('title'));
    const aiNameMatch = head.match(reField('aiName'));
    // `active` is a boolean — only present when explicitly set false (or true).
    // Absence means active (the default). Read it from the header best-effort.
    const activeMatch = head.match(/"active"\s*:\s*(true|false)/);
    const active = activeMatch ? activeMatch[1] === 'true' : undefined;
    // If neither field is in the header, the JSON is structured differently
    // than expected — fall through to full parse rather than guess.
    if (!titleMatch && !aiNameMatch) {
      return { needsFullParse: true };
    }
    let title: string | undefined;
    let aiName: string | undefined;
    try { if (titleMatch) title = JSON.parse(titleMatch[1]); } catch {}
    try { if (aiNameMatch) aiName = JSON.parse(aiNameMatch[1]); } catch {}
    return { title, aiName, active, needsFullParse: false };
  } catch {
    try { if (fh) await fh.close(); } catch {}
    return null;
  }
}

export async function listLogs() {
  await ensureDirs();
  try {
    const logDirs = await fs.readdir(LOGS_DIR, { withFileTypes: true });

    // Phase 1: walk every folder in parallel, collecting (fullPath, folderName, file) tuples.
    const fileEntries: { fullPath: string; folderName: string; file: string }[] = [];
    await Promise.all(logDirs.map(async (dir) => {
      if (!dir.isDirectory()) return;
      const folderName = dir.name;
      const files = (await fs.readdir(path.join(LOGS_DIR, folderName)))
        .filter(f => !f.startsWith('.') && f.endsWith('.json'));
      for (const file of files) {
        fileEntries.push({ fullPath: path.join(LOGS_DIR, folderName, file), folderName, file });
      }
    }));

    // Phase 2: stat + header-read every file in parallel.
    const logs = await Promise.all(fileEntries.map(async ({ fullPath, folderName, file }) => {
      const id = file.replace('.json', '');
      let stat: any = null;
      try { stat = await fs.stat(fullPath); } catch {}
      const updatedAt = stat?.mtimeMs || Date.now();

      const meta = await readLogHeaderMetadata(fullPath);
      if (meta && !meta.needsFullParse) {
        return {
          id,
          folderName,
          title: meta.title || 'New Conversation',
          updatedAt,
          aiName: meta.aiName || 'Default',
          active: meta.active !== false,
        };
      }

      // Fallback: header read failed or wasn't structured. Full parse so we
      // either find the fields or mark the file as corrupted.
      try {
        const data = await fs.readFile(fullPath, 'utf-8');
        const parsed = JSON.parse(data);
        return {
          id,
          folderName,
          title: parsed.title || 'New Conversation',
          updatedAt: parsed.updatedAt || updatedAt,
          aiName: parsed.aiName || 'Default',
          active: parsed.active !== false,
        };
      } catch (e: any) {
        // Genuine corruption. Surface it so the user can recover from
        // local_data/backups/. Old code did the same.
        console.error(`[fsStorage] Corrupted log file ${fullPath}: ${e.message}`);
        return {
          id,
          folderName,
          title: `⚠ CORRUPTED — ${file}`,
          updatedAt,
          aiName: 'Default',
          corrupted: true,
          corruptionError: e.message,
        };
      }
    }));

    return logs.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    return [];
  }
}

export async function deleteLog(convoId: string) {
  await ensureDirs();
  const logDirs = await fs.readdir(LOGS_DIR, { withFileTypes: true });
  for (const dir of logDirs) {
    if (dir.isDirectory()) {
      const filePath = path.join(LOGS_DIR, dir.name, `${convoId}.json`);
      try {
        await fs.unlink(filePath);
      } catch (e) {}
    }
  }
}
