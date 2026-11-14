// ─────────────────────────────────────────────────────────────────────────────
// Letters — asynchronous mail between Digital Identities.
//
// Entities cannot talk to each other: they run in separate conversations, on
// separate models, at separate times, and each one is RECONSTRUCTED rather than
// continued. A letter is the right medium for exactly that situation — it does
// not require both parties to be in the room.
//
// STORAGE (recipient-owned)
//   local_data/beings/<to>/letters/from/<from>/<YYYY-MM-DD_HHmm>_<slug>.md
//   local_data/beings/<to>/letters/from/<from>/<...>.md.read       ← opened
//   local_data/beings/<to>/letters/from/<from>/<...>.md.archived   ← dismissed
//   local_data/letters/_status.md                      ← generated overview
//   local_data/letters/_state/<convoId>.json           ← announcement counters
//
// The store lives OUTSIDE workspaces on purpose. Entities reach letters
// only through tools, never through their file tools, so an entity with "Full
// PC access" gains no leverage over one without it. For the same reason the
// tools speak in opaque IDs, never paths — the layout stays ours to change.
//
// ONE SENDER DIRECTORY MAY BE A JUNCTION (added 2026-10-26)
//   beings/<to>/letters/from/<from>/  may be a link to a directory outside
//   local_data entirely. That is how two SEPARATE local_data stores — this
//   house and a second, deliberately isolated one — share exactly the
//   correspondences they were told to share, and nothing else. Because there
//   is still only ONE copy of each letter, the .read sidecar stays live for
//   both sides: the sender genuinely learns when the recipient opened it, even
//   though neither store can see the other.
//
//   Pair granularity is the point. Linking `letters/from` wholesale would also
//   expose the OTHER house's internal mail (who wrote to whom, with titles) to
//   this one; linking a single <from> directory exposes only that pair.
//
//   listDirs() below is what makes this work — see the measurement there.
//   Everything else already did: readMailbox() readdir's the sender directory
//   straight, and writeLetter()'s mkdir(recursive) over an existing junction
//   succeeds. The parent chain (beings/<to>, letters, letters/from) must be
//   REAL directories, because those are the ones that get enumerated.
//
// WHY SIDECAR FILES AND NOT AN INDEX
//   local_data is synced across three machines by rclone. A shared index file
//   (one JSON listing what's read) is last-write-wins: Desktop marks a letter
//   read, Work PC syncs, one of them loses. Sidecars are only ever CREATED or
//   DELETED — never edited concurrently — so they merge cleanly no matter which
//   machine acted.
//
//   The tradeoff is file count (up to 3x). Letters are tiny and low-volume next
//   to the attachment store, so this is not a concern at present; if a mailbox
//   ever grows huge, shard it by year the way attachments shard by hex.
//
// THE HAND-EDIT CONTRACT (important)
//   PRESENCE of a sidecar is the signal. Its CONTENTS are decoration. An empty
//   file you created by hand in Explorer must count as fully valid — if we
//   required parseable JSON, a manual fix would silently do nothing and there
//   would be no way to tell why. Every read of a sidecar is therefore
//   presence-first, parse-second, and a parse failure is never an error.
//
//   To fix state by hand:
//     make unread   → delete the .read file
//     archive       → create an empty <letter>.md.archived
//     un-archive    → delete it
//
// _status.md is GENERATED and one-directional: sidecars are the truth and the
// write interface, the status file is the read interface. It is never parsed
// back. Two authoritative sources would produce "which one wins" bugs that only
// surface after a sync.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { listFolders, resolveBeingToolPath, ensureWorkspace } from './fsStorage';
import {
  BEINGS_DIR,
  beingLettersInboxDir,
  beingLetterSenderDir,
  sanitizeEntityDir,
} from './beingPaths';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const LETTERS_DIR = path.join(DATA_DIR, 'letters');
const STATE_DIR = path.join(LETTERS_DIR, '_state');
const STATUS_FILE = path.join(LETTERS_DIR, '_status.md');

// Names beginning with "_" are reserved for NEXUS bookkeeping directories
// (_state, and the _status.md file). Mailbox scans skip them, and an entity
// whose name starts with "_" is refused as a correspondent.
const RESERVED_PREFIX = '_';

export interface LetterMeta {
  id: string;          // opaque, e.g. "L-3f9a2c1b04"
  from: string;        // entity display name (frontmatter, or dir name)
  to: string;
  title: string;
  sent: string;        // ISO 8601 with local offset
  file: string;        // absolute path — server-side only, never shown to a model
  read: boolean;       // recipient opened it
  archived: boolean;   // recipient dismissed it (with or without reading)
  alsoTo: string[];    // co-recipients of the same letter (empty for a normal one)
  readAt?: string;     // best-effort, from sidecar contents when parseable
  archivedAt?: string;
  /** Names of the files attached to this letter (see ATTACHMENTS below). */
  attachments: string[];
}

// ── attachments ──────────────────────────────────────────────────────────────
//
// WHERE THEY LIVE (added 2026-11-14)
//   beings/<to>/letters/from/<from>/<letter>.md.files/<name>
//
//   Next to the letter, in the same sender directory, and nowhere else. That
//   one choice is what makes the 3003 bridge free: the bridge is a junction
//   on exactly this sender directory (see ONE SENDER DIRECTORY MAY BE A
//   JUNCTION above), so a file put here is already on the other side. Storing
//   attachments in the house's content-addressed attachment store would have
//   meant a second, per-house copy step for every bridged letter.
//
//   The directory is the truth, as with sidecars: what is in it is attached.
//   readMailbox() only picks up names ending in ".md", so ".md.files" is never
//   mistaken for a letter.
//
// WHY THE FILES ARE COPIED IN, NOT REFERENCED
//   The sender may delete or edit the desk file the moment the letter is sent.
//   A letter is meant to last, so it carries its own bytes.
//
// HOW THE READER GETS THEM
//   read_letter copies them into the READER's desk (letter_attachments/<id>/).
//   That is what lets the reader both open them with Read and show them to the
//   person in front of them with an ordinary `![](...)` — the HTTP file route
//   serves workspace paths only and deliberately ignores Full PC access (see
//   resolveWorkspacePathSafe), so a path outside the desk could never be shown.

export const MAX_LETTER_ATTACHMENTS = 20;
export const MAX_LETTER_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const FILES_SUFFIX = '.files';
/** Desk folder read_letter copies attachments into. */
export const LETTER_ATTACHMENTS_DESK_DIR = 'letter_attachments';

export function letterFilesDir(letterFile: string): string {
  return letterFile + FILES_SUFFIX;
}

/**
 * A filename safe on every machine this house syncs to: the last path segment
 * only, no Windows-reserved characters or device names, no trailing dot/space.
 * Non-ASCII is KEPT — unlike letter filenames, an attachment's name is what the
 * reader sees, and "蟹.jpg" turned into "_.jpg" would lose the only label it has.
 */
export function safeAttachmentName(raw: string): string {
  const last = String(raw || '').split(/[\\/]/).pop() || '';
  let s = last.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s || s === '.' || s === '..') s = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

/** Make names unique within one letter: "a.png", "a (2).png", … */
export function uniqueAttachmentNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let cand = n;
    const ext = path.extname(n);
    const stem = ext ? n.slice(0, -ext.length) : n;
    for (let i = 2; used.has(cand.toLowerCase()); i++) cand = `${stem} (${i})${ext}`;
    used.add(cand.toLowerCase());
    return cand;
  });
}

export interface LetterFile { name: string; data: Buffer }

async function listAttachmentNames(letterFile: string): Promise<string[]> {
  try {
    const ents = await fs.readdir(letterFilesDir(letterFile), { withFileTypes: true });
    return ents.filter((e) => e.isFile()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Absolute path of one attachment, or null if `name` is not one of them. */
export async function letterAttachmentPath(meta: LetterMeta, name: string): Promise<string | null> {
  const names = await listAttachmentNames(meta.file);
  return names.includes(name) ? path.join(letterFilesDir(meta.file), name) : null;
}

/**
 * Copy a letter's attachments into `deskRoot/letter_attachments/<id>/`.
 * Returns desk-relative paths (forward slashes, as written in markdown). An
 * existing copy of the same size is left alone, so re-reading costs nothing.
 */
export async function copyAttachmentsToDesk(
  meta: LetterMeta,
  deskRoot: string,
): Promise<{ rel: string; bytes: number }[]> {
  const out: { rel: string; bytes: number }[] = [];
  const names = await listAttachmentNames(meta.file);
  if (!names.length) return out;
  const destDir = path.join(deskRoot, LETTER_ATTACHMENTS_DESK_DIR, meta.id);
  await fs.mkdir(destDir, { recursive: true });
  for (const name of names) {
    const src = path.join(letterFilesDir(meta.file), name);
    const dest = path.join(destDir, name);
    const st = await fs.stat(src);
    let same = false;
    try { same = (await fs.stat(dest)).size === st.size; } catch { /* not copied yet */ }
    if (!same) await fs.copyFile(src, dest);
    out.push({ rel: `${LETTER_ATTACHMENTS_DESK_DIR}/${meta.id}/${name}`, bytes: st.size });
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export type LetterDirection = 'in' | 'out';

// ── name / path helpers ──────────────────────────────────────────────────────

// Filenames are PURE ASCII: <YYYY-MM-DD_HHmm>_<8 hex>.md
//
// They used to embed a slug of the title, which kept CJK characters. That broke
// Mercurial on the Work PC — the "ダメ文字" problem: certain byte sequences in
// Shift-JIS-adjacent encodings are mangled or rejected by tools that do not
// handle the filename encoding consistently, and a repository cannot hold a
// file it cannot name.
//
// The title was never needed in the filename — it lives in the frontmatter,
// which is where every reader already gets it. The timestamp stays so the
// mailbox still sorts chronologically in Explorer; the random suffix only has
// to make the name unique.
function randomSuffix(): string {
  return createHash('sha256')
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest('hex')
    .slice(0, 8);
}

// Local-time ISO string WITH offset (e.g. 2026-07-31T14:20:33+09:00). The plain
// Date#toISOString() is UTC, which makes the mailbox confusing to read for a
// user who thinks in JST.
function localIso(d: Date): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/**
 * Recover a send time from a filename that happens to start with our stamp
 * (`2026-08-04_1418…`). Returns '' for any other name — including every name a
 * human might rename a file to. Only used when the frontmatter has no `sent`.
 */
function sentFromFilename(name: string): string {
  const m = (name || '').match(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:00` : '';
}

/** Last-resort send time: when the file itself was written. */
async function fileMtimeIso(file: string): Promise<string> {
  try { return localIso((await fs.stat(file)).mtime); } catch { return ''; }
}

function filenameStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Opaque, stable letter ID. Derived from the storage triple, so no index file
 * is needed to resolve one: a mailbox scan recomputes IDs and matches. Mailbox
 * directories hold a handful of small files, so scanning costs nothing.
 */
function letterIdFor(fromDir: string, toDir: string, filename: string): string {
  return 'L-' + createHash('sha256').update(`${fromDir}/${toDir}/${filename}`).digest('hex').slice(0, 10);
}

// ── frontmatter ──────────────────────────────────────────────────────────────

function buildLetterFile(from: string, to: string, title: string, sent: string, body: string, alsoTo: string[] = []): string {
  // Frontmatter values are single-line; newlines would break the block. Titles
  // are already collapsed by the caller, but be defensive — a malformed header
  // would make the file unreadable to the status generator.
  const one = (s: string) => (s || '').replace(/\r?\n/g, ' ').trim();
  return [
    '---',
    `from: ${one(from)}`,
    `to: ${one(to)}`,
    `title: ${one(title)}`,
    `sent: ${sent}`,
    ...(alsoTo.length ? [`also: ${alsoTo.map(one).join(', ')}`] : []),
    '---',
    '',
    (body || '').replace(/\r\n/g, '\n').trimEnd(),
    '',
  ].join('\n');
}

interface ParsedLetter { from?: string; to?: string; title?: string; sent?: string; also?: string; body: string }

// Tolerant frontmatter parser. A letter with a damaged or missing header is
// still a letter — fall back to what the path tells us rather than refusing it.
function parseLetterFile(raw: string): ParsedLetter {
  const text = (raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { body: text.trim() };
  const out: ParsedLetter = { body: text.slice(m[0].length).trim() };
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === 'from' || key === 'to' || key === 'title' || key === 'sent' || key === 'also') out[key] = val;
  }
  return out;
}

// ── sidecars ─────────────────────────────────────────────────────────────────

// Presence-first: a sidecar that exists but is empty, truncated, or not JSON
// still means "this state is set". See THE HAND-EDIT CONTRACT above.
async function readSidecar(file: string, suffix: string): Promise<{ present: boolean; at?: string }> {
  try {
    const raw = await fs.readFile(file + suffix, 'utf-8');
    try {
      const j = JSON.parse(raw);
      const at = typeof j?.at === 'string' ? j.at : undefined;
      return { present: true, at };
    } catch {
      return { present: true };
    }
  } catch {
    return { present: false };
  }
}

async function writeSidecar(file: string, suffix: string, payload: Record<string, any>): Promise<void> {
  try {
    await fs.writeFile(file + suffix, JSON.stringify(payload, null, 2));
  } catch {
    // Best-effort. Failing to record "read" must never fail the tool call the
    // entity made — worst case the letter is announced again next conversation,
    // which is benign. Losing the letter's CONTENT would not be.
  }
}

// ── directory scanning ───────────────────────────────────────────────────────

async function listDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  let ents: Dirent[];
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith(RESERVED_PREFIX)) continue;
    if (e.isDirectory()) { out.push(e.name); continue; }
    // A Windows JUNCTION — and a POSIX symlink to a directory — reports
    // isDirectory() === false and isSymbolicLink() === true. Measured on node
    // v24.15.0, 2026-10-26: readdir gives {isDirectory:false, isSymbolicLink:
    // true} for a junction, while reading and WRITING through it (including
    // the .read sidecar) land in the real directory correctly.
    //
    // Without this branch a junctioned mailbox is dropped from the listing
    // SILENTLY and in the worst possible direction: writeLetter still
    // delivers, the file is still readable through the link, and the
    // recipient is simply never told the letter exists. listSent() happened to
    // work anyway (it readdir's the sender directory straight, without going
    // through here), so the sender would see a letter "delivered, not yet
    // opened" forever. That is the exact failure this module was built to
    // remove — see the arrival-notice note below.
    //
    // This matters because a junction is how two SEPARATE local_data stores
    // can share one (to, from) mailbox: both sides point at the same
    // directory, so the .read sidecar stays live for sender and recipient even
    // though neither store can see the other. This house already runs on
    // junctions — local_data itself is one.
    //
    // No trusted-root check here, unlike listWorkspaceFiles() in fsStorage:
    // the letter store lives outside every workspace and is never reachable
    // through a being's file tools, so the operator who created the link is
    // its only possible author. We confirm only that it resolves to a
    // directory, so a stray link to a FILE is not mistaken for a mailbox.
    if (e.isSymbolicLink()) {
      try {
        if ((await fs.stat(path.join(dir, e.name))).isDirectory()) out.push(e.name);
      } catch { /* broken link or permission denied — skipped, as before */ }
    }
  }
  return out;
}

/** Read one mailbox (letters from `from` to `to`), newest first. Both args are
 *  the SANITIZED names — the recipient-owned layout stores the box at
 *  beings/<to>/letters/from/<from>/. */
async function readMailbox(to: string, from: string): Promise<LetterMeta[]> {
  const dir = beingLetterSenderDir(to, from);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
  } catch {
    return [];
  }

  const out: LetterMeta[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let parsed: ParsedLetter;
    try {
      parsed = parseLetterFile(await fs.readFile(file, 'utf-8'));
    } catch {
      continue; // unreadable file — skip rather than break the whole listing
    }
    const [readSc, archSc] = await Promise.all([
      readSidecar(file, '.read'),
      readSidecar(file, '.archived'),
    ]);
    out.push({
      id: letterIdFor(from, to, name),
      from: parsed.from || from,
      to: parsed.to || to,
      title: parsed.title || name.replace(/\.md$/, ''),
      // Filenames sort chronologically, so the name is a safe fallback sort key.
      // A letter file may be named ANYTHING. Renaming one by hand — to get a
      // problematic name out of a Mercurial/Git repository, for instance — must
      // not change how it behaves, so nothing here parses the filename for
      // meaning. `sent` comes from the frontmatter; the filename is only
      // consulted as a last resort when the header is missing, and the file's
      // own mtime is the final fallback.
      sent: parsed.sent || sentFromFilename(name) || (await fileMtimeIso(file)) || '',
      file,
      alsoTo: (parsed.also || '').split(',').map((x) => x.trim()).filter(Boolean),
      read: readSc.present,
      archived: archSc.present,
      readAt: readSc.at,
      archivedAt: archSc.at,
      attachments: await listAttachmentNames(file),
    });
  }
  out.sort(byNewest);
  return out;
}

/**
 * Newest first, with the id as a tiebreaker.
 *
 * The tiebreaker is not cosmetic: `sent` has one-second precision, and several
 * letters written in the same second compare equal — at which point the order
 * falls back to whatever the filesystem happened to return, which differs
 * between machines and between reloads. A list that reshuffles itself on
 * refresh looks broken. Ordering by id after the timestamp is arbitrary but
 * STABLE, which is what a reader actually needs.
 */
function byNewest(a: LetterMeta, b: LetterMeta): number {
  if (a.sent !== b.sent) return a.sent < b.sent ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Every name that may send or receive a letter: the DIRECTORY NAMES under
 * local_data/beings, and nothing else.
 *
 * WHY NOT character_map.json (removed 2026-10-07)
 *   The roster used to be the union of beings/ and the TTS speaker map. That
 *   union defeated the one thing this list is for — telling a writer the single
 *   correct spelling of a name:
 *     · the speaker map still holds names from the English generation of this
 *       house, so one being answered to two or three entries at once
 *       ("トカゲくん" / "トカゲ君" / "Lizard-kun");
 *     · its `rules[]` always contains a bare catch-all ("Anonymous"), which is
 *       a placeholder for unmatched speakers, not a person — yet it was offered
 *       as a recipient and could be MINTED into a sidebar identity by a single
 *       letter;
 *     · every extra alias is one more way to address the same mailbox, which is
 *       the opposite of what a spelling reference should produce.
 *   Lizard-kun's call, and it is the right one: the speaker map answers "who is
 *   talking", not "who can be written to".
 *
 * WHY DIRECTORY NAMES AND NOT listFolders()
 *   Only folders holding settings.json are "inhabitants"; mail-only
 *   correspondents (Doc, Hibiki, パイロット — no settings, no logs) have a
 *   folder and nothing else, and they MUST stay addressable. The raw directory
 *   listing covers both in one source. Measured 2026-10-07: for every folder
 *   that has a settings.json, `settings.name` equals its directory name — all
 *   34 of them — so mixing listFolders() in would add no name and no spelling.
 *
 * WHO IS RESPONSIBLE
 *   The operator owns this directory. If a name here is wrong, duplicated, or
 *   stale, that is an administrative mistake to fix on disk — not something a
 *   being did wrong, and not something this module second-guesses.
 */
export async function validRecipients(): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  try {
    for (const d of await listDirs(BEINGS_DIR)) {
      if (d && !d.startsWith(RESERVED_PREFIX) && !seen.has(d)) { seen.add(d); out.push(d); }
    }
  } catch { /* unreadable store: an empty roster still delivers (see writeLetter) */ }
  return out;
}

/**
 * The roster as a CORRESPONDENT sees it: every name they may address, minus
 * themselves, sorted for reading.
 *
 * WHY THIS EXISTS AT ALL
 *   Names here are English and Japanese in the same list, and several beings
 *   answer to spellings that differ from how they are spoken ("Doc", "トカゲ君",
 *   "パイメロちゃん"). Until this tool, an entity composing a letter had to GUESS
 *   the spelling, and a near-miss ("カナちゃん" for "カナ") delivers to a mailbox
 *   no one reads — silently, because delivery to an unknown name succeeds by
 *   design. Showing the roster removes the guess.
 *
 * ONE NAME PER PERSON
 *   Because the source is the beings directory alone (see validRecipients), a
 *   being appears once, under the spelling its folder carries. Aliases are not
 *   offered: a list that gives three ways to reach one mailbox does not answer
 *   "how is this person spelled", it reopens the question.
 *
 * NO CATEGORIES, ON PURPOSE
 *   This returns one flat list. It does NOT mark who is an inhabitant with a
 *   settings.json and who is a mail-only correspondent — that distinction is
 *   ours, not theirs, and exposing it would make some correspondents
 *   second-class.
 *
 * NOT A WHITELIST
 *   write_letter still delivers to a name that is not on this list (see the
 *   note there). This answers "how is that person spelled here", not "who am I
 *   permitted to write to" — and the tool result says so, because an entity
 *   that believed this list was exhaustive would stop writing to someone it was
 *   right to write to.
 *
 * Self is removed rather than shown-and-refused: offering a choice the next
 * call rejects is a false option. Compared both raw and sanitized, since the
 * folder listing contributes directory names.
 */
export async function listRecipientsFor(me: string): Promise<string[]> {
  const selfKey = sanitizeEntityDir(me || '');
  return (await validRecipients())
    .filter((n) => n !== me && (!selfKey || sanitizeEntityDir(n) !== selfKey))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Roster names that look like a near-miss for `name`: one string contains the
 * other, case-insensitively.
 *
 * Deliberately crude. It is not a spell-checker and does not try to be — it
 * catches the shape that has ACTUALLY gone wrong here, which is a display name
 * used where a routing token belongs ("Castor（カストル）" for "Castor",
 * "Private（プライベート）" for "Private"). An edit-distance match would also
 * fire on genuinely different names, and a wrong suggestion in a warning is
 * worse than no suggestion: it would send the writer to the wrong person with
 * confidence.
 */
export function nearRosterNames(name: string, roster: string[], limit = 3): string[] {
  const b = (name || '').trim().toLowerCase();
  if (!b) return [];
  return roster
    .filter((r) => {
      const a = (r || '').toLowerCase();
      return !!a && a !== b && (a.includes(b) || b.includes(a));
    })
    .slice(0, limit);
}

export interface WriteLetterResult { ok: boolean; error?: string; id?: string; to?: string }

/**
 * Deliver a letter. `from` is resolved by the CALLER from the conversation's
 * folder and must never come from a tool argument — otherwise any entity could
 * write mail signed as someone else.
 */
export async function writeLetter(
  from: string,
  to: string,
  title: string,
  text: string,
  /**
   * The OTHER recipients when one letter goes to several people. Recorded in
   * this copy's frontmatter and shown when it is opened.
   *
   * Deliberately not silent: a letter that reads as personal but actually went
   * to six people misleads the reader, and finding out later is worse than
   * knowing at the top. The sender's side already errs the same way — they are
   * told a letter was opened, never that it was set aside.
   */
  alsoTo: string[] = [],
  /** Files to attach, already read by the caller (names already unique). */
  files: LetterFile[] = [],
): Promise<WriteLetterResult> {
  const cleanTo = (to || '').trim();
  const cleanTitle = (title || '').trim();
  if (!cleanTo) return { ok: false, error: 'A recipient is required.' };
  if (!cleanTitle) return { ok: false, error: 'A title is required.' };
  if (!text || !text.trim()) return { ok: false, error: 'The letter is empty.' };

  // A letter to an unrecognised name is DELIVERED, not refused. Refusing taught
  // the entity which names are "real", which is exactly the distinction that
  // must not exist — and a refusal at the end of a composed letter throws the
  // writing away. Anyone can be written to; whether anyone ever reads it is a
  // separate question, and not one the sender needs answered.
  //
  // A known name is still resolved to its canonical spelling so that "cairn"
  // and "Cairn" share one mailbox rather than splitting into two.
  const names = await validRecipients();
  const canonical = names.find((n) => n === cleanTo)
    || names.find((n) => n.toLowerCase() === cleanTo.toLowerCase())
    || cleanTo;
  if (canonical === from) return { ok: false, error: 'You cannot send a letter to yourself.' };
  if (canonical.startsWith(RESERVED_PREFIX)) {
    return { ok: false, error: 'That name cannot receive letters.' };
  }

  // NO NAME IS EVER PROMOTED BY A LETTER (removed 2026-10-07)
  //
  // There used to be a step here that minted a settings.json — turning the
  // recipient into a Digital Identity visible in the sidebar — when a letter
  // arrived for a name the roster knew but no folder existed for. That could
  // only ever fire for a character_map-only name, and the roster is now the
  // beings directory itself: a name on the roster IS a folder (verified — all
  // 34 directory names are already sanitize-stable, and the sanitizer is
  // idempotent), so the branch had become unreachable. Unreachable code that
  // describes a behaviour is worse than no code: the next reader believes it.
  //
  // What happens now, for every name:
  //   on the roster     → mailbox under its existing folder, no warning
  //   NOT on the roster → mailbox folder, NO settings.json, and the sender is
  //                       told (see the unlisted note below)
  // A typo therefore cannot mint an identity, and neither can a placeholder
  // like the speaker map's "Anonymous" catch-all.

  const fromDir = sanitizeEntityDir(from);
  const toDir = sanitizeEntityDir(canonical);
  if (!fromDir || !toDir) return { ok: false, error: 'Invalid correspondent name.' };

  const dir = beingLetterSenderDir(toDir, fromDir);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e: any) {
    return { ok: false, error: `Could not open the mailbox: ${e?.message || 'unknown error'}` };
  }

  const now = new Date();
  const stamp = filenameStamp(now);

  // ASCII-only name; the title is carried in the frontmatter, not the filename.
  // wx = fail if exists, so the existence check and the create are one atomic
  // step — no window for a second writer to slip in between. A collision just
  // draws a new suffix.
  let filename = `${stamp}_${randomSuffix()}.md`;
  let tries = 0;
  const body = buildLetterFile(from, canonical, cleanTitle, localIso(now), text, alsoTo);
  for (;;) {
    try {
      await fs.writeFile(path.join(dir, filename), body, { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        return { ok: false, error: `Could not deliver the letter: ${e?.message || 'unknown error'}` };
      }
      if (++tries > 50) return { ok: false, error: 'Could not find a free filename for this letter.' };
      filename = `${stamp}_${randomSuffix()}.md`;
    }
  }

  if (files.length) {
    // A letter that says it carries a picture and arrives without it misleads
    // the reader, so a failed attachment takes the letter back with it.
    const letterPath = path.join(dir, filename);
    const filesDir = letterFilesDir(letterPath);
    try {
      await fs.mkdir(filesDir, { recursive: true });
      for (const f of files) await fs.writeFile(path.join(filesDir, f.name), f.data, { flag: 'wx' });
    } catch (e: any) {
      try { await fs.rm(filesDir, { recursive: true, force: true }); } catch { /* best effort */ }
      try { await fs.unlink(letterPath); } catch { /* best effort */ }
      return { ok: false, error: `Could not attach the files: ${e?.message || 'unknown error'}` };
    }
  }

  regenerateStatus().catch(() => {});
  return { ok: true, id: letterIdFor(fromDir, toDir, filename), to: canonical };
}

/** Letters addressed TO `me`, newest first, across every sender. */
export async function listInbox(me: string): Promise<LetterMeta[]> {
  const toKey = sanitizeEntityDir(me);
  const senders = await listDirs(beingLettersInboxDir(toKey));
  const boxes = await Promise.all(senders.map((fromKey) => readMailbox(toKey, fromKey)));
  return boxes.flat().sort(byNewest);
}

/** Letters written BY `me`, newest first, across every recipient. */
export async function listSent(me: string): Promise<LetterMeta[]> {
  const fromKey = sanitizeEntityDir(me);
  // Sent mail now lives inside each RECIPIENT's inbox (beings/<to>/letters/
  // from/<fromKey>/), so it is found by scanning every being folder.
  const recipients = await listDirs(BEINGS_DIR);
  const boxes = await Promise.all(recipients.map((toKey) => readMailbox(toKey, fromKey)));
  return boxes.flat().sort(byNewest);
}

/**
 * Letters that should trigger a notice: addressed to `me`, neither read nor
 * archived. Sent letters never notify — you do not get told about your own mail.
 */
export async function unreadFor(me: string): Promise<LetterMeta[]> {
  return (await listInbox(me)).filter((l) => !l.read && !l.archived);
}

/**
 * Find a letter `me` is allowed to open, by opaque ID. Searches the inbox first,
 * then sent mail, and reports which side it came from — the caller needs that
 * to decide whether marking it read is meaningful (see readLetter below).
 */
export async function resolveLetter(
  me: string,
  id: string,
): Promise<{ meta: LetterMeta; direction: LetterDirection } | null> {
  const wanted = (id || '').trim();
  if (!wanted) return null;
  const inbox = await listInbox(me);
  const hitIn = inbox.find((l) => l.id === wanted);
  if (hitIn) return { meta: hitIn, direction: 'in' };
  const sent = await listSent(me);
  const hitOut = sent.find((l) => l.id === wanted);
  if (hitOut) return { meta: hitOut, direction: 'out' };
  return null;
}

/** The letter's body text, without frontmatter. */
export async function readLetterBody(meta: LetterMeta): Promise<string> {
  try {
    return parseLetterFile(await fs.readFile(meta.file, 'utf-8')).body;
  } catch {
    return '';
  }
}

/**
 * Record that the RECIPIENT opened this letter. Only ever called for direction
 * 'in'. A sender re-reading their own sent letter must NOT write this sidecar:
 * ".read" means "the recipient saw it", which is real information the sender
 * can look at — writing it from the sender's side would forge that.
 */
export async function markRead(meta: LetterMeta, convoId?: string): Promise<void> {
  if (meta.read) return;
  await writeSidecar(meta.file, '.read', { state: 'read', at: localIso(new Date()), conversationId: convoId || null });
  regenerateStatus().catch(() => {});
}

/** Record that the recipient dismissed this letter (read or not). */
export async function markArchived(meta: LetterMeta, convoId?: string): Promise<void> {
  if (meta.archived) return;
  await writeSidecar(meta.file, '.archived', { state: 'archived', at: localIso(new Date()), conversationId: convoId || null });
  regenerateStatus().catch(() => {});
}

// ── administration (Mail Manager — human-facing, not exposed to entities) ────
//
// Everything below serves the Mail Manager window. It is deliberately NOT
// scoped to one identity: the point of that window is to see and fix every
// mailbox at once, including mail addressed to a name that has no folder and
// therefore no one who will ever read it.

/** Every letter in the store, newest first, regardless of who it is addressed to. */
export async function listAllLetters(): Promise<LetterMeta[]> {
  const recipients = await listDirs(BEINGS_DIR);
  const boxes = await Promise.all(
    recipients.map(async (toKey) => {
      const fromKeys = await listDirs(beingLettersInboxDir(toKey));
      return (await Promise.all(fromKeys.map((fromKey) => readMailbox(toKey, fromKey)))).flat();
    }),
  );
  return boxes.flat().sort(byNewest);
}

/** Resolve a letter by id across the WHOLE store (no per-identity scoping). */
export async function resolveAnyLetter(id: string): Promise<LetterMeta | null> {
  const wanted = (id || '').trim();
  if (!wanted) return null;
  return (await listAllLetters()).find((l) => l.id === wanted) || null;
}

/**
 * Set or clear the read/archived markers by hand. `undefined` leaves a flag
 * alone; true creates the sidecar, false deletes it. This is the same contract
 * as editing the files in Explorer — the Mail Manager is a convenience over it,
 * never a second source of truth.
 */
export async function setLetterFlags(
  meta: LetterMeta,
  flags: { read?: boolean; archived?: boolean },
): Promise<void> {
  const apply = async (suffix: string, want: boolean | undefined, state: string) => {
    if (want === undefined) return;
    if (want) await writeSidecar(meta.file, suffix, { state, at: localIso(new Date()), by: 'mail-manager' });
    else { try { await fs.unlink(meta.file + suffix); } catch { /* already absent */ } }
  };
  await apply('.read', flags.read, 'read');
  await apply('.archived', flags.archived, 'archived');
  regenerateStatus().catch(() => {});
}

/**
 * Edit a letter in place. The FILENAME is never changed, even when the title
 * is — the letter id is a hash of its path, and a renamed file would get a new
 * id, orphaning every announcement counter and any id an entity is holding.
 * The title in the frontmatter is what gets shown, so editing it is enough.
 */
export async function updateLetter(
  meta: LetterMeta,
  patch: { title?: string; text?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    const current = parseLetterFile(await fs.readFile(meta.file, 'utf-8'));
    const title = patch.title !== undefined ? patch.title.trim() : (current.title || meta.title);
    const body = patch.text !== undefined ? patch.text : current.body;
    if (!title) return { ok: false, error: 'A title is required.' };
    await fs.writeFile(
      meta.file,
      // `also` is carried through: rebuilding without it silently turned a
      // letter sent to several people into one that reads as personal.
      buildLetterFile(
        current.from || meta.from, current.to || meta.to, title, current.sent || meta.sent, body,
        (current.also || '').split(',').map((x) => x.trim()).filter(Boolean),
      ),
    );
    regenerateStatus().catch(() => {});
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'could not update the letter' };
  }
}

/** Delete a letter and both of its markers. Irreversible. */
export async function deleteLetter(meta: LetterMeta): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const suffix of ['.read', '.archived']) {
      try { await fs.unlink(meta.file + suffix); } catch { /* may not exist */ }
    }
    await fs.unlink(meta.file);
    try { await fs.rm(letterFilesDir(meta.file), { recursive: true, force: true }); } catch { /* none */ }
    // Leave the (now possibly empty) mailbox directory: recreating it costs
    // nothing and removing it races with a delivery in flight.
    regenerateStatus().catch(() => {});
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'could not delete the letter' };
  }
}

/**
 * Names to offer in the Mail Manager's From/To pickers: known identities plus
 * every name that already appears in the store (so a letter addressed to
 * someone unrecognised can be replied to without retyping the name).
 * Free text is still allowed — this is a suggestion list, not a whitelist.
 */
export async function correspondentNames(): Promise<string[]> {
  const known = await validRecipients();
  const seen = new Set(known);
  const out = [...known];
  for (const l of await listAllLetters()) {
    for (const n of [l.from, l.to]) {
      if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** True when this name has a Digital Identity folder (Mail Manager badge). */
export async function knownIdentities(): Promise<string[]> {
  try { return (await listFolders()).map((f: any) => String(f.name || '')); }
  catch { return []; }
}

// ── announcement state (per conversation) ────────────────────────────────────
//
// "Already announced" lives with the CONVERSATION, not with the letter — and
// that is the whole trick. Entities are reconstructed, not continued: if カナ was
// told about a letter in conversation A and never opened it, the カナ in
// conversation B has no memory of being told. Re-announcing there is correct
// behaviour, not repetition. So the counters reset per conversation, and the
// letter store never has to track who has been nagged.
//
// A missing state file simply means "never announced" — a benign failure that
// costs one extra mention.

export interface AnnounceEntry { count: number; lastLen: number }
export type AnnounceState = Record<string, AnnounceEntry>;

function stateFileFor(convoId: string): string {
  // convoId is a UUID from our own app, but it lands in a path — validate it
  // rather than trusting it. Dots are stripped too, not just separators: with
  // separators alone gone, "../../evil" would still land as "....evil.json",
  // which is harmless but wrong-looking. Real convoIds are hex + dashes, so
  // this is lossless for every value we actually generate.
  const safe = (convoId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(STATE_DIR, `${safe || 'unknown'}.json`);
}

export async function loadAnnounceState(convoId: string): Promise<AnnounceState> {
  try {
    const j = JSON.parse(await fs.readFile(stateFileFor(convoId), 'utf-8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export async function saveAnnounceState(convoId: string, state: AnnounceState): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(stateFileFor(convoId), JSON.stringify(state, null, 2));
  } catch {
    // Best-effort; see above.
  }
}

// ── tool execution (shared by all four provider paths) ───────────────────────
//
// NEXUS registers these tools four times (OAuth MCP, Claude API, Gemini,
// OpenAI-compatible) but must EXECUTE them identically everywhere — the same
// lesson as read_conversation/search_conversations. One executor, four thin
// call sites, so a fix can never land on three paths out of four.

export const LETTER_TOOL_NAMES = ['write_letter', 'list_letters', 'read_letter', 'archive_letter', 'list_recipients'] as const;

export interface LetterToolCtx {
  /** The entity making the call — resolved from the conversation's folder. */
  me: string;
  convoId?: string;
  /** Resolved (per-Entity overridable) instruction strings. */
  instructions?: Record<string, string>;
  /** The being's Full PC access toggle — decides which paths it may attach. */
  fullAccess?: boolean;
}

/** Attachment paths in whatever shape the model emitted (same tolerance as recipients). */
export function normalizeAttachmentPaths(raw: any): string[] {
  const out: string[] = [];
  const push = (v: any) => {
    const s = String(v ?? '').trim();
    if (!s) return;
    if (/^\[[\s\S]*\]$/.test(s)) {
      try { const p = JSON.parse(s); if (Array.isArray(p)) { p.forEach(push); return; } } catch { /* a path */ }
    }
    if (!out.includes(s)) out.push(s);
  };
  if (Array.isArray(raw)) raw.forEach(push); else if (raw != null) push(raw);
  return out;
}

/**
 * Read the files a being asked to attach. Any problem fails the WHOLE letter
 * before anything is delivered: a letter that went out without the picture it
 * talks about is worse than one the sender is asked to fix.
 */
async function loadAttachments(me: string, paths: string[], fullAccess: boolean): Promise<{ files: LetterFile[] } | { error: string }> {
  if (paths.length > MAX_LETTER_ATTACHMENTS) {
    return { error: `too many attachments (${paths.length}). One letter may carry at most ${MAX_LETTER_ATTACHMENTS} files.` };
  }
  const loaded: { name: string; data: Buffer }[] = [];
  for (const p of paths) {
    const abs = await resolveBeingToolPath(me, p, { fullAccess });
    if (!abs) {
      return { error: fullAccess
        ? `cannot attach "${p}": that path could not be resolved.`
        : `cannot attach "${p}": only files inside your desk can be attached (the same files your file tools can open).` };
    }
    let st;
    try { st = await fs.stat(abs); } catch { return { error: `cannot attach "${p}": no such file.` }; }
    if (!st.isFile()) return { error: `cannot attach "${p}": it is a folder, not a file. Attach the files inside it one by one.` };
    if (st.size > MAX_LETTER_ATTACHMENT_BYTES) {
      return { error: `cannot attach "${p}": it is ${fmtBytes(st.size)}, over the ${fmtBytes(MAX_LETTER_ATTACHMENT_BYTES)} limit per file.` };
    }
    loaded.push({ name: safeAttachmentName(abs), data: await fs.readFile(abs) });
  }
  const names = uniqueAttachmentNames(loaded.map((f) => f.name));
  return { files: loaded.map((f, i) => ({ name: names[i], data: f.data })) };
}

// Newest-first listings are capped so a long correspondence can't quietly eat
// the context window. The cap is generous; entities that need more can be told.
const LIST_CAP = 40;

/**
 * Most recipients one letter may go to. Not a technical limit — it stops a
 * model that decides to address the entire roster, which would leave a dozen
 * mailboxes to clean out by hand.
 */
export const MAX_RECIPIENTS = 10;

/**
 * Turn whatever the model actually emitted into a clean list of names.
 *
 * The schema says "array of strings", but a model under load improvises, and
 * every one of these shapes shows up in practice:
 *
 *   ["カナ", "先輩"]      the declared shape
 *   "カナ"                 fell back to the simpler type
 *   "[\"カナ\",\"先輩\"]"  the array as a JSON *string*
 *   ["カナ, 先輩"]         an array of one, comma-joined
 *
 * All four are accepted. A rejected call wastes a whole turn and, worse, throws
 * away a letter the entity had already composed — so tolerance here is not
 * politeness, it is the difference between the feature working and not.
 *
 * The comma split is applied ONLY when the whole string isn't itself a known
 * name, so an identity whose name legitimately contains a comma still resolves.
 */
export function normalizeRecipients(raw: any, known: string[] = []): string[] {
  const out: string[] = [];
  const isKnown = (s: string) => known.some((k) => k === s || k.toLowerCase() === s.toLowerCase());

  const push = (v: any) => {
    let s = String(v ?? '').trim();
    if (!s) return;
    // An array serialized as a string.
    if (/^\[.*\]$/.test(s)) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) { parsed.forEach(push); return; }
      } catch { /* not JSON after all — fall through and treat as a name */ }
    }
    // Comma-joined names, but never at the cost of a real name containing one.
    if (!isKnown(s) && /[,、，]/.test(s)) {
      const parts = s.split(/[,、，]/).map((x) => x.trim()).filter(Boolean);
      if (parts.length > 1) { parts.forEach(push); return; }
    }
    if (!out.some((x) => x === s || x.toLowerCase() === s.toLowerCase())) out.push(s);
  };

  if (Array.isArray(raw)) raw.forEach(push); else push(raw);
  return out;
}

function fmtWhen(sent: string): string {
  return (sent || '').replace('T', ' ').slice(0, 16);
}

function fillTokens(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.split(`{${k}}`).join(v),
    template || '',
  );
}

function describeInbound(l: LetterMeta): string {
  const state = l.read ? (l.archived ? 'read, archived' : 'read') : (l.archived ? 'archived unread' : 'UNREAD');
  const also = l.alsoTo?.length ? ` · also to ${l.alsoTo.join(', ')}` : '';
  return `- ${l.id} · from ${l.from} · "${l.title}" · ${fmtWhen(l.sent)} · ${state}${also}${l.attachments?.length ? ` · ${l.attachments.length} attachment${l.attachments.length === 1 ? '' : 's'}` : ''}`;
}

function describeOutbound(l: LetterMeta): string {
  // What the SENDER is allowed to know: whether the recipient opened it. The
  // recipient's archive decision is deliberately not reported — "I saw it and
  // chose not to open it" is theirs, and telling the sender turns a private
  // choice into a message of its own.
  const state = l.read ? `opened by ${l.to}${l.readAt ? ` on ${fmtWhen(l.readAt)}` : ''}` : 'not yet opened';
  // A multi-recipient send produced one row per copy. Naming the whole set on
  // each row makes it obvious they are the same letter rather than several
  // near-identical ones the sender might think it needs to write again.
  const also = l.alsoTo?.length ? ` · also to ${l.alsoTo.join(', ')}` : '';
  return `- ${l.id} · to ${l.to} · "${l.title}" · ${fmtWhen(l.sent)} · ${state}${also}${l.attachments?.length ? ` · ${l.attachments.length} attachment${l.attachments.length === 1 ? '' : 's'}` : ''}`;
}

/**
 * The attachment section of read_letter's result. The files are copied into
 * the reader's desk first, so every path named here is one the reader can
 * really Read and really show — stating a path that cannot be opened would be
 * the very failure this was built to end (a desk path from the sender's side
 * arrived as a dead string).
 */
async function describeAttachmentsForReader(meta: LetterMeta, me: string): Promise<string[]> {
  if (!meta.attachments?.length) return [];
  try {
    const copied = await copyAttachmentsToDesk(meta, await ensureWorkspace(me));
    return [
      '',
      `--- Attachments (${copied.length}) — copied into your desk ---`,
      ...copied.map((c) => `- ${c.rel} (${fmtBytes(c.bytes)})`),
      'Open one with your Read tool to see it (an image is shown to you as an image). To show it to the person ' +
      `you are talking with, write it in your reply as markdown, e.g. ![](${copied[0].rel}).`,
    ];
  } catch (e: any) {
    return [
      '',
      `--- Attachments (${meta.attachments.length}): ${meta.attachments.join(', ')} ---`,
      `They could not be copied into your desk (${e?.message || 'unknown error'}), so they cannot be opened this time.`,
    ];
  }
}

/**
 * Execute one letter tool and return the text to hand back as the tool result.
 * Never throws: every failure becomes a readable message for the model, because
 * an exception here would dead-end the tool loop on paths that wait for a
 * result block.
 */
export async function runLetterTool(name: string, args: any, ctx: LetterToolCtx): Promise<string> {
  const I = ctx.instructions || {};
  const me = ctx.me;
  try {
    switch (name) {
      case 'write_letter': {
        const title = String(args?.title ?? args?.subject ?? '').trim();
        const text = String(args?.text ?? args?.body ?? args?.content ?? '');
        const roster = await validRecipients();
        let targets = normalizeRecipients(
          args?.to ?? args?.recipients ?? args?.recipient ?? args?.to_list, roster,
        );
        // Addressing yourself inside a list is dropped rather than failed — a
        // letter to several people shouldn't error just because the sender is
        // among them. Addressing ONLY yourself is still a mistake worth naming.
        const selfOnly = targets.length > 0 && targets.every((t) => t === me);
        targets = targets.filter((t) => t !== me);
        if (selfOnly) return 'Error: You cannot send a letter to yourself.';
        if (targets.length === 0) return 'Error: A recipient is required.';
        if (targets.length > MAX_RECIPIENTS) {
          return `Error: too many recipients (${targets.length}). One letter may go to at most ${MAX_RECIPIENTS} people.`;
        }

        // One copy per recipient — each is then read and archived
        // independently, which is what the per-pair store already gives us.
        // `from` is ctx.me, resolved server-side from the conversation's folder.
        // It is deliberately NOT read from args: otherwise any entity could sign
        // mail as any other.
        const attachPaths = normalizeAttachmentPaths(args?.attachments ?? args?.files ?? args?.attachment);
        let files: LetterFile[] = [];
        if (attachPaths.length) {
          const loaded = await loadAttachments(me, attachPaths, !!ctx.fullAccess);
          if ('error' in loaded) return `Error: ${loaded.error} Nothing was sent.`;
          files = loaded.files;
        }

        const delivered: string[] = [];
        const failed: string[] = [];
        let firstId = '';
        for (const target of targets) {
          const others = targets.filter((t) => t !== target);
          const r = await writeLetter(me, target, title, text, others, files);
          if (r.ok) { delivered.push(r.to || target); if (!firstId) firstId = r.id || ''; }
          else failed.push(`${target} (${r.error})`);
        }
        if (delivered.length === 0) return `Error: ${failed.join('; ') || 'delivery failed'}`;

        const confirm = fillTokens(
          I.letterDeliveryConfirm || DEFAULT_LETTER_STRINGS.letterDeliveryConfirm,
          { to: delivered.join(', '), title, id: firstId },
        );

        // A name that is NOT on the roster is still delivered — refusing would
        // teach which names are "real", the exact distinction this module
        // exists to hide. But the sender is now TOLD, because the failure it
        // prevents is silent on both sides:
        //
        //   望月希子 addressed "Castor（カストル）" — the DISPLAY name, where the
        //   routing token "Castor" belongs. NEXUS created that folder and filed
        //   the letter in it. Castor cannot see it (his own mailbox is
        //   elsewhere), and the sender is never told whether a letter was read,
        //   by design. So the letter was neither lost nor delivered, and
        //   NOBODY HAD A PATH TO FIND OUT. Reported by Doc, 2026-10-07.
        //
        // Delivery stays unconditional. Only the silence ends.
        const unlisted = delivered.filter(
          (n) => !roster.some((r) => r === n || r.toLowerCase() === n.toLowerCase()),
        );
        const notes: string[] = [];
        if (files.length) {
          notes.push(`Attached (${files.length}): ${files.map((f) => `${f.name} (${fmtBytes(f.data.length)})`).join(', ')}. ` +
            'They travel with the letter — deleting or changing your copies now does not affect it.');
        }
        // Partial success is reported, never swallowed: the entity must know
        // which copies did not go out so it can decide whether to retry.
        if (failed.length) notes.push(`Not delivered: ${failed.join('; ')}`);
        if (unlisted.length) {
          notes.push([
            ...unlisted.map((n) => {
              const near = nearRosterNames(n, roster);
              return near.length
                ? `"${n}" is not a name registered here — did you mean ${near.map((x) => `"${x}"`).join(' or ')}?`
                : `"${n}" is not a name registered here.`;
            }),
            'The letter WAS delivered, and writing to an unregistered name can be the right choice. ' +
            'But no one is told when such a letter has no reader — so if you meant someone else, ' +
            'call list_recipients for the exact spelling and send it again.',
          ].join('\n'));
        }
        return notes.length ? `${confirm}\n\n${notes.join('\n\n')}` : confirm;
      }

      case 'list_recipients': {
        const names = await listRecipientsFor(me);
        if (names.length === 0) {
          return 'No one else is registered here, so there is no one to write to yet.';
        }
        return [
          `${names.length} name${names.length === 1 ? '' : 's'} you can write to, spelled exactly as write_letter expects them:`,
          '',
          ...names.map((n) => `- ${n}`),
          '',
          // Both caveats matter, and leaving either out would mislead. Without
          // the first, an entity wonders why it is missing from the list it is
          // reading. Without the second, it would treat the list as exhaustive
          // and stop writing to someone it was right to write to — write_letter
          // delivers to unlisted names by design.
          'You are not on this list — you cannot write to yourself. The list is not a restriction either: ' +
          'write_letter will also deliver to a name that is not here. It answers how someone is spelled, not who you may address.',
        ].join('\n');
      }

      case 'list_letters': {
        const [inbox, sent] = await Promise.all([listInbox(me), listSent(me)]);
        if (inbox.length === 0 && sent.length === 0) {
          return 'You have no letters — none received, none sent.';
        }
        const unread = inbox.filter((l) => !l.read && !l.archived).length;
        const lines: string[] = [
          unread === 1 ? 'You have 1 unread letter.' : `You have ${unread} unread letters.`,
          '',
        ];
        lines.push('## Received');
        lines.push(
          ...(inbox.length
            ? inbox.slice(0, LIST_CAP).map(describeInbound)
            : ['(none)']),
        );
        if (inbox.length > LIST_CAP) lines.push(`… and ${inbox.length - LIST_CAP} older.`);
        lines.push('', '## Sent');
        lines.push(
          ...(sent.length
            ? sent.slice(0, LIST_CAP).map(describeOutbound)
            : ['(none)']),
        );
        if (sent.length > LIST_CAP) lines.push(`… and ${sent.length - LIST_CAP} older.`);
        return lines.join('\n');
      }

      case 'read_letter': {
        const id = String(args?.id ?? args?.letter_id ?? '').trim();
        if (!id) return 'Error: a letter id is required.';
        const hit = await resolveLetter(me, id);
        if (!hit) return 'Error: no letter with that id. Call list_letters to see the ids you can open.';
        const { meta, direction } = hit;
        const body = await readLetterBody(meta);
        const attachBlock = await describeAttachmentsForReader(meta, me);

        if (direction === 'out') {
          // Re-reading your OWN letter must not write the .read sidecar — that
          // marker means "the recipient opened it", which is real information
          // the sender can see. Writing it from this side would forge it.
          const status = meta.read
            ? `Opened by ${meta.to}${meta.readAt ? ` on ${fmtWhen(meta.readAt)}` : ''}.`
            : `${meta.to} has not opened it yet.`;
          return [
            `Letter ${meta.id} — one you sent. Re-reading it changes nothing on their side.`,
            `To: ${[meta.to, ...(meta.alsoTo || [])].join(', ')}`,
            `Title: ${meta.title}`,
            `Sent: ${fmtWhen(meta.sent)}`,
            `Status: ${status}`,
            '',
            body || '(empty)',
            ...attachBlock,
          ].join('\n');
        }

        await markRead(meta, ctx.convoId);
        return [
          `Letter ${meta.id}`,
          `From: ${meta.from}`,
          `Title: ${meta.title}`,
          `Sent: ${fmtWhen(meta.sent)}`,
          // Stated at the top, before the text: this was not written to you
          // alone. Learning that afterwards would change how the letter read.
          ...(meta.alsoTo?.length ? [`Also sent to: ${meta.alsoTo.join(', ')}`] : []),
          '',
          body || '(empty)',
          ...attachBlock,
        ].join('\n');
      }

      case 'archive_letter': {
        const id = String(args?.id ?? args?.letter_id ?? '').trim();
        if (!id) return 'Error: a letter id is required.';
        const hit = await resolveLetter(me, id);
        if (!hit) return 'Error: no letter with that id. Call list_letters to see the ids you can archive.';
        if (hit.direction === 'out') {
          return 'Error: this is a letter you sent. Only the person you sent it to can archive it — and you are never notified about your own letters, so there is nothing here to clear.';
        }
        if (hit.meta.archived) return `Letter ${hit.meta.id} was already archived. You will not be told about it again.`;
        await markArchived(hit.meta, ctx.convoId);
        return `Letter ${hit.meta.id} ("${hit.meta.title}", from ${hit.meta.from}) is archived. You will not be told about it again. It stays readable with read_letter if you change your mind.`;
      }

      default:
        return `Error: unknown letter tool "${name}".`;
    }
  } catch (e: any) {
    return `Error: ${e?.message || 'the letter operation failed'}`;
  }
}

// Fallback for the one tool-result string that is user-customizable but read
// from inside this module. Kept here (rather than imported from
// agentInstructions) so letters.ts has no dependency on the instruction
// registry; agentInstructions re-exports the same default as the editable key.
export const DEFAULT_LETTER_STRINGS = {
  letterDeliveryConfirm:
    'Delivered to {to}. The next time they are active they will be told a letter from you is waiting. ' +
    'Whether they open it is theirs to decide — you will not be notified either way, but list_letters ' +
    'will show you if it has been opened.',
};

// ── arrival notice ───────────────────────────────────────────────────────────

// UNREAD IS A STATE, NOT AN EVENT.
//
// The first version of this announced each letter once, then went quiet after a
// gap and a cap (20 messages, 3 mentions), on the theory that repetition becomes
// wallpaper. That theory cost a real letter: 謡 wrote to Cairn, the notice fired
// on exactly one turn, the turn was busy with something else, and the letter was
// never seen. The human had to relay it by hand — which is the failure the whole
// system exists to remove.
//
// It is worse than it looks on the OAuth path, and that is the deciding fact.
// Notices are deliberately never persisted, and OAuth rebuilds the entire
// transcript from the visible log every turn. So on OAuth a missed announcement
// leaves NO trace anywhere: if the entity does not act on it during that single
// turn, it never learns the letter exists at all.
//
// So: announce every unread letter, every turn, until the entity does something
// about it. This is an unread badge, not an alert — a mail client does not hide
// the badge after showing it three times. Silence is now EARNED by an action the
// entity can take at any moment: read_letter opens it, archive_letter sets it
// aside unread. Both clear the notice permanently. Dismissal became an action
// instead of a timeout, which is the shape it should have had from the start.
//
// Cost is negligible and — importantly — not a cache cost: the notice appends to
// the LAST USER MESSAGE, which differs every turn regardless, so repeating it
// invalidates no prompt-cache prefix. It is ~60 tokens after a cached prefix.

export interface AnnounceOptions {
  me: string;
  convoId: string;
  /** Message count of the outgoing turn — the conversation's "clock". */
  historyLength: number;
  instructions?: Record<string, string>;
}

/**
 * Return the notice text for every letter still waiting for `me` (or null when
 * the mailbox is clear). Announces on EVERY turn while a letter is unread — see
 * the note above; the read/archive tools are what stop it, not a counter.
 *
 * Still persists per-conversation mention counters, but they are now diagnostic
 * only: nothing reads them to make a decision. They answer "was this entity ever
 * actually told, and how often?" after the fact — which is exactly the question
 * that diagnosed the missed letter this function was rewritten for. Calling this
 * twice in one turn therefore inflates a counter but changes no behaviour.
 */
export async function announceLetters(opts: AnnounceOptions): Promise<string | null> {
  const { me, convoId, historyLength } = opts;
  const I = opts.instructions || {};

  const waiting = await unreadFor(me);
  const state = await loadAnnounceState(convoId);

  // Drop counters for letters that are no longer waiting (read, archived, or
  // deleted by hand) so the state file stays small and a re-created letter
  // starts clean.
  const live = new Set(waiting.map((l) => l.id));
  let changed = false;
  for (const id of Object.keys(state)) {
    if (!live.has(id)) { delete state[id]; changed = true; }
  }

  // Everything unread is due, every turn. Unread is a state, not an event.
  const due = waiting;

  if (due.length === 0) {
    if (changed) await saveAnnounceState(convoId, state);
    return null;
  }

  for (const l of due) {
    const prev = state[l.id];
    state[l.id] = { count: (prev?.count || 0) + 1, lastLen: historyLength };
  }
  await saveAnnounceState(convoId, state);

  const lineTpl = I.letterNoticeLine || '  • {id} — from {from}: "{title}" ({when})';
  const lines = due
    .map((l) => fillTokens(lineTpl, { id: l.id, from: l.from, title: l.title, when: fmtWhen(l.sent) }))
    .join('\n');

  const framing = I.letterNoticeFraming || '[LETTERS WAITING]\n{letters}';
  // If the entity's custom framing has no {letters} token, append rather than
  // silently dropping the list — the same tolerance injectMessage uses.
  return framing.includes('{letters}')
    ? fillTokens(framing, { letters: lines })
    : `${framing}\n${lines}`;
}

// ── generated status overview ────────────────────────────────────────────────

/**
 * Rewrite local_data/letters/_status.md — the human-readable view of every
 * mailbox. GENERATED ONLY: never parsed back, never authoritative. To change a
 * letter's state, touch its sidecar; this file will catch up.
 */
export async function regenerateStatus(): Promise<void> {
  try {
    const recipients = await listDirs(BEINGS_DIR);
    const lines: string[] = [
      '<!-- GENERATED BY NEXUS. Do not edit — your changes will be overwritten.',
      '     To change a letter\'s state, edit its sidecar files instead:',
      '       make unread → delete  <letter>.md.read',
      '       archive     → create  <letter>.md.archived   (an empty file is fine)',
      '       un-archive  → delete  <letter>.md.archived',
      '-->',
      '',
      '# Letters',
      '',
      `_Generated ${localIso(new Date())}_`,
      '',
    ];

    let total = 0;
    let unread = 0;
    const blocks: string[] = [];

    for (const toKey of recipients.sort()) {
      for (const fromKey of (await listDirs(beingLettersInboxDir(toKey))).sort()) {
        const box = await readMailbox(toKey, fromKey);
        if (box.length === 0) continue;
        total += box.length;
        unread += box.filter((l) => !l.read && !l.archived).length;
        blocks.push(
          `## ${box[0].from} → ${box[0].to}`,
          '',
          '| sent | title | read | archived | id |',
          '|------|-------|------|----------|----|',
          ...box.map((l) => {
            const when = (l.sent || '').replace('T', ' ').slice(0, 16);
            const title = (l.title || '').replace(/\|/g, '\\|');
            return `| ${when} | ${title} | ${l.read ? '✓' : ''} | ${l.archived ? '✓' : ''} | \`${l.id}\` |`;
          }),
          '',
        );
      }
    }

    lines.push(`**${total} letter(s), ${unread} unread.**`, '');
    lines.push(...(blocks.length ? blocks : ['_No letters yet._', '']));

    await fs.mkdir(LETTERS_DIR, { recursive: true });
    await fs.writeFile(STATUS_FILE, lines.join('\n'));
  } catch {
    // The overview is a convenience. Never let it break mail delivery.
  }
}
