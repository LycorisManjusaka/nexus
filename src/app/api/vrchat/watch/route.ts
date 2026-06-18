import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// NOTE: the kohai.txt / ear_log.txt speech transcript is no longer read or
// emptied here. In VRChat mode the frontend polls GET /api/vrchat/logs to keep
// the (non-destructive) merged transcript visible in the input box, and clears
// the files on send. This route now only watches the VRChat screenshot folder
// and signals a new image; the message text comes from the input.

export async function GET(req: NextRequest) {
  const watchPath = req.nextUrl.searchParams.get('path');
  if (!watchPath || !fs.existsSync(watchPath)) {
    return new Response('Path not found', { status: 400 });
  }

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  writer.write(encoder.encode(`data: ${JSON.stringify({ status: 'connected' })}\n\n`));

  let isClosed = false;
  const processedFiles = new Set<string>();

  const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
    if (isClosed || !filename) return;

    const ext = path.extname(filename).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) return;

    const fullPath = path.join(watchPath, filename);

    // Prevent multiple triggers for the same file in a short timespan
    if (processedFiles.has(fullPath)) return;

    // Check if it's a new file creation (exists)
    if (!fs.existsSync(fullPath)) return;

    processedFiles.add(fullPath);
    // Remove from set after 10 seconds to allow later overwrites if needed
    setTimeout(() => processedFiles.delete(fullPath), 10000);

    // Delay briefly to allow file to finish saving
    setTimeout(() => {
      if (isClosed || !fs.existsSync(fullPath)) return;

      try {
        const stats = fs.statSync(fullPath);
        if (stats.size === 0) return;

        const base64Data = fs.readFileSync(fullPath, { encoding: 'base64' });
        const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const dataUrl = `data:${mimeType};base64,${base64Data}`;

        // Text is supplied by the input box (populated live from the logs poll),
        // so the image event no longer carries a merged transcript.
        writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'vrchat_capture', image: dataUrl, filename })}\n\n`));
      } catch (e) {
        console.error("Error reading VRChat capture:", e);
      }
    }, 1000);
  });

  req.signal.addEventListener('abort', () => {
    isClosed = true;
    watcher.close();
    writer.close().catch(() => { });
  });

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
