#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// migrate-attachments.mjs
//
// Moves inline base64 attachments OUT of conversation JSON files and into the
// content-addressed store at local_data/attachments/, replacing each payload
// with a small "ref".
//
// WHY
// A conversation used to carry every image/audio/video inline as a base64
// `data:` URL. That made each turn re-serialize, re-POST and re-write the whole
// thing, and it capped a conversation at V8's max string length (~512 MiB),
// past which it could no longer be saved at all. Payloads now live once on
// disk, shared by hash, and the JSON keeps only a pointer.
//
// HOW (and why line-by-line rather than JSON.parse)
// saveLog always pretty-prints with an indent, so every "dataUrl" sits on its
// own line. This script streams the file a line at a time and rewrites those
// lines. It therefore NEVER builds a whole-file string — which matters because
// a conversation at or past the ~512 MiB string cap cannot be JSON.parse'd at
// all, and those are exactly the files most in need of migrating. Peak memory
// is one line (the largest single attachment), not one file.
//
// SAFE BY DEFAULT: this is a DRY RUN unless you pass --write. The dry run reads
// and reports but writes nothing at all — not even to the attachment store.
//
// With --write, for each conversation:
//   1. stream-rewrite to a temp file, storing each payload as it goes
//   2. VALIDATE the result (it's small now, so it can be safely parsed) and
//      confirm the attachment count still matches
//   3. copy the ORIGINAL to local_data/pre_migration/<folder>/<id>.json
//   4. atomically swap the migrated file into place
// Any failure at any step leaves the original untouched.
//
// Usage (from anywhere — paths resolve from this script's location):
//   node scripts/migrate-attachments.mjs                 # dry run, all folders
//   node scripts/migrate-attachments.mjs --write         # apply
//   node scripts/migrate-attachments.mjs --folder=ユキ    # limit to one folder
//   node scripts/migrate-attachments.mjs --dir=/path/to/local_data
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import readline from 'readline';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const folderArg = args.find(a => a.startsWith('--folder='));
const ONLY_FOLDER = folderArg ? folderArg.slice('--folder='.length) : null;
const dirArg = args.find(a => a.startsWith('--dir='));
// Script lives at <repo>/web-app/scripts/, so local_data is two levels up.
const DATA_DIR = dirArg
  ? path.resolve(dirArg.slice('--dir='.length))
  : path.resolve(__dirname, '..', '..', 'local_data');

const LOGS_DIR = path.join(DATA_DIR, 'logs');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const PRESERVE_DIR = path.join(DATA_DIR, 'pre_migration');

// ── Shared mime table ────────────────────────────────────────────────────────
// Read from the SAME JSON the app uses, so a ref computed here is byte-for-byte
// the ref the app would compute. Duplicating this table was the one way this
// script could silently corrupt dedupe.
const mimeTable = JSON.parse(
  await fs.readFile(path.resolve(__dirname, '..', 'src', 'lib', 'attachmentMime.json'), 'utf-8')
);
const MIME_TO_EXT = mimeTable.mimeToExt;

function extForMime(mime) {
  if (!mime) return 'bin';
  return MIME_TO_EXT[String(mime).toLowerCase().trim()] || 'bin';
}

// ── Store write (mirrors putBytes in src/lib/attachmentStore.ts) ─────────────
async function putBytes(bytes, mime) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ref = `${hash}.${extForMime(mime)}`;
  const full = path.join(ATTACHMENTS_DIR, ref.slice(0, 2), ref);
  await fs.mkdir(path.dirname(full), { recursive: true });
  try {
    await fs.stat(full);
    return { ref, deduped: true };   // identical bytes already stored
  } catch {}
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, full);
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }
  return { ref, deduped: false };
}

// Matches a pretty-printed inline attachment payload line, e.g.
//     "dataUrl": "data:image/jpeg;base64,/9j/4AAQ...",
// Captures indent, mime, payload, and whether a trailing comma is present, so
// the replacement line keeps the surrounding JSON structurally identical.
const DATA_URL_LINE = /^(\s*)"dataUrl":\s*"data:([^;,"]+);base64,([^"]*)"(,?)\s*$/;

// An attachment that is ALREADY externalized. A conversation can legitimately
// contain these before migration: anything attached after the new ingest path
// went live is written as a ref from the start. They must be counted, because
// the post-migration validation compares against every ref in the file — not
// just the ones this run created.
const REF_LINE = /^\s*"ref":\s*"[0-9a-f]{64}\.[a-z0-9]{1,8}"/;

// Any other line still carrying a base64 data: payload. Used as a safety check —
// if one survives the rewrite, the file isn't in the shape we assumed and we
// refuse to touch it rather than half-migrate.
const RESIDUAL_DATA_URL = /"data:[^"]*;base64,/;

const human = b =>
  b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB`
  : b >= 1048576  ? `${(b / 1048576).toFixed(1)} MB`
  : b >= 1024     ? `${(b / 1024).toFixed(1)} KB`
  : `${b} B`;

/**
 * Stream one conversation. In dry-run mode nothing is written anywhere; we only
 * measure. With --write the rewritten file goes to `outPath`.
 */
async function processFile(filePath, outPath) {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const out = outPath ? createWriteStream(outPath, { encoding: 'utf8' }) : null;

  let inlineCount = 0, inlineBytes = 0, dedupedCount = 0, residual = 0, existingRefs = 0;
  const kinds = {};

  const write = line => {
    if (!out) return;
    if (!out.write(line + '\n')) {
      return new Promise(res => out.once('drain', res));
    }
  };

  for await (const line of rl) {
    const m = DATA_URL_LINE.exec(line);
    if (!m) {
      if (REF_LINE.test(line)) existingRefs++;
      else if (RESIDUAL_DATA_URL.test(line)) residual++;
      await write(line);
      continue;
    }
    const [, indent, mime, b64, comma] = m;
    inlineCount++;
    inlineBytes += b64.length;
    kinds[mime] = (kinds[mime] || 0) + 1;

    if (!out) {
      // Dry run: measure only. Don't decode (costs memory) and don't store.
      continue;
    }
    const bytes = Buffer.from(b64, 'base64');
    const { ref, deduped } = await putBytes(bytes, mime);
    if (deduped) dedupedCount++;
    await write(`${indent}"ref": "${ref}"${comma}`);
  }

  if (out) {
    await new Promise((res, rej) => { out.end(err => (err ? rej(err) : res())); });
  }
  return { inlineCount, inlineBytes, dedupedCount, residual, existingRefs, kinds };
}

/**
 * Confirm the migrated file is valid JSON and didn't lose attachments.
 *
 * `expectedRefs` must account for refs that were ALREADY in the file before
 * this run, not just the ones we converted — a conversation used after the new
 * ingest path went live legitimately contains both formats.
 */
async function validate(outPath, expectedRefs) {
  const text = await fs.readFile(outPath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`migrated file is not valid JSON: ${e.message}`);
  }
  let refs = 0, leftoverInline = 0;
  for (const msg of parsed.messages || []) {
    for (const att of msg.attachments || []) {
      if (!att) continue;
      if (att.ref) refs++;
      if (att.dataUrl) leftoverInline++;
    }
  }
  if (refs !== expectedRefs) {
    throw new Error(
      `attachment count mismatch: expected ${expectedRefs} refs ` +
      `(converted now + already externalized) but found ${refs} after parse`
    );
  }
  if (leftoverInline > 0) {
    throw new Error(`${leftoverInline} attachment(s) still hold an inline dataUrl after rewrite`);
  }
  return parsed;
}

async function main() {
  console.log(`NEXUS attachment migration — ${WRITE ? 'APPLY (--write)' : 'DRY RUN'}`);
  console.log(`data dir: ${DATA_DIR}`);
  if (ONLY_FOLDER) console.log(`folder filter: ${ONLY_FOLDER}`);
  console.log('');

  let folders;
  try {
    folders = (await fs.readdir(LOGS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    console.error(`Cannot read ${LOGS_DIR}: ${e.message}`);
    process.exit(1);
  }
  if (ONLY_FOLDER) folders = folders.filter(f => f === ONLY_FOLDER);

  let totalFiles = 0, touchedFiles = 0, totalInline = 0, totalInlineBytes = 0;
  let totalDeduped = 0, totalBefore = 0, totalAfter = 0, failures = 0;
  const allKinds = {};

  for (const folder of folders) {
    const dir = path.join(LOGS_DIR, folder);
    let files;
    try {
      files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    } catch { continue; }

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sizeBefore = (await fs.stat(filePath)).size;
      totalFiles++;

      // Pass 1 is always a measuring pass, even with --write: it tells us
      // whether this file has anything to do before we touch it at all.
      const scan = await processFile(filePath, null);
      if (scan.inlineCount === 0) continue;

      touchedFiles++;
      totalInline += scan.inlineCount;
      totalInlineBytes += scan.inlineBytes;
      totalBefore += sizeBefore;
      for (const [k, v] of Object.entries(scan.kinds)) allKinds[k] = (allKinds[k] || 0) + v;

      const kindStr = Object.entries(scan.kinds).map(([k, v]) => `${v} ${k}`).join(', ');
      const projected = sizeBefore - scan.inlineBytes;

      if (!WRITE) {
        totalAfter += projected;
        console.log(
          `  ${folder}/${file}\n` +
          `      ${human(sizeBefore)} → ~${human(projected)}   ${scan.inlineCount} inline (${kindStr})`
        );
        continue;
      }

      // ── Apply ──────────────────────────────────────────────────────────────
      const tmpOut = `${filePath}.migrating-${process.pid}`;
      try {
        const res = await processFile(filePath, tmpOut);

        if (res.residual > 0) {
          throw new Error(
            `${res.residual} base64 payload(s) were not on their own line — ` +
            `file layout is not what this script assumes, refusing to modify it`
          );
        }
        // Expected = what we just converted PLUS what was already externalized.
        await validate(tmpOut, res.inlineCount + res.existingRefs);

        // Preserve the original BEFORE swapping, so a failure here still
        // leaves the untouched original in place.
        const preserveDir = path.join(PRESERVE_DIR, folder);
        await fs.mkdir(preserveDir, { recursive: true });
        await fs.copyFile(filePath, path.join(preserveDir, file));

        await fs.rename(tmpOut, filePath);

        const sizeAfter = (await fs.stat(filePath)).size;
        totalAfter += sizeAfter;
        totalDeduped += res.dedupedCount;
        console.log(
          `  ✓ ${folder}/${file}\n` +
          `      ${human(sizeBefore)} → ${human(sizeAfter)}   ` +
          `${res.inlineCount} moved (${kindStr})${res.dedupedCount ? `, ${res.dedupedCount} deduped` : ''}`
        );
      } catch (e) {
        failures++;
        totalAfter += sizeBefore;
        try { await fs.unlink(tmpOut); } catch {}
        console.error(`  ✗ ${folder}/${file}\n      FAILED: ${e.message}\n      original left untouched`);
      }
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`conversations scanned : ${totalFiles}`);
  console.log(`with inline payloads  : ${touchedFiles}`);
  console.log(`inline attachments    : ${totalInline}`);
  if (Object.keys(allKinds).length) {
    console.log(`  by type             : ${Object.entries(allKinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  }
  console.log(`base64 in JSON        : ${human(totalInlineBytes)}`);
  console.log(`logs ${WRITE ? 'size' : 'projected'}  : ${human(totalBefore)} → ${human(totalAfter)}`);
  if (WRITE) {
    console.log(`payloads deduped      : ${totalDeduped}`);
    console.log(`originals preserved   : ${PRESERVE_DIR}`);
    if (failures) console.log(`FAILURES              : ${failures} (originals untouched)`);
  } else {
    console.log('');
    console.log('This was a DRY RUN — nothing was written.');
    console.log('Re-run with --write to apply.');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
