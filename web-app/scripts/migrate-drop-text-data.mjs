#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// migrate-drop-text-data.mjs
//
// Replaces the inline `textData` of every text attachment that is ALREADY in
// the content-addressed store with a short `textPreview`, so the conversation
// JSON stops carrying a second copy of bytes the store already holds.
//
//     before   "textData": "<the whole file>",  "ref": "<hash>.txt"
//     after    "textPreview": "<first 501 chars>",  "ref": "<hash>.txt"
//
// This is the MIRROR of migrate-text-attachments.mjs. That script ADDED a ref
// alongside textData (additively, on purpose). This one removes the now-
// redundant copy. Two directions, two scripts, and this one depends on that
// one having run — an attachment with no ref is never touched.
//
// WHY, AND WHY THE ORIGINAL DESIGN SAID NOT TO
// attachmentStore.ts argues that externalizing text display "would add a disk
// read per turn and a fetch per preview to save nothing". Half of that is
// still exactly right — the prompt-injection path does now read the ref from
// disk (route.ts already implements that fallback), and that read is real. But
// "to save nothing" was measured against the PROMPT, which costs the same
// either way. It was written before NEXUS was served over a network, so the
// cost it never weighed is the one that now dominates: the conversation JSON
// crosses a slow link on every open. The axis arrived after the comment did.
//
// MEASURED 2026-11-01, this corpus (305 logs, 232.8 MB):
//     158 logs hold inline textData; 2526 text attachments; 51.6 MB of text
//     dropping textData outright  28.0% of gzipped conversation bytes
//     keeping a 501-char preview   26.3%  <- this script
//     per-log gzip saving          p50 23.7%  p90 54.2%  max 74.0%
// The 1.7-point difference buys a preview that never waits on the network:
// MessageBubble renders only the first 500 chars inline anyway.
//
// WHY 501 CHARS
// The renderer's truncation test is `length > 500`. Storing exactly 500 could
// not distinguish "this file is 500 chars" from "this is a cut", so one extra
// char makes the SAME comparison correct for both shapes. See
// src/lib/attachmentText.ts, which owns that rule for the app side.
//
// FIVE CONDITIONS, ALL REQUIRED. An attachment is only converted when:
//     1. textData is a string
//     2. ref is a valid content-addressed ref
//     3. size is a positive integer      <- else the byte label would show 0
//     4. textData.length > 501           <- else the preview IS the file and
//                                           dropping only costs a fetch
//     5. the store file exists AND its bytes equal textData encoded as UTF-8
// Condition 5 is checked PER ATTACHMENT, not sampled. Measured over the whole
// corpus beforehand: 2519/2519 exact, 0 missing — but a migration that deletes
// the only copy of something must verify the other copy itself, every time,
// not inherit a survey's conclusion.
//
// WHY JSON.parse RATHER THAN THE LINE-STREAMING migrate-text-attachments USES
// That script streams because in September conversations still held inline
// base64 media and ran to hundreds of MB. Media is externalized now: the
// largest log in this corpus is 5.4 MB and parses in 25.9 ms. Parsing lets the
// five conditions above look at the whole attachment object — `size` and `ref`
// live on different lines than `textData`, so a line-based rewrite could not
// check them at all.
//
// KEY ORDER IS PRESERVED because JSON.parse keeps insertion order and
// JSON.stringify emits it. That matters: saveLog writes header fields first so
// that listLogs can read metadata from the first 4096 bytes alone, and a
// round-trip that reordered keys would break that guarantee silently.
//
// `updatedAt` IS BUMPED, deliberately. An open NEXUS tab polls for a newer
// disk version and mirrors it (shipped 2026-11-01). Leaving updatedAt alone
// would make the tab keep its stale in-memory copy — the one that still has
// textData — and its next save would write the migration straight back out.
// Bumping it makes open tabs pull the migrated shape instead.
//
// SAFE BY DEFAULT: DRY RUN unless you pass --write. The dry run reads and
// reports and writes nothing anywhere.
//
// With --write, per conversation that has anything to convert:
//   1. verify every candidate against the store (condition 5)
//   2. rewrite to a temp file
//   3. VALIDATE: re-parse it, confirm no converted attachment kept textData,
//      confirm each one gained a preview, confirm the untouched ones are
//      byte-identical to before
//   4. copy the ORIGINAL to local_data/pre_migration_dropdata/<being>/<file>
//   5. atomically swap
// Any failure at any step leaves the original untouched.
//
// Usage (paths resolve from this script's location, so running it inside
// another installation's repo targets THAT installation's local_data):
//   node scripts/migrate-drop-text-data.mjs                # dry run
//   node scripts/migrate-drop-text-data.mjs --write         # apply
//   node scripts/migrate-drop-text-data.mjs --being=Cairn   # one being
//   node scripts/migrate-drop-text-data.mjs --dir=/path/to/local_data
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const beingArg = args.find(a => a.startsWith('--being='));
const ONLY_BEING = beingArg ? beingArg.slice('--being='.length) : null;
const dirArg = args.find(a => a.startsWith('--dir='));
const DATA_DIR = dirArg
  ? path.resolve(dirArg.slice('--dir='.length))
  : path.resolve(__dirname, '..', '..', 'local_data');

const BEINGS_DIR = path.join(DATA_DIR, 'beings');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const PRESERVE_DIR = path.join(DATA_DIR, 'pre_migration_dropdata');

// Must match PREVIEW_STORE_CHARS in src/lib/attachmentText.ts. Duplicated
// rather than imported because this is plain .mjs and that is TypeScript —
// same reason attachmentMime.json exists for the other migration script.
const PREVIEW_STORE_CHARS = 501;

/**
 * Cut without splitting a surrogate pair. Mirrors cutWithoutSplittingPair in
 * src/lib/attachmentText.ts — duplicated for the same reason the constant is:
 * this is plain .mjs and that is TypeScript.
 *
 * JS indices are UTF-16 code units, so a fixed offset can land between the
 * halves of an astral character and store a lone surrogate — valid JSON, and a
 * replacement glyph on screen. Measured in this corpus before writing it: 2 of
 * 2487 candidates split a pair at exactly 501.
 *
 * The app does NOT decide truncation by length, precisely so that a cut landing
 * on 500 instead of 501 here cannot hide the "view full file" affordance.
 */
function cutWithoutSplittingPair(s, n) {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

const REF_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;
const isValidRef = r => typeof r === 'string' && REF_RE.test(r);
const refPath = ref => path.join(ATTACHMENTS_DIR, ref.slice(0, 2), ref);

const human = b =>
  b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB`
  : b >= 1048576  ? `${(b / 1048576).toFixed(1)} MB`
  : b >= 1024     ? `${(b / 1024).toFixed(1)} KB`
  : `${b} B`;

/**
 * Why this attachment is NOT a candidate, or null when it is one.
 * Returning the reason (rather than a boolean) is what lets the dry run tell
 * "nothing to do here" apart from "something is wrong here".
 */
function skipReason(att) {
  if (!att || typeof att !== 'object') return 'not an object';
  if (typeof att.textData !== 'string') {
    // No textData at all: either a previous run already converted it (which is
    // what makes this script safe to re-run), or it was never text.
    return typeof att.textPreview === 'string' ? 'already migrated' : 'no textData';
  }
  if (!isValidRef(att.ref)) return 'no ref';
  if (!(Number.isInteger(att.size) && att.size > 0)) return 'no size';
  if (att.textData.length <= PREVIEW_STORE_CHARS) return 'already short';
  return null;
}

/** Read one conversation and decide what would change. No writes. */
async function planFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  const obj = JSON.parse(raw);
  const candidates = [];   // { msgIndex, attIndex, att }
  const skips = new Map(); // reason -> count
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  msgs.forEach((m, mi) => {
    if (!m || typeof m !== 'object' || !Array.isArray(m.attachments)) return;
    m.attachments.forEach((a, ai) => {
      const why = skipReason(a);
      if (why === null) candidates.push({ msgIndex: mi, attIndex: ai, att: a });
      else if (why !== 'no textData') skips.set(why, (skips.get(why) || 0) + 1);
    });
  });
  return { obj, raw, candidates, skips };
}

/**
 * Condition 5, per attachment: the store holds these exact bytes.
 * Throws with a specific message on the first failure — a migration that
 * cannot prove the other copy exists must not continue for that file.
 */
async function verifyAgainstStore(candidates) {
  for (const c of candidates) {
    const p = refPath(c.att.ref);
    let disk;
    try {
      disk = await fs.readFile(p);
    } catch (e) {
      throw new Error(`store payload unreadable for "${c.att.name}" (${c.att.ref}): ${e.code || e.message}`);
    }
    const inline = Buffer.from(c.att.textData, 'utf-8');
    if (!disk.equals(inline)) {
      throw new Error(
        `store payload DIFFERS for "${c.att.name}" (${c.att.ref}): ` +
        `store ${disk.length} B vs inline ${inline.length} B — not dropping it`
      );
    }
  }
}

/**
 * Re-parse the rewritten text and prove the three things that could be wrong:
 * every converted attachment lost textData and gained a preview, the preview
 * is the right prefix, and nothing that was not a candidate changed at all.
 */
function validate(outText, original, candidates) {
  let parsed;
  try {
    parsed = JSON.parse(outText);
  } catch (e) {
    throw new Error(`rewritten file is not valid JSON: ${e.message}`);
  }
  const keyOf = c => `${c.msgIndex}/${c.attIndex}`;
  const expected = new Set(candidates.map(keyOf));

  const omsgs = original.messages || [];
  const nmsgs = parsed.messages || [];
  if (omsgs.length !== nmsgs.length) {
    throw new Error(`message count changed: ${omsgs.length} -> ${nmsgs.length}`);
  }
  for (let mi = 0; mi < omsgs.length; mi++) {
    const oa = (omsgs[mi] && omsgs[mi].attachments) || [];
    const na = (nmsgs[mi] && nmsgs[mi].attachments) || [];
    if (oa.length !== na.length) {
      throw new Error(`attachment count changed in message ${mi}: ${oa.length} -> ${na.length}`);
    }
    for (let ai = 0; ai < oa.length; ai++) {
      const k = `${mi}/${ai}`;
      if (expected.has(k)) {
        if (na[ai].textData !== undefined) {
          throw new Error(`converted attachment ${k} still has textData`);
        }
        if (typeof na[ai].textPreview !== 'string') {
          throw new Error(`converted attachment ${k} has no textPreview`);
        }
        const want = cutWithoutSplittingPair(oa[ai].textData, PREVIEW_STORE_CHARS);
        if (na[ai].textPreview !== want) {
          throw new Error(`converted attachment ${k} preview is not the expected prefix`);
        }
        if (na[ai].ref !== oa[ai].ref) {
          throw new Error(`converted attachment ${k} lost or changed its ref`);
        }
      } else {
        // Untouched: must be deep-equal. Comparing serialized forms is the
        // cheapest way to catch an accidental key reorder or a dropped field.
        if (JSON.stringify(oa[ai]) !== JSON.stringify(na[ai])) {
          throw new Error(`attachment ${k} was NOT a candidate but changed`);
        }
      }
    }
  }
  return parsed;
}

async function main() {
  console.log(`NEXUS drop-inline-textData migration — ${WRITE ? 'APPLY (--write)' : 'DRY RUN'}`);
  console.log(`data dir: ${DATA_DIR}`);
  if (ONLY_BEING) console.log(`being filter: ${ONLY_BEING}`);
  console.log('');

  let beings;
  try {
    beings = (await fs.readdir(BEINGS_DIR, { withFileTypes: true }))
      .filter(d => d.isDirectory() || d.isSymbolicLink())
      .map(d => d.name);
  } catch (e) {
    // Name the three causes apart. A junction to another account's store
    // answers EPERM here, and "empty" would send the reader looking in the
    // wrong place entirely.
    console.error(`Cannot read ${BEINGS_DIR}: ${e.code || ''} ${e.message}`);
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      console.error('That is a permissions wall, not an empty folder — run this as the account that owns the store.');
    }
    process.exit(1);
  }
  if (ONLY_BEING) beings = beings.filter(b => b === ONLY_BEING);

  let files = 0, touched = 0, converted = 0, bytesSaved = 0, failures = 0;
  const allSkips = new Map();

  for (const being of beings) {
    const dir = path.join(BEINGS_DIR, being, 'logs');
    let names;
    try {
      names = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    } catch { continue; }

    for (const name of names) {
      const filePath = path.join(dir, name);
      files++;
      let plan;
      try {
        plan = await planFile(filePath);
      } catch (e) {
        failures++;
        console.error(`  ✗ ${being}/${name}\n      could not read/parse: ${e.message}`);
        continue;
      }
      for (const [k, v] of plan.skips) allSkips.set(k, (allSkips.get(k) || 0) + v);
      if (plan.candidates.length === 0) continue;

      const sizeBefore = Buffer.byteLength(plan.raw, 'utf-8');
      touched++;
      // NOT counted here. With --write a file can still be refused (a payload
      // that differs from the store), and counting candidates up front made
      // the summary claim 5 conversions in a run that performed 2 — while the
      // byte total, computed from what actually landed, said 3.9 KB. A report
      // whose own two numbers disagree is the only reason that was caught.
      if (!WRITE) {
        converted += plan.candidates.length;
        // By subtraction, not by slicing from the cut point: a safe cut can
        // land one char earlier, and the estimate should describe the bytes
        // this run would actually remove.
        const saving = plan.candidates.reduce((n, c) =>
          n + Buffer.byteLength(c.att.textData, 'utf-8')
            - Buffer.byteLength(cutWithoutSplittingPair(c.att.textData, PREVIEW_STORE_CHARS), 'utf-8'), 0);
        bytesSaved += saving;
        console.log(
          `  ${being}/${name}\n` +
          `      ${plan.candidates.length} attachment(s), ~${human(saving)} of ${human(sizeBefore)} ` +
          `(${((saving / sizeBefore) * 100).toFixed(1)}%)`
        );
        continue;
      }

      const tmpOut = `${filePath}.migrating-${process.pid}`;
      try {
        await verifyAgainstStore(plan.candidates);

        // Rewrite in place on the parsed object. Rebuilding each attachment
        // with the SAME key order, substituting textPreview where textData
        // was, keeps the diff readable and the header-first guarantee intact.
        for (const c of plan.candidates) {
          const att = plan.obj.messages[c.msgIndex].attachments[c.attIndex];
          const rebuilt = {};
          for (const [k, v] of Object.entries(att)) {
            if (k === 'textData') rebuilt.textPreview = cutWithoutSplittingPair(v, PREVIEW_STORE_CHARS);
            else rebuilt[k] = v;
          }
          plan.obj.messages[c.msgIndex].attachments[c.attIndex] = rebuilt;
        }
        plan.obj.updatedAt = Date.now();

        const outText = JSON.stringify(plan.obj, null, 2);
        validate(outText, JSON.parse(plan.raw), plan.candidates);
        await fs.writeFile(tmpOut, outText, 'utf-8');

        const preserveDir = path.join(PRESERVE_DIR, being);
        await fs.mkdir(preserveDir, { recursive: true });
        await fs.copyFile(filePath, path.join(preserveDir, name));

        await fs.rename(tmpOut, filePath);

        // Counted only now — after the swap. Both totals in the summary are
        // then derived from what reached disk, so they can be checked against
        // each other.
        converted += plan.candidates.length;
        const sizeAfter = Buffer.byteLength(outText, 'utf-8');
        bytesSaved += sizeBefore - sizeAfter;
        console.log(
          `  ✓ ${being}/${name}\n` +
          `      ${plan.candidates.length} attachment(s), ${human(sizeBefore)} -> ${human(sizeAfter)} ` +
          `(-${(((sizeBefore - sizeAfter) / sizeBefore) * 100).toFixed(1)}%)`
        );
      } catch (e) {
        failures++;
        try { await fs.unlink(tmpOut); } catch {}
        console.error(`  ✗ ${being}/${name}\n      FAILED: ${e.message}\n      original left untouched`);
      }
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`conversations scanned      : ${files}`);
  console.log(`with text to convert       : ${touched}`);
  console.log(`attachments converted      : ${converted}`);
  console.log(`bytes saved                : ${human(bytesSaved)}`);
  if (allSkips.size) {
    console.log('left alone                 :');
    for (const [k, v] of [...allSkips].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${v} × ${k}`);
    }
  }
  if (WRITE) {
    console.log(`originals preserved        : ${PRESERVE_DIR}`);
    if (failures) console.log(`FAILURES                   : ${failures} (originals untouched)`);
    console.log('');
    console.log('If a NEXUS tab is open, press Ctrl+Shift+R in it now.');
  } else {
    console.log('');
    console.log('This was a DRY RUN — nothing was written.');
    console.log('Re-run with --write to apply.');
  }
  if (failures) process.exitCode = 1;
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
