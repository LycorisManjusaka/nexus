import { promises as fsp } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { beingCameraDir } from '@/lib/beingPaths';
import { mimeForRef, openAttachmentStream } from '@/lib/attachmentStore';

// GET /api/camera-file?folder=<being name>&file=<filename>
// Serves one file out of a being's camera/ folder — the actual media bytes
// CameraPanel.tsx points a <video>/<img> src at. Range support is load-
// bearing for the same reason it is on the attachment route: without a 206
// response some browsers refuse to play the file at all.
//
// `file` is untrusted client input; `path.basename()` strips any directory
// components before it's ever joined to a real path, and the resolved path
// is re-checked against the being's camera dir as defense in depth — the
// same two-layer guard the diff-viewer route uses for its temp files.

export const runtime = 'nodejs';

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const folder = url.searchParams.get('folder') || '';
  const fileParam = url.searchParams.get('file') || '';
  if (!folder || !fileParam) {
    return new Response('Missing ?folder= or ?file=', { status: 400 });
  }

  const dir = beingCameraDir(folder);
  const safeFile = path.basename(fileParam);
  const fullPath = path.join(dir, safeFile);
  if (!fullPath.startsWith(dir + path.sep) && fullPath !== dir) {
    return new Response('Invalid file', { status: 400 });
  }

  let size: number;
  try {
    const st = await fsp.stat(fullPath);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    return new Response('Camera file not found', { status: 404 });
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': mimeForRef(safeFile),
    'Accept-Ranges': 'bytes',
    // Camera files change in place (same filename, new content) when the
    // user swaps assets, unlike content-addressed attachments — so this is
    // deliberately NOT marked immutable/long-cached.
    'Cache-Control': 'no-cache',
  };

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
