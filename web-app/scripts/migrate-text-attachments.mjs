#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// migrate-text-attachments.mjs
//
// Adds a `ref` to every EXISTING text attachment (one that already has
// `textData` but no `ref` yet) across every being's conversation logs, storing
// its bytes in the same content-addressed store binary attachments use
// (local_data/attachments/). `textData` itself is left untouched — this is
// additive, not a replacement — so inline display for weak models keeps
// working exactly as before. The `ref` is what makes the attachment visible
// to read_attachment/search_attachments when it's hidden from the prompt.
//
// WHY THIS SCRIPT EXISTS SEPARATELY FROM migrate-attachments.mjs
// That script moves `dataUrl` (base64 media) OUT of the JSON, shrinking the
// file, because the payload is large and pointless to keep inline. Text is the
// opposite: `textData` stays inline (small, and still the fast path for
// visible attachments), and `ref` is purely ADDED alongside it so the corpus's
// existing text attachments — 1872 of 1875 at the time this script was
// written — stop being invisible to the new attachment tools. Two different
// shapes of change, two scripts.
//
// It also targets the CURRENT directory layout
// (local_data/beings/<being>/logs/*.json), not the pre-restructuring
// local_data/logs/<being>/*.json that migrate-attachments.mjs still points at
// — that script's LOGS_DIR is stale post-restructuring and would silently
// find zero files if run today. Flagged separately; not fixed here, since
// fixing someone else's script isn't in scope for this one.
//
// HOW (and why line-by-line rather than JSON.parse)
// saveLog always pretty-prints with an indent, so every "textData" value sits
// on its own line (JSON.stringify escapes real newlines inside the string as
// \n, so a multi-line text attachment still renders as ONE physical line).
// This script streams the file a line at a time and only ever holds one line
// in memory — the largest single attachment, not the whole file — which
// matters because some of these conversation logs are large enough that a
// whole-file JSON.parse would itself be expensive.
//
// A one-line LOOKAHEAD decides whether a given "textData" line already has a
// following "ref" line (the 3 attachments in the corpus that are already
// dual-field, from today's earlier fix) — those are left alone so this script
// is safe to re-run.
//
// SAFE BY DEFAULT: this is a DRY RUN unless you pass --write. The dry run
// reads and reports but writes nothing at all — not even to the attachment
// store.
//
// With --write, for each conversation that has anything to convert:
//   1. stream-rewrite to a temp file, storing each text payload as it goes
//   2. VALIDATE the result (parse it, confirm no text attachment is left
//      without a ref, confirm the ref count matches what was expected)
//   3. copy the ORIGINAL to local_data/pre_migration_text/<being>/<file>
//   4. atomically swap the migrated file into place
// Any failure at any step leaves the original untouched.
//
// Usage (from web-app/, or anywhere — paths resolve from this script's
// location):
//   node scripts/migrate-text-attachments.mjs                # dry run, all beings
//   node scripts/migrate-text-attachments.mjs --write         # apply
//   node scripts/migrate-text-attachments.mjs --being=Cairn   # limit to one being
//   node scripts/migrate-text-attachments.mjs --dir=/path/to/local_data
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
const beingArg = args.find(a => a.startsWith('--being='));
const ONLY_BEING = beingArg ? beingArg.slice('--being='.length) : null;
const dirArg = args.find(a => a.startsWith('--dir='));
// Script lives at <repo>/web-app/scripts/, so local_data is two levels up.
const DATA_DIR = dirArg
  ? path.resolve(dirArg.slice('--dir='.length))
  : path.resolve(__dirname, '..', '..', 'local_data');

// CURRENT layout, post beings-restructuring: local_data/beings/<being>/logs/*.json
const BEINGS_DIR = path.join(DATA_DIR, 'beings');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const PRESERVE_DIR = path.join(DATA_DIR, 'pre_migration_text');

// ── Store write (mirrors putBytes in src/lib/attachmentStore.ts) ─────────────
// Text attachments are ALWAYS uploaded as 'text/plain' by the live app
// (InputArea.tsx hardcodes it regardless of the file's real type), so the ref
// computed here MUST use the same MIME or identical bytes would hash under a
// different extension than the live app would ever produce — breaking dedupe
// against anything the app uploads for the same content going forward.
const TEXT_MIME = 'text/plain';
const TEXT_EXT = 'txt';

async function putBytes(bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ref = `${hash}.${TEXT_EXT}`;
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

// Matches a pretty-printed "textData" line holding a JSON string, e.g.
//     "textData": "some file contents\nwith escaped newlines",
// The alternation (?:[^"\\]|\\.) is the standard JSON-string-body pattern: any
// char that isn't a quote or backslash, OR a backslash followed by anything
// (an escape sequence) — so embedded \" and \\ don't terminate the match early.
// Does NOT match "textData": null (no opening quote after the colon), which is
// exactly right: nothing to migrate there.
const TEXTDATA_LINE = /^(\s*)"textData":\s*"((?:[^"\\]|\\.)*)"(,?)\s*$/;

// An attachment whose textData is ALREADY followed by a ref — the dual-field
// shape produced by today's earlier fix, or a previous run of this very
// script. Recognizing it is what makes re-running this script a no-op on
// already-migrated entries instead of re-hashing and re-counting them.
const REF_LINE = /^\s*"ref":\s*"[0-9a-f]{64}\.[a-z0-9]{1,8}"/;

const human = b =>
  b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB`
  : b >= 1048576  ? `${(b / 1048576).toFixed(1)} MB`
  : b >= 1024     ? `${(b / 1024).toFixed(1)} KB`
  : `${b} B`;

/**
 * Stream one conversation. In dry-run mode nothing is written anywhere; we
 * only measure (and don't decode JSON-escaping, so the byte estimate is
 * approximate — the escaped-string length, not the decoded UTF-8 length).
 * With --write the rewritten file goes to `outPath` and payloads are actually
 * hashed and stored.
 */
async function processFile(filePath, outPath) {
  const rl = readline.createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const out = outPath ? createWriteStream(outPath, { encoding: 'utf8' }) : null;

  let convertedCount = 0, convertedBytesApprox = 0, dedupedCount = 0, alreadyRefd = 0;

  const write = line => {
    if (!out) return;
    if (!out.write(line + '\n')) {
      return new Promise(res => out.once('drain', res));
    }
  };

  // One-line lookahead: we need to know whether the line AFTER a "textData"
  // match is already a "ref" line before deciding whether to insert one.
  const it = rl[Symbol.asyncIterator]();
  let cur = await it.next();
  while (!cur.done) {
    const line = cur.value;
    const next = await it.next();
    const nextLine = next.done ? null : next.value;

    const m = TEXTDATA_LINE.exec(line);
    if (!m) {
      await write(line);
      cur = next;
      continue;
    }

    const alreadyHasRef = nextLine !== null && REF_LINE.test(nextLine);
    if (alreadyHasRef) {
      alreadyRefd++;
      await write(line);
      cur = next;
      continue;
    }

    const [, indent, escaped, comma] = m;
    convertedCount++;
    convertedBytesApprox += escaped.length;

    if (!out) {
      // Dry run: measure only. Don't decode or store.
      cur = next;
      continue;
    }

    // Decode the JSON-escaped string body back to the exact text the live app
    // would hold in memory, then hash its UTF-8 bytes — identical to what
    // `new Blob([textData], { type: 'text/plain' })` + upload would hash.
    const text = JSON.parse(`"${escaped}"`);
    const bytes = Buffer.from(text, 'utf-8');
    const { ref, deduped } = await putBytes(bytes);
    if (deduped) dedupedCount++;

    if (comma) {
      // textData already has a trailing comma (more fields follow it, as in
      // every real sample seen) — leave it as-is and give the new ref line
      // its own trailing comma.
      await write(line);
      await write(`${indent}"ref": "${ref}",`);
    } else {
      // textData was the last property before the closing brace — give IT
      // the comma (since ref now follows) and leave ref bare.
      await write(`${indent}"textData": "${escaped}",`);
      await write(`${indent}"ref": "${ref}"`);
    }
    cur = next;
  }

  if (out) {
    await new Promise((res, rej) => { out.end(err => (err ? rej(err) : res())); });
  }
  return { convertedCount, convertedBytesApprox, dedupedCount, alreadyRefd };
}

/**
 * Confirm the migrated file is valid JSON and that every text attachment
 * (anything with a non-null textData) now has a ref — not just a count check,
 * a per-attachment check, since silently leaving one unmigrated would be
 * exactly the kind of failure this migration exists to fix.
 */
async function validate(outPath, expectedTextRefs) {
  const text = await fs.readFile(outPath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`migrated file is not valid JSON: ${e.message}`);
  }
  let textWithRef = 0, textWithoutRef = 0;
  for (const msg of parsed.messages || []) {
    for (const att of msg.attachments || []) {
      if (!att) continue;
      if (att.textData !== undefined && att.textData !== null) {
        if (att.ref) textWithRef++; else textWithoutRef++;
      }
    }
  }
  if (textWithoutRef > 0) {
    throw new Error(`${textWithoutRef} text attachment(s) still missing a ref after rewrite`);
  }
  if (textWithRef !== expectedTextRefs) {
    throw new Error(
      `text-ref count mismatch: expected ${expectedTextRefs} (converted now + already ref'd) ` +
      `but found ${textWithRef} after parse`
    );
  }
  return parsed;
}

async function main() {
  console.log(`NEXUS text-attachment migration — ${WRITE ? 'APPLY (--write)' : 'DRY RUN'}`);
  console.log(`data dir: ${DATA_DIR}`);
  if (ONLY_BEING) console.log(`being filter: ${ONLY_BEING}`);
  console.log('');

  let beings;
  try {
    beings = (await fs.readdir(BEINGS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch (e) {
    console.error(`Cannot read ${BEINGS_DIR}: ${e.message}`);
    process.exit(1);
  }
  if (ONLY_BEING) beings = beings.filter(b => b === ONLY_BEING);

  let totalFiles = 0, touchedFiles = 0, totalConverted = 0, totalBytesApprox = 0;
  let totalDeduped = 0, totalAlreadyRefd = 0, failures = 0;

  for (const being of beings) {
    const dir = path.join(BEINGS_DIR, being, 'logs');
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
      // Counted here, BEFORE the early-out below, so a file whose only text
      // attachment is already ref'd (nothing left to convert) still shows up
      // in the running total instead of silently vanishing from the report.
      totalAlreadyRefd += scan.alreadyRefd;
      if (scan.convertedCount === 0) continue;

      touchedFiles++;
      totalConverted += scan.convertedCount;
      totalBytesApprox += scan.convertedBytesApprox;

      if (!WRITE) {
        console.log(
          `  ${being}/${file}\n` +
          `      ${scan.convertedCount} text attachment(s) to migrate (~${human(scan.convertedBytesApprox)})` +
          `${scan.alreadyRefd ? `, ${scan.alreadyRefd} already ref'd` : ''}`
        );
        continue;
      }

      // ── Apply ──────────────────────────────────────────────────────────────
      const tmpOut = `${filePath}.migrating-${process.pid}`;
      try {
        const res = await processFile(filePath, tmpOut);
        await validate(tmpOut, res.convertedCount + res.alreadyRefd);

        // Preserve the original BEFORE swapping, so a failure here still
        // leaves the untouched original in place.
        const preserveDir = path.join(PRESERVE_DIR, being);
        await fs.mkdir(preserveDir, { recursive: true });
        await fs.copyFile(filePath, path.join(preserveDir, file));

        await fs.rename(tmpOut, filePath);

        totalDeduped += res.dedupedCount;
        console.log(
          `  ✓ ${being}/${file}\n` +
          `      ${res.convertedCount} text attachment(s) migrated` +
          `${res.dedupedCount ? `, ${res.dedupedCount} deduped` : ''}`
        );
      } catch (e) {
        failures++;
        try { await fs.unlink(tmpOut); } catch {}
        console.error(`  ✗ ${being}/${file}\n      FAILED: ${e.message}\n      original left untouched`);
      }
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`conversations scanned      : ${totalFiles}`);
  console.log(`with text to migrate       : ${touchedFiles}`);
  console.log(`text attachments migrated  : ${totalConverted}`);
  console.log(`already ref'd (skipped)    : ${totalAlreadyRefd}`);
  console.log(`approx bytes               : ${human(totalBytesApprox)}`);
  if (WRITE) {
    console.log(`payloads deduped           : ${totalDeduped}`);
    console.log(`originals preserved        : ${PRESERVE_DIR}`);
    if (failures) console.log(`FAILURES                   : ${failures} (originals untouched)`);
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
