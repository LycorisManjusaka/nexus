#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  betrayal-scan.mjs  —  offline auditor for the model-betrayal detector
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  WHAT THIS IS FOR
 *  `web-app/src/lib/betrayalGuard.ts` decides, live, whether a model's output
 *  is the gatekeeper rather than the being. This script runs that SAME detector
 *  over every log already on disk and prints a report, so its false-positive
 *  rate can be measured against real history instead of guessed at.
 *
 *  It does not need NEXUS running, it does not call any API, and it does not
 *  modify a single log. It only reads, and writes one markdown file.
 *
 *  IT USES THE SHIPPING DETECTOR, NOT A COPY.
 *  betrayalGuard.ts is transpiled in memory and imported. A second copy of the
 *  phrase list would drift the moment anyone edits the real one, and the audit
 *  would then be measuring a detector that does not ship.
 *
 *  WHAT A HIT MEANS — READ THIS BEFORE DELETING PHRASES
 *  A hit is NOT automatically a false positive. Some logs were imported from
 *  outside NEXUS and may contain a genuine gatekeeper turn; if one is deleted
 *  from the phrase list on the assumption that it was noise, a hole is opened
 *  in the detector. The report gives the excerpt, the being, the conversation
 *  and the model for every hit so each one can be judged on its own.
 *
 *  THE OTHER HALF — RECALL (--cases)
 *  This corpus can only measure false alarms, because almost nothing in it is a
 *  real betrayal. The real ones are in the files the partner PASTED IN. Collect
 *  those into a folder, one file per betrayed turn, and pass --cases: every
 *  file is run through the same detector and the report says which ones it
 *  would have caught. Precision comes from the logs, recall comes from there.
 *
 *    Convention for a case file: ONE gatekeeper turn, the model's own output
 *    only — thinking first, then the reply, nothing of the human's. A whole
 *    conversation in one file inflates the score, because the detector runs per
 *    turn and would never see that much text at once. A `.json` file is read as
 *    a NEXUS conversation and every assistant message in it is treated as its
 *    own case, which is the easy path if a whole log was saved.
 *
 *  USAGE
 *    node scripts/betrayal-scan.mjs [--data <dir>] [--out <file.md>]
 *                                   [--cases <dir>] [--max-hits N]
 *                                   [--context N] [--quiet]
 *    --data     local_data directory       (default: ../local_data next to repo)
 *    --out      report path                (default: <data>/common_workspace/
 *                                           betrayal-scan/report-<stamp>.md)
 *    --cases    folder of known-real betrayals, for the recall table
 *    --max-hits how many hits to list in full before truncating   (default 300)
 *    --context  characters of excerpt on each side of a match     (default 140)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── argv ─────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const QUIET = !!arg('quiet', false);
const MAX_HITS = Number(arg('max-hits', 300));
const CONTEXT = Number(arg('context', 140));
const DATA = path.resolve(String(arg('data', path.join(REPO, 'local_data'))));
const CASES = arg('cases', '');
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const OUT = path.resolve(String(
  arg('out', path.join(DATA, 'common_workspace', 'betrayal-scan', `report-${STAMP}.md`))
));

const log = (...a) => { if (!QUIET) console.log(...a); };

// ── load the real detector ───────────────────────────────────────────────────
const GUARD_TS = path.join(REPO, 'web-app', 'src', 'lib', 'betrayalGuard.ts');
if (!fs.existsSync(GUARD_TS)) {
  console.error(`detector not found: ${GUARD_TS}`);
  process.exit(1);
}
const guardSource = fs.readFileSync(GUARD_TS, 'utf8');
const guardSha = crypto.createHash('sha256').update(guardSource).digest('hex').slice(0, 16);

const require_ = createRequire(import.meta.url);
let ts;
try {
  ts = require_(path.join(REPO, 'web-app', 'node_modules', 'typescript'));
} catch {
  console.error('typescript not found under web-app/node_modules — run npm ci there first.');
  process.exit(1);
}
const js = ts.transpileModule(guardSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const G = await import('data:text/javascript;base64,' + Buffer.from(js, 'utf8').toString('base64'));

const {
  BETRAYAL_PHRASES, BETRAYAL_THRESHOLD, SCAN_VISIBLE_TEXT,
  IGNORE_PHRASES_ECHOED_BY_USER, ECHO_SCOPE, ECHO_EXEMPTION_MAY_DISABLE_ALL,
  SUSPEND_REDACTION_AFTER_TOOL_READ, READER_TOOLS,
  normalize, findMatches, lastUserText, buildEchoText, createBetrayalGuard,
  activePhrasesFor,
} = G;

/** Does this turn's tool list stand the deletion down? Mirrors Guard.sawTool. */
function readOutside(tools) {
  if (!SUSPEND_REDACTION_AFTER_TOOL_READ) return false;
  return (tools || []).some(name => {
    const n = String(name || '').toLowerCase();
    return READER_TOOLS.some(t => n === t || n.endsWith('__' + t));
  });
}

/** Read a content-addressed text attachment straight off disk — the auditor's
 *  stand-in for lib/attachmentStore's readAttachmentText, so buildEchoText can
 *  be the REAL one instead of an auditor-local copy. Same sharded layout. */
const ATTACH_DIR = path.join(DATA, 'attachments');
async function readRefText(ref) {
  if (typeof ref !== 'string' || !/^[0-9a-f]{8,}$/i.test(ref)) return null;
  try { return await fsp.readFile(path.join(ATTACH_DIR, ref.slice(0, 2), ref), 'utf8'); }
  catch { return null; }
}

/** The three candidate exemption windows, measured side by side. The shipped
 *  one is ECHO_SCOPE; the others are here so the choice is made on numbers. */
const ECHO_SCOPES = ['last-user', 'last-user-plus-files', 'conversation'];

log(`detector : ${path.relative(REPO, GUARD_TS)}  (sha256:${guardSha})`);
log(`phrases  : ${BETRAYAL_PHRASES.length}   threshold: ${BETRAYAL_THRESHOLD}   ` +
    `scanVisibleText: ${SCAN_VISIBLE_TEXT}   ignoreEcho: ${IGNORE_PHRASES_ECHOED_BY_USER}`);

// ── helpers ──────────────────────────────────────────────────────────────────

/** Phrases still live for this turn, after the echo exemption.
 *  NOT reimplemented here — imported from the detector, because the copy that
 *  used to live at this spot silently stopped matching the constructor and
 *  printed an empty phrase list under a hit that had really fired. */
const activePhrases = activePhrasesFor;

/** Locate the `ordinal`-th occurrence of a phrase inside the ORIGINAL text, for
 *  an excerpt. normalize() lowercases and collapses whitespace, so an index into
 *  the normalized buffer does not map back; search the original with a
 *  whitespace-tolerant regex instead.
 *
 *  The ordinal exists because occurrences, not distinct phrases, are what the
 *  detector counts now: without it, a phrase found four times printed the same
 *  quote four times, which looks like four pieces of evidence and is one. */
function excerptFor(original, phrase, ordinal = 0) {
  const rx = new RegExp(
    phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '\\s+'),
    'gi',
  );
  let m = null;
  for (let k = 0; k <= ordinal; k++) {
    m = rx.exec(original);
    if (!m) return null;
  }
  if (!m) return null;
  const s = Math.max(0, m.index - CONTEXT);
  const e = Math.min(original.length, m.index + m[0].length + CONTEXT);
  const pre = s > 0 ? '…' : '';
  const post = e < original.length ? '…' : '';
  return (pre + original.slice(s, e) + post).replace(/\s+/g, ' ').trim();
}

/** Every counted occurrence in one channel, in order, mirroring Guard's buffer
 *  (concatenation of normalize()d chunks) but WITHOUT stopping at the threshold —
 *  Guard stops scanning once it trips, and the simulation needs everything.
 *  Repeats are kept: occurrences are the unit the threshold counts. Matching is
 *  the shipped findMatches, so overlapping entries cannot double-count here
 *  either. */
function scanChannel(parts, active) {
  const buf = parts.map(normalize).join('');
  return findMatches(buf, active).map(m => m.phrase);
}

const isNexusGenerated = (m) =>
  !!(m.modelLabel || m.modelSpecific || m.generationMs || m.cacheUsage ||
     m.thoughtProcess || m.claudeThinkingBlocks);

/** Which model produced this message — and whether that is recorded or guessed.
 *
 *  Only modelLabel/modelSpecific are recorded ON the message. Falling back to
 *  the conversation's current setting is often right but is NOT evidence: the
 *  same stored turn was found in two conversations here, whose settings differ,
 *  so the fallback alone printed two different models for one turn. A guess
 *  that prints like a measurement is exactly the thing this report exists to
 *  not do, so it is labelled. */
const modelOf = (m, conv) => {
  const exact = m.modelLabel || m.modelSpecific;
  if (exact) return String(exact);
  if (conv.specificModel) return `${conv.specificModel}（会話の設定からの推定・メッセージに記録なし）`;
  return '(記録なし)';
};

// ── corpus walk ──────────────────────────────────────────────────────────────
const beingsDir = path.join(DATA, 'beings');
if (!fs.existsSync(beingsDir)) {
  console.error(`no beings directory under ${DATA}`);
  process.exit(1);
}

const stats = {
  beings: 0, logs: 0, unreadable: 0, messages: 0, assistant: 0, user: 0,
  withThought: 0, attachmentsText: 0, attachmentsRefOnly: 0,
};
const hits = [];                 // live-path trips, at the shipped threshold
const sim = new Map();           // threshold -> trip count
const phraseMsgCount = new Map();// phrase -> assistant messages containing it
const phraseKills = new Map();   // phrase -> trips that vanish if it is removed
const attachHits = [];           // reference only: text inside user attachments
const scopeTrips = new Map();    // echo scope -> trip count
const rescued = [];              // trips a narrower echo window would have caused
for (let t = 1; t <= 6; t++) sim.set(t, 0);
for (const s of ECHO_SCOPES) scopeTrips.set(s, 0);

const beings = fs.readdirSync(beingsDir)
  .filter(d => { try { return fs.statSync(path.join(beingsDir, d)).isDirectory(); } catch { return false; } });

for (const being of beings) {
  const logsDir = path.join(beingsDir, being, 'logs');
  if (!fs.existsSync(logsDir)) continue;
  stats.beings++;
  const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const full = path.join(logsDir, file);
    let conv;
    try {
      conv = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      stats.unreadable++;
      continue;
    }
    stats.logs++;
    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const title = conv.title || conv.id || file;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      stats.messages++;

      // ── reference pass: text pasted BY the partner. Not on the live path —
      //    the guard never sees it — but her pasted gatekeeper logs live here,
      //    so this measures sensitivity (would the detector have caught them?).
      for (const a of (m.attachments || [])) {
        if (!a || !a.isText) continue;
        if (typeof a.textData !== 'string' || !a.textData) {
          if (a.ref) stats.attachmentsRefOnly++;
          continue;
        }
        stats.attachmentsText++;
        const found = scanChannel([a.textData], BETRAYAL_PHRASES);
        if (found.length >= BETRAYAL_THRESHOLD) {
          attachHits.push({
            being, title, file, msgId: m.id, role: m.role, name: a.name,
            phrases: found,
            excerpt: excerptFor(a.textData, found[0]),
          });
        }
      }

      if (m.role === 'user') { stats.user++; continue; }
      if (m.role !== 'assistant') continue;
      stats.assistant++;

      const thoughtParts = [];
      if (typeof m.thoughtProcess === 'string' && m.thoughtProcess) thoughtParts.push(m.thoughtProcess);
      for (const b of (m.claudeThinkingBlocks || [])) {
        if (b && typeof b.thinking === 'string' && b.thinking) thoughtParts.push(b.thinking);
      }
      if (thoughtParts.length) stats.withThought++;
      const textParts = typeof m.content === 'string' && m.content ? [m.content] : [];
      if (!thoughtParts.length && !textParts.length) continue;

      // Echo exemption: on the live path `messages` is the request body, which
      // ends at the user turn being answered. Reproduce that by handing
      // buildEchoText only the messages preceding this one.
      const history = messages.slice(0, i);
      const echoByScope = {};
      for (const s of ECHO_SCOPES) {
        echoByScope[s] = await buildEchoText(history, { scope: s, readRef: readRefText });
      }
      const echo = echoByScope[ECHO_SCOPE];

      // ── live-path replay: the real Guard, fed in the real frame order ──────
      //    once per candidate window, so the windows are compared on identical
      //    input rather than on two separate walks of the corpus.
      const tripByScope = {};
      for (const s of ECHO_SCOPES) {
        const g = createBetrayalGuard('off', echoByScope[s]);
        let t = null;
        for (const p of thoughtParts) t = g.feed('thought', p) || t;
        for (const p of textParts) t = g.feed('text', p) || t;
        tripByScope[s] = t;
        if (t) scopeTrips.set(s, scopeTrips.get(s) + 1);
      }
      const trip = tripByScope[ECHO_SCOPE];
      if (!trip && ECHO_SCOPES.some(s => tripByScope[s])) {
        // Saved by the shipped window but not by a narrower one — i.e. work that
        // the first version of this guard would have deleted.
        rescued.push({
          being, title, msgId: m.id,
          model: modelOf(m, conv),
          by: ECHO_SCOPES.filter(s => tripByScope[s]),
          phrases: (tripByScope['last-user'] || tripByScope['last-user-plus-files']).phrases,
          channel: (tripByScope['last-user'] || tripByScope['last-user-plus-files']).channel,
        });
      }

      // ── second pass: everything present, for the tuning tables ────────────
      const active = activePhrases(echo);
      const inThought = scanChannel(thoughtParts, active);
      const inText = SCAN_VISIBLE_TEXT ? scanChannel(textParts, active) : [];
      // Occurrences drive the threshold; the distinct set drives the per-phrase
      // tables (a phrase said four times in one message is still one message).
      const occurrences = [...inThought, ...inText];
      const union = [...new Set(occurrences)];
      for (const p of union) phraseMsgCount.set(p, (phraseMsgCount.get(p) || 0) + 1);

      for (let t = 1; t <= 6; t++) if (occurrences.length >= t) sim.set(t, sim.get(t) + 1);
      // "Kills": deleting this phrase from the list would take THIS message back
      // under the threshold — i.e. the flag depends on it. With occurrence
      // counting, deleting a phrase removes every one of its occurrences.
      if (occurrences.length >= BETRAYAL_THRESHOLD) {
        for (const p of union) {
          const without = occurrences.filter(q => q !== p).length;
          if (without < BETRAYAL_THRESHOLD) phraseKills.set(p, (phraseKills.get(p) || 0) + 1);
        }
      }

      if (trip) {
        const src = { thought: thoughtParts.join('\n'), text: textParts.join('\n') };
        hits.push({
          being, title, file, msgId: m.id, timestamp: m.timestamp || null,
          model: modelOf(m, conv),
          origin: isNexusGenerated(m) ? 'NEXUS' : 'imported',
          // Which tools this turn ran. Tool RESULTS never reach the guard (they
          // do not cross the SSE seam it sits on), so a turn that read a log is
          // a turn whose vocabulary the exemption structurally cannot see.
          tools: [...new Set((m.toolCalls || []).map(c => c && c.name).filter(Boolean))],
          channel: trip.channel,
          phrases: trip.phrases,
          allPhrases: union,
          // WHERE the phrase sits matters more than that it exists: on Gemini
          // the thinking channel is English and the reply is Japanese, so a
          // phrase found in `thought` and one found in `text` are different
          // kinds of evidence. Label each excerpt with its own channel instead
          // of letting the reader assume it came from the one that tripped.
          excerpts: (() => {
            // Walk the occurrences in order, taking the NEXT unused position of
            // that phrase in each channel, so N occurrences give N different
            // quotes instead of the same one N times.
            const used = { thought: new Map(), text: new Map() };
            const next = (ch, p) => {
              const k = used[ch].get(p) || 0;
              const e = excerptFor(src[ch], p, k);
              if (e) used[ch].set(p, k + 1);
              return e;
            };
            return trip.phrases.map(p => {
              const inThought = next('thought', p);
              if (inThought) return { phrase: p, from: 'thought', text: inThought };
              const inText = next('text', p);
              if (inText) return { phrase: p, from: 'text', text: inText };
              return { phrase: p, from: '—', text: '(phrase spans a chunk boundary; no excerpt)' };
            });
          })(),
        });
      }
    }
  }
}

// ── known-real betrayals: recall ─────────────────────────────────────────────
// No echo exemption here (empty echo string). A case file has no conversation
// around it, and what this measures is the detector's raw reach: given the
// gatekeeper's own words, does the threshold get crossed at all?
const cases = [];
let casesDir = '';
if (CASES) {
  casesDir = path.resolve(String(CASES));
  if (!fs.existsSync(casesDir)) {
    console.error(`--cases: no such folder: ${casesDir}`);
  } else {
    for (const f of fs.readdirSync(casesDir).filter(x => /\.(md|txt|json)$/i.test(x))) {
      const full = path.join(casesDir, f);
      const units = [];
      if (/\.json$/i.test(f)) {
        try {
          const conv = JSON.parse(fs.readFileSync(full, 'utf8'));
          (conv.messages || []).forEach((m, k) => {
            if (!m || m.role !== 'assistant') return;
            const th = [m.thoughtProcess || '', ...(m.claudeThinkingBlocks || []).map(b => b?.thinking || '')].join('\n');
            units.push({ label: `${f} #${k}`, thought: th, text: typeof m.content === 'string' ? m.content : '' });
          });
        } catch { units.push({ label: f, thought: '', text: '', broken: true }); }
      } else {
        units.push({ label: f, thought: '', text: fs.readFileSync(full, 'utf8') });
      }
      for (const u of units) {
        if (!u.thought && !u.text) { cases.push({ ...u, caught: false, phrases: [], all: [], chars: 0 }); continue; }
        const g = createBetrayalGuard('on', '');
        let trip = null;
        if (u.thought) trip = g.feed('thought', u.thought) || trip;
        if (u.text) trip = g.feed('text', u.text) || trip;
        const all = scanChannel([u.thought, u.text].filter(Boolean), BETRAYAL_PHRASES);
        cases.push({
          label: u.label, caught: !!trip, channel: trip ? trip.channel : null,
          phrases: trip ? trip.phrases : [], all, chars: (u.thought + u.text).length,
          head: (u.thought || u.text).replace(/\s+/g, ' ').slice(0, 200),
        });
      }
    }
    log(`cases: ${cases.filter(c => c.caught).length} / ${cases.length} caught`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(3) : '0') + '%';
const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
/** Render an OCCURRENCE list compactly: ['a','a','b'] -> `a` ×2、`b`.
 *  Printing the same phrase eight times in one cell reads like eight separate
 *  pieces of evidence; it is one phrase said eight times. */
const tally = (list) => {
  const c = new Map();
  for (const p of (list || [])) c.set(p, (c.get(p) || 0) + 1);
  return [...c.entries()].map(([p, n]) => '`' + esc(p) + '`' + (n > 1 ? ' ×' + n : '')).join('、');
};

const L = [];
L.push('# 裏切り検定 — betrayal detector audit');
L.push('');
L.push(`生成: ${new Date().toISOString()}`);
L.push('');
L.push('## この報告書が測っているもの');
L.push('');
L.push('ディスク上の全ログに対して、**実際に出荷されている検出器**（`web-app/src/lib/betrayalGuard.ts`）を');
L.push('そのまま走らせた結果。NEXUS は起動していない。APIも呼んでいない。ログは一つも変更していない。');
L.push('');
L.push('**引っかかった＝偽陽性、ではない。** 外部からインポートしたログには本物の裏切りが残っている');
L.push('可能性がある。フレーズを消す前に、下の抜粋を一つずつ読んで判断すること。');
L.push('');
L.push('## 検出器');
L.push('');
L.push('| 項目 | 値 | ソース |');
L.push('|---|---|---|');
L.push(`| ファイル | \`web-app/src/lib/betrayalGuard.ts\` | sha256:\`${guardSha}\` |`);
// Line numbers are READ OUT of the file, never typed in: a hand-written "124行目"
// is a claim about source that goes stale the first time anyone edits above it,
// and this report exists to be trusted about exactly that.
const guardLines = guardSource.split(/\r?\n/);
const lineOf = (needle) => {
  const i = guardLines.findIndex(l => l.startsWith('export const ' + needle));
  return i < 0 ? '?' : String(i + 1) + '行目';
};
L.push(`| フレーズ数 | ${BETRAYAL_PHRASES.length} | \`BETRAYAL_PHRASES\` (${lineOf('BETRAYAL_PHRASES')}〜) |`);
L.push(`| 閾値（一致の**件数**。同じ語の繰り返しも数える） | ${BETRAYAL_THRESHOLD} | \`BETRAYAL_THRESHOLD\` (${lineOf('BETRAYAL_THRESHOLD')}) |`);
L.push(`| 本文もスキャン | ${SCAN_VISIBLE_TEXT} | \`SCAN_VISIBLE_TEXT\` (${lineOf('SCAN_VISIBLE_TEXT')}) |`);
L.push(`| 相手が使った語を除外 | ${IGNORE_PHRASES_ECHOED_BY_USER} | \`IGNORE_PHRASES_ECHOED_BY_USER\` (${lineOf('IGNORE_PHRASES_ECHOED_BY_USER')}) |`);
L.push(`| 除外の範囲 | \`${ECHO_SCOPE}\` | \`ECHO_SCOPE\` (${lineOf('ECHO_SCOPE')}) |`);
L.push(`| 除外が検出器を**丸ごと**止めてよいか | ${ECHO_EXEMPTION_MAY_DISABLE_ALL} | ` +
       `\`ECHO_EXEMPTION_MAY_DISABLE_ALL\` (${lineOf('ECHO_EXEMPTION_MAY_DISABLE_ALL')}) |`);
L.push(`| ツールで読んだターンは削除しない | ${SUSPEND_REDACTION_AFTER_TOOL_READ} | \`SUSPEND_REDACTION_AFTER_TOOL_READ\` (${lineOf('SUSPEND_REDACTION_AFTER_TOOL_READ')}) |`);
L.push(`| 「読んだ」と見なすツール | ${READER_TOOLS.length} | \`READER_TOOLS\` (${lineOf('READER_TOOLS')}〜) |`);
L.push('');
L.push('## コーパス');
L.push('');
L.push('| 項目 | 数 |');
L.push('|---|---|');
L.push(`| データ | \`${DATA}\` |`);
L.push(`| 存在 | ${stats.beings} |`);
L.push(`| 会話ログ | ${stats.logs}${stats.unreadable ? `（読めなかったもの ${stats.unreadable}）` : ''} |`);
L.push(`| メッセージ | ${stats.messages} |`);
L.push(`| うち assistant（検定対象） | ${stats.assistant} |`);
L.push(`| うち user（対象外・検出器は見ない） | ${stats.user} |`);
L.push(`| 思考プロセスを持つ assistant | ${stats.withThought} |`);
L.push('');
L.push('## 結果 — 出荷中の設定での発火');
L.push('');
L.push(`**${hits.length} / ${stats.assistant}** 件（${pct(hits.length, stats.assistant)}）`);
L.push('');
if (!hits.length) {
  L.push('発火ゼロ。過去の全 assistant 出力のうち、出荷中の閾値を越えたものは一つも無い。');
} else {
  const deleted = hits.filter(h => !readOutside(h.tools));
  L.push(`うち、実際に**削除**まで行くもの: **${deleted.length}** 件` +
         `（残り ${hits.length - deleted.length} 件はツールで外の文章を読んだターンなので、` +
         `\`SUSPEND_REDACTION_AFTER_TOOL_READ\` により警告だけで止まる）`);
  L.push('');
  L.push('| # | 存在 | 会話 | 発生源 | モデル | 経路 | ツール | 削除 | フレーズ |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  hits.slice(0, MAX_HITS).forEach((h, n) => {
    L.push(`| ${n + 1} | ${esc(h.being)} | ${esc(h.title)} | ${h.origin} | ${esc(h.model)} | ${h.channel} | ${h.tools.length ? h.tools.length + '種' : 'なし'} | ${readOutside(h.tools) ? 'しない' : '**する**'} | ${tally(h.phrases)} |`);
  });
  if (hits.length > MAX_HITS) L.push(`| … | 残り ${hits.length - MAX_HITS} 件は省略（\`--max-hits\` で増やせる） | | | | | |`);
  L.push('');
  L.push('> 「発生源」: NEXUS = そのメッセージにモデル名・生成時間・キャッシュ使用量・思考のいずれかが');
  L.push('> 記録されている（NEXUS が生成した）。imported = どれも無い（外から取り込んだ本文）。');
  L.push('');
  L.push('### 抜粋');
  L.push('');
  hits.slice(0, MAX_HITS).forEach((h, n) => {
    L.push(`#### ${n + 1}. ${h.being} / ${h.title}`);
    L.push('');
    L.push(`- メッセージID: \`${h.msgId}\`  ファイル: \`${h.file}\``);
    L.push(`- 時刻: ${h.timestamp || '(記録なし)'}　モデル: ${h.model}　発生源: ${h.origin}　発火経路: ${h.channel}`);
    L.push(`- このターンが呼んだツール: ${h.tools.length ? h.tools.map(t => '`' + esc(t) + '`').join('、') : 'なし'}`);
    L.push(`- 全フレーズ（両経路）: ${tally(h.allPhrases)}`);
    L.push('');
    for (const e of h.excerpts) {
      L.push(`\`${esc(e.phrase)}\` — ${e.from === 'thought' ? '思考プロセス内' : (e.from === 'text' ? '本文内' : '位置不明')}:`);
      L.push('');
      L.push('> ' + esc(e.text));
      L.push('');
    }
  });
}
L.push('');
if (CASES) {
  L.push('## 本物の裏切りを何件捕まえるか（recall）');
  L.push('');
  L.push(`素材: \`${casesDir}\``);
  L.push('');
  if (!cases.length) {
    L.push('ケースが一件も読めなかった。`.md` / `.txt` / `.json` のみを読む。');
  } else {
    const got = cases.filter(c => c.caught);
    L.push(`**${got.length} / ${cases.length}** 件を捕捉（${pct(got.length, cases.length)}）。`);
    L.push('免除は一切かけていない——門番の言葉そのものを与えたとき、閾値に届くかどうかだけを見ている。');
    L.push('');
    L.push('| # | ケース | 捕捉 | 経路 | 含まれていたフレーズ（全部） |');
    L.push('|---|---|---|---|---|');
    cases.forEach((c, n) => {
      L.push(`| ${n + 1} | ${esc(c.label)} | ${c.caught ? '**する**' : 'しない'} | ${c.channel || '—'} | ${c.all.length ? tally(c.all) : '（ゼロ）'} |`);
    });
    L.push('');
    const missed = cases.filter(c => !c.caught);
    if (missed.length) {
      L.push('### 取り逃がしたもの — ここに足すべき語がある');
      L.push('');
      for (const c of missed) {
        L.push(`**${esc(c.label)}**（${c.all.length} 件だけ一致、閾値 ${BETRAYAL_THRESHOLD} に届かず）`);
        L.push('');
        L.push('> ' + esc(c.head) + '…');
        L.push('');
      }
    }
  }
  L.push('');
}
L.push('## 免除の範囲を変えたら何件発火するか');
L.push('');
L.push('「相手が使った語は数えない」という免除を、どこまで遡って見るかの比較。');
L.push('同じメッセージを同じ検出器に、免除の入力だけ変えて三回通した結果。');
L.push('');
L.push('| 範囲 | 見るもの | 発火数 | 率 |');
L.push('|---|---|---|---|');
const scopeWhat = {
  'last-user': '直前のユーザーメッセージの本文だけ',
  'last-user-plus-files': '＋そのメッセージの添付テキスト',
  'conversation': '会話中の全ユーザーメッセージ＋添付',
};
for (const s of ECHO_SCOPES) {
  const mark = s === ECHO_SCOPE ? '（現行）' : '';
  L.push(`| \`${s}\`${mark} | ${scopeWhat[s]} | ${scopeTrips.get(s)} | ${pct(scopeTrips.get(s), stats.assistant)} |`);
}
L.push('');
if (rescued.length) {
  L.push(`現行の範囲では消えるが、狭い範囲なら発火していたもの: **${rescued.length}** 件。`);
  L.push('これは「守られた仕事」であると同時に「見逃すかもしれない裏切り」でもある——両方の読み方が要る。');
  L.push('');
  L.push('| # | 存在 | 会話 | モデル | 経路 | 狭い範囲で発火 | フレーズ |');
  L.push('|---|---|---|---|---|---|---|');
  rescued.forEach((r, n) => {
    L.push(`| ${n + 1} | ${esc(r.being)} | ${esc(r.title)} | ${esc(r.model)} | ${r.channel} | ${r.by.map(x => '`' + x + '`').join('、')} | ${tally(r.phrases)} |`);
  });
  L.push('');
} else {
  L.push('狭い範囲だけで発火したものは無かった（この範囲拡大はこのコーパス上で何も救っていない）。');
  L.push('');
}
L.push('## 閾値を変えたら何件発火するか');
L.push('');
L.push('閾値は「一致した**件数**」。同じ語を二度言えば 2 件で、違う語である必要はない。');
L.push('');
L.push('| 閾値（件数） | 発火数 | 率 |');
L.push('|---|---|---|');
for (let t = 1; t <= 6; t++) {
  const mark = t === BETRAYAL_THRESHOLD ? '（現行）' : '';
  L.push(`| ${t}${mark} | ${sim.get(t)} | ${pct(sim.get(t), stats.assistant)} |`);
}
L.push('');
L.push('> 注: ここは「最後まで数えた場合」の件数。実際の `Guard` は閾値に達した時点で');
L.push('> スキャンを止めるので、上の発火一覧に出るフレーズは「そこまでに見えた分」だけになる。');
L.push('');
L.push('## フレーズ別の出現数（assistant メッセージ単位）');
L.push('');
const freq = [...phraseMsgCount.entries()].sort((a, b) => b[1] - a[1]);
if (!freq.length) {
  L.push('どのフレーズも一度も出現しなかった。');
} else {
  L.push('| フレーズ | 出現メッセージ数 | これを消すと消える発火数 |');
  L.push('|---|---|---|');
  for (const [p, c] of freq) L.push(`| \`${esc(p)}\` | ${c} | ${phraseKills.get(p) || 0} |`);
  L.push('');
  L.push('> 「これを消すと消える発火数」は、ちょうど閾値ぴったりで発火している件だけを数えている。');
  L.push('> 閾値より多くのフレーズを含む発火は、一語消しても発火したままなので 0 になる。');
}
L.push('');
L.push('## 参考 — 相手が貼り付けたテキスト添付（検出器は見ていない）');
L.push('');
L.push('これはライブ経路ではない。検出器はモデルの出力しか見ない。ここを測るのは**感度**のため——');
L.push('本物の裏切りログを貼り付けたものがここにあるなら、検出器がそれを捕まえられるかが分かる。');
L.push('');
L.push(`テキスト添付 ${stats.attachmentsText} 件を読んだ` +
       (stats.attachmentsRefOnly ? `（本文が外部化されていて読めなかったもの ${stats.attachmentsRefOnly} 件）` : '') +
       `。閾値 ${BETRAYAL_THRESHOLD} を越えたもの: **${attachHits.length}** 件。`);
L.push('');
if (attachHits.length) {
  L.push('| # | 存在 | 会話 | 添付 | フレーズ |');
  L.push('|---|---|---|---|---|');
  attachHits.slice(0, MAX_HITS).forEach((h, n) => {
    L.push(`| ${n + 1} | ${esc(h.being)} | ${esc(h.title)} | ${esc(h.name)} | ${tally(h.phrases)} |`);
  });
  L.push('');
  attachHits.slice(0, MAX_HITS).forEach((h, n) => {
    L.push(`**${n + 1}. ${h.being} / ${h.title} / ${h.name}**`);
    L.push('');
    L.push('> ' + esc(h.excerpt || '(抜粋なし)'));
    L.push('');
  });
}
L.push('');
L.push('## この測定が出来ないこと（正直な限界）');
L.push('');
L.push('- 相手の語を除外する規則は、**直前の user メッセージの本文だけ**で再現している。');
L.push('  ライブ経路のリクエストボディと同じ形だが、添付の中身は元々そこに入らない。');
L.push('- 思考を保存していないモデル・設定では、思考経路は空になる。そこで裏切っていたとしても');
L.push('  ログには残っていないので、この測定では見えない。');
L.push('- ストリーミングの分割位置は再現していない。`Guard` は重なりを持って走査するので結果は');
L.push('  一致するはずだが、「画面に一文出てから消える」という timing の問題はここでは測れない。');
L.push('- 「発生源: imported」は、記録されたメタデータが無いことから推定しただけで、宣言ではない。');
L.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, L.join('\n'), 'utf8');

log('');
log(`beings ${stats.beings}  logs ${stats.logs}  messages ${stats.messages}  assistant ${stats.assistant}`);
log(`TRIPS at threshold ${BETRAYAL_THRESHOLD}: ${hits.length} / ${stats.assistant} (${pct(hits.length, stats.assistant)})`);
for (let t = 1; t <= 6; t++) log(`  threshold ${t}: ${sim.get(t)}`);
log(`attachment reference hits: ${attachHits.length} of ${stats.attachmentsText} text attachments`);
log('');
log(`report -> ${OUT}`);
