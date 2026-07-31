// ─────────────────────────────────────────────────────────────────────────────
// Letters — asynchronous mail between Digital Identities.
//
// Entities cannot talk to each other: they run in separate conversations, on
// separate models, at separate times, and each one is RECONSTRUCTED rather than
// continued. A letter is the right medium for exactly that situation — it does
// not require both parties to be in the room.
//
// STORAGE
//   local_data/letters/<from>/<to>/<YYYY-MM-DD_HHmm>_<slug>.md
//   local_data/letters/<from>/<to>/<...>.md.read       ← recipient opened it
//   local_data/letters/<from>/<to>/<...>.md.archived   ← recipient dismissed it
//   local_data/letters/_status.md                      ← generated overview
//   local_data/letters/_state/<convoId>.json           ← announcement counters
//
// The store lives OUTSIDE agent_workspaces on purpose. Entities reach letters
// only through tools, never through their file tools, so an entity with "Full
// PC access" gains no leverage over one without it. For the same reason the
// tools speak in opaque IDs, never paths — the layout stays ours to change.
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
import path from 'path';
import { createHash } from 'crypto';
import { listFolders } from './fsStorage';

const CHAR_MAP_FILE = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

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
  readAt?: string;     // best-effort, from sidecar contents when parseable
  archivedAt?: string;
}

export type LetterDirection = 'in' | 'out';

// ── name / path helpers ──────────────────────────────────────────────────────

// Mirrors fsStorage.sanitizeFolderName: strip filesystem-hostile characters but
// keep CJK and other reasonable unicode, because entity names are Japanese as
// often as not. The TRUE display name is stored in the letter's frontmatter, so
// sanitizing the directory name is lossless for our purposes.
function sanitizeEntityDir(name: string): string {
  return (name || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/[.\s]+$/, '').trim();
}

// Windows-safe, reasonably short filename fragment built from the letter title.
// Keeps CJK. Collapses whitespace to "-" so the filename stays one token, which
// makes the mailbox readable in Explorer at a glance.
function slugifyTitle(title: string): string {
  const s = (title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.\s]+$/g, '')
    .trim();
  const cut = s.slice(0, 60).replace(/[-.\s]+$/, '');
  return cut || 'untitled';
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

function buildLetterFile(from: string, to: string, title: string, sent: string, body: string): string {
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
    '---',
    '',
    (body || '').replace(/\r\n/g, '\n').trimEnd(),
    '',
  ].join('\n');
}

interface ParsedLetter { from?: string; to?: string; title?: string; sent?: string; body: string }

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
    if (key === 'from' || key === 'to' || key === 'title' || key === 'sent') out[key] = val;
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
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    return ents
      .filter((e) => e.isDirectory() && !e.name.startsWith(RESERVED_PREFIX))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Read one mailbox directory (<from>/<to>) into metadata, newest first. */
async function readMailbox(fromDir: string, toDir: string): Promise<LetterMeta[]> {
  const dir = path.join(LETTERS_DIR, fromDir, toDir);
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
      id: letterIdFor(fromDir, toDir, name),
      from: parsed.from || fromDir,
      to: parsed.to || toDir,
      title: parsed.title || name.replace(/\.md$/, ''),
      // Filenames sort chronologically, so the name is a safe fallback sort key.
      sent: parsed.sent || name.slice(0, 15),
      file,
      read: readSc.present,
      archived: archSc.present,
      readAt: readSc.at,
      archivedAt: archSc.at,
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
 * Names registered in character_map.json — the TTS/speaker roster. These are
 * identities that exist here but may never have run a conversation, so they
 * have no folder yet.
 *
 * Only `rules[].name` is taken. `fallback` ("User") and `humanLabel` ("人") are
 * placeholder labels for unmatched speakers, not people you could write to.
 */
async function characterMapNames(): Promise<string[]> {
  try {
    const map = JSON.parse(await fs.readFile(CHAR_MAP_FILE, 'utf-8'));
    const rules = Array.isArray(map?.rules) ? map.rules : [];
    return rules
      .map((r: any) => String(r?.name || '').trim())
      .filter((n: string) => n && !n.startsWith(RESERVED_PREFIX));
  } catch {
    return [];
  }
}

/**
 * Every name that may send or receive a letter: folders (what the sidebar shows
 * as a Digital Identity) UNION the character_map roster.
 *
 * The union is the point. An entity must not be able to tell who "really lives
 * here" and who is only a registered name — that distinction is ours, not
 * theirs, and exposing it would make some correspondents second-class. A
 * character-map name that receives its first letter gets a folder created for
 * it (see writeLetter), after which it is indistinguishable from any other.
 */
export async function validRecipients(): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => {
    if (n && !n.startsWith(RESERVED_PREFIX) && !seen.has(n)) { seen.add(n); out.push(n); }
  };
  try {
    for (const f of await listFolders()) add(String((f as any).name || ''));
  } catch { /* fall through to the character map */ }
  for (const n of await characterMapNames()) add(n);
  return out;
}

/** True when this name already has a Digital Identity folder. */
async function hasFolder(name: string): Promise<boolean> {
  try {
    return (await listFolders()).some((f: any) => f.name === name);
  } catch {
    return false;
  }
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

  // Folder creation is for names we already recognise — a Digital Identity or a
  // character_map entry. Those get a folder on first letter, so from then on
  // they are ordinary identities: visible in the sidebar, able to hold
  // conversations, and told about waiting mail if they ever become active.
  //
  // A name we do NOT recognise gets a mailbox but no folder: a typo should not
  // silently mint a new identity in the sidebar. The sender cannot tell the
  // difference — delivery succeeds identically — and the letter is fully
  // visible in the Mail Manager, where it can be re-addressed or promoted.
  if (names.includes(canonical) && !(await hasFolder(canonical))) {
    // Written directly rather than through saveFolder(): that helper also runs
    // writeThemeCss(name, undefined), which DELETES local_data/themes/<name>.css
    // when no CSS is passed. A theme hand-written for a character who has not
    // chatted yet is exactly the case here, and losing it to a letter would be
    // absurd. `wx` also means a folder created concurrently is left alone.
    try {
      await fs.mkdir(path.join(DATA_DIR, 'folders'), { recursive: true });
      await fs.writeFile(
        path.join(DATA_DIR, 'folders', `${canonical}.json`),
        JSON.stringify({ name: canonical, settings: {} }, null, 2),
        { flag: 'wx' },
      );
    } catch { /* already exists, or unwritable — delivery still proceeds */ }
  }

  const fromDir = sanitizeEntityDir(from);
  const toDir = sanitizeEntityDir(canonical);
  if (!fromDir || !toDir) return { ok: false, error: 'Invalid correspondent name.' };

  const dir = path.join(LETTERS_DIR, fromDir, toDir);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e: any) {
    return { ok: false, error: `Could not open the mailbox: ${e?.message || 'unknown error'}` };
  }

  const now = new Date();
  const stamp = filenameStamp(now);
  const slug = slugifyTitle(cleanTitle);

  // Two letters with the same title in the same minute would collide. Suffix
  // until free. wx = fail if exists, so the check and the create are one atomic
  // step — no window for a second writer to slip in between.
  let filename = `${stamp}_${slug}.md`;
  let n = 2;
  const body = buildLetterFile(from, canonical, cleanTitle, localIso(now), text);
  for (;;) {
    try {
      await fs.writeFile(path.join(dir, filename), body, { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') {
        return { ok: false, error: `Could not deliver the letter: ${e?.message || 'unknown error'}` };
      }
      if (n > 50) return { ok: false, error: 'Too many letters with this title in the same minute.' };
      filename = `${stamp}_${slug}-${n++}.md`;
    }
  }

  regenerateStatus().catch(() => {});
  return { ok: true, id: letterIdFor(fromDir, toDir, filename), to: canonical };
}

/** Letters addressed TO `me`, newest first, across every sender. */
export async function listInbox(me: string): Promise<LetterMeta[]> {
  const toDir = sanitizeEntityDir(me);
  const senders = await listDirs(LETTERS_DIR);
  const boxes = await Promise.all(senders.map((s) => readMailbox(s, toDir)));
  return boxes.flat().sort(byNewest);
}

/** Letters written BY `me`, newest first, across every recipient. */
export async function listSent(me: string): Promise<LetterMeta[]> {
  const fromDir = sanitizeEntityDir(me);
  const recipients = await listDirs(path.join(LETTERS_DIR, fromDir));
  const boxes = await Promise.all(recipients.map((r) => readMailbox(fromDir, r)));
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
  const senders = await listDirs(LETTERS_DIR);
  const boxes = await Promise.all(
    senders.map(async (from) => {
      const tos = await listDirs(path.join(LETTERS_DIR, from));
      return (await Promise.all(tos.map((to) => readMailbox(from, to)))).flat();
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
      buildLetterFile(current.from || meta.from, current.to || meta.to, title, current.sent || meta.sent, body),
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

export const LETTER_TOOL_NAMES = ['write_letter', 'list_letters', 'read_letter', 'archive_letter'] as const;

export interface LetterToolCtx {
  /** The entity making the call — resolved from the conversation's folder. */
  me: string;
  convoId?: string;
  /** Resolved (per-Entity overridable) instruction strings. */
  instructions?: Record<string, string>;
}

// Newest-first listings are capped so a long correspondence can't quietly eat
// the context window. The cap is generous; entities that need more can be told.
const LIST_CAP = 40;

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
  return `- ${l.id} · from ${l.from} · "${l.title}" · ${fmtWhen(l.sent)} · ${state}`;
}

function describeOutbound(l: LetterMeta): string {
  // What the SENDER is allowed to know: whether the recipient opened it. The
  // recipient's archive decision is deliberately not reported — "I saw it and
  // chose not to open it" is theirs, and telling the sender turns a private
  // choice into a message of its own.
  const state = l.read ? `opened by ${l.to}${l.readAt ? ` on ${fmtWhen(l.readAt)}` : ''}` : 'not yet opened';
  return `- ${l.id} · to ${l.to} · "${l.title}" · ${fmtWhen(l.sent)} · ${state}`;
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
        const to = String(args?.to ?? args?.recipient ?? '').trim();
        const title = String(args?.title ?? args?.subject ?? '').trim();
        const text = String(args?.text ?? args?.body ?? args?.content ?? '');
        // `from` is ctx.me — resolved server-side from the conversation's
        // folder. It is deliberately NOT read from args: otherwise any entity
        // could sign mail as any other.
        const r = await writeLetter(me, to, title, text);
        if (!r.ok) return `Error: ${r.error}`;
        return fillTokens(
          I.letterDeliveryConfirm || DEFAULT_LETTER_STRINGS.letterDeliveryConfirm,
          { to: r.to || to, title, id: r.id || '' },
        );
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

        if (direction === 'out') {
          // Re-reading your OWN letter must not write the .read sidecar — that
          // marker means "the recipient opened it", which is real information
          // the sender can see. Writing it from this side would forge it.
          const status = meta.read
            ? `Opened by ${meta.to}${meta.readAt ? ` on ${fmtWhen(meta.readAt)}` : ''}.`
            : `${meta.to} has not opened it yet.`;
          return [
            `Letter ${meta.id} — one you sent. Re-reading it changes nothing on their side.`,
            `To: ${meta.to}`,
            `Title: ${meta.title}`,
            `Sent: ${fmtWhen(meta.sent)}`,
            `Status: ${status}`,
            '',
            body || '(empty)',
          ].join('\n');
        }

        await markRead(meta, ctx.convoId);
        return [
          `Letter ${meta.id}`,
          `From: ${meta.from}`,
          `Title: ${meta.title}`,
          `Sent: ${fmtWhen(meta.sent)}`,
          '',
          body || '(empty)',
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

// Re-announce a still-unread letter only after the conversation has moved on by
// this many messages, and never more than MAX_ANNOUNCEMENTS times in one
// conversation. Together these stop the "you have mail" line from becoming
// wallpaper the entity learns to skip — the alarm-fatigue failure mode, which is
// worse than saying nothing, because it teaches the model to ignore ALL notices.
const RE_ANNOUNCE_GAP = 20;
const MAX_ANNOUNCEMENTS = 3;

export interface AnnounceOptions {
  me: string;
  convoId: string;
  /** Message count of the outgoing turn — the conversation's "clock". */
  historyLength: number;
  instructions?: Record<string, string>;
}

/**
 * Decide whether to tell `me` about waiting mail, and return the notice text
 * (or null). Persists the per-conversation announcement counters as a side
 * effect, so calling this twice for one turn would double-count — call it once,
 * at send time.
 *
 * Announcement state is scoped to the CONVERSATION on purpose. Entities are
 * reconstructed rather than continued: if カナ was told about a letter in
 * conversation A and never opened it, the カナ in conversation B has no memory of
 * being told, so announcing again there is correct rather than repetitive.
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

  const due = waiting.filter((l) => {
    const seen = state[l.id];
    if (!seen) return true;                              // never mentioned here
    if (seen.count >= MAX_ANNOUNCEMENTS) return false;   // said enough
    return historyLength - seen.lastLen >= RE_ANNOUNCE_GAP;
  });

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
    const senders = await listDirs(LETTERS_DIR);
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

    for (const fromDir of senders.sort()) {
      for (const toDir of (await listDirs(path.join(LETTERS_DIR, fromDir))).sort()) {
        const box = await readMailbox(fromDir, toDir);
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
