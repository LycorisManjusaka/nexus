import { NextResponse } from 'next/server';
import { splitVideoForUpload } from '@/lib/videoSplit';
import { putBytes } from '@/lib/attachmentStore';

export const runtime = 'nodejs';
// Re-encoding a large clip can take a while; allow a generous ceiling.
export const maxDuration = 300;

// POST multipart/form-data { file } — re-encodes the video at CRF 28 and, if it
// still exceeds the 20 MiB base64 cap, splits it into <name>_part1.mp4, … .
// Returns { parts: [{ name, mimeType, size, ref }] } — one part when
// compression alone brought it under the cap.
//
// Parts are written straight into the content-addressed store and returned as
// refs. They used to come back as base64 `data:` URLs, which meant a split
// video crossed the wire twice (up as bytes, back down as inflated base64) only
// for the browser to hand it back on the next send. The bytes are already here
// in memory, so storing them here is both cheaper and simpler.
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof (file as any).arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
    }
    const name = (file as File).name || 'video.mp4';
    const buf = Buffer.from(await (file as File).arrayBuffer());

    const parts = await splitVideoForUpload(buf, name);

    const stored = await Promise.all(
      parts.map(async p => {
        const { ref } = await putBytes(p.buffer, 'video/mp4');
        return { name: p.name, mimeType: 'video/mp4', size: p.buffer.length, ref };
      })
    );

    return NextResponse.json({ parts: stored });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Video split failed.' }, { status: 500 });
  }
}
