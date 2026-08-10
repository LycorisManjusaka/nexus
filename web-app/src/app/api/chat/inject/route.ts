import { NextResponse } from 'next/server';
import { pushInjection } from '@/lib/injectMessage';

// POST { turnId, text } — queue a "partner interjection" into a running turn.
// The active /api/chat request drains it at its next model-call boundary (see
// injectMessage.ts). Returns { ok } — ok:false means empty input; a 200 with
// ok:true does NOT guarantee the turn is still running (it may have just
// finished), only that the text was queued.
export async function POST(req: Request) {
  try {
    const { turnId, text } = await req.json();
    if (!turnId || typeof turnId !== 'string') {
      return NextResponse.json({ error: 'turnId is required' }, { status: 400 });
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
      return NextResponse.json({ error: 'text is required' }, { status: 400 });
    }
    const ok = pushInjection(turnId, text);
    return NextResponse.json({ ok });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed to queue interjection' }, { status: 500 });
  }
}
