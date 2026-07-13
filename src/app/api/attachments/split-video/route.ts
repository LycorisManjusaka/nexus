import { NextResponse } from 'next/server';
import { splitVideoForUpload } from '@/lib/videoSplit';

export const runtime = 'nodejs';
// Re-encoding a large clip can take a while; allow a generous ceiling.
export const maxDuration = 300;

// POST multipart/form-data { file } — re-encodes the video at CRF 28 and, if it
// still exceeds the 20 MiB base64 cap, splits it into <name>_part1.mp4, … .
// Returns { parts: [{ name, mimeType, size, dataUrl }] } — one part when
// compression alone brought it under the cap.
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

    return NextResponse.json({
      parts: parts.map(p => ({
        name: p.name,
        mimeType: 'video/mp4',
        size: p.buffer.length,
        dataUrl: `data:video/mp4;base64,${p.buffer.toString('base64')}`,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Video split failed.' }, { status: 500 });
  }
}
