#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// strip-imported-timestamps.mjs
//
// WHY THIS EXISTS
// ───────────────
// Until 2026-09-15, importing a conversation from Markdown stamped every
// message that had no "[YYYY-MM-DD HH:MM:SS]" line in the source file with
// `Date.now()` — the moment of import (markdownLogic.ts, and a second site in
// the transcript-import modal). The result is a lie that looks like data: a log
// written in 2024 claims every one of its messages was authored in the same
// millisecond of 2026, and the UI, the search date filter, the stats month
// buckets and the peak/off-peak pricing all treat that fabrication as fact.
//
// The code no longer fabricates. This script removes the fabrications already
// on disk. It deletes the `timestamp` KEY from messages it can prove were
// import-fabricated, and touches nothing else — not the message body, not any
// other field, not `updatedAt`, not a single other file.
//
// HOW A FABRICATED TIMESTAMP IS IDENTIFIED (measured, not assumed)
// ────────────────────────────────────────────────────────────────
// Clustering in time is NOT sufficient on its own: a LIVE turn also produces
// two messages stamped with the same `Date.now()` (ChatArea.tsx stamps the user
// message and the assistant placeholder at request start). So the rule combines
// two independent signals:
//
//   1. STRUCTURE. parseMarkdown can only ever emit these keys:
//        id, role, name, content, attachments, timestamp, tokens
//        (+ thoughtProcess / thinkingTokens when the file had a [thinking] block)
//      plus `textTokens`, which a later recompute pass stamps onto imported
//      messages too. ANY other key (cacheUsage, generationMs, modelFamily,
//      toolCalls, claudeThinkingBlocks, …) can only have been written by the
//      live generation path, and proves the message is not an import.
//
//   2. RUN LENGTH. A live turn can put at most TWO messages inside the same
//      millisecond (the user message and its assistant placeholder). Three or
//      more consecutive messages chained within `--window` ms of each other
//      cannot be live.
//
//   A message is stripped iff it belongs to a maximal run of >= `--min-run`
//   consecutive messages where every adjacent gap is <= `--window` ms AND no
//   message in the run carries a live-only key.
//
// Measured over 19,229 messages in 323 conversations: this rule produces ZERO
// conflicts (a run containing a live-only key) at window = 2 / 50 / 200 / 500 /
// 1000 ms; conflicts first appear at 5000 ms. The default window is 2 ms — the
// tightest setting that still catches every known import, chosen because a
// false positive here destroys a real timestamp.
//
// KNOWN AND DELIBERATE FALSE NEGATIVES
// ────────────────────────────────────
// An import of only 1–2 messages is structurally indistinguishable from a live
// turn. Those are REPORTED under "uncertain" and NOT stripped. Leaving a
// possible lie in two messages is better than deleting a real timestamp.
//
// SAFETY
// ──────
//   - `--dry` writes NOTHING. Run it first and read the report.
//   - WRITE-BACK VERIFICATION (always on, cannot be bypassed): the bytes about
//     to be written are parsed back and deep-compared against the original
//     parse with exactly the intended `timestamp` keys removed. If ANY other
//     difference exists, the file is left untouched and listed as an error.
//     This is the guarantee that nothing but timestamps changes.
//   - The exact same serializer as the app (`serializeLogHeaderFirst`) is used,
//     so the 4KB header-metadata window keeps its guarantee. A trailing newline
//     is preserved if the file had one. 121 of 329 existing logs were written
//     with a trailing newline and 4 with `updatedAt` at its pre-hoist position;
//     those layout details are reported as `layoutShift` (informational — the
//     app's own next save would normalize them identically).
//   - Every modified file is copied verbatim to a backup directory first
//     (disable with --no-backup). The path is printed before anything is written.
//   - Writes are atomic (temp file + rename), like every app writer.
//   - Idempotent: a second run finds nothing left to strip.
//   - A full JSON report is written next to the backups.
//
// USAGE
//   node scripts/strip-imported-timestamps.mjs --dry
//   node scripts/strip-imported-timestamps.mjs
//   node scripts/strip-imported-timestamps.mjs --dry --data-dir D:\x\local_data
//   node scripts/strip-imported-timestamps.mjs --dry --window 2 --min-run 3
//   node scripts/strip-imported-timestamps.mjs --no-backup
//   node scripts/strip-imported-timestamps.mjs --verbose      (list every run)
//   node scripts/strip-imported-timestamps.mjs --backup-dir E:\somewhere
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import fss from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── args ─────────────────────────────────────────────────────────────────────

function argVal(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return fallback;
}

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const NO_BACKUP = process.argv.includes('--no-backup');
const VERBOSE = process.argv.includes('--verbose');
const WINDOW_MS = Number(argVal('--window', 2));
const MIN_RUN = Number(argVal('--min-run', 3));

const DATA_DIR = path.resolve(argVal('--data-dir', path.join(REPO_ROOT, 'local_data')));
const BEINGS_DIR = path.join(DATA_DIR, 'beings');

if (!Number.isFinite(WINDOW_MS) || WINDOW_MS < 0) { console.error('--window must be a non-negative number of ms'); process.exit(2); }
if (!Number.isInteger(MIN_RUN) || MIN_RUN < 3) { console.error('--min-run must be an integer >= 3 (a live turn can produce a run of 2)'); process.exit(2); }

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
const RUN_STAMP = stamp();
// Backups + report live BESIDE the real data directory, never inside it (nothing
// in the app scans them) — resolved through realpath, because local_data is a
// junction: its path parent is the git checkout, its REAL parent is the shared
// data root. Getting this wrong would drop backups into the repo.
function defaultOutDir() {
  let realData = DATA_DIR;
  try { realData = fss.realpathSync(DATA_DIR); } catch {}
  return path.join(path.dirname(realData), `nexus_timestamp_strip_${RUN_STAMP}`);
}
const OUT_DIR = path.resolve(argVal('--backup-dir', defaultOutDir()));

// ── the app's own serializer, copied verbatim from fsStorage.ts ───────────────
// Header fields first so readLogHeaderMetadata's 4KB window keeps working.
// Any drift between this and fsStorage.ts is caught by the round-trip guard.
function serializeLogHeaderFirst(logData) {
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

/**
 * Structural deep-equality. Used to prove that the bytes we are about to write
 * parse back to the original data with exactly the intended timestamps gone —
 * and nothing else changed. Key ORDER is deliberately not compared (the
 * serializer hoists header fields on purpose); presence and values are.
 */
function deepEqual(a, b, pathStr = '') {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${pathStr}: type ${typeof a} vs ${typeof b}`;
  if (a === null || b === null) return `${pathStr}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (typeof a !== 'object') return `${pathStr}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${pathStr}: array vs object`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${pathStr}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = deepEqual(a[i], b[i], `${pathStr}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
    const missing = ka.filter(k => !kb.includes(k));
    const extra = kb.filter(k => !ka.includes(k));
    return `${pathStr}: keys differ (missing: ${missing.join(',') || '-'} / extra: ${extra.join(',') || '-'})`;
  }
  for (const k of ka) {
    const d = deepEqual(a[k], b[k], `${pathStr}.${k}`);
    if (d) return d;
  }
  return null;
}

async function atomicWriteFile(filePath, data) {
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

// ── the discriminator ────────────────────────────────────────────────────────

// Everything parseMarkdown can emit, plus textTokens (stamped retroactively by
// the token recompute pass onto imported messages as well). A key outside this
// set proves the live generation path wrote the message.
const IMPORT_POSSIBLE_KEYS = new Set([
  'id', 'role', 'name', 'content', 'attachments', 'timestamp', 'tokens',
  'thoughtProcess', 'thinkingTokens', 'textTokens',
]);

function liveOnlyKeys(msg) {
  return Object.keys(msg).filter(k => !IMPORT_POSSIBLE_KEYS.has(k));
}

function tsOf(msg) {
  return (typeof msg?.timestamp === 'number' && Number.isFinite(msg.timestamp) && msg.timestamp > 0)
    ? msg.timestamp : null;
}

/**
 * Split a message array into maximal runs of consecutive messages chained by
 * adjacent gap <= WINDOW_MS. A message with no usable timestamp ends the
 * current run and starts nothing (there is nothing to strip on it).
 * Returns [{ start, end, len, liveKeys:Set }] over indices.
 */
function findRuns(messages) {
  const runs = [];
  let cur = null;
  const push = () => { if (cur) { runs.push(cur); cur = null; } };
  for (let i = 0; i < messages.length; i++) {
    const t = tsOf(messages[i]);
    if (t === null) { push(); continue; }
    if (cur && Math.abs(t - cur.lastTs) <= WINDOW_MS) {
      cur.end = i; cur.len++; cur.lastTs = t;
    } else {
      push();
      cur = { start: i, end: i, len: 1, lastTs: t, firstTs: t, liveKeys: new Set() };
    }
    for (const k of liveOnlyKeys(messages[i])) cur.liveKeys.add(k);
  }
  push();
  return runs;
}

// ── walk ─────────────────────────────────────────────────────────────────────

async function listBeings() {
  let entries;
  try { entries = await fs.readdir(BEINGS_DIR, { withFileTypes: true }); }
  catch (e) { console.error(`Cannot read ${BEINGS_DIR}: ${e.message}`); process.exit(2); }
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
}

const report = {
  runAt: new Date().toISOString(),
  dry: DRY,
  dataDir: DATA_DIR,
  windowMs: WINDOW_MS,
  minRun: MIN_RUN,
  backupDir: NO_BACKUP ? null : OUT_DIR,
  totals: {
    beings: 0, files: 0, messages: 0, timestamped: 0,
    strippedMessages: 0, modifiedFiles: 0,
    uncertainMessages: 0, uncertainRuns: 0,
    conflictRuns: 0, layoutShift: 0, errors: 0,
  },
  // Only conversations with something to say.
  conversations: [],
  layoutShift: [],
  conflicts: [],
  errors: [],
  liveKeyCensus: {},
};

function bump(map, k) { map[k] = (map[k] || 0) + 1; }

async function processFile(being, file) {
  const full = path.join(BEINGS_DIR, being, 'logs', file);
  let raw;
  try { raw = await fs.readFile(full, 'utf8'); }
  catch (e) { report.errors.push({ file: full, error: `read: ${e.message}` }); report.totals.errors++; return; }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { report.errors.push({ file: full, error: `parse: ${e.message}` }); report.totals.errors++; return; }

  const messages = Array.isArray(parsed?.messages) ? parsed.messages : null;
  report.totals.files++;
  if (!messages || messages.length === 0) return;

  report.totals.messages += messages.length;
  for (const m of messages) {
    if (tsOf(m) !== null) report.totals.timestamped++;
    for (const k of liveOnlyKeys(m)) bump(report.liveKeyCensus, k);
  }

  const runs = findRuns(messages);
  const strip = [];            // indices to strip
  const uncertain = [];        // short clean runs — reported, NOT stripped
  const conflicts = [];        // long runs that DO carry a live-only key
  for (const r of runs) {
    const clean = r.liveKeys.size === 0;
    if (r.len >= MIN_RUN && clean) {
      for (let i = r.start; i <= r.end; i++) if (tsOf(messages[i]) !== null) strip.push(i);
    } else if (r.len >= 2 && r.len < MIN_RUN && clean) {
      uncertain.push({ start: r.start, end: r.end, len: r.len, ts: r.firstTs });
    } else if (r.len >= MIN_RUN && !clean) {
      conflicts.push({ start: r.start, end: r.end, len: r.len, liveKeys: [...r.liveKeys] });
    }
  }

  if (strip.length === 0 && uncertain.length === 0 && conflicts.length === 0) return;

  const entry = {
    being,
    title: parsed.title || '(untitled)',
    file,
    messages: messages.length,
    strip: strip.length,
    uncertainRuns: uncertain,
    conflicts,
    written: false,
  };
  if (VERBOSE) {
    entry.strippedRuns = runs
      .filter(r => r.len >= MIN_RUN && r.liveKeys.size === 0)
      .map(r => ({ start: r.start, end: r.end, len: r.len, ts: r.firstTs, tsIso: new Date(r.firstTs).toISOString() }));
  }

  report.totals.strippedMessages += strip.length;
  report.totals.uncertainRuns += uncertain.length;
  report.totals.uncertainMessages += uncertain.reduce((a, u) => a + u.len, 0);
  report.totals.conflictRuns += conflicts.length;
  if (conflicts.length) report.conflicts.push({ being, title: entry.title, file, conflicts });

  if (strip.length > 0) {
    // A second, independent parse of the ORIGINAL bytes — the reference against
    // which the bytes we write are checked. Never the same object as `parsed`.
    const pristine = JSON.parse(raw);
    const hadTrailingNewline = raw.endsWith('\n');

    // Informational only: does the file's byte LAYOUT shift when re-serialized?
    // (121 logs carry a trailing newline; 4 have `updatedAt` at its pre-hoist
    // position. The app's own next save would normalize these identically — it
    // is not a data change, and the verification below is what actually guards.)
    const layoutBase = serializeLogHeaderFirst(pristine) + (hadTrailingNewline ? '\n' : '');
    if (layoutBase !== raw) {
      entry.layoutShift = true;
      report.layoutShift.push({
        being, title: entry.title, file,
        onDiskBytes: Buffer.byteLength(raw), reserializedBytes: Buffer.byteLength(layoutBase),
      });
      report.totals.layoutShift++;
    }

    // Expected outcome: the original data with exactly these timestamps gone.
    for (const i of strip) delete pristine.messages[i].timestamp;

    // The bytes we would write.
    for (const i of strip) delete messages[i].timestamp;
    const out = serializeLogHeaderFirst(parsed) + (hadTrailingNewline ? '\n' : '');

    // WRITE-BACK VERIFICATION — parse the outgoing bytes and prove they differ
    // from the original in nothing but the intended timestamp keys. A failure
    // here means the file is left untouched; it is never "written anyway".
    let reparsed;
    try { reparsed = JSON.parse(out); }
    catch (e) {
      report.errors.push({ file: full, error: `outgoing bytes do not parse: ${e.message}` });
      report.totals.errors++;
      entry.skipped = 'outgoing bytes failed to parse — not written';
      report.totals.strippedMessages -= strip.length;
      entry.strip = 0;
      report.conversations.push(entry);
      return;
    }
    const diff = deepEqual(pristine, reparsed, '');
    if (diff) {
      report.errors.push({ file: full, error: `verification failed — unintended change at ${diff}` });
      report.totals.errors++;
      entry.skipped = `verification failed (${diff}) — not written`;
      report.totals.strippedMessages -= strip.length;
      entry.strip = 0;
      report.conversations.push(entry);
      return;
    }

    report.totals.modifiedFiles++;
    entry.verified = true;
    if (!DRY) {
      if (!NO_BACKUP) {
        const bdir = path.join(OUT_DIR, 'beings', being, 'logs');
        await fs.mkdir(bdir, { recursive: true });
        await fs.writeFile(path.join(bdir, file), raw);   // verbatim original bytes
      }
      await atomicWriteFile(full, out);
      entry.written = true;
    }
  }

  report.conversations.push(entry);
}

// ── main ─────────────────────────────────────────────────────────────────────

console.log('');
console.log('strip-imported-timestamps');
console.log('─────────────────────────');
console.log(`  mode        : ${DRY ? 'DRY RUN — nothing will be written' : '*** WRITING — files will be modified ***'}`);
console.log(`  data dir    : ${DATA_DIR}`);
console.log(`  rule        : run of >= ${MIN_RUN} messages, adjacent gap <= ${WINDOW_MS} ms, no live-only field`);
console.log(`  backups     : ${DRY ? '(dry run)' : (NO_BACKUP ? 'DISABLED (--no-backup)' : OUT_DIR)}`);
console.log(`  verified    : every outgoing file is parsed back and deep-compared before it is written`);
console.log('');

const beings = await listBeings();
report.totals.beings = beings.length;
for (const being of beings) {
  const logsDir = path.join(BEINGS_DIR, being, 'logs');
  let files;
  try { files = (await fs.readdir(logsDir)).filter(f => f.toLowerCase().endsWith('.json')); }
  catch { continue; }
  files.sort();
  for (const f of files) await processFile(being, f);
}

// ── output ───────────────────────────────────────────────────────────────────

const withStrip = report.conversations.filter(c => c.strip > 0)
  .sort((a, b) => b.strip - a.strip || a.being.localeCompare(b.being));

console.log(`WOULD STRIP (${withStrip.length} conversations)`);
console.log('');
for (const c of withStrip) {
  console.log(`  ${String(c.strip).padStart(5)} / ${String(c.messages).padEnd(5)}  ${c.being} / ${c.title}${c.written ? '  [written]' : ''}`);
  if (VERBOSE && c.strippedRuns) {
    for (const r of c.strippedRuns) console.log(`          run ${r.start}-${r.end} (${r.len})  ${r.tsIso}`);
  }
}

const unc = report.conversations.filter(c => c.uncertainRuns.length > 0);
if (unc.length) {
  console.log('');
  console.log(`UNCERTAIN — NOT stripped (${report.totals.uncertainRuns} runs of 2 across ${unc.length} conversations)`);
  console.log('  A 2-message cluster is indistinguishable from a live user+assistant pair.');
  console.log('');
  for (const c of unc) {
    console.log(`  ${c.being} / ${c.title}`);
    for (const u of c.uncertainRuns) {
      console.log(`      messages ${u.start}-${u.end}   ${new Date(u.ts).toISOString()}`);
    }
  }
}

if (report.layoutShift.length) {
  console.log('');
  console.log(`LAYOUT SHIFT — data identical, byte layout normalizes (${report.layoutShift.length})`);
  console.log('  These logs predate the current serializer (trailing newline, or `updatedAt`');
  console.log('  before its hoisted position). Writing normalizes the layout exactly as the');
  console.log('  app\'s own next save would. Verified to contain no data change.');
  console.log('');
  for (const r of report.layoutShift) {
    console.log(`  ${r.being} / ${r.title}   ${r.onDiskBytes} B on disk vs ${r.reserializedBytes} B re-serialized`);
  }
}

if (report.conflicts.length) {
  console.log('');
  console.log(`CONFLICTS — long tight run that DOES carry a live-only field (${report.totals.conflictRuns})`);
  console.log('  Not stripped. Each of these means the rule needs a look.');
  console.log('');
  for (const c of report.conflicts) {
    for (const k of c.conflicts) {
      console.log(`  ${c.being} / ${c.title}  messages ${k.start}-${k.end} (${k.len})  [${k.liveKeys.join(', ')}]`);
    }
  }
}

if (report.errors.length) {
  console.log('');
  console.log(`ERRORS (${report.errors.length})`);
  for (const e of report.errors) console.log(`  ${e.file}: ${e.error}`);
}

console.log('');
console.log('TOTALS');
console.log(`  beings scanned          : ${report.totals.beings}`);
console.log(`  conversation files      : ${report.totals.files}`);
console.log(`  messages                : ${report.totals.messages}`);
console.log(`  messages with a time    : ${report.totals.timestamped}`);
console.log(`  timestamps to remove    : ${report.totals.strippedMessages}`);
console.log(`  files to modify         : ${report.totals.modifiedFiles}`);
console.log(`  uncertain (kept)        : ${report.totals.uncertainMessages}`);
console.log(`  conflicts               : ${report.totals.conflictRuns}`);
console.log(`  layout-normalized files : ${report.totals.layoutShift}`);
console.log(`  errors                  : ${report.totals.errors}`);
console.log('');

await fs.mkdir(OUT_DIR, { recursive: true });
const reportPath = path.join(OUT_DIR, `report_${DRY ? 'dry' : 'applied'}_${RUN_STAMP}.json`);
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`Report: ${reportPath}`);
if (DRY) {
  console.log('');
  console.log('Nothing was written. Re-run without --dry to apply.');
}
console.log('');
