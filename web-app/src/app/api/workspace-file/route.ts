import { promises as fsp } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { resolveWorkspacePathSafe, realpathAllowingMissing } from '@/lib/fsStorage';
import { beingWorkspaceDir } from '@/lib/beingPaths';
import { mimeForRef, openAttachmentStream } from '@/lib/attachmentStore';

// GET /api/workspace-file?folder=<being name>&path=<relative or absolute>&download=1
//
// Serves one file out of a being's workspace so plain markdown in a message
// can show it: `![](camera/Idle.jpg)` becomes a real <img>, `[x.zip](x.zip)`
// becomes a real download. MessageBubble rewrites local src/href to this URL
// (see lib/inlineMedia.ts); nothing else points here.
//
// Containment: resolveWorkspacePathSafe() is the same resolver the entity's
// own file tools use — it resolves symlinks/junctions and re-checks the real
// target against the workspace root (plus the deployment's trusted junction
// parent, so common_workspace keeps working). An ABSOLUTE path is accepted
// only when it lands inside that root, which is what makes "the desk's
// absolute path" work without opening the rest of the disk. fullAccess is
// NOT consulted here and the resolver cannot be asked to ignore the sandbox
// — see the comment on its export in fsStorage.ts.
//
// Range support is load-bearing for video: without a 206 some browsers refuse
// to play the file at all (same reason the attachment and camera-file routes
// carry it).

export const runtime = 'nodejs';

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream;
}

/**
 * RFC 6266 Content-Disposition. A Japanese filename cannot survive the plain
 * `filename=` parameter (it is latin-1 only), so emit an ASCII-sanitised
 * fallback for old clients AND the real name via `filename*` for everyone
 * else, rather than mangling the name or dropping the header.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Make an absolute path the being can actually observe work.
 *
 * local_data is commonly a junction (here: C:\dev\nexus\local_data →
 * C:\dev\common\local_data), and the shared resolver's FIRST containment check
 * compares raw, pre-realpath strings against the junction-side workspace root.
 * So the junction-side absolute path passes and the real-side one — which is
 * what `pwd` prints inside the entity's own shell, and what the human sees in
 * Explorer — is rejected. Measured: link-side 200, real-side 403.
 *
 * Rather than loosening that shared check (it is the first gate for every file
 * tool, not just this route), strip the workspace prefix here when the absolute
 * path lies inside the workspace's REAL location, handing the resolver an
 * ordinary relative path. Anything that does not match is passed through
 * untouched, so containment is still decided by the resolver and not by this
 * function: C:\Windows\... cannot be rewritten into something acceptable.
 *
 * The absolute path is compared both as written and after realpath, so the
 * OTHER instance's link-side path works too: two houses share one local_data,
 * a message written in one is read in the other, and C:\dev\nexus\... is not a
 * prefix of C:\dev\nexus-cairn\... Measured: without this, the same markdown
 * rendered on 3000 and vanished on 3001.
 */
async function normalizeAbsoluteInsideWorkspace(folder: string, p: string): Promise<string> {
  if (!path.isAbsolute(p)) return p;
  const root = path.resolve(beingWorkspaceDir(folder));
  let realRoot: string;
  try { realRoot = await fsp.realpath(root); } catch { realRoot = root; }
  const abs = path.resolve(p);
  const realAbs = (await realpathAllowingMissing(abs)) || abs;
  for (const base of [realRoot, root]) {
    for (const cand of [abs, realAbs]) {
      if (cand === base) return '';
      if (cand.toLowerCase().startsWith(base.toLowerCase() + path.sep)) {
        return cand.slice(base.length + 1);
      }
    }
  }
  return (await relativeThroughWorkspaceLink(root, realAbs)) ?? p;
}

/**
 * Rewrite an absolute path into "<linkName>/<tail>" when it lands inside
 * something junctioned INTO the workspace.
 *
 * The shared folder is reached this way (beings/<X>/workspace/common_workspace
 * → ...\local_data\common_workspace), and that target is a SIBLING of the
 * workspace, not a descendant — so there is no workspace prefix to strip and
 * the absolute path was rejected even though the very same bytes are served
 * under the link's relative name. Every tool that produces a file there prints
 * the absolute form (ComfyUI's --out, pwd, Explorer), so the natural `![](...)`
 * failed while the equivalent relative one worked. Measured: identical bytes,
 * 403 vs 200.
 *
 * Containment is NOT widened: what comes back is exactly the relative path the
 * being could already have written, and resolveWorkspacePathSafe still judges
 * it (realpath + workspace/trusted-junction prefix check). An absolute path
 * that is not under one of these links falls through unchanged and is refused
 * as before — C:\Windows\... cannot be rewritten into something acceptable,
 * and neither can another being's workspace.
 *
 * Only the top level of the workspace is scanned, and only for absolute paths
 * that already failed the prefix test, so a relative request costs nothing.
 */
async function relativeThroughWorkspaceLink(root: string, realAbs: string): Promise<string | null> {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const realLink = await realpathAllowingMissing(path.join(root, e.name));
    if (!realLink) continue;
    if (realAbs === realLink) return e.name;
    if (realAbs.toLowerCase().startsWith(realLink.toLowerCase() + path.sep)) {
      return path.join(e.name, realAbs.slice(realLink.length + 1));
    }
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const folder = url.searchParams.get('folder') || '';
  const rawPath = url.searchParams.get('path') || '';
  const asDownload = url.searchParams.get('download') === '1';
  if (!folder || !rawPath) {
    return new Response('Missing ?folder= or ?path=', { status: 400 });
  }

  const relPath = await normalizeAbsoluteInsideWorkspace(folder, rawPath);
  const fullPath = relPath ? await resolveWorkspacePathSafe(folder, relPath) : null;
  if (!fullPath) {
    // Deliberately the same message for "escapes the workspace" and "folder
    // name is bogus": the caller does not need to learn which.
    return new Response('Path is outside this workspace', { status: 403 });
  }

  let size: number;
  try {
    const st = await fsp.stat(fullPath);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    return new Response('File not found', { status: 404 });
  }

  const name = path.basename(fullPath);
  const baseHeaders: Record<string, string> = {
    'Content-Type': asDownload ? 'application/octet-stream' : mimeForRef(name),
    'Accept-Ranges': 'bytes',
    // Desk files are edited in place (same path, new bytes), unlike
    // content-addressed attachments — so no long cache. Same reasoning as
    // camera-file.
    'Cache-Control': 'no-cache',
  };
  if (asDownload) baseHeaders['Content-Disposition'] = contentDisposition(name);

  const rangeHeader = req.headers.get('range');
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const [, rawStart, rawEnd] = m;
      let start: number;
      let end: number;
      if (rawStart === '') {
        const suffixLen = parseInt(rawEnd, 10);
        if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
          return new Response('Invalid range', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        }
        start = Math.max(0, size - suffixLen);
        end = size - 1;
      } else {
        start = parseInt(rawStart, 10);
        end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return new Response('Requested range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      return new Response(toWebStream(openAttachmentStream(fullPath, start, end)), {
        status: 206,
        headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
  }

  return new Response(toWebStream(openAttachmentStream(fullPath)), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(size) },
  });
}
