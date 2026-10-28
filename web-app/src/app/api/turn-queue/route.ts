import { NextResponse } from 'next/server';
import {
  enqueue, pending, claim, release, abandon, composeBatch, readLease, splitByLease,
  breakLease,
} from '@/lib/turnQueue';

// The stock a being's turns are fed from (phase 4a, 2026-10-27).
//
// GET  ?being=&convoId=            → { count, waiting, claimed, claimedUnknown,
//                                      items: [{id, at, from, kind, claimed}], lease }
// POST { action: 'enqueue', being, convoId, from, text, attachments?, kind? }
//                                  → { ok, id, position }
// POST { action: 'claim',   being, convoId, holder }
//                                  → { ok, token, items, composed } | { ok:false, reason }
// POST { action: 'release', being, convoId, token, consumedIds }  → { ok, removed, remaining }
// POST { action: 'abandon', being, convoId, token }               → { ok }
// POST { action: 'break',   being, convoId, expectedHolder, expectedStartedAt }
//                                  → { ok } | { ok:false, reason }
//
// This file holds NO rules. Ordering, exclusivity and rendering all live in
// lib/turnQueue.ts, because `next/server` cannot be imported outside Next's own
// runtime (MEASURED 2026-10-27) — anything decided here would be untestable
// from the day it was written, which is why 68 routes in this tree have no unit
// test. The route only validates its inputs and forwards.
//
// GET deliberately omits each item's payload. The caller needs a count and the
// sender labels to show "2 waiting, from X and Y"; handing out the bodies would
// invite a second renderer next to composeBatch, and then two answers to "what
// does this batch look like".

function fail(e: unknown, fallback: string) {
  const msg = e instanceof Error ? e.message : fallback;
  return NextResponse.json({ error: msg }, { status: 500 });
}

/** Both keys are path segments inside local_data — require real strings. */
function keys(src: { being?: unknown; convoId?: unknown }) {
  const being = typeof src.being === 'string' ? src.being.trim() : '';
  const convoId = typeof src.convoId === 'string' ? src.convoId.trim() : '';
  return { being, convoId, ok: !!being && !!convoId };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const { being, convoId, ok } = keys({
      being: url.searchParams.get('being') || '',
      convoId: url.searchParams.get('convoId') || '',
    });
    if (!ok) {
      return NextResponse.json({ error: 'being and convoId are required' }, { status: 400 });
    }
    const items = await pending(being, convoId);
    const lease = await readLease(being, convoId);
    const split = splitByLease(items, lease);
    const claimedSet = new Set(split.claimed.map((i) => i.id));
    return NextResponse.json({
      // `count` is every file on disk and is kept for callers that only want a
      // "is there anything at all" answer. It is deliberately NOT the number to
      // show a human: see waiting/claimed.
      count: items.length,
      waiting: split.waiting.length,
      claimed: split.claimed.length,
      claimedUnknown: split.claimedUnknown,
      items: items.map((i) => ({
        id: i.id, at: i.at, from: i.from, kind: i.kind, claimed: claimedSet.has(i.id),
      })),
      lease: lease ? { holder: lease.holder, startedAt: lease.startedAt } : null,
    });
  } catch (e) {
    return fail(e, 'failed to read the stock');
  }
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const { being, convoId, ok } = keys(body);
  if (!ok) {
    return NextResponse.json({ error: 'being and convoId are required' }, { status: 400 });
  }

  try {
    if (action === 'enqueue') {
      const text = typeof body.text === 'string' ? body.text : '';
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      // An empty message with no attachments is not a thing to wake anyone for.
      if (!text.trim() && attachments.length === 0) {
        return NextResponse.json({ error: 'nothing to enqueue' }, { status: 400 });
      }
      const kind = body.kind === 'letter' || body.kind === 'schedule' || body.kind === 'system'
        ? body.kind
        : 'user_message';
      const r = await enqueue(being, convoId, {
        kind,
        from: typeof body.from === 'string' ? body.from : '',
        payload: { text, attachments },
      });
      return NextResponse.json({ ok: true, id: r.item.id, position: r.position });
    }

    if (action === 'claim') {
      const holder = typeof body.holder === 'string' ? body.holder : '';
      const r = await claim(being, convoId, holder);
      if (!r.ok) {
        return NextResponse.json({
          ok: false,
          reason: r.reason,
          lease: r.reason === 'busy' && r.lease
            ? { holder: r.lease.holder, startedAt: r.lease.startedAt }
            : null,
        });
      }
      const composed = composeBatch(r.claim.items);
      // `consumable` is the server's answer to "which ids may be released",
      // so the client never has to re-derive it from `skipped`. A skipped item
      // stays in the stock on purpose (see Batch.skipped).
      const skippedIds = new Set(composed.skipped.map((s) => s.id));
      return NextResponse.json({
        ok: true,
        token: r.claim.token,
        items: r.claim.items.map((i) => ({ id: i.id, at: i.at, from: i.from, kind: i.kind })),
        composed,
        consumable: r.claim.items.map((i) => i.id).filter((id) => !skippedIds.has(id)),
      });
    }

    if (action === 'release') {
      const token = typeof body.token === 'string' ? body.token : '';
      if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 });
      const consumedIds = Array.isArray(body.consumedIds)
        ? body.consumedIds.filter((x): x is string => typeof x === 'string')
        : [];
      const r = await release(being, convoId, token, consumedIds);
      return NextResponse.json(r);
    }

    if (action === 'abandon') {
      const token = typeof body.token === 'string' ? body.token : '';
      if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 });
      return NextResponse.json({ ok: await abandon(being, convoId, token) });
    }

    // Force a lease open when its holder is gone.
    //
    // WHY THIS EXISTS (MEASURED 2026-10-29): a tab auto-drained the stock and
    // was then CLOSED mid-turn. Its `catch`/`finally` never ran -- the process
    // was gone -- so neither `release` nor `abandon` fired. The lease stayed,
    // the panel read "running 1" forever, and the runner's tick answered
    // skipped:"busy". Three readings agreeing about a holder that no longer
    // existed, and NO HTTP path to clear it: breakLease sat in lib with the
    // comment "Never called by anything in this module", which was true of
    // the whole tree.
    //
    // The caller echoes back the holder and startedAt that GET showed it.
    // Those are not secrets and not authorisation -- they are a WITNESS that
    // the human was looking at THIS lease and not at one that replaced it
    // since. The token stays server-side on purpose: handing it out would also
    // hand out `release`, which can delete the items of a LIVE turn.
    if (action === 'break') {
      const lease = await readLease(being, convoId);
      if (!lease) return NextResponse.json({ ok: false, reason: 'no-lease' });
      const holder = typeof body.expectedHolder === 'string' ? body.expectedHolder : '';
      const startedAt = Number(body.expectedStartedAt);
      if (holder !== lease.holder || startedAt !== lease.startedAt) {
        // Re-read rather than retry: what is on disk is not what was shown.
        return NextResponse.json({ ok: false, reason: 'stale' });
      }
      return NextResponse.json({ ok: await breakLease(being, convoId, lease.token) });
    }

    return NextResponse.json({ error: `unknown action: ${action || '(none)'}` }, { status: 400 });
  } catch (e) {
    return fail(e, 'failed to update the stock');
  }
}
