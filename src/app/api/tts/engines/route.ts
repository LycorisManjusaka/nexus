import { NextResponse } from 'next/server';
import { loadEnginePaths, saveEnginePaths, isEngineUp, ENGINES } from '@/lib/ttsEngines';

// Stored executable paths for the local TTS engines, plus a live up/down probe
// so Preferences can show whether each engine is currently running.
//
// These live server-side (local_data/tts_engines.json) rather than in the
// browser's globalSettings because the process launch happens on the server.

export const runtime = 'nodejs';

export async function GET() {
  const paths = await loadEnginePaths();
  const status = await Promise.all(
    Object.entries(ENGINES).map(async ([id, def]) => ({
      engine: Number(id),
      key: def.key,
      name: def.name,
      base: def.base,
      configured: !!paths[def.key],
      running: await isEngineUp(Number(id)),
    }))
  );
  return NextResponse.json({ paths, status });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    await saveEnginePaths(body?.paths || {});
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to save' }, { status: 500 });
  }
}
