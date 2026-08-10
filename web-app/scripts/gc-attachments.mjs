#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// gc-attachments.mjs
//
// Mark-and-sweep cleanup for the content-addressed attachment store.
//
// WHY THIS IS NEEDED
// Payloads are shared by content hash, so the same file can be referenced from
// several conversations at once (cloning a conversation and copying messages
// between conversations are both normal operations). That means deletion can't
// happen when a conversation is deleted — you'd break the copies. Instead
// nothing is ever deleted eagerly, and this script occasionally reclaims what
// genuinely nothing points at anymore.
//
// The failure mode is deliberately lopsided: an orphan wastes disk, while a
// wrongly-deleted payload silently breaks media in a conversation. So every
// judgement call here errs toward keeping the file.
//
// MARK PHASE scans, for refs:
//   • local_data/logs/       — live conversations
//   • local_data/backups/    — RESTORABLE history. Backups written after the
//                              migration contain refs, and restoring one must
//                              still find its media. Skipping this directory
//                              would quietly gut your backups.
// (pre_migration/ holds pre-migration originals, which carry inline dataUrls
// and reference nothing — scanned anyway, cheaply, in case that ever changes.)
//
// GRACE PERIOD protects a payload that has been uploaded but not yet saved into
// any conversation — the window between attaching a file and sending the
// message. Files newer than --grace-hours (default 24) are never swept.
//
// SAFE BY DEFAULT: dry run unless you pass --write.
//
// Usage:
//   node scripts/gc-attachments.mjs                    # dry run
//   node scripts/gc-attachments.mjs --write            # delete orphans
//   node scripts/gc-attachments.mjs --grace-hours=72
//   node scripts/gc-attachments.mjs --dir=/path/to/local_data
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const graceArg = args.find(a => a.startsWith('--grace-hours='));
const GRACE_HOURS = graceArg ? Number(graceArg.slice('--grace-hours='.length)) : 24;
const dirArg = args.find(a => a.startsWith('--dir='));
const DATA_DIR = dirArg
  ? path.resolve(dirArg.slice('--dir='.length))
  : path.resolve(__dirname, '..', '..', 'local_data');

const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
// Every directory that can legitimately hold a reference to a payload.
const SCAN_DIRS = ['logs', 'backups', 'pre_migration'].map(d => path.join(DATA_DIR, d));

const REF_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
// Refs as they appear inside a conversation file. Matched anywhere on the line
// rather than anchored, so this stays correct even if a file isn't pretty-
// printed the way saveLog writes it.
const REF_IN_LINE = /"ref"\s*:\s*"([0-9a-f]{64}\.[a-z0-9]{1,8})"/g;

const human = b =>
  b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB`
  : b >= 1048576  ? `${(b / 1048576).toFixed(1)} MB`
  : b >= 1024     ? `${(b / 1024).toFixed(1)} KB`
  : `${b} B`;

async function* walkJson(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJson(full);
    else if (e.name.endsWith('.json')) yield full;
  }
}

/** Collect every ref mentioned by a file, streaming so huge files stay cheap. */
async function collectRefs(file, into) {
  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // Fast reject before running the regex — most lines mention no ref at all.
    if (!line.includes('"ref"')) continue;
    let m;
    REF_IN_LINE.lastIndex = 0;
    while ((m = REF_IN_LINE.exec(line))) into.add(m[1]);
  }
}

async function main() {
  console.log(`NEXUS attachment GC — ${WRITE ? 'SWEEP (--write)' : 'DRY RUN'}`);
  console.log(`data dir     : ${DATA_DIR}`);
  console.log(`grace period : ${GRACE_HOURS}h (newer payloads are never swept)`);
  console.log('');

  // ── Mark ───────────────────────────────────────────────────────────────────
  const referenced = new Set();
  let filesScanned = 0;
  for (const dir of SCAN_DIRS) {
    let count = 0;
    for await (const file of walkJson(dir)) {
      await collectRefs(file, referenced);
      count++;
    }
    filesScanned += count;
    console.log(`  scanned ${String(count).padStart(5)} file(s) in ${path.basename(dir)}/`);
  }
  console.log(`\nreferenced payloads: ${referenced.size}`);

  // ── Sweep ──────────────────────────────────────────────────────────────────
  let shards = [];
  try {
    shards = await fs.readdir(ATTACHMENTS_DIR);
  } catch {
    console.log('\nNo attachment store found — nothing to do.');
    return;
  }

  const cutoff = Date.now() - GRACE_HOURS * 3600 * 1000;
  let total = 0, totalBytes = 0;
  let orphans = 0, orphanBytes = 0, skippedYoung = 0, deleted = 0, failed = 0;

  for (const shard of shards) {
    const shardDir = path.join(ATTACHMENTS_DIR, shard);
    let names;
    try {
      names = await fs.readdir(shardDir);
    } catch { continue; }

    for (const name of names) {
      const full = path.join(shardDir, name);

      // Anything that isn't a well-formed ref (stray .tmp-* from an interrupted
      // write, for instance) is left alone. Cleaning those up is not this
      // script's job and guessing is how you delete something that matters.
      if (!REF_RE.test(name)) continue;

      let st;
      try { st = await fs.stat(full); } catch { continue; }
      if (!st.isFile()) continue;

      total++;
      totalBytes += st.size;
      if (referenced.has(name)) continue;

      // Unreferenced — but possibly attached-and-not-yet-sent.
      if (st.mtimeMs > cutoff) {
        skippedYoung++;
        continue;
      }

      orphans++;
      orphanBytes += st.size;
      if (!WRITE) {
        console.log(`  orphan: ${name}  ${human(st.size)}`);
        continue;
      }
      try {
        await fs.unlink(full);
        deleted++;
        console.log(`  ✓ deleted ${name}  ${human(st.size)}`);
      } catch (e) {
        failed++;
        console.error(`  ✗ ${name}: ${e.message}`);
      }
    }
  }

  // Drop shard directories that ended up empty, so the store doesn't accumulate
  // 256 empty folders.
  if (WRITE) {
    for (const shard of shards) {
      try { await fs.rmdir(path.join(ATTACHMENTS_DIR, shard)); } catch {}
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`conversation files scanned : ${filesScanned}`);
  console.log(`payloads in store          : ${total} (${human(totalBytes)})`);
  console.log(`still referenced           : ${total - orphans - skippedYoung}`);
  console.log(`within grace period        : ${skippedYoung}`);
  console.log(`orphans                    : ${orphans} (${human(orphanBytes)})`);
  if (WRITE) {
    console.log(`deleted                    : ${deleted}`);
    if (failed) console.log(`failed                     : ${failed}`);
  } else {
    console.log('');
    console.log('This was a DRY RUN — nothing was deleted.');
    console.log('Re-run with --write to reclaim the orphans above.');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
