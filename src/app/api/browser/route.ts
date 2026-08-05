import { NextResponse } from 'next/server';
import { openProfileBrowser, browserSessionInfo, closeBrowser } from '@/lib/browserTools';

// Manual control over an identity's browser profile.
//
// The entity's own browsing needs no endpoint — the tools launch Chromium
// themselves on first use. This route exists for the one thing the entity
// cannot do and should not be able to do: sign the profile in.
//
// GET  → which automation browsers are currently open (so the UI can say what
//        pressing the button will close).
// POST → { action: 'open-profile' | 'close', entity, useSystem?, executablePath?, url? }

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ sessions: browserSessionInfo() });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action || '');
    const entity = String(body?.entity || '').trim();

    if (!entity) {
      return NextResponse.json({ ok: false, message: 'No identity given.' }, { status: 400 });
    }

    switch (action) {
      case 'open-profile': {
        const result = await openProfileBrowser(entity, {
          useSystem: body?.useSystem === true,
          executablePath: typeof body?.executablePath === 'string' ? body.executablePath : undefined,
          url: typeof body?.url === 'string' ? body.url : undefined,
        });
        // Always 200 with an `ok` flag — "Chromium isn't installed" is a normal
        // answer the panel shows the user, not a transport failure.
        return NextResponse.json(result);
      }
      case 'close': {
        const n = await closeBrowser(entity);
        return NextResponse.json({
          ok: true,
          message: n > 0 ? `Closed ${entity}'s browser window.` : `${entity} had no browser window open.`,
        });
      }
      default:
        return NextResponse.json({ ok: false, message: `Unknown action "${action}".` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, message: e?.message || String(e) }, { status: 500 });
  }
}
