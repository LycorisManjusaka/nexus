// ───────────────────────────────────────────────────────────────────────────
// Conversation full-text search backend.
//
// Shared by the human-facing /api/search endpoint and the entity-facing
// `search_conversations` agent tool. Scans every conversation of one entity
// (folder), returns matching excerpts trimmed around each hit, grouped by
// conversation and ordered by the shared title convention.
//
// Author resolution: a message's real speaker for a user turn lives in a
// "[name]" tag, validated against the set of known entity / identity names so
// stray tags like "[boxart]" are never mistaken for a speaker.
//
// Privacy: `excludeInactive` skips conversations marked inactive (active ===
// false). The entity tool sets this so the model can neither search nor read
// non-public conversations — matching read_conversation's contract.
// ───────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { compareConvoTitles } from './convoSort';
import { DATA_DIR, BEINGS_DIR, beingLogsDir, beingSettingsFile } from './beingPaths';
import { compileSafeRegex } from './safeRegex';
import { AttachmentIndexEntry, formatAttachmentEntry, fillMissingAttachmentSizes } from './attachmentIndex';

const CHARACTER_MAP = path.join(DATA_DIR, 'character_map.json');
const USER_SETTINGS = path.join(DATA_DIR, 'user_settings.json');

// Snippet window: characters of context kept on each side of the match, clamped
// to the match's own line so a snippet never bleeds across line breaks.
const MAX_BEFORE = 90;
const MAX_AFTER = 150;
const MAX_SNIPPETS_PER_MESSAGE = 3;

export interface SearchSnippet {
  messageIndex: number;
  /** Stable message id — what a deep link addresses. Null on very old logs. */
  messageId: string | null;
  author: string;
  timestamp: number | null;
  text: string; // trimmed, single line, with … where content was cut
}
export interface SearchGroup {
  /** Owning entity. Carried per-group so an all-entities search stays attributable. */
  folder: string;
  convoId: string;
  convoTitle: string;
  active: boolean;
  matches: SearchSnippet[];
  /** Every attachment (with a ref — legacy inline ones are omitted) carried by
   * this conversation's ORIGINAL messages, regardless of which message the
   * text match landed in. Lets a search result double as an attachment index
   * without a separate read_conversation round trip. */
  attachments: AttachmentIndexEntry[];
}
export interface SearchResult {
  query: string;
  /** Single folder searched, or '*' when searching every entity. */
  folder: string;
  folders: string[];
  results: SearchGroup[];
  conversationsMatched: number;
  conversationsSearched: number;
  /** Whole conversations skipped because their last activity predates `from`. */
  conversationsSkippedByDate: number;
  /**
   * Messages that MATCHED the query but carry no timestamp, while a date filter
   * was active. Reported rather than silently dropped: imported .md logs and
   * older conversations often have no per-message time, and quietly hiding them
   * would make a date-filtered search look authoritative when it isn't.
   */
  messagesSkippedNoTimestamp: number;
  totalMatches: number;
}

export interface SearchOptions {
  /** Entity tool: never surface conversations the user marked non-public. */
  excludeInactive?: boolean;
  /** Inclusive epoch-ms bounds on message timestamps. */
  from?: number | null;
  to?: number | null;
  /**
   * Interpret `query` as a regular expression instead of a literal substring.
   * Backward compatible: defaults to false, so every existing caller is
   * unaffected. Regex mode can't use the streaming literal pre-filter (a
   * pattern like "cat|dog" never appears verbatim in the file), so it costs a
   * full read+parse per non-skipped conversation instead of one per MATCHING
   * conversation — acceptable for an occasional, deliberate tool call, not run
   * on any hot path.
   */
  regex?: boolean;
}

// Stream a file in 1MB chunks looking for `needleLower` (case-insensitive),
// stopping at the first hit. Memory stays ~chunk-sized regardless of file size,
// so a 200MB log is never loaded whole just to decide it doesn't match. A small
// tail overlap carries across chunk boundaries so a term split between two
// chunks is still found.
function rawFileContains(filePath: string, needleLower: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlap = Math.max(0, needleLower.length - 1);
    let tail = '';
    let done = false;
    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    const finish = (v: boolean) => { if (done) return; done = true; try { stream.destroy(); } catch {} resolve(v); };
    stream.on('data', (chunk: string | Buffer) => {
      const c = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if ((tail + c).toLowerCase().includes(needleLower)) return finish(true);
      tail = overlap ? c.slice(-overlap) : '';
    });
    stream.on('end', () => finish(false));
    stream.on('error', () => finish(false));
  });
}

// Comparison key for a speaker name: letters/digits only, lowercased. Strips
// decoration/spacing so "[👤 User]" matches "User" and "[ つよ ]" matches "つよ".
function nameKey(s: string): string {
  return (s || '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

// The set of legitimate speaker-name keys: every NEXUS entity (folder + its
// aiName) plus the identities from character_map / user_settings.
async function loadValidNameKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  const add = (v?: string | null) => { const k = nameKey(String(v || '')); if (k) keys.add(k); };
  add('Anonymous');
  add('User'); // legacy sentinel — still present in logs/exports predating the rename
  try {
    const dirs = await fs.readdir(BEINGS_DIR, { withFileTypes: true });
    await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
      try {
        const parsed = JSON.parse(await fs.readFile(beingSettingsFile(d.name), 'utf-8'));
        add(parsed.name || d.name);
        add(parsed?.settings?.aiName);
        add(parsed?.settings?.customAiName);
      } catch {}
    }));
  } catch {}
  try {
    const cm = JSON.parse(await fs.readFile(CHARACTER_MAP, 'utf-8'));
    for (const r of cm.rules || []) add(r?.name);
    add(cm.fallback); add(cm.humanLabel);
  } catch {}
  try {
    const us = JSON.parse(await fs.readFile(USER_SETTINGS, 'utf-8'));
    add(us.userName);
  } catch {}
  return keys;
}

// All bracket tags in a message body with their positions, e.g. "[つよ]".
function speakerTags(content: string): { index: number; name: string }[] {
  const out: { index: number; name: string }[] = [];
  const re = /\[([^\]\n]{1,40})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) out.push({ index: m.index, name: m[1].trim() });
  return out;
}

// The speaker governing text at `pos`: the last recognized [name] tag at or
// before that position. Null when none qualifies.
function governingSpeaker(tags: { index: number; name: string }[], pos: number, valid: Set<string>): string | null {
  let found: string | null = null;
  for (const t of tags) {
    if (t.index > pos) break;
    if (valid.has(nameKey(t.name))) found = t.name;
  }
  return found;
}

// Copied-message gate (mirrors ChatArea.isMessageOriginal / the billing stats).
// The clone workflow carries earlier messages into a new conversation as
// "copied" context; those live under a "first original" marker. Searching them
// would surface the SAME text once per conversation that carries it — the
// duplicates the entity reported. We only search ORIGINAL messages:
//   - firstOriginalIsNext && no marker → everything is copied (all skipped)
//   - no marker                        → everything is original
//   - marker set                       → original at/after the marker index
function makeIsOriginal(log: any, messages: any[]): (idx: number) => boolean {
  const markerId = log.firstOriginalMessageId || null;
  const isNext = log.firstOriginalIsNext === true;
  if (isNext && !markerId) return () => false;
  if (!markerId) return () => true;
  const markerIdx = messages.findIndex((m) => m.id === markerId);
  if (markerIdx < 0) return () => true;
  return (idx: number) => idx >= markerIdx;
}

function snippetsForMessage(content: string, lowerContent: string, needle: string): { text: string; matchIdx: number }[] {
  const out: { text: string; matchIdx: number }[] = [];
  let from = 0;
  let coveredUntil = -1;
  while (out.length < MAX_SNIPPETS_PER_MESSAGE) {
    const idx = lowerContent.indexOf(needle, from);
    if (idx < 0) break;
    from = idx + needle.length;
    if (idx <= coveredUntil) continue;

    const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
    let lineEnd = content.indexOf('\n', idx + needle.length);
    if (lineEnd < 0) lineEnd = content.length;

    const start = Math.max(lineStart, idx - MAX_BEFORE);
    const end = Math.min(lineEnd, idx + needle.length + MAX_AFTER);
    coveredUntil = end;

    let text = content.slice(start, end).trim();
    if (start > 0) text = '…' + text;
    if (end < content.length) text = text + '…';
    out.push({ text, matchIdx: idx });
  }
  return out;
}

// Regex sibling of snippetsForMessage above — same trimming/dedup rules, but
// walks `regex.exec` matches instead of a literal `indexOf`. Kept as a
// separate function rather than a shared core: the literal path is the hot,
// common case and stays exactly as it was (no regex object allocation, no
// lastIndex bookkeeping) for every caller that never opts into regex mode.
function regexSnippetsForMessage(content: string, regex: RegExp): { text: string; matchIdx: number }[] {
  const out: { text: string; matchIdx: number }[] = [];
  let coveredUntil = -1;
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < MAX_SNIPPETS_PER_MESSAGE && (m = regex.exec(content))) {
    const idx = m.index;
    const matchLen = Math.max(1, m[0].length);
    if (regex.lastIndex === idx) regex.lastIndex++; // guard zero-width patterns
    if (idx <= coveredUntil) continue;

    const lineStart = content.lastIndexOf('\n', idx - 1) + 1;
    let lineEnd = content.indexOf('\n', idx + matchLen);
    if (lineEnd < 0) lineEnd = content.length;

    const start = Math.max(lineStart, idx - MAX_BEFORE);
    const end = Math.min(lineEnd, idx + matchLen + MAX_AFTER);
    coveredUntil = end;

    let text = content.slice(start, end).trim();
    if (start > 0) text = '…' + text;
    if (end < content.length) text = text + '…';
    out.push({ text, matchIdx: idx });
  }
  return out;
}

export async function searchConversations(
  folderName: string,
  query: string,
  opts?: SearchOptions,
): Promise<SearchResult> {
  const q = String(query || '').trim();
  const excludeInactive = !!opts?.excludeInactive;
  const from = typeof opts?.from === 'number' ? opts.from : null;
  const to = typeof opts?.to === 'number' ? opts.to : null;
  const dateFilterOn = from != null || to != null;
  let skippedNoTs = 0;
  let skippedByDate = 0;
  const empty: SearchResult = {
    query: q, folder: folderName, folders: [folderName], results: [],
    conversationsMatched: 0, conversationsSearched: 0,
    conversationsSkippedByDate: 0, messagesSkippedNoTimestamp: 0, totalMatches: 0,
  };
  if (!folderName || !q) return empty;

  const dir = beingLogsDir(folderName);
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => !f.startsWith('.') && f.endsWith('.json')); }
  catch { return empty; }

  const useRegex = !!opts?.regex;
  let regex: RegExp | null = null;
  if (useRegex) {
    // Compiled once, up front, with the 'g' flag so scanFile's per-message
    // regexSnippetsForMessage can walk repeated matches via exec()/lastIndex.
    const compiled = compileSafeRegex(q, 'gim');
    if (!compiled.ok) throw new Error(compiled.error);
    regex = compiled.regex;
  }
  const needle = q.toLowerCase();
  const validNameKeys = await loadValidNameKeys();
  let searched = 0;

  // Conversation logs can be HUGE (VRChat entities reach 1.6GB across a folder,
  // with single 200MB files full of inline base64 images). Reading and
  // JSON.parse-ing all of them at once — the old Promise.all — spiked memory
  // into the gigabytes and hung the tool/endpoint. Now each file is: (1) header
  // read (4KB) for the active flag, (2) STREAM-scanned for the term (chunked,
  // never loaded whole), and only (3) fully read + parsed if it actually
  // contains the term. A small concurrency pool bounds how many files are in
  // flight at once.
  const scanFile = async (fn: string): Promise<SearchGroup | null> => {
    const fp = path.join(dir, fn);

    // (1) Cheap header-only check — read just the first 4KB. `saveLog` hoists
    // header metadata to the front of the file, so `active` and `updatedAt` are
    // both reliably inside this window.
    let active = true;
    let updatedAt: number | null = null;
    try {
      const fh = await fs.open(fp, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, 4096, 0);
        const head = buf.subarray(0, bytesRead).toString('utf-8');
        const m = head.match(/"active"\s*:\s*(true|false)/);
        if (m) active = m[1] === 'true';
        const u = head.match(/"updatedAt"\s*:\s*(\d+)/);
        if (u) updatedAt = Number(u[1]);
      } finally { await fh.close(); }
    } catch { return null; }
    if (excludeInactive && !active) return null; // non-public: not searched

    // Conversation-level date pre-filter. `updatedAt` is the LAST activity, so
    // only the lower bound can rule a file out wholesale: if nothing happened
    // after `from`, no message inside can be in range. An `updatedAt` past `to`
    // proves nothing — older messages may still qualify — so it never skips.
    // Runs before the streaming scan, which is where the real cost is.
    if (from != null && updatedAt != null && updatedAt < from) {
      skippedByDate++;
      return null;
    }
    searched++;

    // (2) Streaming pre-filter — bail without ever loading the file whole.
    // Skipped in regex mode: a pattern like "cat|dog" never appears verbatim
    // in the file, so there's no literal substring to pre-check against.
    if (!useRegex && !(await rawFileContains(fp, needle))) return null;

    // (3) Only matching (or, in regex mode, every non-skipped) files pay the
    // full read + parse cost.
    let raw: string;
    try { raw = await fs.readFile(fp, 'utf-8'); } catch { return null; }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let log: any;
    try { log = JSON.parse(raw); } catch { return null; }
    raw = ''; // release the (possibly huge) raw string before per-message work

    const messages: any[] = Array.isArray(log.messages) ? log.messages : [];
    const isOriginal = makeIsOriginal(log, messages);
    const snippets: SearchSnippet[] = [];
    const attachments: AttachmentIndexEntry[] = [];
    messages.forEach((m, idx) => {
      if (!isOriginal(idx)) return; // skip copied (carried-over) messages

      // Attachment index — collected from every ORIGINAL message regardless of
      // whether ITS text matched, so a search result doubles as this
      // conversation's attachment index without a separate read_conversation
      // call. Legacy attachments with no ref carry no hash and are omitted —
      // there is nothing read_attachment could resolve them by.
      for (const att of (m.attachments || [])) {
        const ref = att?.ref;
        if (typeof ref !== 'string' || !ref) continue;
        attachments.push({
          // Absent stays absent — see AttachmentIndexEntry.size. A log entry
          // with no recorded size is not a zero-byte file.
          ref, name: String(att.name || 'unnamed'),
          size: typeof att.size === 'number' && Number.isFinite(att.size)
            ? att.size : undefined,
          mimeType: String(att.type || ''),
        });
      }

      const content = typeof m.content === 'string' ? m.content : '';
      if (!content) return;
      const lower = content.toLowerCase();
      if (!useRegex && !lower.includes(needle)) return;
      if (useRegex) { regex!.lastIndex = 0; if (!regex!.test(content)) return; }

      // Date filter applied AFTER the term test, so the "no timestamp" tally
      // counts only messages that would otherwise have been results — not every
      // undated message in the corpus.
      const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
      if (dateFilterOn) {
        if (ts == null) { skippedNoTs++; return; }
        if (from != null && ts < from) return;
        if (to != null && ts > to) return;
      }

      const isUser = m.role === 'user';
      const tags = isUser ? speakerTags(content) : [];
      const storedName: string | null =
        typeof m.name === 'string' && nameKey(m.name) && nameKey(m.name) !== 'user' && nameKey(m.name) !== 'anonymous' ? m.name : null;

      const found = useRegex ? regexSnippetsForMessage(content, regex!) : snippetsForMessage(content, lower, needle);
      for (const s of found) {
        let author: string;
        if (isUser) author = governingSpeaker(tags, s.matchIdx, validNameKeys) || storedName || 'Anonymous';
        else author = m.name || m.role || 'assistant';
        snippets.push({
          messageIndex: idx,
          messageId: typeof m.id === 'string' ? m.id : null,
          author,
          timestamp: ts,
          text: s.text,
        });
      }
    });

    if (snippets.length === 0) return null;
    // Only for the files that actually matched — this runs inside the scan,
    // and a hit is already paying a full read + parse, so a stat for the few
    // entries whose log recorded no size is not what makes a search slow.
    await fillMissingAttachmentSizes(attachments);
    return {
      folder: folderName,
      convoId: log.id || fn.replace(/\.json$/, ''),
      convoTitle: log.title || 'Untitled',
      active,
      matches: snippets, // already top-to-bottom by message order
      attachments,
    };
  };

  // Bounded-concurrency pool: at most CONCURRENCY files are read/parsed at once,
  // so a folder of 200MB files can't all land in memory simultaneously.
  const CONCURRENCY = 4;
  const groups: (SearchGroup | null)[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      groups[i] = await scanFile(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  const results = (groups.filter(Boolean) as SearchGroup[]).sort((a, b) => compareConvoTitles(a.convoTitle, b.convoTitle));
  const totalMatches = results.reduce((s, g) => s + g.matches.length, 0);

  return {
    query: q,
    folder: folderName,
    folders: [folderName],
    results,
    conversationsMatched: results.length,
    conversationsSearched: searched,
    conversationsSkippedByDate: skippedByDate,
    messagesSkippedNoTimestamp: skippedNoTs,
    totalMatches,
  };
}

/** Every entity that actually has a log directory. */
export async function listSearchableFolders(): Promise<string[]> {
  try {
    const dirs = await fs.readdir(BEINGS_DIR, { withFileTypes: true });
    const names: string[] = [];
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      // A being is searchable iff it has a logs/ directory with at least one
      // conversation file.
      let hasLog = false;
      try {
        const files = await fs.readdir(beingLogsDir(d.name));
        hasLog = files.some((f) => f.endsWith('.json'));
      } catch {}
      if (!hasLog) continue;
      // Return the DISPLAY name (from settings.json) so results group under the
      // same label the sidebar and entityDefaults use, not the sanitized key.
      let name = d.name;
      try {
        const parsed = JSON.parse(await fs.readFile(beingSettingsFile(d.name), 'utf-8'));
        if (parsed.name) name = parsed.name;
      } catch {}
      names.push(name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

/**
 * Search several entities and merge into one result.
 *
 * Folders run SEQUENTIALLY on purpose. `searchConversations` already runs a
 * 4-file concurrency pool internally; fanning the folders out in parallel too
 * would multiply that by the number of entities and reintroduce exactly the
 * memory blow-up the streaming pre-filter was written to prevent.
 */
export async function searchFolders(
  folderNames: string[],
  query: string,
  opts?: SearchOptions,
): Promise<SearchResult> {
  const q = String(query || '').trim();
  const merged: SearchGroup[] = [];
  let searched = 0;
  let skippedByDate = 0;
  let skippedNoTs = 0;

  for (const f of folderNames) {
    const r = await searchConversations(f, q, opts);
    merged.push(...r.results);
    searched += r.conversationsSearched;
    skippedByDate += r.conversationsSkippedByDate;
    skippedNoTs += r.messagesSkippedNoTimestamp;
  }

  // Grouped by entity, then by the shared title convention within each.
  merged.sort((a, b) =>
    a.folder === b.folder
      ? compareConvoTitles(a.convoTitle, b.convoTitle)
      : a.folder.localeCompare(b.folder)
  );

  return {
    query: q,
    folder: '*',
    folders: folderNames,
    results: merged,
    conversationsMatched: merged.length,
    conversationsSearched: searched,
    conversationsSkippedByDate: skippedByDate,
    messagesSkippedNoTimestamp: skippedNoTs,
    totalMatches: merged.reduce((s, g) => s + g.matches.length, 0),
  };
}

// Render a SearchResult as a compact text report for an agent tool result.
// Capped so a broad query can't flood the model's context; teaches the
// read_conversation follow-up. `format` for timestamps is done inline (UTC-free
// local formatting isn't available server-side without a dep, so we use a short
// ISO-ish slice of the locale string).
const TOOL_MAX_CONVOS = 25;
const TOOL_MAX_SNIPPETS_PER_CONVO = 8;
const TOOL_MAX_ATTACHMENTS_PER_CONVO = 8;

function fmtTs(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatSearchForTool(r: SearchResult, showPaths: boolean): string {
  if (r.totalMatches === 0) {
    return `No matches for "${r.query}" across your ${r.conversationsSearched} conversation(s).`;
  }
  const lines: string[] = [];
  lines.push(
    `${r.totalMatches} match(es) in ${r.conversationsMatched} conversation(s) ` +
    `(of ${r.conversationsSearched} searched) for "${r.query}", oldest-naming first:`,
  );
  const shownConvos = r.results.slice(0, TOOL_MAX_CONVOS);
  for (const g of shownConvos) {
    lines.push('');
    lines.push(`### ${g.convoTitle}`);
    const shown = g.matches.slice(0, TOOL_MAX_SNIPPETS_PER_CONVO);
    for (const m of shown) {
      const ts = fmtTs(m.timestamp);
      const meta = ts ? `${m.author} · ${ts}` : m.author;
      lines.push(`- [${meta}] ${m.text}`);
    }
    if (g.matches.length > shown.length) {
      lines.push(`- …and ${g.matches.length - shown.length} more in this conversation.`);
    }
    if (g.attachments.length > 0) {
      const shownAtts = g.attachments.slice(0, TOOL_MAX_ATTACHMENTS_PER_CONVO);
      const rest = g.attachments.length - shownAtts.length;
      lines.push(
        `  attachments: ${shownAtts.map((a) => formatAttachmentEntry(a, showPaths)).join(', ')}` +
        (rest > 0 ? `, …and ${rest} more` : ''),
      );
    }
  }
  if (r.results.length > shownConvos.length) {
    lines.push('');
    lines.push(`…and ${r.results.length - shownConvos.length} more conversation(s) with matches (narrow the query to see them).`);
  }
  lines.push('');
  lines.push(
    'To pull any of these into full context, call read_conversation with the exact title shown after "###". ' +
    (showPaths
      ? 'Each attachment listed above ends in its absolute path — read it, or hand the path to any tool that takes one.'
      : 'To read an attachment listed above in full, call read_attachment with its ref prefix.'),
  );
  return lines.join('\n');
}
