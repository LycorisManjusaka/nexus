import { NextResponse } from 'next/server';
import { getActiveTurn, touchTurn, endTurn, HEARTBEAT_MS } from '@/lib/turnRegistry';
import { requestStop, forgetStop } from '@/lib/turnStop';

// Read/refresh "is a turn running for this conversation, and is it mine".
//
// GET  ?convoId=&clientId=   → { active, mine, label?, startedAt?, ageMs? }
// POST { convoId, turnId, event: 'beat' | 'end' | 'stop' } → { ok, outcome? }
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
    // ── Stop THIS turn, named explicitly ────────────────────────────────────
    // Separate from the browser Stop button's abort, which the chat route
    // cannot tell apart from a tab dying (see lib/turnStop.ts). A turn started
    // by the server-side runner has no browser fetch at all, so this is the
    // ONLY way to stop one. Shipped before the runner because it is its
    // prerequisite, not a convenience.
    //
    // `ok` means the request was accepted. `outcome` is what actually
    // happened, and the caller must read that rather than trusting `ok`:
    //   fired    — a running turn was told
    //   recorded — nobody was listening yet; a turn registering now gets it
    //   already  — this exact turn had been asked before
    // Saying ok:true while nothing happened is the failure this house has
    // paid for twice (the dead "add timestamps" button returned ok:true,
    // updated:0 for 55 days).
    if (event === 'stop') {
      const outcome = requestStop(convoId, turnId);
      return NextResponse.json({ ok: true, outcome });
    }
    if (event === 'end') {
      endTurn(convoId, turnId);
      // A finished turn can no longer be stopped, so nothing about it should
      // stay reachable. This is one of the two cleanups turnStop's TTL exists
      // to back up — see LISTENER_TTL_MS.
      forgetStop(convoId, turnId);
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
