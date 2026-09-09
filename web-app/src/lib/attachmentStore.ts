import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import path from 'path';
import mimeTable from './attachmentMime.json';

// Content-addressed store for binary attachment payloads.
//
// WHY THIS EXISTS
// Conversations used to carry every attachment inline as a base64 `data:` URL
// inside the conversation JSON. That made a conversation a single self-contained
// file, but it also meant the whole thing — hundreds of MB of media — was
// re-serialized, re-POSTed and re-written on EVERY turn, and it capped a
// conversation at V8's max string length (536,870,888 chars ≈ 512 MiB), past
// which `JSON.stringify` throws `RangeError: Invalid string length` and the
// conversation can no longer be saved at all.
//
// Payloads now live here, keyed by the SHA-256 of their bytes, and the
// conversation JSON keeps only a small `ref`.
//
// WHY CONTENT-ADDRESSED RATHER THAN ONE FOLDER PER CONVERSATION
// Cloning a conversation and copying messages between conversations are both
// first-class Nexus operations, so the SAME attachment is routinely referenced
// from several conversations. Keying by content means copies share one file for
// free and identical media is deduplicated across the whole corpus. The tradeoff
// is that deletion can't be a hot-path concern — a ref may be shared — so unused
// payloads are reclaimed by an occasional mark-and-sweep instead. That failure
// mode (an orphan wastes disk) is far safer than the alternative (deleting a
// conversation silently breaks the media in its copies).
//
// TEXT ATTACHMENTS ALSO GET A REF, ADDITIVELY. `textData` stays inline — it's
// small and is injected directly into the prompt each turn, and externalizing
// display would add a disk read per turn and a fetch per preview to save
// nothing. But when an attachment is hidden from the prompt (auto-hide, or an
// entity's "hidden attachments accessible via tool" setting), its `ref` is
// what makes read_attachment/search_attachments able to reach it at all — so
// text attachments are dual-field: `textData` for display, `ref` for the same
// bytes addressable by hash. See migrate-text-attachments.mjs, which backfilled
// every pre-existing text attachment that predated this.

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

// A ref is `<64 hex chars>.<ext>`. Anything else is rejected before it ever
// reaches the filesystem — refs arrive from conversation JSON and from request
// URLs, so this is the guard that keeps `../` out of a resolved path.
const REF_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,8}$/;

// The mime<->extension table lives in JSON because the standalone migration
// script needs the SAME mapping and cannot import TypeScript. If the two ever
// disagreed, identical bytes would land under two different extensions and
// dedupe would silently miss. See attachmentMime.json.
const MIME_TO_EXT: Record<string, string> = mimeTable.mimeToExt;
const EXT_TO_MIME: Record<string, string> = mimeTable.extToMime;

export function extForMime(mime: string | undefined | null): string {
  if (!mime) return 'bin';
  return MIME_TO_EXT[mime.toLowerCase().trim()] || 'bin';
}

export function mimeForRef(ref: string): string {
  const ext = ref.split('.').pop()?.toLowerCase() || 'bin';
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

export function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref);
}

/**
 * Absolute path for a ref, sharded by the first two hex characters.
 *
 * Sharding matters on this corpus: a flat directory would accumulate tens of
 * thousands of files (the VRChat entity folders alone hold thousands of images),
 * and directory enumeration on Windows degrades badly at that size. 256 shards
 * keeps each one small.
 *
 * Returns null for any ref that fails validation, so callers can't be tricked
 * into resolving a path outside the store.
 */
export function refPath(ref: string): string | null {
  if (!isValidRef(ref)) return null;
  return path.join(ATTACHMENTS_DIR, ref.slice(0, 2), ref);
}

async function ensureShard(ref: string): Promise<string | null> {
  const full = refPath(ref);
  if (!full) return null;
  await fs.mkdir(path.dirname(full), { recursive: true });
  return full;
}

export interface PutResult {
  ref: string;
  size: number;
  /** True when the payload was already in the store and no bytes were written. */
  deduped: boolean;
}

/**
 * Store raw bytes and return their ref. Writing is skipped when the payload is
 * already present — content addressing means an existing file with this hash
 * necessarily has these exact bytes.
 */
export async function putBytes(bytes: Buffer, mime: string | undefined): Promise<PutResult> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const ref = `${hash}.${extForMime(mime)}`;
  const full = await ensureShard(ref);
  if (!full) throw new Error(`attachmentStore: refused to write invalid ref ${ref}`);

  try {
    const st = await fs.stat(full);
    return { ref, size: st.size, deduped: true };
  } catch {
    // Not present yet — fall through and write it.
  }

  // Write via a temp file + rename so a crashed or concurrent write can never
  // leave a half-written payload visible under a hash that claims to describe
  // complete content. Same discipline as the conversation writer.
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, full);
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    // A concurrent writer may have won the race and created the file between
    // our stat and our rename. That's a success, not a failure — the bytes are
    // identical by construction.
    try {
      const st = await fs.stat(full);
      return { ref, size: st.size, deduped: true };
    } catch {}
    throw e;
  }
  return { ref, size: bytes.length, deduped: false };
}

/**
 * Store an upload by streaming it straight to disk, hashing as it passes.
 *
 * The point is never holding the payload in memory. `req.arrayBuffer()` on a
 * 500 MB video would allocate 500 MB server-side — the exact class of
 * allocation this whole change exists to eliminate. Instead the body flows
 * through a hashing transform into a temp file, and only once the hash is known
 * does the file get renamed into its content-addressed home.
 */
export async function putStream(
  body: ReadableStream | null,
  mime: string | undefined
): Promise<PutResult> {
  if (!body) throw new Error('attachmentStore: empty upload body');
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });

  const tmp = path.join(
    ATTACHMENTS_DIR,
    `.incoming-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  const hash = createHash('sha256');
  let size = 0;
  // A Transform (rather than a 'data' listener) keeps backpressure intact —
  // attaching a listener would flip the stream into flowing mode and race the
  // write.
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(body as any), hasher, createWriteStream(tmp));
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    throw e;
  }

  if (!size) {
    try { await fs.unlink(tmp); } catch {}
    throw new Error('attachmentStore: upload contained no bytes');
  }

  const ref = `${hash.digest('hex')}.${extForMime(mime)}`;
  const full = await ensureShard(ref);
  if (!full) {
    try { await fs.unlink(tmp); } catch {}
    throw new Error(`attachmentStore: refused to write invalid ref ${ref}`);
  }

  // Already stored — content addressing guarantees the existing file has these
  // exact bytes, so drop the upload rather than rewriting it.
  try {
    const st = await fs.stat(full);
    await fs.unlink(tmp);
    return { ref, size: st.size, deduped: true };
  } catch {}

  try {
    await fs.rename(tmp, full);
  } catch (e) {
    try { await fs.unlink(tmp); } catch {}
    // Lost a race with a concurrent upload of identical bytes — that's success.
    try {
      const st = await fs.stat(full);
      return { ref, size: st.size, deduped: true };
    } catch {}
    throw e;
  }
  return { ref, size, deduped: false };
}

/** Store a `data:<mime>;base64,<payload>` URL. Returns null if it isn't one. */
export async function putDataUrl(dataUrl: string): Promise<PutResult | null> {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.startsWith('data:')) return null;
  const header = dataUrl.slice(5, comma);
  if (!header.includes('base64')) return null;
  const mime = header.split(';')[0] || undefined;
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  if (!bytes.length) return null;
  return putBytes(bytes, mime);
}

/**
 * Read a payload back as base64 + mime, the shape the chat pipeline wants.
 * Returns null when the ref is invalid or the payload is missing, so a lost
 * file degrades to "attachment skipped" rather than throwing mid-turn.
 */
export async function readAttachmentBase64(
  ref: string
): Promise<{ base64: string; mimeType: string; size: number } | null> {
  const full = refPath(ref);
  if (!full) return null;
  try {
    const buf = await fs.readFile(full);
    return { base64: buf.toString('base64'), mimeType: mimeForRef(ref), size: buf.length };
  } catch {
    return null;
  }
}

/**
 * Read a ref back as UTF-8 text. Text attachments are content-addressed too
 * (see the read_attachment tool), so their bytes live in the same store as
 * media. Returns null when the ref is invalid or the payload is missing, so a
 * lost file degrades to "not found" rather than throwing mid-turn.
 */
export async function readAttachmentText(ref: string): Promise<string | null> {
  const full = refPath(ref);
  if (!full) return null;
  try {
    const buf = await fs.readFile(full);
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

/** Size + mime without reading the payload. Used by the serving route. */
export async function statAttachment(
  ref: string
): Promise<{ size: number; mimeType: string; path: string } | null> {
  const full = refPath(ref);
  if (!full) return null;
  try {
    const st = await fs.stat(full);
    if (!st.isFile()) return null;
    return { size: st.size, mimeType: mimeForRef(ref), path: full };
  } catch {
    return null;
  }
}

/** Open a byte range for streaming. Caller owns the returned stream. */
export function openAttachmentStream(fullPath: string, start?: number, end?: number) {
  return start === undefined
    ? createReadStream(fullPath)
    : createReadStream(fullPath, { start, end });
}

/**
 * Every ref currently in the store. Used by the mark-and-sweep GC; returns refs
 * (not paths) so callers compare against what conversations actually reference.
 */
export async function listAllRefs(): Promise<string[]> {
  const out: string[] = [];
  let shards: string[] = [];
  try {
    shards = await fs.readdir(ATTACHMENTS_DIR);
  } catch {
    return out;
  }
  for (const shard of shards) {
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(ATTACHMENTS_DIR, shard));
    } catch {
      continue;
    }
    for (const n of names) if (isValidRef(n)) out.push(n);
  }
  return out;
}

export { ATTACHMENTS_DIR };
