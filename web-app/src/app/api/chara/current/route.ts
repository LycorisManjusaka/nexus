import { NextResponse } from 'next/server';
import { resolveUserIdentity } from '@/lib/userIdentity';

export const dynamic = 'force-dynamic';

/**
 * Who is speaking right now, for every open conversation window.
 *
 * Polled by InputArea, so a pick made in one window shows up in the others
 * without any cross-window messaging: they all read the same file.
 *
 * `style` is the style actually in effect (session override if there is one,
 * otherwise the identity's own default); `styleIsOverride` says which of the two
 * it is, so the UI can show a session pick as distinct from the default without
 * having to fetch the identity map to compare.
 */
export async function GET() {
  try {
    const r = resolveUserIdentity();
    return NextResponse.json({
      name: r.name,
      humanLabel: r.humanLabel,
      style: r.style,
      styleIsOverride: r.styleIsOverride,
      hasVoice: !!(r.rule?.engine && r.rule?.character),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
