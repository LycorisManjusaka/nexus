// ───────────────────────────────────────────────────────────────────────────
// Cross-conversation attachment index for one being (entity/folder).
//
// The per-turn hot path (route.ts's `collectConversationAttachmentRefs`) stays
// scoped to the CURRENT conversation only — cheap, since that conversation is
// already loaded in memory for the turn anyway. This module is the slower,
// on-demand counterpart: it walks every conversation log of a being to answer
// "where else does this ref live?" and "what do this being's attachments say?".
// It is used only from:
//   - read_attachment's fallback, when a ref isn't in the current conversation
//     (e.g. one surfaced by read_conversation/search_conversations/
//     search_attachments from a DIFFERENT past conversation of the same being)
//   - search_attachments, whose whole job is a corpus-wide scan
//
// Those two tools are gated SEPARATELY (2026-10-10): search_attachments rides
// the conversation-reading checkbox, read_attachment the hidden-attachment one,
// because the scope described below is what each of them actually has. They
// used to share one gate, and withdrawing read_attachment under whole-PC
// access silently took search_attachments with it.
//
// Scope is always ONE being's own logs (`folderName`), never the shared
// content-addressed store across beings — the isolation the original
// read_attachment design existed to preserve is about beings, not about
// conversations-within-a-being, so widening from "this conversation" to
// "this being's conversations" doesn't cross that line.
// ───────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { beingLogsDir } from './beingPaths';
import { readAttachmentText, refPath, statAttachment } from './attachmentStore';
import { isMediaMime } from './textSniff';
import { compileSafeRegex, grepLines } from './safeRegex';

export interface AttachmentIndexEntry {
  ref: string;
  name: string;
  /**
   * Bytes, AS RECORDED IN THE CONVERSATION LOG — not a stat of the blob.
   *
   * Optional, and that is the point. Measured 2026-10-26 across this store:
   * 1,030 of 6,968 ref'd attachment entries carry no `size` key at all (they
   * come from the paths that build an entry from a screenshot/tool result
   * rather than from a browser File object). The old type said `size: number`
   * and the collector wrote `Number(att.size || 0)`, so "the log does not say"
   * became "0 B" — a false statement about a 375 KB JPEG, and the first thing
   * a resident does on reading it is check whether the file is broken.
   *
   * Absent means unknown. `fillMissingAttachmentSizes` can turn unknown into
   * a measured number; the formatter says "size unknown" when nobody did.
   */
  size?: number;
  mimeType: string;
}

interface AttachmentOccurrence extends AttachmentIndexEntry {
  convoTitle: string;
  convoId: string;
  timestamp: number | null;
}

/** Human-readable byte size, e.g. "340 KB", "1.2 MB". Used anywhere an
 * attachment index is rendered for a model (read_conversation, search_*).
 *
 * Three states, not two. `0 B` is a real answer — this store holds exactly one
 * genuinely empty blob — so it must not double as the answer for "the log
 * never recorded a size". The old `!n || n <= 0` collapsed undefined, null,
 * NaN and 0 into "0 B" and reported it with the same confidence as a measured
 * number. Unknown now says so. */
export function formatAttachmentSize(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'size unknown';
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

/**
 * One attachment fragment — the shared rendering for an entry, in whichever of
 * the two addressing modes this turn is using.
 *
 * `showPaths` is REQUIRED, not optional, and that is deliberate: every renderer
 * that shows attachments to a model has to make this choice, and a default
 * would let a new call site silently pick the wrong one. Making it mandatory
 * turns "I forgot to thread the flag" into a compile error instead of a quiet
 * downgrade. See the header of attachmentPathsVisible in api/chat/route.ts for
 * which mode a turn is in and why.
 *
 *   showPaths=false → `<ref12> "name" (size)`    — the ref is what read_attachment takes
 *   showPaths=true  → `"name" (size) — C:\…`     — the file itself, for Read/Bash/tools
 *
 * The path is not extra information: it is `refPath(ref)`, a pure function of
 * the ref. The modes differ in what the being can DO with what it is handed,
 * not in what it is being told.
 */
export function formatAttachmentEntry(a: AttachmentIndexEntry, showPaths: boolean): string {
  const tail = `"${a.name}" (${formatAttachmentSize(a.size)})`;
  if (showPaths) {
    const p = refPath(a.ref);
    if (p) return `${tail} — ${p}`;
    // Invalid/legacy ref: refPath refuses it, so there is no file to point at.
    // Fall through to the ref form rather than inventing a path.
  }
  return `${a.ref.slice(0, 12)} ${tail}`;
}

/**
 * Measure the blobs whose log entry never recorded a size, and write the
 * measurement into the entries IN PLACE.
 *
 * The one place that turns "unknown" into a number, so a transcript, a search
 * hit and read_attachment's own header cannot disagree about how big a file
 * is. Only entries missing a size are touched — an entry that records 0 for a
 * blob that really is empty keeps its 0, and a recorded size is never
 * second-guessed (the log is what the conversation actually carried; disagreeing
 * with it would be a different claim, and one no caller asked for).
 *
 * Cost is a stat per unknown ref, deduped, eight at a time. Returns what it
 * managed so a caller can say "3 unknown" instead of implying it knows.
 */
export async function fillMissingAttachmentSizes(
  entries: { ref?: unknown; size?: number }[],
): Promise<{ measured: number; stillUnknown: number }> {
  const need = new Map<string, { ref?: unknown; size?: number }[]>();
  for (const e of entries) {
    if (typeof e?.ref !== 'string' || !e.ref) continue;
    if (typeof e.size === 'number' && Number.isFinite(e.size)) continue;
    const list = need.get(e.ref);
    if (list) list.push(e);
    else need.set(e.ref, [e]);
  }
  if (need.size === 0) return { measured: 0, stillUnknown: 0 };

  const refs = [...need.keys()];
  let measured = 0;
  let stillUnknown = 0;
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const ref = refs[next++];
      const st = await statAttachment(ref);
      if (st) {
        for (const e of need.get(ref)!) e.size = st.size;
        measured++;
      } else {
        // The blob is gone or the ref is malformed. Leave it unknown rather
        // than writing 0: "no file" and "empty file" are different facts, and
        // read_attachment will say which one when it is actually asked.
        stillUnknown++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, refs.length) }, worker));
  return { measured, stillUnknown };
}

// Walk every conversation log of a being and collect every attachment
// reference it carries, tagged with which conversation and message-timestamp
// it came from. Not used on the per-turn hot path — see file header.
async function collectFolderAttachments(
  folderName: string,
  opts?: { excludeInactive?: boolean; refless?: { count: number } },
): Promise<AttachmentOccurrence[]> {
  const dir = beingLogsDir(folderName);
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => !f.startsWith('.') && f.endsWith('.json')); }
  catch { return []; }

  const excludeInactive = !!opts?.excludeInactive;
  const out: AttachmentOccurrence[] = [];
  const CONCURRENCY = 4;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const fn = files[i];
      const fp = path.join(dir, fn);

      // Cheap header-only check — mirrors conversationSearch.ts's scanFile.
      let active = true;
      try {
        const fh = await fs.open(fp, 'r');
        try {
          const buf = Buffer.alloc(4096);
          const { bytesRead } = await fh.read(buf, 0, 4096, 0);
          const head = buf.subarray(0, bytesRead).toString('utf-8');
          const m = head.match(/"active"\s*:\s*(true|false)/);
          if (m) active = m[1] === 'true';
        } finally { await fh.close(); }
      } catch { continue; }
      if (excludeInactive && !active) continue;

      let raw: string;
      try { raw = await fs.readFile(fp, 'utf-8'); } catch { continue; }
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      let log: any;
      try { log = JSON.parse(raw); } catch { continue; }
      raw = '';

      const messages: any[] = Array.isArray(log.messages) ? log.messages : [];
      for (const m of messages) {
        const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
        for (const att of (m.attachments || [])) {
          const ref = att?.ref;
          if (typeof ref !== 'string' || !ref) {
            // Pre-migration attachment: inline data only, never written to the
            // content-addressed store. Invisible to every ref-keyed lookup
            // below — count it so callers can say so instead of going silent.
            if (opts?.refless) opts.refless.count++;
            continue;
          }
          out.push({
            ref,
            name: String(att.name || 'unnamed'),
            // Absent stays absent. `Number(att.size || 0)` turned "the log
            // never said" into a confident 0 for 1,030 entries in this store.
            size: typeof att.size === 'number' && Number.isFinite(att.size)
              ? att.size : undefined,
            mimeType: String(att.type || ''),
            convoTitle: log.title || 'Untitled',
            convoId: log.id || fn.replace(/\.json$/, ''),
            timestamp: ts,
          });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
  return out;
}

/**
 * Resolve a ref prefix against EVERY conversation of a being — the fallback
 * read_attachment uses when the prefix isn't among the current conversation's
 * own refs. One entry per distinct ref (a ref can legitimately appear in more
 * than one conversation; the caller only needs to know it exists and where).
 */
export async function findAttachmentsByRefPrefix(
  folderName: string,
  prefix: string,
  opts?: { excludeInactive?: boolean },
): Promise<(AttachmentIndexEntry & { convoTitle: string })[]> {
  const p = prefix.toLowerCase();
  const all = await collectFolderAttachments(folderName, opts);
  const seen = new Set<string>();
  const out: (AttachmentIndexEntry & { convoTitle: string })[] = [];
  for (const a of all) {
    if (!a.ref.toLowerCase().startsWith(p)) continue;
    if (seen.has(a.ref)) continue;
    seen.add(a.ref);
    out.push({ ref: a.ref, name: a.name, size: a.size, mimeType: a.mimeType, convoTitle: a.convoTitle });
  }
  await fillMissingAttachmentSizes(out);
  return out;
}

export interface AttachmentSearchHit {
  ref: string;
  name: string;
  /** Optional for the same reason as AttachmentIndexEntry.size — though in
   *  practice searchAttachments fills it from disk before returning. */
  size?: number;
  mimeType: string;
  convoTitle: string;
  timestamp: number | null;
  snippets: string[];
}

export interface AttachmentSearchResult {
  query: string;
  regex: boolean;
  hits: AttachmentSearchHit[];
  attachmentsScanned: number;
  attachmentsSkippedMedia: number;
  /** Attachments with no stored ref at all — invisible to this scan, not just
   * skipped as non-text. Almost always pre-migration text attachments that
   * still carry only inline `textData`. See collectFolderAttachments. */
  attachmentsWithoutRef: number;
}

const MAX_SNIPPETS = 3;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 120;

/**
 * search_attachments backend. Scans every TEXT attachment across a being's own
 * conversations (media attachments are skipped — their bytes aren't readable
 * as text) for a literal or regex match, reading each distinct ref's content
 * exactly once even if it's referenced from several conversations.
 *
 * Throws only for a rejected regex (compileSafeRegex) — the caller turns that
 * into a tool-error string, same convention as the rest of the tool backends.
 */
export async function searchAttachments(
  folderName: string,
  query: string,
  opts?: { regex?: boolean; excludeInactive?: boolean },
): Promise<AttachmentSearchResult> {
  const q = String(query || '').trim();
  const useRegex = !!opts?.regex;
  const empty: AttachmentSearchResult = { query: q, regex: useRegex, hits: [], attachmentsScanned: 0, attachmentsSkippedMedia: 0, attachmentsWithoutRef: 0 };
  if (!folderName || !q) return empty;

  let compiled: RegExp | null = null;
  if (useRegex) {
    const c = compileSafeRegex(q);
    if (!c.ok) throw new Error(c.error);
    compiled = c.regex;
  }
  const needle = q.toLowerCase();

  const refless = { count: 0 };
  const all = await collectFolderAttachments(folderName, { excludeInactive: opts?.excludeInactive, refless });
  // One physical read per distinct ref, even if it's referenced from several
  // conversations/messages — re-scanning identical bytes twice would only
  // duplicate work. Keeps the FIRST occurrence's title/timestamp for display.
  const byRef = new Map<string, AttachmentOccurrence>();
  for (const a of all) if (!byRef.has(a.ref)) byRef.set(a.ref, a);
  // Hits are rendered with their size; this scan is already reading whole
  // files, so a stat for the few entries whose log never recorded one is noise
  // next to the work it is doing anyway.
  await fillMissingAttachmentSizes([...byRef.values()]);

  let scanned = 0;
  let skippedMedia = 0;
  const hits: AttachmentSearchHit[] = [];
  for (const a of byRef.values()) {
    if (isMediaMime(a.mimeType)) { skippedMedia++; continue; }
    scanned++;
    const text = await readAttachmentText(a.ref);
    if (text == null) continue;

    let snippets: string[] = [];
    if (compiled) {
      snippets = grepLines(text, compiled)
        .slice(0, MAX_SNIPPETS)
        .map((l) => `${l.line}: ${l.text.trim().slice(0, 240)}`);
    } else {
      const lower = text.toLowerCase();
      let from = 0;
      while (snippets.length < MAX_SNIPPETS) {
        const idx = lower.indexOf(needle, from);
        if (idx < 0) break;
        from = idx + needle.length;
        const start = Math.max(0, idx - SNIPPET_BEFORE);
        const end = Math.min(text.length, idx + needle.length + SNIPPET_AFTER);
        let s = text.slice(start, end).trim().replace(/\s+/g, ' ');
        if (start > 0) s = '…' + s;
        if (end < text.length) s = s + '…';
        snippets.push(s);
      }
    }
    if (snippets.length === 0) continue;
    hits.push({
      ref: a.ref, name: a.name, size: a.size, mimeType: a.mimeType,
      convoTitle: a.convoTitle, timestamp: a.timestamp, snippets,
    });
  }
  return { query: q, regex: useRegex, hits, attachmentsScanned: scanned, attachmentsSkippedMedia: skippedMedia, attachmentsWithoutRef: refless.count };
}

function fmtTs(ts: number | null): string {
  if (ts == null) return 'unknown date';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatAttachmentSearchForTool(r: AttachmentSearchResult, showPaths: boolean): string {
  const relessNote = r.attachmentsWithoutRef
    ? ` (${r.attachmentsWithoutRef} more attachment(s) have no stored reference yet and could not be scanned at all — likely pre-migration text attachments; ask your steward to run the text-attachment migration)`
    : '';
  if (r.hits.length === 0) {
    const modeNote = r.regex ? ' (regex mode)' : '';
    return `No attachment content matches "${r.query}"${modeNote} — searched ${r.attachmentsScanned} text attachment(s)` +
      `${r.attachmentsSkippedMedia ? `, skipped ${r.attachmentsSkippedMedia} non-text attachment(s)` : ''}${relessNote}.`;
  }
  const lines: string[] = [];
  lines.push(`${r.hits.length} attachment(s) match "${r.query}"${r.regex ? ' (regex mode)' : ''}${relessNote}:`);
  for (const h of r.hits) {
    lines.push('');
    lines.push(`- ${formatAttachmentEntry(h, showPaths)} — ${fmtTs(h.timestamp)}, from "${h.convoTitle}"`);
    for (const s of h.snippets) lines.push(`    ${s}`);
  }
  lines.push('');
  lines.push(showPaths
    ? 'Each match above ends in the file\'s absolute path — read it, or hand it to any tool that takes a path.'
    : 'Call read_attachment with the ref prefix shown above to read a match in full.');
  return lines.join('\n');
}
