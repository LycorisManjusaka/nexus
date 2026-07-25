import { NextResponse } from 'next/server';
import { putStream } from '@/lib/attachmentStore';

// Upload endpoint for attachment payloads.
//
// The body is RAW BYTES, not JSON and not multipart, with the media type given
// by the Content-Type header. That is deliberate: wrapping a video in base64
// inside a JSON envelope inflates it ~33% and forces both sides to materialize
// it as a string, which is precisely the pattern that put conversations into
// V8's max-string-length wall. Raw bytes stream from the browser straight to
// disk without either side holding the whole payload.
//
// The response is small — `{ ref, size, deduped }` — and the ref is what gets
// stored in the conversation instead of the bytes.

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const mime = req.headers.get('content-type') || undefined;
    const { ref, size, deduped } = await putStream(req.body, mime);
    return NextResponse.json({ ref, size, deduped });
  } catch (e: any) {
    console.error('[attachments] upload failed:', e);
    return NextResponse.json(
      { error: e?.message || 'Upload failed' },
      { status: 500 }
    );
  }
}
