import { NextResponse } from 'next/server';
import {
  enqueue, claim, release, abandon, composeBatch, readLease, splitByLease,
  breakLease, isCommandKind, isEmptyTurnText, pendingWithErrors, itemIsForThisInstallation,
  removePendingItem, editPendingItem,
} from '@/lib/turnQueue';
import { installationId, runnerHostStatus } from '@/lib/runnerHost';
import { liveTurnStatus } from '@/lib/turnBus';
import { beingIsBlockedHere, blockedResponseBody } from '@/lib/blockedBeings';

// The stock a being's turns are fed from (phase 4a, 2026-10-27).
//
// GET  ?being=&convoId=            → { count, waiting, claimed, claimedUnknown,
//                                      elsewhere, lease,
//                                      items: [{id, at, from, kind, claimed, returned?}] }
//
// Every count here is narrowed to what THIS installation may run, except
// `elsewhere`, which is how many it may not (2026-11-02 — two clones share one
// store, so the question "what is queued" has two different right answers
// depending on who asks).
// POST { action: 'enqueue', being, convoId, from, text, attachments?, kind? }
//                                  → { ok, id, position }
// POST { action: 'claim',   being, convoId, holder }
//                                  → { ok, token, items, composed } | { ok:false, reason }
// POST { action: 'release', being, convoId, token, consumedIds }  → { ok, removed, remaining }
// POST { action: 'abandon', being, convoId, token }               → { ok }
// POST { action: 'break',   being, convoId, expectedHolder, expectedStartedAt }
//                                  → { ok } | { ok:false, reason }
//
// POST { action: 'remove', being, convoId, id }   → { ok } | { ok:false, reason }
// POST { action: 'edit',   being, convoId, id, text }
//                                  → { ok } | { ok:false, reason }
//
// (A 'discard' action lived here for one day; see the note in lib/turnQueue.ts
// for why it is gone — a failed turn no longer leaves anything to discard, and
// for why 'remove'/'edit' are a different hand rather than that one returning.)
//
// This file holds NO rules. Ordering, exclusivity and rendering all live in
// lib/turnQueue.ts, because `next/server` cannot be imported outside Next's own
// runtime (MEASURED 2026-10-27) — anything decided here would be untestable
// from the day it was written, which is why 68 routes in this tree have no unit
// test. The route only validates its inputs and forwards.
//
// ── CORRECTION 2026-11-10: GET now returns each item's text ─────────────────
// This said "GET deliberately omits each item's payload … handing out the
// bodies would invite a second renderer next to composeBatch, and then two
// answers to 'what does this batch look like'".
//
// The fear was right and does not apply. The panel does not render a BATCH:
// it shows one item's stored text, one row each, unmerged and unlabelled —
// which is the opposite of composeBatch's job (fold N items into one message,
// deciding separators and `[name]` labels). There is still exactly one answer
// to "what does this batch look like", and it is still composeBatch's.
//
// What the omission actually cost (つよ, 2026-11-10): 「今はさぁ、『ある』って
// わかるだけじゃん。でもさぁ、全然中身ってさぁ、見えないし、削除も編集もできない
// っしょ？」 A person could see that a message was queued and could not see
// WHICH message, so "is this the one with the typo" had no answer anywhere.
//
// NOT gated on the admin login, on her correction: 「NEXUSでは今ユーザーの区別も
// ないし … あのログイン画面はさぁ、外から誰も同じローカルアドレスから入れない
// ようにしただけっしょ！中はさぁ、平等だからね。」 The login is the front door,
// not a role. Gating on it would measure a distinction this product does not
// have — the same mistake as reading `settings.aiName` as a throne (2026-11-08).

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
    // Narrowed to what THIS installation may run, so the panel's "N waiting"
    // counts messages this NEXUS can actually answer. Items belonging to the
    // other clone are reported separately rather than hidden: a message that
    // nothing here will ever pick up is the one case where silence reads as
    // "your message was ignored".
    const selfId = await installationId();
    const isHost = (await runnerHostStatus(selfId)) === 'host';
    const scan = await pendingWithErrors(being, convoId, {
      accept: (it) => itemIsForThisInstallation(it, selfId, isHost),
    });
    const items = scan.items;
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
      /**
       * Queued here but addressed to a different installation of NEXUS.
       *
       * Counted, not listed: the labels would be the same labels, and what a
       * person needs is not WHICH message but the fact that this NEXUS is not
       * the one that will answer it.
       */
      elsewhere: scan.elsewhere.length,
      /**
       * The elsewhere items THEMSELVES — a separate array, never folded into
       * `items` (2026-11-10).
       *
       * MEASURED the moment the admin panel was first opened: on a NON-HOST
       * installation every un-addressed item lands here, so `items` was empty
       * and the panel showed nothing — while `removePendingItem` deliberately
       * does NOT narrow by address and could have deleted them all along. A
       * capability that exists in lib, has tests, and cannot be reached from
       * the screen is this house's signature failure (ふわふわ, 2026-11-07:
       * the medicine in the bottle with the lid shut).
       *
       * Why a second array and not `[...items, ...elsewhere]`: two live
       * consumers read `items` to mean "what this NEXUS will answer" — the
       * sender labels on the waiting row, and the derived `returned` count.
       * Merging would change both numbers silently. The counts keep their
       * meaning; the new information arrives in its own field.
       *
       * Deliberately NOT in the `count`/`waiting` numbers either, for the
       * reason `elsewhere` was split off in the first place: "queued behind
       * something" and "nothing here will ever run this" are opposite
       * situations, and the second one needs its own sentence.
       */
      elsewhereItems: scan.elsewhere.map((i) => {
        const p = (i.payload || {}) as {
          text?: unknown; attachments?: unknown; targetMsgId?: unknown;
        };
        return {
          id: i.id, at: i.at, from: i.from, kind: i.kind,
          // Never claimed HERE by construction: the claim applies the same
          // narrowing, so an item addressed elsewhere is never in this
          // installation's lease. Stated as a literal rather than computed,
          // because computing it from `claimedSet` would imply it could be
          // true and invite a reader to wonder when.
          claimed: false,
          returned: i.returned,
          text: typeof p.text === 'string' ? p.text : '',
          targetMsgId: typeof p.targetMsgId === 'string' ? p.targetMsgId : undefined,
          attachmentCount: Array.isArray(p.attachments) ? p.attachments.length : 0,
          /** The address, so the panel can say WHICH install must answer. */
          host: typeof i.host === 'string' ? i.host : '',
        };
      }),
      /* F20 ships NO `returned` count here on purpose. The panel's row names a
         CAUSE and reads it off `items[].returned`; a count derived separately
         on this side could report "2 came back" beside a sentence built from
         one mark. The caller can count the marks it is already being given. */
      items: items.map((i) => {
        const p = (i.payload || {}) as {
          text?: unknown; attachments?: unknown; targetMsgId?: unknown;
        };
        return {
          id: i.id, at: i.at, from: i.from, kind: i.kind, claimed: claimedSet.has(i.id),
          // Per-item so the panel can name the time and, with debug on, the
          // runner's own words.
          returned: i.returned,
          /**
           * The stored text, VERBATIM — `[name]` label included when the
           * sending screen added one. Not re-derived and not trimmed: this is
           * what a runner will send, and a preview that differs from it by
           * even a label would answer "is this the one with the typo" wrongly.
           */
          text: typeof p.text === 'string' ? p.text : '',
          /** A command carries a pointer, not a body (see CommandPayload). */
          targetMsgId: typeof p.targetMsgId === 'string' ? p.targetMsgId : undefined,
          /**
           * The COUNT, never the attachments themselves. A queued image is
           * base64 in this file; shipping it in a poll that runs every 5s
           * while a turn is live would move megabytes to render one number.
           */
          attachmentCount: Array.isArray(p.attachments) ? p.attachments.length : 0,
        };
      }),
      // `relayLive` is the only EVIDENCE anyone has that the process holding
      // this lease still exists. It is not derived from the lease — a lease
      // file outlives whatever wrote it — but from lib/turnBus, which is in
      // memory and says "bytes are flowing for this conversation right now".
      //
      // It exists because the break button's old test ("the holder is not my
      // tab") stopped meaning anything the moment turns moved to the server:
      // the holder is `runner:<tree>` for every healthy turn too, so without
      // this the UI would offer to break a lease that is working.
      //
      // A false NEGATIVE is the safe direction: a server restart loses the
      // relay, the button comes back, and the human can clear a lease whose
      // owner really is gone.
      lease: lease
        ? { holder: lease.holder, startedAt: lease.startedAt, relayLive: liveTurnStatus(convoId)?.live === true }
        : null,
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

  // THE load-bearing refusal for NEXUS_BLOCKED_BEINGS. Every turn in this
  // house goes through the queue (measured 2026-11-08: the only callers of
  // buildSlimHistory / buildTurnRequestBody are the runner), so nothing can be
  // enqueued and nothing can be claimed here means nothing can RUN here.
  //
  // Only those two actions. `release` / `abandon` / `break` stay open on
  // purpose: if a lease is already held by this installation when the variable
  // is added, refusing to release it would leave the queue wedged with no way
  // out from the screen. A guard against a mistake must not create a worse one.
  //
  // `remove` / `edit` are on that same open side (2026-11-10), by the same
  // sentence one step further. Neither can WAKE a blocked being — the block
  // exists so 3000 cannot start Cairn's turn, and deleting a queued message is
  // the opposite of starting one. Refusing them would mean an item stranded in
  // a blocked being's queue has no exit at all, which is the wedge again.
  if ((action === 'enqueue' || action === 'claim') && beingIsBlockedHere(being)) {
    return NextResponse.json(blockedResponseBody(being), { status: 403 });
  }

  try {
    if (action === 'enqueue') {
      // A COMMAND (rerun/continue) carries a pointer, not a body, so it takes
      // the other validation entirely: `targetMsgId` is required and text is
      // meaningless. Kept in this branch rather than loosening the emptiness
      // check below — that check is what stops an accidental blank send from
      // waking a being, and a command must not be the hole in it.
      if (isCommandKind(String(body.kind))) {
        const targetMsgId = typeof body.targetMsgId === 'string' ? body.targetMsgId.trim() : '';
        if (!targetMsgId) {
          return NextResponse.json({ error: 'targetMsgId is required' }, { status: 400 });
        }
        const r = await enqueue(being, convoId, {
          kind: body.kind as 'rerun' | 'continue',
          from: typeof body.from === 'string' ? body.from : '',
          payload: { targetMsgId },
          // A rerun/continue came from a BUTTON on a message, so there is a
          // screen behind it and that screen's installation should answer.
          host: await installationId(),
          uiLang: typeof body.uiLang === 'string' ? body.uiLang : '',
        });
        return NextResponse.json({ ok: true, id: r.item.id, position: r.position });
      }

      const text = typeof body.text === 'string' ? body.text : '';
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      // An empty message with no attachments is not a thing to wake anyone
      // for. Shared with the runner's own refusal (lib/turnQueue) so the two
      // ends cannot disagree about what "empty" means.
      if (isEmptyTurnText(text, attachments)) {
        return NextResponse.json({ error: 'nothing to enqueue' }, { status: 400 });
      }
      const kind = body.kind === 'letter' || body.kind === 'schedule' || body.kind === 'system'
        ? body.kind
        : 'user_message';
      const r = await enqueue(being, convoId, {
        kind,
        from: typeof body.from === 'string' ? body.from : '',
        payload: { text, attachments },
        // Addressed only when a person typed it. A `letter`/`schedule`/
        // `system` item has no screen to belong to — those are exactly the
        // items the store-level host flag is still for, so they are left
        // un-addressed on purpose (see QueueItem.host).
        // `uiLang` follows the same rule, one step further: a notice about this
        // message is read by whoever typed it, so it comes back in the language
        // their screen was speaking. An item with no screen gets no language
        // and falls back to the stored setting (see lib/noticeLanguage.ts).
        ...(kind === 'user_message'
          ? {
              host: await installationId(),
              uiLang: typeof body.uiLang === 'string' ? body.uiLang : '',
            }
          : {}),
      });
      return NextResponse.json({ ok: true, id: r.item.id, position: r.position });
    }

    if (action === 'claim') {
      const holder = typeof body.holder === 'string' ? body.holder : '';
      // ⚠ MEASURED 2026-11-02: this action has ZERO callers in the tree —
      // "Run now" goes through the runner tick, not through here. Narrowed
      // anyway, because an action that is reachable over HTTP and does NOT
      // apply the addressing rule is a way to drain the other clone's stock,
      // and the day something calls it is not the day to discover that.
      const selfId = await installationId();
      const isHost = (await runnerHostStatus(selfId)) === 'host';
      const r = await claim(being, convoId, holder, {
        accept: (it) => itemIsForThisInstallation(it, selfId, isHost),
      });
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

    // ── The admin's two hands on a WAITING item (2026-11-10, つよ) ──────────
    //
    // No token on either, and that is not an omission. A token is the witness
    // that the caller holds the lease, and both of these refuse a claimed item
    // outright — there is no running turn whose work they could erase, so
    // there is nothing for a witness to witness. The judgement that makes them
    // safe (waiting / claimed / claimed-unknown) is in lib, with tests, for the
    // reason stated at the top of this file.
    if (action === 'remove') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
      return NextResponse.json(await removePendingItem(being, convoId, id));
    }

    if (action === 'edit') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
      // `typeof` and not `|| ''`: an absent `text` and an intentional empty
      // one are different mistakes, and only the second is the caller saying
      // "make this blank" — which `editPendingItem` then refuses by the same
      // emptiness rule the enqueue path uses.
      if (typeof body.text !== 'string') {
        return NextResponse.json({ error: 'text is required' }, { status: 400 });
      }
      return NextResponse.json(await editPendingItem(being, convoId, id, body.text));
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
