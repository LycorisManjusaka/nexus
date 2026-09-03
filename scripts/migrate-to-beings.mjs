#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// migrate-to-beings.mjs
//
// One-time, idempotent, move-not-copy restructuring of local_data from the old
// flat parallel-directory layout (logs/<name>, system_prompts/<name>,
// workspaces/<name>, folders/<name>.json, themes/<name>.css, ...) into
// local_data/beings/<name>/{logs,soul,summaries,changelogs,workspace,
// browser_profile,computer_control_logs,backups,letters/from/<sender>,
// settings.json,theme.css,tts_dict.json}.
//
// Root-level, NOT per-being data — attachments/ (content-addressed, shared,
// deduped), ears_cache/, eyes_cache/, voicechanger/, watcher_cache/,
// system_prompt_agents/ (operator-owned), keys.json, user_settings.json,
// user_identity.json, character_map.json, tts_engines.json,
// audio_services.json, en_katakana_dict.json, letters/_state/ + _status.md
// (per-conversation bookkeeping, stays at the letters root under the
// recipient-owned redesign) — is left exactly where it is.
//
// themes/example.css is a template with no matching being and is deliberately
// left behind, not migrated.
//
// Safety:
//   - Every move is fs.rename (same volume, so this is atomic and cheap — no
//     copy+delete window where data could be lost mid-operation).
//   - Never overwrites: if a destination already exists, the source is left
//     untouched in place and the collision is logged as a conflict.
//   - Idempotent: re-running after a successful migration finds nothing left
//     to move (sources are gone) and exits cleanly. A `.migration_complete`
//     marker under beings/ additionally short-circuits a full re-scan unless
//     --force is passed.
//   - --dry-run prints every move it WOULD make without touching disk.
//   - Full JSON report written to local_data/migration_report_<ts>.json.
//
// Usage:
//   node scripts/migrate-to-beings.mjs --dry-run
//   node scripts/migrate-to-beings.mjs
//   node scripts/migrate-to-beings.mjs --force        (ignore the completion marker)
//   node scripts/migrate-to-beings.mjs --data-dir D:\somewhere\local_data
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Default: <repo>/local_data. Override with --data-dir <abs-or-rel-path> to
// migrate a local_data tree that lives elsewhere (e.g. on the Working PC,
// where the checkout layout or data location may differ from the Desktop).
function resolveDataDir() {
  const i = process.argv.indexOf('--data-dir');
  if (i !== -1 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return path.join(REPO_ROOT, 'local_data');
}

const DATA_DIR = resolveDataDir();
const BEINGS_DIR = path.join(DATA_DIR, 'beings');
const MARKER = path.join(BEINGS_DIR, '.migration_complete');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// ── sanitizers ───────────────────────────────────────────────────────────────

// fsStorage.ts's OLD sanitizeFolderName — used historically for
// system_prompts/, summaries/, changelogs/, workspaces/, and backups/<name>.
// No trailing-dot/whitespace trim.
function oldSanitize(name) {
  return String(name || '').replace(/[\\/:*?"<>|]+/g, '_');
}

// browserTools.ts's safeName / fsStorage.ts's browserProfileName /
// computerTools.ts's safeName — same char strip, PLUS 64-char truncation and
// an empty-string fallback to 'Default'. Used for browser_profiles/ and
// computer_control_logs/.
function oldBrowserSanitize(name) {
  return String(name || 'Default').replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'Default';
}

// The NEW canonical sanitizer (beingPaths.ts / letters.ts's sanitizeEntityDir,
// which was already identical) — becomes the beings/<key> directory name.
function newSanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/[.\s]+$/, '')
    .trim();
}

// ── fs helpers ───────────────────────────────────────────────────────────────

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listDirNames(dir) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

async function listFileStems(dir, ext) {
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => e.name.slice(0, -ext.length));
  } catch { return []; }
}

const report = { movedCount: 0, moved: [], conflicts: [], errors: [], names: [] };

async function move(src, dest, label) {
  if (!(await exists(src))) return;
  if (await exists(dest)) {
    report.conflicts.push(`${label}: target already exists — left source untouched. src=${src} dest=${dest}`);
    return;
  }
  report.moved.push(`${label}: ${src}  ->  ${dest}`);
  report.movedCount++;
  if (DRY_RUN) return;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  } catch (e) {
    report.errors.push(`${label}: rename failed — ${e?.message || e}. src=${src} dest=${dest}`);
  }
}

// ── master being-name list ──────────────────────────────────────────────────
//
// Mirrors listFolders() in fsStorage.ts (folders/*.json name field, unioned
// with logs/ subdirectory raw names) and then adds every orphan found in any
// OTHER per-being subsystem directory whose (correctly un-sanitized-back)
// name isn't already covered — the same auto-discovery listFolders() already
// does for logs/, extended to the other five subsystems so nothing with real
// data gets left behind un-migrated.

async function buildMasterNameList() {
  const names = new Set();
  const folderFileStemOf = new Map(); // resolved name -> folders/*.json filename stem

  const foldersDir = path.join(DATA_DIR, 'folders');
  let folderFiles = [];
  try { folderFiles = await fs.readdir(foldersDir); } catch {}
  for (const f of folderFiles) {
    if (!f.endsWith('.json')) continue;
    const stem = f.slice(0, -5);
    let name = stem;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(foldersDir, f), 'utf-8'));
      name = parsed.name || stem;
    } catch {}
    names.add(name);
    folderFileStemOf.set(name, stem);
  }

  for (const n of await listDirNames(path.join(DATA_DIR, 'logs'))) names.add(n);

  // Orphan discovery: anything under these subsystem dirs whose OLD-sanitized
  // form doesn't match any already-known name becomes its own being name (we
  // have no better information than the on-disk name itself for these).
  const knownOld = new Set([...names].map(oldSanitize));
  const knownOldBrowser = new Set([...names].map(oldBrowserSanitize));

  for (const dir of ['system_prompts', 'summaries', 'changelogs', 'workspaces', 'backups']) {
    for (const n of await listDirNames(path.join(DATA_DIR, dir))) {
      if (!knownOld.has(n)) names.add(n);
    }
  }
  for (const n of await listDirNames(path.join(DATA_DIR, 'browser_profiles'))) {
    if (!knownOldBrowser.has(n)) names.add(n);
  }
  for (const n of await listDirNames(path.join(DATA_DIR, 'computer_control_logs'))) {
    if (!knownOldBrowser.has(n)) names.add(n);
  }
  for (const n of await listFileStems(path.join(DATA_DIR, 'themes'), '.css')) {
    if (n === 'example') continue; // template, deliberately left behind
    names.add(n);
  }
  for (const n of await listFileStems(path.join(DATA_DIR, 'tts_dict'), '.json')) {
    names.add(n);
  }

  return { names: [...names].sort((a, b) => a.localeCompare(b)), folderFileStemOf };
}

// ── per-being migration ──────────────────────────────────────────────────────

async function migrateOne(name, folderFileStemOf) {
  const key = newSanitize(name);
  if (!key) { report.errors.push(`Empty sanitized key for name "${name}" — skipped entirely.`); return; }
  report.names.push(`${name}  ->  beings/${key}`);

  const oldSan = oldSanitize(name);
  const oldBrowserSan = oldBrowserSanitize(name);
  const dest = path.join(BEINGS_DIR, key);

  // Raw-name (unsanitized) sources: logs, folder settings, theme, tts dict.
  await move(path.join(DATA_DIR, 'logs', name), path.join(dest, 'logs'), `${name}: logs`);

  const folderStem = folderFileStemOf.get(name) || name;
  await move(
    path.join(DATA_DIR, 'folders', `${folderStem}.json`),
    path.join(dest, 'settings.json'),
    `${name}: settings.json`,
  );

  await move(path.join(DATA_DIR, 'themes', `${name}.css`), path.join(dest, 'theme.css'), `${name}: theme.css`);
  await move(path.join(DATA_DIR, 'tts_dict', `${name}.json`), path.join(dest, 'tts_dict.json'), `${name}: tts_dict.json`);

  // Old-sanitized-name sources.
  await move(path.join(DATA_DIR, 'system_prompts', oldSan), path.join(dest, 'soul'), `${name}: soul`);
  await move(path.join(DATA_DIR, 'summaries', oldSan), path.join(dest, 'summaries'), `${name}: summaries`);
  await move(path.join(DATA_DIR, 'changelogs', oldSan), path.join(dest, 'changelogs'), `${name}: changelogs`);
  await move(path.join(DATA_DIR, 'workspaces', oldSan), path.join(dest, 'workspace'), `${name}: workspace`);

  // Old browser-sanitized-name sources (64-char truncated variant).
  await move(
    path.join(DATA_DIR, 'browser_profiles', oldBrowserSan),
    path.join(dest, 'browser_profile'),
    `${name}: browser_profile`,
  );
  await move(
    path.join(DATA_DIR, 'computer_control_logs', oldBrowserSan),
    path.join(dest, 'computer_control_logs'),
    `${name}: computer_control_logs`,
  );

  // Backups: old-sanitized top dir, subfolders system_prompts->soul and
  // summaries/footers keep their names; anything else loose inside moves flat.
  const backupsSrc = path.join(DATA_DIR, 'backups', oldSan);
  if (await exists(backupsSrc)) {
    await move(path.join(backupsSrc, 'system_prompts'), path.join(dest, 'backups', 'soul'), `${name}: backups/soul`);
    await move(path.join(backupsSrc, 'summaries'), path.join(dest, 'backups', 'summaries'), `${name}: backups/summaries`);
    await move(path.join(backupsSrc, 'footers'), path.join(dest, 'backups', 'footers'), `${name}: backups/footers`);
    let remaining = [];
    try { remaining = await fs.readdir(backupsSrc); } catch {}
    for (const f of remaining) {
      // The three handled subdirs above must never be re-processed as loose
      // items. In a dry run the explicit moves don't actually happen, so
      // readdir still sees them; and if a real move ever fails, the item stays
      // behind and its conflict/error is already recorded — re-moving it here
      // would land it at the wrong destination (backups/system_prompts instead
      // of backups/soul).
      if (f === 'system_prompts' || f === 'summaries' || f === 'footers') continue;
      await move(path.join(backupsSrc, f), path.join(dest, 'backups', f), `${name}: backups/${f}`);
    }
    if (!DRY_RUN) {
      try {
        const leftover = await fs.readdir(backupsSrc);
        if (leftover.length === 0) await fs.rmdir(backupsSrc);
      } catch {}
    }
  }
}

// ── letters: sender-owned -> recipient-owned ────────────────────────────────
//
// letters/<from>/<to>/*.md (sender-owned) becomes beings/<to>/letters/from/
// <from>/*.md (recipient-owned). letters.ts's sanitizeEntityDir was already
// IDENTICAL to the new canonical sanitizer, so every <from>/<to> directory
// name on disk today already equals the being key it will become — this scan
// works directly off directory names, independent of the master name list.
// letters/_state/ and letters/_status.md stay exactly where they are.

async function migrateLetters() {
  const lettersRoot = path.join(DATA_DIR, 'letters');
  const senderDirs = await listDirNames(lettersRoot);
  for (const from of senderDirs) {
    if (from === '_state' || from.startsWith('_')) continue;
    const fromPath = path.join(lettersRoot, from);
    const toDirs = await listDirNames(fromPath);
    for (const to of toDirs) {
      await move(
        path.join(fromPath, to),
        path.join(BEINGS_DIR, to, 'letters', 'from', from),
        `letters: ${from} -> ${to}`,
      );
    }
    if (!DRY_RUN) {
      try {
        const leftover = await fs.readdir(fromPath);
        if (leftover.length === 0) await fs.rmdir(fromPath);
      } catch {}
    }
  }
}

// ── misc root-level relocations ─────────────────────────────────────────────

async function migrateMisc() {
  // stopkey.pid: computer_control_logs/stopkey.pid -> local_data/stopkey.pid
  await move(
    path.join(DATA_DIR, 'computer_control_logs', 'stopkey.pid'),
    path.join(DATA_DIR, 'stopkey.pid'),
    'stopkey.pid',
  );
}

// Dead `settings/` directory — deleted only if genuinely empty, never forced.
async function cleanupDeadSettingsDir() {
  const settingsDir = path.join(DATA_DIR, 'settings');
  if (!(await exists(settingsDir))) return;
  let entries = [];
  try { entries = await fs.readdir(settingsDir); } catch { return; }
  if (entries.length > 0) {
    report.conflicts.push(`settings/ is not empty (${entries.length} entries) — left in place, NOT deleted.`);
    return;
  }
  report.moved.push('settings/ (dead, empty) -> removed');
  if (!DRY_RUN) {
    try { await fs.rmdir(settingsDir); } catch (e) { report.errors.push(`settings/ rmdir failed — ${e?.message || e}`); }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!FORCE && (await exists(MARKER))) {
    console.log(`Already migrated (marker present at ${MARKER}). Pass --force to re-scan anyway.`);
    return;
  }

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Migrating ${DATA_DIR} into beings/ layout...`);

  const { names, folderFileStemOf } = await buildMasterNameList();
  console.log(`Found ${names.length} being name(s): ${names.join(', ')}`);

  for (const name of names) {
    await migrateOne(name, folderFileStemOf);
  }
  await migrateLetters();
  await migrateMisc();
  await cleanupDeadSettingsDir();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  // Dry-run reports go OUTSIDE local_data (repo root) — a dry run must leave
  // local_data completely untouched, including not writing a report into it.
  const reportPath = DRY_RUN
    ? path.join(REPO_ROOT, `migration_dryrun_report_${ts}.json`)
    : path.join(DATA_DIR, `migration_report_${ts}.json`);
  if (!DRY_RUN) await fs.mkdir(BEINGS_DIR, { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${report.movedCount} item(s) ${DRY_RUN ? 'would be' : ''} moved.`);
  if (report.conflicts.length) {
    console.log(`\n${report.conflicts.length} CONFLICT(S) (source left untouched):`);
    report.conflicts.forEach((c) => console.log('  ! ' + c));
  }
  if (report.errors.length) {
    console.log(`\n${report.errors.length} ERROR(S):`);
    report.errors.forEach((e) => console.log('  X ' + e));
  }
  console.log(`\nFull report: ${reportPath}`);

  if (!DRY_RUN && report.errors.length === 0) {
    await fs.writeFile(MARKER, JSON.stringify({ completedAt: new Date().toISOString(), report: path.basename(reportPath) }, null, 2));
    console.log(`\nMarker written: ${MARKER}`);
  } else if (!DRY_RUN) {
    console.log('\nErrors occurred — marker NOT written. Fix and re-run (safe: already-moved items are skipped).');
  }
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
