import { NextResponse } from 'next/server';
import { getActiveTurn, touchTurn, endTurn, HEARTBEAT_MS } from '@/lib/turnRegistry';

// Read/refresh "is a turn running for this conversation, and is it mine".
//
// GET  ?convoId=&clientId=   → { active, mine, label?, startedAt?, ageMs? }
// POST { convoId, turnId, event: 'beat' | 'end' } → { ok }
//
// There is deliberately NO way for a client to CLAIM a turn here. The only
// writer of "a turn started" is the chat route itself, at the point it actually
// starts one — otherwise a tab could announce a turn it never ran and lock the
// conversation's send button for everyone else. A client may only keep its own
// entry alive, or retire it.
//
// `turnId` is never returned. A tab that did not start the turn has no use for
// it today, and handing it out would imply a cross-tab interjection path that
// does not exist yet.

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const convoId = url.searchParams.get('convoId') || '';
    const clientId = url.searchParams.get('clientId') || '';
    if (!convoId) return NextResponse.json({ error: 'convoId is required' }, { status: 400 });

    const t = getActiveTurn(convoId);
    if (!t) return NextResponse.json({ active: false, mine: false, heartbeatMs: HEARTBEAT_MS });

    return NextResponse.json({
      active: true,
      // The server decides this, not the caller — so "is it me?" is answered
      // the same way everywhere instead of being re-derived per call site.
      mine: !!clientId && t.clientId === clientId,
      label: t.label,
      startedAt: t.startedAt,
      ageMs: Date.now() - t.startedAt,
      heartbeatMs: HEARTBEAT_MS,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed to read active turn' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { convoId, turnId, event } = await req.json();
    if (!convoId || typeof convoId !== 'string') {
      return NextResponse.json({ error: 'convoId is required' }, { status: 400 });
    }
    if (!turnId || typeof turnId !== 'string') {
      return NextResponse.json({ error: 'turnId is required' }, { status: 400 });
    }
    if (event === 'end') {
      endTurn(convoId, turnId);
      return NextResponse.json({ ok: true });
    }
    // Anything else is a heartbeat. ok:false means there was nothing to keep
    // alive (already expired, or the entry belongs to a newer turn) — the
    // caller does not need to act on it, and must not re-create the entry.
    const ok = touchTurn(convoId, turnId);
    return NextResponse.json({ ok });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed to update active turn' }, { status: 500 });
  }
}
