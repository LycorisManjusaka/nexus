import { NextResponse } from 'next/server';
import {
  loadEnginePaths, saveEnginePaths, isEngineUp, ENGINES,
  startEngine, stopEngine, restartEngine, isLocalEngine, engineEndpoint,
} from '@/lib/ttsEngines';

// Stored executable paths for the local TTS engines, a live up/down probe so
// Preferences can show whether each engine is currently running, and explicit
// start/stop/restart control.
//
// Paths live server-side (local_data/tts_engines.json) rather than in the
// browser's globalSettings because the process launch happens on the server.

export const runtime = 'nodejs';

export async function GET() {
  const paths = await loadEnginePaths();
  const status = await Promise.all(
    Object.entries(ENGINES).map(async ([id, def]) => {
      const engine = Number(id);
      const ep = engineEndpoint(engine);
      return {
        engine,
        key: def.key,
        name: def.name,
        base: def.base,
        port: ep?.port ?? null,
        // Stop is only offered for engines on this machine — see isLocalEngine.
        local: isLocalEngine(engine),
        configured: !!paths[def.key],
        running: await isEngineUp(engine),
      };
    })
  );
  return NextResponse.json({ paths, status });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Lifecycle actions. Kept on the same route as the path config so the panel
    // has a single endpoint to talk to.
    const action = body?.action;
    if (action) {
      const engine = Number(body?.engine);
      if (!ENGINES[engine]) {
        return NextResponse.json({ ok: false, message: `Unknown engine ${body?.engine}` }, { status: 400 });
      }
      let result;
      switch (action) {
        case 'start':   result = await startEngine(engine);   break;
        case 'stop':    result = await stopEngine(engine);    break;
        case 'restart': result = await restartEngine(engine); break;
        default:
          return NextResponse.json({ ok: false, message: `Unknown action "${action}"` }, { status: 400 });
      }
      // Always 200 with an `ok` flag: a refused stop ("engine is remote") is a
      // normal answer the panel displays, not a transport error.
      return NextResponse.json(result);
    }

    await saveEnginePaths(body?.paths || {});
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to save' }, { status: 500 });
  }
}
