// ───────────────────────────────────────────────────────────────────────────
// read_conversation tool backend.
//
// Finds a past conversation BY NAME (title) within the same entity folder and
// returns it in one of two shapes:
//
//   inline — the whole transcript as text, injected into context for this turn
//            only. Used when the conversation is small, or when the caller has
//            no file tools to open a path with.
//
//   file   — the transcript written to a MIRROR file under the being's own
//            workspace (workspace/logs/<title>__<id>.md), with only the path
//            and some metadata returned. The being then dissects it with
//            Grep/Read and pays only for the parts it actually needs.
//
// The file shape exists because a large transcript injected inline is a
// one-way cost: it sits in the context window for the rest of the session and
// pushes the conversation toward auto-compaction. Beings with file tools were
// already improvising around this ("don't take it raw — extract it and grep
// it"); this makes the supported path the obvious one. It is the same shape
// search_attachments → read_attachment(ref) already uses.
//
// Privacy rule: conversations marked inactive (active === false) are
// "non-public" and MUST be refused — the AI is never allowed to read them.
// Because the mirror is a real file that outlives the turn, that rule needs a
// second enforcement point: every call SWEEPS the mirror directory and unlinks
// any mirror whose source conversation is now inactive, deleted, renamed, or
// moved to another being. Without the sweep, flipping a conversation to
// inactive would leave a readable stale copy behind — a privacy-guard bypass,
// not just staleness.
//
// Mirrors are generated lazily (on read), never kept in sync in the
// background. There is exactly one writer: this module, during a
// read_conversation call.
// ───────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import { listLogs, loadLog, ensureWorkspace } from './fsStorage';
import { formatAttachmentEntry, formatAttachmentSize, fillMissingAttachmentSizes } from './attachmentIndex';

/** Subdirectory of the being's workspace holding conversation mirrors. */
export const MIRROR_SUBDIR = 'logs';

/** First line of every generated mirror. The sweep only deletes files that
 *  carry it, so a being's own notes dropped into workspace/logs/ are safe. */
const MIRROR_MARKER = '<!-- nexus:conversation-mirror v1 -->';

/** Transcripts at or below this many characters are returned inline — one
 *  round trip is cheaper than a path plus a Read for something this small.
 *  ~20K chars ≈ 5–7K tokens. */
const INLINE_MAX_CHARS = 20000;

export interface ReadConversationResult {
  ok: boolean;
  error?: string;
  title?: string;
  /** 'inline' → `transcript` is populated. 'file' → `path`/`relPath` are. */
  mode?: 'inline' | 'file';
  transcript?: string;
  /** Absolute path to the mirror (for beings with full filesystem access). */
  path?: string;
  /** Same file, relative to the being's workspace root (for sandboxed tools). */
  relPath?: string;
  bytes?: number;
  messages?: number;
  /** "2026-04-01 12:03 → 2026-04-03 22:41", or '' when nothing is timestamped. */
  period?: string;
  speakers?: string[];
  /** True when the requested conversation is the one currently in progress. */
  isCurrent?: boolean;
}

export interface ReadConversationOptions {
  /** The caller has file tools (Read/Grep) available. When false, the result
   *  is always inline — a path would be useless. This is the `toolUseEnabled`
   *  gate, NOT a provider check: every path that can open a file qualifies. */
  fileTools?: boolean;
  /** Id of the conversation this turn belongs to, so the result can say that
   *  the in-flight turn isn't in the file yet. */
  currentConvoId?: string;
  /** How attachments in the transcript are addressed — absolute paths (the
   *  caller can reach the whole disk) or 12-char refs (read_attachment is the
   *  only way in). REQUIRED on purpose; see formatAttachmentEntry. */
  showPaths: boolean;
}

// Normalize a conversation name for fuzzy matching: trim, collapse internal
// whitespace, normalize full-width digits to ASCII, and lowercase. The current
// title format is "<base>_<index>", but models often still guess the old
// "＃"/"#" separator (e.g. "先輩#46"); treat "_", "#", and "＃" as the SAME
// separator so "先輩#46" still resolves to "先輩_46".
function normalizeName(s: string): string {
  return (s || '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[#＃_]/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Strip base64 data URIs and oversized inline blobs from a message's content
// so the transcript stays text-only.
function cleanContent(content: any): string {
  if (typeof content !== 'string') {
    try { content = JSON.stringify(content); } catch { return ''; }
  }
  return (content as string)
    // Markdown image/data URIs: ![alt](data:...) → [image]
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '[image]')
    // Bare data URIs
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[binary]');
}

// Render a message's attachment list, in whichever addressing mode this turn
// uses — `[<ref> "name" (size), …]` or `["name" (size) — <abs path>, …]` — via
// the shared formatAttachmentEntry, so a transcript and read_attachment's own
// error text never disagree about how a file is named. Legacy attachments (no
// ref — inline dataUrl/textData predating content-addressing) are still listed
// by name/size so the transcript doesn't silently drop them, but flagged as
// unreachable, in the terms of whichever mode is active.
function formatMessageAttachments(attachments: any, showPaths: boolean): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    if (typeof a?.ref === 'string' && a.ref) return formatAttachmentEntry(a, showPaths);
    return showPaths
      ? `"${String(a?.name || 'unnamed')}" (legacy inline payload — no file on disk)`
      : `"${String(a?.name || 'unnamed')}" (no ref — not readable via read_attachment)`;
  });
  return ` [${parts.join(', ')}]`;
}

/** "2026-04-01 12:03" — matches conversationSearch.ts's fmtTs so the two tools
 *  render the same instant the same way. */
function fmtTs(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface BuiltTranscript {
  body: string;
  messages: number;
  speakers: string[];
  firstTs: number | null;
  lastTs: number | null;
}

// Build the speaker-tagged transcript body. Each turn is prefixed with its
// speaker in square brackets — "[Name]:" — matching the app's native [username]
// identity convention (used in message content, VRChat input, and the OAuth
// transcript). Brackets are chosen over "## Name" on purpose: message bodies
// legitimately contain markdown sub-headings ("## Summary"), so a "##" speaker
// delimiter would be indistinguishable from in-body headings. The assistant
// label falls back to the ENTITY name (folderName) — never the conversation
// TITLE, which is a per-conversation name, not the speaker's identity.
// Skip pure-system bookkeeping; strip base64; guard against inline thoughts.
function buildTranscript(messages: any[], folderName: string, showPaths: boolean): BuiltTranscript {
  const lines: string[] = [];
  const speakers = new Set<string>();
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let count = 0;

  for (const m of messages) {
    const speaker = m.role === 'user' ? (m.name || 'Anonymous') : (m.name || folderName || 'Assistant');
    const text = cleanContent(m.content || '').trim();
    const atts = formatMessageAttachments(m.attachments, showPaths);
    if (!text && !atts) continue;

    const ts = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : null;
    if (ts != null) {
      if (firstTs == null || ts < firstTs) firstTs = ts;
      if (lastTs == null || ts > lastTs) lastTs = ts;
    }
    const stamp = ts != null ? ` (${fmtTs(ts)})` : '';

    speakers.add(speaker);
    count++;
    lines.push(`[${speaker}]${stamp}:${atts}\n${text}`.trimEnd());
  }

  return {
    body: lines.join('\n\n'),
    messages: count,
    speakers: [...speakers],
    firstTs,
    lastTs,
  };
}

// Framing legend so the reading model parses speakers unambiguously and
// doesn't mistake a message's own "##" markdown headings for new speakers.
const LEGEND_BASE =
  'Each turn begins with its speaker in square brackets followed by the time it ' +
  'was sent, e.g. "[Name] (2026-04-01 12:03):". Any line starting with "#" inside ' +
  'a turn is that message\'s own markdown heading — NOT a new speaker. ';

function legendFor(showPaths: boolean): string {
  return LEGEND_BASE + (showPaths
    ? 'Attachments are listed as "\\"name\\" (size) — <absolute path>" right after ' +
      'the speaker tag; the path is the file itself on disk, so read it or hand it ' +
      'to any tool that takes a path. A few legacy attachments were stored inline ' +
      'and have no file.'
    : 'Attachments are listed as "<ref> \\"name\\" (size)" right after the speaker ' +
      'tag; a ref can be read in full with the read_attachment tool (it works across ' +
      'ALL of your conversations, not just this one). Attachments with no ref are ' +
      'legacy inline payloads and cannot be read that way.');
}

/** Filesystem-safe, human-recognizable stem for a mirror filename. */
function mirrorStem(title: string): string {
  const s = (title || 'untitled')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/[.\s]+$/, '')
    .trim();
  // Windows' 260-char path limit is the real constraint; the id and extension
  // are appended after this, so keep the stem short.
  return (s.slice(0, 80) || 'untitled');
}

function mirrorFileName(title: string, convoId: string): string {
  // The id suffix — not the title alone — is what makes a mirror identifiable:
  // titles collide, contain characters Windows rejects, and change on rename.
  return `${mirrorStem(title)}__${convoId}.md`;
}

/**
 * Delete every mirror in `dir` that no longer corresponds to a live, active,
 * still-owned, still-identically-named conversation of this being.
 *
 * This is the second enforcement point for the privacy guard: `expected` is
 * built from the ACTIVE conversations of THIS being only, so a conversation
 * flipped to inactive, deleted, renamed, or moved to another being loses its
 * mirror on the next read_conversation call.
 *
 * Only files carrying MIRROR_MARKER as their first line are ever unlinked —
 * anything else in workspace/logs/ belongs to the being and is left alone.
 */
async function sweepMirrors(dir: string, expected: Set<string>): Promise<void> {
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return; }
  await Promise.all(entries.map(async (name) => {
    if (!name.endsWith('.md')) return;
    if (expected.has(name)) return;
    const full = path.join(dir, name);
    let head = '';
    try {
      const fh = await fs.open(full, 'r');
      try {
        const buf = Buffer.alloc(MIRROR_MARKER.length);
        await fh.read(buf, 0, buf.length, 0);
        head = buf.toString('utf-8');
      } finally { await fh.close(); }
    } catch { return; }
    if (head !== MIRROR_MARKER) return; // not ours — never touch it
    try { await fs.unlink(full); } catch {}
  }));
}

export async function readConversationByName(
  folderName: string,
  name: string,
  opts: ReadConversationOptions,
): Promise<ReadConversationResult> {
  if (!name || !name.trim()) {
    return { ok: false, error: 'A conversation name is required.' };
  }
  const target = normalizeName(name);

  const all = await listLogs();
  const logs = all.filter((l: any) => l.folderName === folderName);
  if (logs.length === 0) {
    return { ok: false, error: `No conversations found in this being.` };
  }

  // Prefer an exact normalized title match; fall back to a contains-match.
  let hit = logs.find((l: any) => normalizeName(l.title || '') === target);
  if (!hit) {
    const partial = logs.filter((l: any) => normalizeName(l.title || '').includes(target));
    if (partial.length === 1) hit = partial[0];
    else if (partial.length > 1) {
      const names = partial.map((l: any) => l.title).join('", "');
      return {
        ok: false,
        error: `Multiple conversations match "${name}": "${names}". Be more specific.`,
      };
    }
  }

  // Housekeeping runs even on a miss: the mirror directory must not outlive
  // the conversations it copies, and a failed lookup is as good a moment as
  // any to notice a conversation went private.
  // Realpath the workspace before building the mirror path. `ensureWorkspace`
  // returns a path built from the server's cwd (…/nexus/local_data/…), but
  // local_data is a JUNCTION — the OAuth path anchors Claude Code's cwd to the
  // RESOLVED spelling (…/common/local_data/…) for exactly this reason, and
  // Claude Code hard-refuses any absolute path outside its cwd. Handing back
  // the junction spelling would make the file unreadable by the very beings
  // this mode exists for. Resolve here so the absolute path we advertise is
  // the same one their tools are anchored to.
  const workspaceRaw = await ensureWorkspace(folderName);
  let workspaceDir = workspaceRaw;
  try { workspaceDir = await fs.realpath(workspaceRaw); } catch {}
  const mirrorDir = path.join(workspaceDir, MIRROR_SUBDIR);
  const expected = new Set<string>(
    logs
      .filter((l: any) => l.active !== false && !l.corrupted)
      .map((l: any) => mirrorFileName(l.title || '', l.id)),
  );
  await sweepMirrors(mirrorDir, expected);

  if (!hit) {
    return { ok: false, error: `No conversation named "${name}" was found in this being.` };
  }

  // Privacy guard — inactive conversations are non-public and must be refused.
  if (hit.active === false) {
    return {
      ok: false,
      error: `The conversation "${hit.title}" is marked inactive (non-public) and cannot be read.`,
    };
  }

  const full = await loadLog(hit.id);
  if (!full || !Array.isArray(full.messages)) {
    return { ok: false, error: `Failed to load "${hit.title}".` };
  }

  // Fill in sizes the log never recorded, BEFORE rendering: buildTranscript is
  // synchronous and a stat is not, and this is the one transcript a resident
  // actually reads attachment sizes from. Without it, 1,030 of this store's
  // 6,968 ref'd attachments render as "0 B" — which reads as "the file is
  // broken", and was reported as exactly that.
  await fillMissingAttachmentSizes(
    full.messages.flatMap((m: any) => (Array.isArray(m?.attachments) ? m.attachments : [])),
  );

  const built = buildTranscript(full.messages, folderName, opts.showPaths);
  const isCurrent = !!opts.currentConvoId && opts.currentConvoId === hit.id;
  // Compare the RENDERED stamps, not the raw epochs: a conversation that ran
  // for forty seconds has two different timestamps that format to the same
  // minute, and "12:03 → 12:03" reads like a bug.
  const firstStamp = fmtTs(built.firstTs);
  const lastStamp = fmtTs(built.lastTs);
  const period = !firstStamp ? '' : (lastStamp && lastStamp !== firstStamp ? `${firstStamp} → ${lastStamp}` : firstStamp);

  const fileName = mirrorFileName(hit.title || '', hit.id);
  const absPath = path.join(mirrorDir, fileName);
  const relPath = `${MIRROR_SUBDIR}/${fileName}`;

  // A mirror may already exist from an earlier read. Refresh it whenever we
  // rebuild the transcript — including in inline mode — so a stale copy can
  // never be sitting in the workspace while a fresher reading of the same
  // conversation was just returned. The danger of a copy is not that it goes
  // stale; it's that it goes stale silently.
  const wantFile = !!opts.fileTools && built.body.length > INLINE_MAX_CHARS;
  let mirrorExists = false;
  if (!wantFile) {
    try { await fs.access(absPath); mirrorExists = true; } catch {}
  }

  if (wantFile || mirrorExists) {
    const stampedNow = fmtTs(Date.now());
    const banner = [
      MIRROR_MARKER,
      `# ${hit.title}`,
      '',
      `> **This file is a COPY**, written by \`read_conversation\` at ${stampedNow}.`,
      `> The original is the conversation itself (\`logs/${hit.id}.json\`). This file`,
      '> does not update on its own — it is rewritten each time `read_conversation`',
      '> is called for this conversation. Editing it changes nothing in the',
      '> conversation, and the next refresh overwrites your edits.',
      isCurrent
        ? '>\n> This is the conversation you are in RIGHT NOW. It reflects the last\n> autosave; the turn currently in flight is not in it yet.'
        : '',
      '',
      `- Being: ${folderName}`,
      `- Messages: ${built.messages}`,
      period ? `- Period: ${period}` : '',
      built.speakers.length ? `- Speakers: ${built.speakers.join(', ')}` : '',
      '',
      legendFor(opts.showPaths),
      '',
      '---',
      '',
    ].filter((l) => l !== '').join('\n');

    const contents = `${banner}\n${built.body}\n`;
    try {
      await fs.mkdir(mirrorDir, { recursive: true });
      await fs.writeFile(absPath, contents, 'utf-8');
    } catch (e: any) {
      // Couldn't write the mirror — fall back to inline rather than failing
      // the read. A slow answer beats no answer.
      return {
        ok: true,
        title: hit.title,
        mode: 'inline',
        isCurrent,
        messages: built.messages,
        speakers: built.speakers,
        period,
        transcript: `${legendFor(opts.showPaths)}\n\n${built.body}`,
      };
    }

    if (wantFile) {
      return {
        ok: true,
        title: hit.title,
        mode: 'file',
        path: absPath,
        relPath,
        bytes: Buffer.byteLength(contents, 'utf-8'),
        messages: built.messages,
        speakers: built.speakers,
        period,
        isCurrent,
      };
    }
  }

  return {
    ok: true,
    title: hit.title,
    mode: 'inline',
    isCurrent,
    messages: built.messages,
    speakers: built.speakers,
    period,
    transcript: `${legendFor(opts.showPaths)}\n\n${built.body}`,
  };
}

/**
 * Render a ReadConversationResult as the text a model receives. Every provider
 * path returns the same words — the shape of the answer must not depend on
 * which vessel is reading it.
 */
export function formatReadConversationResult(r: ReadConversationResult): string {
  if (!r.ok) return `Error: ${r.error || 'not found'}`;

  if (r.mode === 'file') {
    const facts = [
      `- Messages: ${r.messages}`,
      r.period ? `- Period: ${r.period}` : '',
      r.speakers?.length ? `- Speakers: ${r.speakers.join(', ')}` : '',
      `- Size: ${formatAttachmentSize(r.bytes || 0)}`,
    ].filter(Boolean).join('\n');

    return [
      `"${r.title}" was too large to return inline, so it was written to a file`,
      `in your workspace instead. Open it with your file tools — Grep it for what`,
      `you actually need rather than reading the whole thing, and read only the`,
      `matching regions.`,
      '',
      `Workspace-relative path: ${r.relPath}`,
      `Absolute path: ${r.path}`,
      '',
      facts,
      '',
      r.isCurrent
        ? 'This is the conversation you are in right now; the file reflects the last autosave and does not include the turn in flight.'
        : '',
      'The file is a copy, refreshed each time you call read_conversation on this',
      'conversation. Editing it does not change the conversation.',
    ].filter((l) => l !== '').join('\n');
  }

  return `# ${r.title}\n\n${r.transcript || '(empty conversation)'}`;
}
