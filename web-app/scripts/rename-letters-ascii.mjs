// Rename existing letter files to the ASCII-only scheme used for new letters:
//
//     <YYYY-MM-DD_HHmm>_<8 hex>.md
//
// Why: filenames built from the title carried Japanese text, which breaks
// Mercurial on the Work PC (the "ダメ文字" problem — certain byte sequences are
// mangled or rejected by tools that handle filename encoding inconsistently,
// and a repository cannot hold a file it cannot name).
//
// Nothing is lost. The title lives in the frontmatter and always has; the
// filename was only ever decoration. NEXUS reads a letter's title, sender,
// recipient and timestamp from the header, never from the name, so a renamed
// letter behaves identically.
//
// The one rule this script exists to enforce: a letter's `.read` and
// `.archived` sidecars MUST be renamed with it, or its state is lost. Renaming
// by hand is exactly where that gets forgotten.
//
// The send time is taken from the frontmatter, so a file already renamed to
// something arbitrary still lands on the right timestamp.
//
// Usage (from anywhere — the path does not depend on your shell's directory):
//   node scripts/rename-letters-ascii.mjs
//   node scripts/rename-letters-ascii.mjs --write
//   node scripts/rename-letters-ascii.mjs --dir=/path/to/local_data --write

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolved from the SCRIPT's own location, not the shell's working directory.
// The first version used process.cwd(): run from web-app/scripts/ it looked for
// web-app/local_data, found nothing, and cheerfully reported "scanned 0" — a
// silent no-op that looked exactly like success. Matches the --dir convention
// already used by migrate-attachments.mjs and gc-attachments.mjs.
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const DATA = dirArg
  ? path.resolve(dirArg.slice('--dir='.length))
  : path.resolve(__dirname, '..', '..', 'local_data');
const LETTERS = path.join(DATA, 'letters');
const WRITE = process.argv.includes('--write');
const SIDECARS = ['.read', '.archived'];
const ASCII = /^[\x20-\x7e]+$/;

const pad = (n) => String(n).padStart(2, '0');

/** `2026-08-01T10:54:00+09:00` → `2026-08-01_1054`. Falls back to mtime. */
async function stampFor(file, raw) {
  const m = (raw || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}_${m[4]}${m[5]}`;
  const d = (await fs.stat(file)).mtime;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function suffix() {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8);
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function dirs(p) {
  try {
    return (await fs.readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch { return []; }
}

// Refuse to run against a directory that isn't there. Swallowing this is what
// turned a wrong path into a confident "scanned 0 · APPLIED."
console.log(`local_data : ${DATA}`);
console.log(`letters    : ${LETTERS}`);
try {
  const st = await fs.stat(LETTERS);
  if (!st.isDirectory()) throw new Error('not a directory');
} catch {
  console.error(
    `\nERROR: no letters directory at ${LETTERS}\n` +
    `Pass an explicit path if local_data lives elsewhere:\n` +
    `  node scripts/rename-letters-ascii.mjs --dir=C:/path/to/local_data\n`
  );
  process.exit(1);
}

let scanned = 0, renamed = 0, skipped = 0, movedSidecars = 0;
const plan = [];

for (const from of await dirs(LETTERS)) {
  for (const to of await dirs(path.join(LETTERS, from))) {
    const dir = path.join(LETTERS, from, to);
    const files = (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
    for (const name of files) {
      scanned++;
      if (ASCII.test(name)) { skipped++; continue; }

      const file = path.join(dir, name);
      let sent = '';
      try {
        const head = (await fs.readFile(file, 'utf-8')).slice(0, 600);
        sent = head.match(/^sent:\s*(.+)$/m)?.[1]?.trim() || '';
      } catch { /* unreadable header — mtime fallback below */ }

      let next = `${await stampFor(file, sent)}_${suffix()}.md`;
      let guard = 0;
      while (await exists(path.join(dir, next))) {
        if (++guard > 50) throw new Error(`no free name for ${file}`);
        next = `${await stampFor(file, sent)}_${suffix()}.md`;
      }

      const carried = [];
      for (const sc of SIDECARS) if (await exists(file + sc)) carried.push(sc);

      plan.push({ dir, name, next, carried, rel: path.relative(LETTERS, file) });
      renamed++;
      movedSidecars += carried.length;

      if (WRITE) {
        // Sidecars first: if the process dies mid-way, an orphaned sidecar is
        // recoverable, whereas a letter whose state files vanished is not.
        for (const sc of carried) await fs.rename(file + sc, path.join(dir, next + sc));
        await fs.rename(file, path.join(dir, next));
      }
    }
  }
}

for (const p of plan) {
  console.log(`${p.rel}\n   -> ${p.next}${p.carried.length ? `   (+ ${p.carried.join(' ')})` : ''}`);
}
console.log(`\nscanned ${scanned} · rename ${renamed} · already ASCII ${skipped} · sidecars carried ${movedSidecars}`);
console.log(WRITE ? '\nAPPLIED.' : '\nDRY RUN — pass --write to apply.');
