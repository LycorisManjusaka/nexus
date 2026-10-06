import { NextRequest, NextResponse } from 'next/server';
import { classifyFromHeaders } from '@/lib/deviceClass';

// GET /api/device-probe → what the SERVER can tell about the caller's device.
//
// Read-only, no side effects, no logging. Exists so the phone/tablet/desktop
// decision can be read off a real connection instead of assumed — open it from
// the actual device and the answer is the answer, with the raw signals next to
// it so a wrong call can be traced to its source.
//
// Deliberately never consults screen size; see lib/deviceClass.ts for why.
export async function GET(req: NextRequest) {
  try {
    const get = (n: string) => req.headers.get(n);
    const device = classifyFromHeaders(get);
    return NextResponse.json(
      {
        device,
        signals: {
          userAgent: get('user-agent') || '',
          secChUaMobile: get('sec-ch-ua-mobile') || '',
          secChUaPlatform: get('sec-ch-ua-platform') || '',
          secChUa: get('sec-ch-ua') || '',
          acceptLanguage: get('accept-language') || '',
          host: get('host') || '',
        },
        // Stated rather than inferred: client hints are absent over plain HTTP
        // to a LAN address, so an empty secChUaMobile there is expected, not a
        // fault to chase.
        note:
          'Client hints (sec-ch-ua-*) are only sent in a secure context (HTTPS or localhost). ' +
          'Over plain HTTP to a LAN IP they are absent and the User-Agent string is the only signal.',
      },
      { status: 200 },
    );
  } catch (e: any) {
    // A device probe must never be the thing that breaks a screen.
    return NextResponse.json(
      { device: { kind: 'desktop', source: 'unknown', guessed: true }, error: e?.message },
      { status: 200 },
    );
  }
}
