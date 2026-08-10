import { Readable } from 'stream';
import { statAttachment, openAttachmentStream } from '@/lib/attachmentStore';

// Serves a content-addressed attachment payload.
//
// This is what message previews point at instead of an inline base64 `data:`
// URL. Streaming from a real URL is not just equivalent to a data URL, it is
// better: a `data:` URL forces the entire payload into the page as a string
// before <video> or <img> can use it, whereas this route lets the browser pull
// only the bytes it needs, cache them, and — via Range below — seek.
//
// RANGE SUPPORT IS LOAD-BEARING. Without a 206 response <video> and <audio>
// cannot seek, and some browsers refuse to play long media at all. Video is a
// large part of what pushed conversations past the size ceiling in the first
// place, so this route has to handle it properly rather than always sending the
// whole file.
//
// Note the static sibling route `api/attachments/split-video` — Next resolves
// static segments ahead of this dynamic one, so it is unaffected.

export const runtime = 'nodejs';

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream {
  return Readable.toWeb(nodeStream as Readable) as unknown as ReadableStream;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ref: string }> }
) {
  const { ref } = await params;

  // statAttachment returns null for a malformed ref as well as a missing file,
  // so an attempt to escape the store with `../` lands here as a plain 404.
  const info = await statAttachment(ref);
  if (!info) {
    return new Response('Attachment not found', { status: 404 });
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': info.mimeType,
    'Accept-Ranges': 'bytes',
    // The ref IS the hash of the content, so a given URL can never point at
    // different bytes. That makes the payload permanently cacheable.
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': `"${ref}"`,
  };

  const rangeHeader = req.headers.get('range');
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const [, rawStart, rawEnd] = m;
      let start: number;
      let end: number;

      if (rawStart === '') {
        // Suffix form (`bytes=-500`) — the last N bytes.
        const suffixLen = parseInt(rawEnd, 10);
        if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
          return new Response('Invalid range', {
            status: 416,
            headers: { 'Content-Range': `bytes */${info.size}` },
          });
        }
        start = Math.max(0, info.size - suffixLen);
        end = info.size - 1;
      } else {
        start = parseInt(rawStart, 10);
        end = rawEnd === '' ? info.size - 1 : parseInt(rawEnd, 10);
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
        return new Response('Requested range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${info.size}` },
        });
      }
      // Clamp rather than reject — players routinely ask past the end.
      end = Math.min(end, info.size - 1);

      return new Response(toWebStream(openAttachmentStream(info.path, start, end)), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${info.size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
  }

  return new Response(toWebStream(openAttachmentStream(info.path)), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(info.size) },
  });
}
