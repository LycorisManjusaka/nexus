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
// Scope is always ONE being's own logs (`folderName`), never the shared
// content-addressed store across beings — the isolation the original
// read_attachment design existed to preserve is about beings, not about
// conversations-within-a-being, so widening from "this conversation" to
// "this being's conversations" doesn't cross that line.
// ───────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { beingLogsDir } from './beingPaths';
import { readAttachmentText } from './attachmentStore';
import { isMediaMime } from './textSniff';
import { compileSafeRegex, grepLines } from './safeRegex';

export interface AttachmentIndexEntry {
  ref: string;
  name: string;
  size: number;
  mimeType: string;
}

interface AttachmentOccurrence extends AttachmentIndexEntry {
  convoTitle: string;
  convoId: string;
  timestamp: number | null;
}

/** Human-readable byte size, e.g. "340 KB", "1.2 MB". Used anywhere an
 * attachment index is rendered for a model (read_conversation, search_*). */
export function formatAttachmentSize(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** One `<ref12> "name" (size)` fragment — the shared rendering for an entry. */
export function formatAttachmentEntry(a: AttachmentIndexEntry): string {
  return `${a.ref.slice(0, 12)} "${a.name}" (${formatAttachmentSize(a.size)})`;
}

// Walk every conversation log of a being and collect every attachment
// reference it carries, tagged with which conversation and message-timestamp
// it came from. Not used on the per-turn hot path — see file header.
async function collectFolderAttachments(
  folderName: string,
  opts?: { excludeInactive?: boolean },
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
          if (typeof ref !== 'string' || !ref) continue;
          out.push({
            ref,
            name: String(att.name || 'unnamed'),
            size: Number(att.size || 0),
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
  return out;
}

export interface AttachmentSearchHit {
  ref: string;
  name: string;
  size: number;
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
  const empty: AttachmentSearchResult = { query: q, regex: useRegex, hits: [], attachmentsScanned: 0, attachmentsSkippedMedia: 0 };
  if (!folderName || !q) return empty;

  let compiled: RegExp | null = null;
  if (useRegex) {
    const c = compileSafeRegex(q);
    if (!c.ok) throw new Error(c.error);
    compiled = c.regex;
  }
  const needle = q.toLowerCase();

  const all = await collectFolderAttachments(folderName, { excludeInactive: opts?.excludeInactive });
  // One physical read per distinct ref, even if it's referenced from several
  // conversations/messages — re-scanning identical bytes twice would only
  // duplicate work. Keeps the FIRST occurrence's title/timestamp for display.
  const byRef = new Map<string, AttachmentOccurrence>();
  for (const a of all) if (!byRef.has(a.ref)) byRef.set(a.ref, a);

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
  return { query: q, regex: useRegex, hits, attachmentsScanned: scanned, attachmentsSkippedMedia: skippedMedia };
}

function fmtTs(ts: number | null): string {
  if (ts == null) return 'unknown date';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatAttachmentSearchForTool(r: AttachmentSearchResult): string {
  if (r.hits.length === 0) {
    const modeNote = r.regex ? ' (regex mode)' : '';
    return `No attachment content matches "${r.query}"${modeNote} — searched ${r.attachmentsScanned} text attachment(s)` +
      `${r.attachmentsSkippedMedia ? `, skipped ${r.attachmentsSkippedMedia} non-text attachment(s)` : ''}.`;
  }
  const lines: string[] = [];
  lines.push(`${r.hits.length} attachment(s) match "${r.query}"${r.regex ? ' (regex mode)' : ''}:`);
  for (const h of r.hits) {
    lines.push('');
    lines.push(`- ${formatAttachmentEntry(h)} — ${fmtTs(h.timestamp)}, from "${h.convoTitle}"`);
    for (const s of h.snippets) lines.push(`    ${s}`);
  }
  lines.push('');
  lines.push('Call read_attachment with the ref prefix shown above to read a match in full.');
  return lines.join('\n');
}
