import { NextRequest, NextResponse } from 'next/server';
import { buildCameraManifest } from '@/lib/cameraFiles';

// GET /api/camera-files?folder=<being name>
// Returns the fallback-resolved manifest CameraPanel.tsx drives its state
// machine off of. Missing/empty camera/ folder is not an error — it comes
// back as { manifest: { states: {}, transitions: {} } }, which the panel
// renders as nothing rather than a broken image.

export async function GET(req: NextRequest) {
  const folder = req.nextUrl.searchParams.get('folder') || '';
  if (!folder) {
    return NextResponse.json({ error: 'Missing ?folder=' }, { status: 400 });
  }
  const manifest = buildCameraManifest(folder);
  return NextResponse.json({ manifest });
}
