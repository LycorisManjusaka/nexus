import { NextResponse } from 'next/server';
import path from 'path';
import { beingCameraDir } from '@/lib/beingPaths';
import { loadKeys } from '@/lib/fsStorage';
import { pushCameraFile } from '@/lib/obsCamera';

// POST /api/camera/push  { folder, file }
// Server-side relay: the client resolved which file should be showing (state
// machine lives in CameraPanel.tsx) and asks the server — which is the only
// place that can reach OBS's WebSocket port on the host — to point OBS's
// Media Source at it. Always 200s; OBS being off/misconfigured is reported
// as {ok:false, reason} and must never surface as a request failure, since
// the in-app panel already rendered the same file on its own.

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'Invalid JSON body' });
  }

  const folder = typeof body?.folder === 'string' ? body.folder : '';
  const file = typeof body?.file === 'string' ? body.file : '';
  if (!folder || !file) {
    return NextResponse.json({ ok: false, reason: 'Missing folder/file' });
  }

  const dir = beingCameraDir(folder);
  const safeFile = path.basename(file);
  const fullPath = path.join(dir, safeFile);
  if (!fullPath.startsWith(dir + path.sep) && fullPath !== dir) {
    return NextResponse.json({ ok: false, reason: 'Invalid file' });
  }

  const keys = await loadKeys();
  const cfg = {
    url: (keys?.obsWebSocketUrl || '').trim() || 'ws://127.0.0.1:4455',
    password: keys?.obsWebSocketPassword || '',
    // obsSourceName is the pre-dual-source field name — kept as a fallback
    // for the image slot only, so anyone who already configured it (before
    // this fix) doesn't silently lose image pushes on upgrade.
    imageSourceName: (keys?.obsImageSourceName || keys?.obsSourceName || '').trim(),
    videoSourceName: (keys?.obsVideoSourceName || '').trim(),
  };

  const result = await pushCameraFile(cfg, fullPath);
  return NextResponse.json(result);
}
