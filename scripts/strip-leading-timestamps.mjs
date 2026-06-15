#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// strip-leading-timestamps.mjs
//
// Walks the NEXUS conversation logs and removes stacked "[YYYY-MM-DD HH:MM:SS]"
// timestamp tags from the VERY BEGINNING of messages. Models (especially Kimi)
// echo the dateTimeVisibility timestamps back at the start of a reply, sometimes
// a whole stack:
//
//     [2026-05-30 00:36:54]
//     [2026-05-30 00:36:54]
//     Actual reply text...
//
// This script collapses that to "Actual reply text...".
//
// By default it only touches ASSISTANT messages — user messages legitimately
// carry injected timestamps (chronological VRChat data) that we must keep.
// Pass --all-roles to strip from every message.
//
// SAFE BY DEFAULT: this is a DRY RUN unless you pass --write. Dry run prints
// exactly what would change without modifying any file.
//
// Usage (from the web-app/ directory or anywhere):
//   node scripts/strip-leading-timestamps.mjs               # dry run
//   node scripts/strip-leading-timestamps.mjs --write       # apply changes
//   node scripts/strip-leading-timestamps.mjs --all-roles --write
//   node scripts/strip-leading-timestamps.mjs --dir=/path/to/local_data/logs
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ALL_ROLES = args.includes('--all-roles');
const dirArg = args.find((a) => a.startsWith('--dir='));
// Default: <repo>/local_data/logs  (script lives at <repo>/web-app/scripts/)
const LOGS_DIR = dirArg
  ? path.resolve(dirArg.slice('--dir='.length))
  : path.resolve(__dirname, '..', '..', 'local_data', 'logs');

// ── Timestamp matching (mirrors src/lib/timestampStrip.ts) ────────────────────
// Leading class is `\s*` (not `[ \t]*`) so a timestamp stack preceded by one or
// more blank lines (e.g. "\n[2026-05-31 16:44:20]\n…") is still stripped.
const LEADING_STACK_RE =
  /^(?:\s*\[\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\][ \t]*\r?\n?)+/;
const ONLY_TIMESTAMPS_RE =
  /^(?:\s*\[\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*)+$/;

function stripLeadingTimestamps(text) {
  if (!text) return text;
  return text.replace(LEADING_STACK_RE, '');
}
function isOnlyTimestamps(text) {
  const t = (text || '').trim();
  if (!t) return false;
  return ONLY_TIMESTAMPS_RE.test(t);
}

// ── Recursive .json walk ──────────────────────────────────────────────────────
async function* walkJson(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJson(full);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
      yield full;
    }
  }
}

// Atomic write: temp file + rename, so a crash can't truncate a log.
async function writeFileAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

function shorten(s, n = 60) {
  const oneLine = (s || '').replace(/\r?\n/g, '⏎');
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

async function main() {
  console.log(`Logs dir : ${LOGS_DIR}`);
  console.log(`Roles    : ${ALL_ROLES ? 'all messages' : 'assistant only'}`);
  console.log(`Mode     : ${WRITE ? 'WRITE (will modify files)' : 'DRY RUN (no changes)'}\n`);

  let filesScanned = 0;
  let filesChanged = 0;
  let messagesChanged = 0;
  let messagesEmptied = 0;

  for await (const file of walkJson(LOGS_DIR)) {
    filesScanned++;
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      console.warn(`! skip (read error): ${file} — ${e.message}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.warn(`! skip (not valid JSON): ${file}`);
      continue;
    }
    const msgs = Array.isArray(data?.messages) ? data.messages : null;
    if (!msgs) continue;

    let fileDirty = false;
    for (const m of msgs) {
      if (!m || typeof m.content !== 'string') continue;
      if (!ALL_ROLES && m.role !== 'assistant') continue;

      const before = m.content;
      const after = stripLeadingTimestamps(before);
      if (after === before) continue;

      messagesChanged++;
      fileDirty = true;
      if (after.trim() === '' && isOnlyTimestamps(before)) messagesEmptied++;

      const removed = before.slice(0, before.length - after.length);
      console.log(`  ${path.relative(LOGS_DIR, file)} [${m.role}] removed: "${shorten(removed)}"`);

      m.content = after;
    }

    if (fileDirty) {
      filesChanged++;
      if (WRITE) {
        await writeFileAtomic(file, JSON.stringify(data, null, 2));
      }
    }
  }

  console.log(`\n──────── summary ────────`);
  console.log(`files scanned    : ${filesScanned}`);
  console.log(`files changed    : ${filesChanged}`);
  console.log(`messages changed : ${messagesChanged}`);
  console.log(`  └ emptied      : ${messagesEmptied} (content was ONLY timestamps)`);
  if (!WRITE) {
    console.log(`\nThis was a DRY RUN. Re-run with --write to apply the changes above.`);
  } else {
    console.log(`\nDone — files updated in place (atomic write).`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
