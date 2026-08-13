import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { putDataUrl } from './attachmentStore';
import { retitleForRenamedIdentity } from './convoNaming';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const SETTINGS_DIR = path.join(DATA_DIR, 'settings');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

const USER_SETTINGS_FILE = path.join(DATA_DIR, 'user_settings.json');

const FOLDERS_DIR = path.join(DATA_DIR, 'folders');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');

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
// workspaces/. Paths inside are relative and bounded — any attempt
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

// ── Per-Entity editable footer (FOOTER.md) ───────────────────────────────────
// An entity can keep a FOOTER.md in its own workspace and edit it with its file
// tools. When present, the chat route appends its contents to that entity's
// system prompt (the editable "footer"). When absent, nothing changes — the
// baked prompt is used as-is.
const FOOTER_FILENAME = 'FOOTER.md';

/** Read an entity's workspace FOOTER.md, or null when there isn't one. */
export async function readEntityFooter(folderName: string): Promise<string | null> {
  const p = path.join(WORKSPACES_DIR, sanitizeFolderName(folderName), FOOTER_FILENAME);
  try { return await fs.readFile(p, 'utf-8'); }
  catch { return null; }
}

// Filesystem-safe timestamp for a backup filename: YYYY-MM-DD_HH-MM-SS-mmm.
function footerBackupStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// Snapshot an entity's footer to backups/<Entity>/footers/<timestamp>.md, but
// ONLY when it has CHANGED since the last time we saw it. A hidden ".last"
// marker holds the previously-seen content:
//   - first sighting → record the marker only (the pre-existing "current"
//     footer is NOT saved — we can only capture versions from now on),
//   - a later change  → save the NEW version and advance the marker,
//   - no change       → do nothing.
// Best-effort: never throws, so a footer-backup hiccup can't break a log save.
async function backupFooterIfChanged(folderName: string): Promise<void> {
  try {
    const cur = await readEntityFooter(folderName);
    if (cur === null) return; // entity has no footer file → nothing to track
    const dir = path.join(BACKUPS_DIR, folderName, 'footers');
    const marker = path.join(dir, '.last');
    let prev: string | null = null;
    try { prev = await fs.readFile(marker, 'utf-8'); } catch {}
    if (prev === cur) return; // unchanged (or identical to the recorded baseline)
    await fs.mkdir(dir, { recursive: true });
    if (prev !== null) {
      // A genuine change vs. what we last saw → preserve the new version.
      await atomicWriteFile(path.join(dir, `${footerBackupStamp()}.md`), cur);
    }
    // First sighting (prev === null): record the baseline marker only.
    await fs.writeFile(marker, cur);
  } catch { /* best-effort */ }
}

/**
 * Write an entity's FOOTER.md (its self-authored Layer 5), preserving whatever
 * was there before.
 *
 * This is the HUMAN edit path — the System Prompt Updater window. The entity
 * writes the same file with its own tools, so an edit here can overwrite text
 * the entity authored; the previous version is therefore snapshotted
 * unconditionally rather than through backupFooterIfChanged(), which only fires
 * when the content differs from the last-seen marker and would silently skip
 * the snapshot right after a normal save.
 *
 * An empty body writes an empty file rather than deleting it: appendLayer5Footer
 * already treats empty as "no Layer 5", and keeping the file makes the clearing
 * reversible from the backups.
 */
export async function writeEntityFooter(folderName: string, body: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const dir = path.join(WORKSPACES_DIR, sanitizeFolderName(folderName));
    const file = path.join(dir, FOOTER_FILENAME);
    const text = String(body ?? '');

    const cur = await readEntityFooter(folderName);
    if (cur !== null && cur !== text) {
      // Preserve the version being replaced, then advance the marker so the
      // saveLog hook doesn't snapshot this same content a second time.
      const bdir = path.join(BACKUPS_DIR, folderName, 'footers');
      try {
        await fs.mkdir(bdir, { recursive: true });
        await atomicWriteFile(path.join(bdir, `${footerBackupStamp()}.md`), cur);
        await fs.writeFile(path.join(bdir, '.last'), text);
      } catch { /* a backup hiccup must not block the edit */ }
    }

    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(file, text);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'could not write FOOTER.md' };
  }
}

function resolveWorkspacePath(folderName: string, relPath: string): string | null {
  const root = path.resolve(WORKSPACES_DIR, sanitizeFolderName(folderName));
  // Trim any leading slashes — model might emit "/notes.md"
  const cleaned = String(relPath || '').replace(/^[/\\]+/, '');
  const target = path.resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

// local_data itself is commonly a junction/symlink (deployment sync setups
// point it at a shared folder, e.g. C:\dev\common\local_data). A workspace
// can also contain a SECOND junction nested inside it (e.g.
// workspaces/<Entity>/common_workspace → C:\dev\common\common_workspace)
// so multiple entities/machines can share one folder. That second junction's
// real target is a SIBLING of local_data's real target, not a descendant of
// it — so a plain realpath-prefix check against the workspace root rejects it
// as an "escape" even though it's deployment infrastructure the user set up,
// not something an entity created (workspace tools never call fs.symlink;
// only Bash, gated behind the separate per-entity dangerous-tools toggle,
// could plant a junction). getTrustedJunctionRoot() computes the shared
// parent directory that local_data's own real target lives under
// (C:\dev\common in the example above) and both containment checks below
// accept it as an additional valid prefix, alongside the workspace's own
// root. This does not widen trust to the whole filesystem the way
// fullAccess does — only to the specific sync-parent folder the deployment
// already implicitly trusts via the local_data junction itself.
let trustedJunctionRootPromise: Promise<string | null> | null = null;
export async function getTrustedJunctionRoot(): Promise<string | null> {
  if (!trustedJunctionRootPromise) {
    trustedJunctionRootPromise = (async () => {
      try {
        const realDataDir = await fs.realpath(DATA_DIR);
        return path.dirname(realDataDir);
      } catch {
        return null;
      }
    })();
  }
  return trustedJunctionRootPromise;
}

function isWithinTrustedRoots(real: string, realRoot: string, trustedRoot: string | null): boolean {
  if (real === realRoot || real.startsWith(realRoot + path.sep)) return true;
  if (trustedRoot && (real === trustedRoot || real.startsWith(trustedRoot + path.sep))) return true;
  return false;
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
    const trustedRoot = await getTrustedJunctionRoot();
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
          if (!isWithinTrustedRoots(realTarget, realRoot, trustedRoot)) return null;
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
    if (!isWithinTrustedRoots(realTarget, realRoot, trustedRoot)) return null;
    return realTarget;
  } catch {
    return null;
  }
}

// ── Capability options ──────────────────────────────────────────────────────
// Per-entity (per-folder) toggles, threaded from the chat route:
//   - fullAccess: when true, the entity's file tools are NOT sandboxed to its
//     workspace. Absolute paths are used verbatim (anywhere on the PC) and
//     relative paths are anchored to the workspace for convenience. When false
//     (default) every path is contained to workspaces/<Entity>/ exactly
//     as before.
// This is the mechanism behind "full PC access is optional per Entity".
export interface WsOpts { fullAccess?: boolean }

// Unified resolver used by every workspace fs helper. Sandboxed by default;
// unrestricted when fullAccess is on.
async function resolvePathForAccess(folderName: string, relPath: string, opts?: WsOpts): Promise<string | null> {
  if (opts?.fullAccess) {
    const cleaned = String(relPath || '');
    if (!cleaned) return null;
    // Absolute → use as-is (whole filesystem). Relative → anchor to workspace.
    if (path.isAbsolute(cleaned)) return path.resolve(cleaned);
    const root = path.resolve(WORKSPACES_DIR, sanitizeFolderName(folderName));
    return path.resolve(root, cleaned);
  }
  return resolveWorkspacePathSafe(folderName, relPath);
}

export async function listWorkspaceFiles(folderName: string): Promise<string[]> {
  const root = await ensureWorkspace(folderName);
  const trustedRoot = await getTrustedJunctionRoot();
  let realRoot: string;
  try { realRoot = await fs.realpath(root); } catch { realRoot = root; }

  const out: string[] = [];
  // Resolved-symlink dirs we've already walked — prevent double-visiting the
  // same real directory through different symlink paths (and infinite loops).
  const walkedReals = new Set<string>();

  async function walk(dir: string, prefix: string) {
    let entries: any[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // skip hidden + atomic-write tempfiles
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, rel);
      } else if (e.isSymbolicLink()) {
        // POSIX symlinks return isDirectory()=false even when pointing at a
        // directory. Resolve the target: if it's within the workspace or
        // trusted-junction root, walk it transparently so nested junctions
        // inside the workspace (e.g. common_workspace) appear as normal dirs.
        try {
          const realTarget = await fs.realpath(full);
          if (!isWithinTrustedRoots(realTarget, realRoot, trustedRoot)) continue;
          const st = await fs.stat(realTarget);
          if (st.isDirectory()) {
            if (walkedReals.has(realTarget)) continue;
            walkedReals.add(realTarget);
            await walk(realTarget, rel);
          } else {
            out.push(rel);
          }
        } catch {
          // Broken symlink or permission denied — skip silently.
        }
      } else if (e.isFile()) {
        out.push(rel);
      }
    }
  }

  await walk(root, '');
  return out.sort();
}

export async function readWorkspaceFile(folderName: string, relPath: string, opts?: WsOpts): Promise<string | null> {
  const target = await resolvePathForAccess(folderName, relPath, opts);
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
export async function readWorkspaceFileBinary(folderName: string, relPath: string, opts?: WsOpts): Promise<{ data: Buffer; mimeType: string } | null> {
  const target = await resolvePathForAccess(folderName, relPath, opts);
  if (!target) return null;
  try {
    const data = await fs.readFile(target);
    return { data, mimeType: imageMimeFor(relPath) };
  } catch { return null; }
}

export async function writeWorkspaceFile(folderName: string, relPath: string, content: string, opts?: WsOpts): Promise<{ ok: boolean; existed: boolean; error?: string }> {
  const target = await resolvePathForAccess(folderName, relPath, opts);
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
export async function editWorkspaceFile(folderName: string, relPath: string, oldString: string, newString: string, opts?: WsOpts): Promise<{ ok: boolean; error?: string }> {
  const target = await resolvePathForAccess(folderName, relPath, opts);
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

// Delete a file (a "dangerous" tool, gated per-Entity by agentAllowDelete).
// Sandboxed by default; with fullAccess it can delete anywhere by absolute
// path. Refuses directories (use with care) and missing files report cleanly.
export async function deleteWorkspaceFile(folderName: string, relPath: string, opts?: WsOpts): Promise<{ ok: boolean; error?: string }> {
  const target = await resolvePathForAccess(folderName, relPath, opts);
  if (!target) return { ok: false, error: 'Path escapes workspace' };
  try {
    const st = await fs.stat(target);
    if (st.isDirectory()) {
      return { ok: false, error: 'Target is a directory; this tool only deletes files' };
    }
  } catch (e: any) {
    return { ok: false, error: 'File not found' };
  }
  try {
    await fs.unlink(target);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'delete failed' };
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

// ── Identity rename ─────────────────────────────────────────────────────────
// An identity's name is its primary key on disk: it names a file or a directory
// in nine separate places under local_data. This used to move three of them
// (the folder JSON, the theme CSS, the logs directory) and silently orphan the
// rest — the entity kept its conversations but lost its workspace, its system
// prompt files, its summaries, its changelogs, its browser logins, its TTS
// dictionary and its backups. Nothing failed loudly; the data was simply no
// longer reachable under the new name.
//
// `letters/` is deliberately left alone. A mailbox is a correspondence between
// two names, both of which appear in the path, and the sender's copy of every
// letter lives under a *different* identity's tree. Rewriting that coherently
// is a larger job than all of the above combined, and a half-done rename there
// loses mail. The old name keeps its mailbox.

/** What a rename actually did, so the caller can show it instead of guessing. */
export interface RenameFolderReport {
  moved: string[];
  skipped: string[];
  failed: { what: string; error: string }[];
}

/** Escape a name for literal use inside a RegExp (identity names are user-chosen). */
function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mirrors `safeName` in browserTools.ts — that module pulls in Playwright, so
 *  the rule is repeated here rather than imported into every API route. */
function browserProfileName(entity: string): string {
  return String(entity || 'Default').replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'Default';
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

/**
 * Move one path if it's there. Never overwrites: an existing target is reported
 * as a failure and left untouched, because the alternative is silently merging
 * or destroying another identity's data.
 */
async function movePathIfPresent(
  from: string,
  to: string,
  label: string,
  report: RenameFolderReport
): Promise<void> {
  if (from === to) return;
  if (!(await pathExists(from))) { report.skipped.push(label); return; }
  if (await pathExists(to)) {
    report.failed.push({ what: label, error: `target already exists: ${to}` });
    return;
  }
  try {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    report.moved.push(label);
  } catch (e: any) {
    report.failed.push({ what: label, error: String(e?.message || e) });
  }
}

/**
 * Rename `<oldStem>_<n>.md` → `<newStem>_<n>.md` inside one directory.
 * Files that don't match the pattern are left exactly as they are — a
 * hand-named summary keeps its name.
 */
async function retitleNumberedFiles(
  dir: string,
  oldStem: string,
  newStem: string,
  label: string,
  report: RenameFolderReport
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch { return; }
  const re = new RegExp(`^${escapeForRegExp(oldStem)}_(\\d+)\\.md$`);
  let n = 0;
  for (const name of entries) {
    const m = re.exec(name);
    if (!m) continue;
    const to = path.join(dir, `${newStem}_${m[1]}.md`);
    if (await pathExists(to)) {
      report.failed.push({ what: `${label}/${name}`, error: 'target already exists' });
      continue;
    }
    try { await fs.rename(path.join(dir, name), to); n++; }
    catch (e: any) { report.failed.push({ what: `${label}/${name}`, error: String(e?.message || e) }); }
  }
  if (n > 0) report.moved.push(`${label} (${n} file${n === 1 ? '' : 's'})`);
}

/**
 * Rewrite every conversation log in the (already moved) directory so its
 * internal `folderName` matches the new identity, and retitle the ones using
 * the `<identity>_<n>` convention.
 *
 * This is not cosmetic. `saveLog` deletes copies of a conversation id from
 * every logs directory whose name differs from the payload's `folderName`, so
 * a log left claiming the old name would, on its very next save, be moved back
 * into a freshly recreated directory under the old name.
 */
async function rewriteLogsForRename(
  logDir: string,
  oldName: string,
  newName: string,
  report: RenameFolderReport
): Promise<void> {
  let files: string[];
  try {
    files = (await fs.readdir(logDir)).filter(f => f.endsWith('.json'));
  } catch { return; }

  let rewritten = 0;
  for (const file of files) {
    const p = path.join(logDir, file);
    try {
      const parsed = JSON.parse(await fs.readFile(p, 'utf-8'));
      const nextTitle = retitleForRenamedIdentity(parsed.title || '', oldName, newName);
      if (parsed.folderName === newName && nextTitle === parsed.title) continue;
      parsed.folderName = newName;
      if (parsed.title) parsed.title = nextTitle;
      // Same lock key saveLog uses, so a rename can't interleave with a save.
      await withWriteLock(`log:${parsed.id || file.replace(/\.json$/, '')}`, async () => {
        await atomicWriteFile(p, serializeLogHeaderFirst(parsed));
      });
      rewritten++;
    } catch (e: any) {
      report.failed.push({ what: `logs/${file}`, error: String(e?.message || e) });
    }
  }
  if (rewritten > 0) report.moved.push(`conversation logs (${rewritten} rewritten)`);
}

export async function renameFolder(oldName: string, newName: string): Promise<RenameFolderReport> {
  await ensureDirs();

  const trimmed = String(newName || '').trim();
  if (!trimmed) throw new Error('New being name is empty.');
  if (trimmed === oldName) throw new Error('New being name is the same as the old one.');
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error('A being name cannot contain \\ / : * ? " < > |');
  }
  // Refuse before touching anything, rather than half-merging two identities.
  if (await pathExists(path.join(FOLDERS_DIR, `${trimmed}.json`))) {
    throw new Error(`A being named "${trimmed}" already exists.`);
  }
  if (await pathExists(path.join(LOGS_DIR, trimmed))) {
    throw new Error(`A conversation folder named "${trimmed}" already exists.`);
  }

  const report: RenameFolderReport = { moved: [], skipped: [], failed: [] };

  // 1. The folder JSON — carries the name inside it as well as in its filename.
  try {
    const oldFilePath = path.join(FOLDERS_DIR, `${oldName}.json`);
    const parsed = JSON.parse(await fs.readFile(oldFilePath, 'utf-8'));
    parsed.name = trimmed;
    await fs.writeFile(path.join(FOLDERS_DIR, `${trimmed}.json`), JSON.stringify(parsed, null, 2));
    await fs.unlink(oldFilePath);
    report.moved.push('being settings');
  } catch (e: any) {
    // An identity with no settings file is legal — listFolders synthesizes one
    // from the logs directory — so a missing file is "skipped", not "failed".
    if (e?.code === 'ENOENT') report.skipped.push('being settings');
    else report.failed.push({ what: 'being settings', error: String(e?.message || e) });
  }

  // 2. Flat, raw-name files.
  await fs.mkdir(THEMES_DIR, { recursive: true });
  await movePathIfPresent(themeCssPath(oldName), themeCssPath(trimmed), 'CSS theme', report);
  await movePathIfPresent(
    path.join(DATA_DIR, 'tts_dict', `${oldName}.json`),
    path.join(DATA_DIR, 'tts_dict', `${trimmed}.json`),
    'TTS pronunciation dictionary', report
  );

  // 3. Conversations: move the directory, then fix what's inside it.
  const newLogDir = path.join(LOGS_DIR, trimmed);
  await movePathIfPresent(path.join(LOGS_DIR, oldName), newLogDir, 'conversations folder', report);
  await rewriteLogsForRename(newLogDir, oldName, trimmed, report);

  // 4. Per-identity directories. Most sanitize the name for the path; browser
  //    profiles use their own slightly different rule.
  const oldSafe = sanitizeFolderName(oldName);
  const newSafe = sanitizeFolderName(trimmed);

  await movePathIfPresent(
    path.join(WORKSPACES_DIR, oldSafe), path.join(WORKSPACES_DIR, newSafe),
    'workspace', report
  );
  await movePathIfPresent(
    path.join(DATA_DIR, 'browser_profiles', browserProfileName(oldName)),
    path.join(DATA_DIR, 'browser_profiles', browserProfileName(trimmed)),
    'browser profile', report
  );

  // 5. Directories whose *contents* are also named after the identity.
  const spDir = path.join(DATA_DIR, 'system_prompts', newSafe);
  await movePathIfPresent(path.join(DATA_DIR, 'system_prompts', oldSafe), spDir, 'system prompts', report);
  await retitleNumberedFiles(spDir, oldSafe, newSafe, 'system prompts', report);

  const sumDir = path.join(DATA_DIR, 'summaries', newSafe);
  await movePathIfPresent(path.join(DATA_DIR, 'summaries', oldSafe), sumDir, 'summaries', report);
  await retitleNumberedFiles(sumDir, oldName, trimmed, 'summaries', report);

  const clDir = path.join(DATA_DIR, 'changelogs', newSafe);
  await movePathIfPresent(path.join(DATA_DIR, 'changelogs', oldSafe), clDir, 'changelogs', report);
  await retitleNumberedFiles(clDir, oldName, trimmed, 'changelogs', report);

  // 6. Backups. Not on the original list, but leaving them behind makes every
  //    existing backup unreachable from the Backups window — the files survive
  //    while the only way to open them does not.
  await movePathIfPresent(
    path.join(BACKUPS_DIR, oldName), path.join(BACKUPS_DIR, trimmed),
    'backups', report
  );
  if (oldSafe !== oldName) {
    await movePathIfPresent(
      path.join(BACKUPS_DIR, oldSafe), path.join(BACKUPS_DIR, newSafe),
      'backups (sanitized path)', report
    );
  }

  return report;
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

/**
 * Serialize a conversation log with the small metadata fields the header parser
 * cares about hoisted to the very FRONT of the object, ahead of large fields
 * like `systemPrompt` and the `messages` array.
 *
 * `readLogHeaderMetadata` only reads the first 4KB; `systemPrompt` alone can
 * blow past that, so if `active`/`title` sit after it they fall outside the
 * window and a "Mark inactive" toggle silently reverts. Pulling them first
 * guarantees they're always visible.
 *
 * Every writer of a log file must go through here — `saveLog` and the identity
 * rename both do — or the 4KB guarantee holds in one place and not the other.
 */
function serializeLogHeaderFirst(logData: any): string {
  const { messages: _msgs, ...headerFields } = logData;
  const { id: _id, folderName: _fn, aiName: _ai, title: _t, active: _act, updatedAt: _ua, ...rest } = headerFields;
  return JSON.stringify({
    id: _id,
    folderName: _fn,
    aiName: _ai,
    title: _t,
    active: _act,
    updatedAt: _ua,
    ...rest,
    messages: _msgs,
  }, null, 2);
}

// Hash a file WITHOUT reading it into a string. Used by the backup identity
// check below: conversations with inline base64 media reach hundreds of MB, and
// `await fs.readFile(path, 'utf-8')` on one of those allocates a full-size
// string just to answer "did this change?" — memory that a large conversation
// cannot spare. Streaming keeps the cost at one 64 KB buffer. Returns null if
// the file can't be read, which callers treat as "assume changed".
async function hashFileStreaming(filePath: string): Promise<string | null> {
  try {
    const hash = createHash('sha1');
    const stream = createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Move any still-inline attachment payload into the content-addressed store.
 *
 * Attachments normally arrive already externalized — the browser uploads them
 * at attach time. But old-format conversations can reappear at any point:
 * restoring one of the pre-migration backups, importing a JSON export (which
 * deliberately re-inlines payloads so the exported file stays self-contained),
 * or syncing a file from a machine running older code. Without this, such a
 * conversation would stay inline forever and quietly grow back toward the size
 * ceiling until someone remembered to re-run the migration script.
 *
 * Mutates `logData` in place (saveLog already does this for updatedAt/active).
 * Best-effort throughout: a storage failure leaves that attachment inline
 * rather than failing the save. Cheap no-op in the normal case — the loop just
 * finds nothing to do.
 *
 * NOTE this fixes what is STORED, not what was transmitted: the browser has
 * already sent its inline copy by the time we get here, and will keep sending
 * it until the conversation is reloaded. It also cannot help a conversation
 * past V8's string cap, since that payload can never reach the server at all —
 * only the migration script, which works on the file directly, handles those.
 */
async function externalizeInlineAttachments(logData: any): Promise<number> {
  if (!Array.isArray(logData?.messages)) return 0;
  let moved = 0;
  for (const msg of logData.messages) {
    if (!Array.isArray(msg?.attachments)) continue;
    for (const att of msg.attachments) {
      // Text attachments keep `textData` inline by design, and anything with a
      // ref is already done.
      if (!att || att.ref || typeof att.dataUrl !== 'string' || !att.dataUrl) continue;
      try {
        const stored = await putDataUrl(att.dataUrl);
        if (!stored) continue;
        att.ref = stored.ref;
        if (!att.size) att.size = stored.size;
        delete att.dataUrl;
        moved++;
      } catch (e) {
        console.error(`[attachments] could not externalize "${att.name || 'unnamed'}" during save:`, e);
      }
    }
  }
  return moved;
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
    // Convert any old-format inline payloads before serializing, so a restored
    // backup or an imported JSON export doesn't get written back inline.
    try {
      const moved = await externalizeInlineAttachments(logData);
      if (moved > 0) {
        console.log(`[attachments] externalized ${moved} inline attachment(s) while saving ${convoId}`);
      }
    } catch (e) {
      console.error('[attachments] externalize pass failed (saving as-is):', e);
    }

    const currentJson = serializeLogHeaderFirst(logData);
    await atomicWriteFile(filePath, currentJson);

    // --- Auto-Backup ---
    try {
      const currentDate = new Date().toISOString().split('T')[0];
      const backupDir = path.join(BACKUPS_DIR, folderName);
      await fs.mkdir(backupDir, { recursive: true });

      const files = await fs.readdir(backupDir);
      // `.endsWith('.json')` keeps the sidecar hash files below out of the list
      // (they share the `${convoId}_` prefix and would otherwise sort last and
      // be mistaken for the latest backup).
      const convoBackups = files.filter(f => f.startsWith(`${convoId}_`) && f.endsWith('.json')).sort();

      // "Has anything changed since the last backup?" used to be answered with
      // `latestData === currentJson`, which read the previous backup back into
      // memory in full. On a 500 MB conversation that is a 500 MB read plus a
      // 500 MB resident string on EVERY turn — pure overhead for a boolean, and
      // one more large allocation on a path that is already close to V8's
      // max-string-length wall.
      //
      // Instead each backup gets a tiny `<file>.sha1` sidecar. The fast path now
      // reads ~40 bytes. Backups written before this change have no sidecar, so
      // the first save after upgrading stream-hashes the existing file once
      // (bounded memory) and writes the sidecar; every save after that is cheap.
      const currentHash = createHash('sha1').update(currentJson).digest('hex');

      let shouldBackup = true;
      if (convoBackups.length > 0) {
        const latestPath = path.join(backupDir, convoBackups[convoBackups.length - 1]);
        let latestHash: string | null = null;
        try {
          latestHash = (await fs.readFile(`${latestPath}.sha1`, 'utf-8')).trim();
        } catch {
          latestHash = await hashFileStreaming(latestPath);
          if (latestHash) {
            try { await fs.writeFile(`${latestPath}.sha1`, latestHash); } catch {}
          }
        }
        // A null hash means the previous backup was unreadable — treat that as
        // "changed" so we err toward keeping a backup rather than skipping one.
        if (latestHash !== null && latestHash === currentHash) shouldBackup = false;
      }

      if (shouldBackup) {
        const outPath = path.join(backupDir, `${convoId}_${currentDate}.json`);
        await atomicWriteFile(outPath, currentJson);
        try { await fs.writeFile(`${outPath}.sha1`, currentHash); } catch {}
      }
    } catch (e) {
      console.error('Backup failed:', e);
    }

    // Snapshot the entity's FOOTER.md if it changed this turn. saveLog is the
    // one server-side choke point every turn's save flows through (all provider
    // paths, OAuth included), so a single call here catches every footer edit.
    // Best-effort and de-duplicated — see backupFooterIfChanged.
    await backupFooterIfChanged(folderName);
  });
}

export async function loadLog(convoId: string) {
  await ensureDirs();
  const logDirs = await fs.readdir(LOGS_DIR, { withFileTypes: true });
  for (const dir of logDirs) {
    if (!dir.isDirectory()) continue;
    const filePath = path.join(LOGS_DIR, dir.name, `${convoId}.json`);
    let data: string;
    try {
      data = await fs.readFile(filePath, 'utf-8');
    } catch {
      // Not in this folder (ENOENT) — keep scanning the others.
      continue;
    }
    // The file EXISTS in this folder. Strip a leading UTF-8 BOM if present:
    // cross-machine sync (rclone/Google Drive) or an editor re-save can prepend
    // EF BB BF, which the 4KB header regex in listLogs tolerates but JSON.parse
    // rejects at position 0 — the exact "list works, single-load 404s" symptom.
    if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1);
    try {
      return JSON.parse(data);
    } catch (e: any) {
      // File found but unparseable. DON'T swallow it silently (the old behavior
      // made this a mystery 404). Log the concrete reason — BOM already handled
      // above, so this now means truncated/corrupted content (e.g. an
      // interrupted or partial sync). Length + head help tell which.
      console.error(
        `[fsStorage] loadLog: found "${filePath}" but JSON.parse failed: ${e?.message}. ` +
        `length=${data.length} bytes; head="${data.slice(0, 120).replace(/\n/g, '\\n')}"; ` +
        `tail="${data.slice(-80).replace(/\n/g, '\\n')}". ` +
        `Likely a truncated/corrupted file from sync — re-pull local_data or restore from local_data/backups/.`
      );
      return null; // exists but corrupt — no point scanning other folders
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
        let data = await fs.readFile(fullPath, 'utf-8');
        if (data.charCodeAt(0) === 0xFEFF) data = data.slice(1); // strip UTF-8 BOM
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
