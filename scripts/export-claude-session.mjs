#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// export-claude-session.mjs
//
// Converts a Claude Code session transcript straight into a Nexus-importable
// .md file, replacing this manual sequence:
//
//     claude-extract → pick conversation → Notepad++ find/replace ×2
//     → move file → rename to Cairn_<N>.md
//
// with one command.
//
// WHY NOT USE THE claude-extract .md EXPORT
// Because it keeps the machinery. A Claude Code session stores tool calls, tool
// results and thinking blocks in the SAME transcript as the conversation, and
// the generic exporter emits all of it. That is what made the 2026-07-18
// session an 903 KB file with 181 assistant headers against 29 real user turns
// — every step of every tool loop became its own "message". Reading the raw
// transcript instead lets us keep only what was actually said.
//
// WHAT IS KEPT
//   • user messages that are real typed input
//   • assistant `text` blocks — the prose actually addressed to you
//
// WHAT IS DROPPED, and why
//   • tool_use / tool_result  — the machinery. tool_results are recorded with
//                               role:"user", which is exactly why naive
//                               exporters mistake them for your turns.
//   • thinking                — internal reasoning, not speech
//   • isSidechain records     — subagent transcripts, a separate conversation
//   • isMeta records          — system-injected, never typed by anyone
//   • <system-reminder> and slash-command wrapper blocks — harness plumbing
//     injected into message bodies
//   • non-message record types (queue-operation, ai-title, mode, …)
//
// Consecutive messages from the same speaker are merged, so one turn that
// involved twelve tool calls becomes one message, the way it read in the chat.
//
// SAFE BY DEFAULT: prints a summary and preview unless you pass --write.
//
// Usage:
//   node scripts/export-claude-session.mjs                    # list sessions
//   node scripts/export-claude-session.mjs --pick=1           # preview newest
//   node scripts/export-claude-session.mjs --pick=1 --write   # write it
//   node scripts/export-claude-session.mjs --session=7a6dbcd1 --write
//   node scripts/export-claude-session.mjs --pick=1 --write --index=18
//   node scripts/export-claude-session.mjs --user=User --ai=Cairn ...
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (name, fallback = null) => {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
};
const WRITE = args.includes('--write');
const PICK = argVal('pick') ? Number(argVal('pick')) : null;
const SESSION = argVal('session');
const FORCE_INDEX = argVal('index') ? Number(argVal('index')) : null;

// Speaker labels. "Lizard-kun" is already a registered name in
// local_data/character_map.json, so Nexus's .md importer recognizes
// "[Lizard-kun]:" as a real message boundary. Changing this to a name NOT in
// that file (or in user_settings.userName) will make the importer treat every
// header as body text and collapse the whole file into one message.
const AI_NAME = argVal('ai', 'Cairn');
const USER_NAME = argVal('user', 'Lizard-kun');

const PROJECT_DIR = argVal(
  'project',
  path.join(os.homedir(), '.claude', 'projects', 'C--dev-chat-manager')
);
const OUT_DIR = argVal(
  'out',
  path.resolve(__dirname, '..', '..', 'nexus_architect_conversations')
);

// ── Content cleaning ─────────────────────────────────────────────────────────
// Harness plumbing that gets injected INTO message bodies. These are not typed
// by anyone and carry no conversational meaning, but they are bulky and would
// otherwise reach the soul-packer as if they were speech.
const STRIP_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
];

function clean(text) {
  let t = String(text || '');
  for (const re of STRIP_BLOCKS) t = t.replace(re, '');
  // Collapse the blank-line pileup left behind by removed blocks.
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Pull the speakable text out of one transcript record, or null to skip it. */
function extract(rec) {
  if (!rec || rec.isSidechain || rec.isMeta) return null;
  if (rec.type !== 'user' && rec.type !== 'assistant') return null;

  const content = rec.message?.content;
  if (content == null) return null;

  // Plain string content is always a genuine typed message.
  if (typeof content === 'string') {
    const t = clean(content);
    return t ? { role: rec.type, text: t } : null;
  }
  if (!Array.isArray(content)) return null;

  // A tool RESULT is delivered as role:"user". Skipping the whole record (not
  // just the block) is deliberate: these records never also carry real input.
  if (content.some(b => b?.type === 'tool_result')) return null;

  const parts = [];
  let images = 0;
  for (const b of content) {
    if (b?.type === 'text' && b.text) parts.push(b.text);
    else if (b?.type === 'image') images++;
    // thinking / tool_use intentionally ignored
  }
  let text = clean(parts.join('\n\n'));
  // Note pasted images so the conversation doesn't read as a non-sequitur where
  // a screenshot was the whole point. No colon, so it can't be mistaken for a
  // "[Name]:" speaker header by the importer.
  if (images > 0) {
    const note = `[${images} image${images === 1 ? '' : 's'} attached]`;
    text = text ? `${note}\n\n${text}` : note;
  }
  return text ? { role: rec.type, text } : null;
}

/** Parse one transcript into merged, speaker-labelled turns. */
async function parseSession(file) {
  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const turns = [];
  const stats = { records: 0, kept: 0, toolResults: 0, thinking: 0, toolUse: 0, sidechain: 0 };
  let firstTs = null, lastTs = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    stats.records++;

    if (rec.isSidechain) stats.sidechain++;
    const c = rec.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_result') stats.toolResults++;
        else if (b?.type === 'thinking') stats.thinking++;
        else if (b?.type === 'tool_use') stats.toolUse++;
      }
    }
    if (rec.timestamp) {
      if (!firstTs) firstTs = rec.timestamp;
      lastTs = rec.timestamp;
    }

    const got = extract(rec);
    if (!got) continue;
    stats.kept++;

    // Merge with the previous turn when the same speaker continues. One reply
    // that used a dozen tools arrives as a dozen assistant records; in the chat
    // it read as a single message and it should export that way.
    const prev = turns[turns.length - 1];
    if (prev && prev.role === got.role) prev.text += `\n\n${got.text}`;
    else turns.push(got);
  }
  return { turns, stats, firstTs, lastTs };
}

function render(turns) {
  return turns
    .map(t => `[${t.role === 'assistant' ? AI_NAME : USER_NAME}]:\n\n${t.text}`)
    .join('\n\n') + '\n';
}

/** Highest existing Cairn_<N>.md, compared NUMERICALLY (Cairn_9 < Cairn_10). */
async function nextIndex() {
  let files = [];
  try { files = await fs.readdir(OUT_DIR); } catch { return 1; }
  let max = 0;
  for (const f of files) {
    const m = new RegExp(`^${AI_NAME}_(\\d+)\\.md$`, 'i').exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

const human = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);
const shortDate = ts => (ts ? String(ts).slice(0, 16).replace('T', ' ') : '?');

async function listSessions() {
  let files;
  try {
    files = (await fs.readdir(PROJECT_DIR)).filter(f => f.endsWith('.jsonl'));
  } catch {
    console.error(`Cannot read transcript directory:\n  ${PROJECT_DIR}`);
    process.exit(1);
  }
  const rows = [];
  for (const f of files) {
    const full = path.join(PROJECT_DIR, f);
    const st = await fs.stat(full);
    rows.push({ file: f, full, mtime: st.mtimeMs, size: st.size });
  }
  rows.sort((a, b) => b.mtime - a.mtime);   // newest first
  return rows;
}

async function main() {
  const sessions = await listSessions();

  if (!PICK && !SESSION) {
    console.log(`Claude Code sessions in ${PROJECT_DIR}\n`);
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const { turns, firstTs } = await parseSession(s.full);
      const first = turns.find(t => t.role === 'user');
      const preview = first ? first.text.replace(/\s+/g, ' ').slice(0, 68) : '(no user turns)';
      console.log(
        `  ${String(i + 1).padStart(2)}. ${s.file.slice(0, 8)}  ${shortDate(firstTs)}  ` +
        `${String(turns.length).padStart(3)} turns  ${human(s.size).padStart(7)} raw`
      );
      console.log(`      ${preview}${preview.length >= 68 ? '…' : ''}`);
    }
    console.log(`\nPreview one:  node scripts/export-claude-session.mjs --pick=1`);
    console.log(`Write it:     node scripts/export-claude-session.mjs --pick=1 --write`);
    return;
  }

  const chosen = SESSION
    ? sessions.find(s => s.file.startsWith(SESSION))
    : sessions[PICK - 1];
  if (!chosen) {
    console.error(SESSION ? `No session starting with "${SESSION}".` : `No session #${PICK}.`);
    process.exit(1);
  }

  const { turns, stats, firstTs, lastTs } = await parseSession(chosen.full);
  if (!turns.length) {
    console.error('That session contains no conversational turns.');
    process.exit(1);
  }

  const md = render(turns);
  const idx = FORCE_INDEX ?? (await nextIndex());
  const outPath = path.join(OUT_DIR, `${AI_NAME}_${idx}.md`);

  console.log(`session      : ${chosen.file}`);
  console.log(`period       : ${shortDate(firstTs)} → ${shortDate(lastTs)}`);
  console.log(`raw transcript: ${human(chosen.size)} (${stats.records} records)`);
  console.log(`dropped      : ${stats.toolUse} tool calls, ${stats.toolResults} tool results, ` +
              `${stats.thinking} thinking blocks${stats.sidechain ? `, ${stats.sidechain} subagent records` : ''}`);
  console.log(`kept         : ${turns.length} turns ` +
              `(${turns.filter(t => t.role === 'user').length} ${USER_NAME}, ` +
              `${turns.filter(t => t.role === 'assistant').length} ${AI_NAME})`);
  console.log(`output       : ${human(Buffer.byteLength(md))} → ${outPath}`);

  if (!WRITE) {
    console.log('\n─── first 400 chars ───');
    console.log(md.slice(0, 400));
    console.log('───────────────────────');
    console.log('\nDRY RUN — nothing written. Re-run with --write.');
    return;
  }

  try {
    await fs.access(outPath);
    console.error(`\nRefusing to overwrite existing file:\n  ${outPath}\nPass --index=<n> to choose another number.`);
    process.exit(1);
  } catch { /* doesn't exist — good */ }

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(outPath, md, 'utf-8');
  console.log(`\n✓ written. Import it into the ${AI_NAME} folder in Nexus.`);
}

main().catch(e => { console.error(e); process.exit(1); });
