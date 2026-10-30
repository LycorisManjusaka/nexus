import { NextResponse } from 'next/server';
import { claim, release, abandon, queuedConversations } from '@/lib/turnQueue';
import { runTurnForQueue, type RunTurnResult } from '@/lib/runTurnForQueue';
import { runnerHostStatus, describeRunnerHost, installationId } from '@/lib/runnerHost';
import { autoTriggerEnabled } from '@/lib/autoTriggers';
import { onStop } from '@/lib/turnStop';
import { beginTurn, endTurn, publishTurnText, liveTurnStatus } from '@/lib/turnBus';
import { loadLog, saveLog, listFolders, loadUserSettings } from '@/lib/fsStorage';
// ⚠ The FIRST route-to-route import in this tree (measured: zero others).
// The alternative was an HTTP fetch to our own server, which would have to get
// past the admin gate — and src/middleware.ts says why there is exactly one
// gate. A runner is the same process; it does not need a key to talk to
// itself. The cost is that this one line is untestable (next/server cannot
// load outside Next's runtime), which is why every rule lives in lib.
import { POST as chatPost } from '@/app/api/chat/route';

// One pass of the server-side runner (phase 4b-5, 2026-10-29).
//
// POST {}                          → every being, every queued conversation
// POST { being, convoId }          → just that one, and WAIT for it
// POST { being, convoId, detach }  → just that one, answer immediately
// POST { auto: true }              → ALSO require the behaviour checkbox
//
// This is the thing that makes "send it, close the tab, come back and it is
// finished" true: the turn runs here and the result is written to disk by this
// process, not by a browser.
//
// ── WHY `detach` EXISTS ────────────────────────────────────────────────────
//
// MEASURED 2026-10-29 (つよ): with the auto-trigger checked, sending and then
// closing the tab stopped LM Studio mid-generation. The queue was never the
// problem — the browser was still the one POSTing to /api/chat, so the tab's
// connection WAS the turn's lifeline. `detach` lets a tab hand the turn over
// and then merely WATCH it (GET /api/turn-events), which is what makes
// closing the tab cost a view instead of an answer.
//
// The relay is opened SYNCHRONOUSLY here, before this route answers, so the
// tab can subscribe the instant its kick returns. Opened in the detached pass
// instead, the subscribe would race it and lose.
//
// WHY `auto` IS A PARAMETER AND NOT THE DEFAULT
//
// つよ's design (2026-10-28): the behaviour tab lists the REASONS a being may
// wake by itself, and "stocked messages" is the first row. An explicit tick is
// not one of those reasons — somebody asked for it — so by default this route
// does not consult the checkbox, exactly as the client-side "run it now"
// button does not. A future poller passes `auto: true` and is then subject to
// the checkbox. Keeping that distinction in the request rather than in two
// endpoints means the rule has one implementation.
//
// WHY THE HOST FLAG IS HONOURED EVEN FOR A MANUAL TICK
//
// MEASURED: :3000 and :3001 are separate installations sharing ONE local_data
// (realpath C:\dev\common\local_data). The lease stops a turn running twice;
// it does not stop it running in the WRONG TREE, and which tree answered is
// invisible from the screen. Default is "nobody hosts", so a fresh checkout
// runs nothing until someone says where.
//
// NO RULES HERE. Scheduling, exclusivity, the relay and the turn itself live
// in lib.

/** Per-conversation outcome, so a failing pass names what it tried. */
type Outcome = {
  being: string;
  convoId: string;
  ran: boolean;
  /** Why nothing ran, when nothing ran. Never a bare "failed". */
  skipped?: 'busy' | 'empty' | 'auto-trigger-off' | 'claim-failed';
  result?: RunTurnResult;
};

/**
 * The name a turn answers to for Stop and interjections.
 *
 * Minted HERE rather than inside runTurnForQueue because the relay has to
 * carry it, and the relay opens before the turn does. Same shape ChatArea
 * uses for a turn it POSTs itself, so /api/chat/active and /api/chat/inject
 * cannot tell the two apart -- which is the point.
 */
function newTurnId(): string {
  return `turn_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
}

function fail(e: unknown, fallback: string) {
  const msg = e instanceof Error ? e.message : fallback;
  return NextResponse.json({ error: msg }, { status: 500 });
}

interface PassOpts {
  auto: boolean;
  oneBeing: string;
  oneConvo: string;
  selfId: string;
  origin: string;
  /**
   * A relay this route already opened (the `detach` path). Whatever happens —
   * including nothing at all, because the batch was claimed by someone else —
   * it must be closed, or the tab that is watching waits forever on a turn
   * that is not coming.
   */
  relayConvoId: string | null;
}

async function runPass(opts: PassOpts): Promise<{ attempted: number; ran: number; outcomes: Outcome[] }> {
  const folders = await listFolders();
  const globalSettings = (await loadUserSettings()) || null;
  const holder = `runner:${opts.selfId}`;

  const targets: Array<{ being: string; convoId: string; settings: Record<string, unknown> }> = [];
  if (opts.oneBeing && opts.oneConvo) {
    const f = folders.find((x: { name: string }) => x.name === opts.oneBeing);
    targets.push({ being: opts.oneBeing, convoId: opts.oneConvo, settings: (f?.settings || {}) as Record<string, unknown> });
  } else {
    for (const f of folders as Array<{ name: string; settings?: Record<string, unknown> }>) {
      for (const row of await queuedConversations(f.name)) {
        targets.push({ being: f.name, convoId: row.convoId, settings: f.settings || {} });
      }
    }
  }

  const outcomes: Outcome[] = [];
  /** Relays this pass is responsible for closing. */
  const open = new Set<string>(opts.relayConvoId ? [opts.relayConvoId] : []);

  const closeRelay = (convoId: string, note?: { type: string; [k: string]: unknown }) => {
    if (!open.has(convoId)) return;
    open.delete(convoId);
    endTurn(convoId, note);
  };

  try {
    for (const t of targets) {
      const log = await loadLog(t.convoId);

      // The checkbox lives on the CONVERSATION, so it is read from the log
      // and not from folder settings — the same place the client-side drain
      // reads it. A folder default only reaches new conversations.
      if (opts.auto && !autoTriggerEnabled(log?.autoTriggers, 'stock')) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'auto-trigger-off' });
        closeRelay(t.convoId, { type: 'notice', content: 'This conversation does not start by itself.' });
        continue;
      }

      const c = await claim(t.being, t.convoId, holder);
      if (!c.ok) {
        const skipped = c.reason === 'busy' ? 'busy' : c.reason === 'empty' ? 'empty' : 'claim-failed';
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped });
        if (skipped !== 'empty') console.log(`[runner] skipped ${t.being}/${t.convoId}: ${skipped}`);
        closeRelay(t.convoId, { type: 'notice', content: `Nothing ran: ${skipped}.` });
        continue;
      }

      // A relay for a turn that is ABOUT to produce frames. Not opened before
      // the claim: a pass that skips must not clear the relay of a turn that
      // another pass is already streaming into.
      // The RELAY is the single source of this turn's id: a tab that is
      // already watching read it from there, and minting a second one here
      // would leave Stop pointing at a turn that does not exist.
      const existing = liveTurnStatus(t.convoId);
      let turnId: string;
      if (existing?.live === true) {
        turnId = existing.turnId;
      } else {
        turnId = newTurnId();
        beginTurn(t.convoId, turnId);
        open.add(t.convoId);
      }

      // Watch for an explicit Stop so a cancel can be told from a failure.
      // Registered HERE, before the turn starts, because this route knows the
      // turnId first and requestStop fires every listener for the key — the
      // chat route's (which aborts the generation) and this one (which only
      // records that it happened). A callback, not isStopRequested read later:
      // the chat route calls forgetStop the instant it aborts, so by the time
      // runTurnForQueue's throw is caught the record is already gone.
      let stopped = false;
      const offStop = onStop(t.convoId, turnId, () => { stopped = true; });

      let result: RunTurnResult;
      try {
        result = await runTurnForQueue(t.being, t.convoId, c.claim.items, {
          wasStopped: () => stopped,
          loadLog,
          saveLog,
          chatPost,
          globalSettings,
          enableReadConversation: t.settings.enableReadConversation === true,
          folderDefaults: {
            aiName: String(t.settings.aiName || ''),
            folderName: t.being,
            systemPrompt: String(t.settings.systemPrompt || ''),
            specificModel: String(t.settings.specificModel || ''),
            modelParams: (t.settings.modelParams || {}) as Record<string, unknown>,
          },
          newId: () => crypto.randomUUID(),
          nowMs: () => Date.now(),
          clientId: holder,
          // The route reads the body, not the host — but a Request needs a URL,
          // and using the incoming one means a failing turn names the port it
          // was aimed at rather than a port this file invented.
          origin: opts.origin,
          onRawText: (text) => publishTurnText(t.convoId, text),
          injectTurnId: turnId,
        });
      } catch (e) {
        offStop();
        // runTurnForQueue returns its failures; reaching here means something
        // outside its own error handling threw. The lease still has to go back
        // and the watcher still has to be told, or a crash in one turn leaves
        // the conversation permanently "running".
        await abandon(t.being, t.convoId, c.claim.token);
        const reason = String((e as Error)?.message || e);
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, result: { ok: false, stage: 'post', reason } });
        closeRelay(t.convoId, { type: 'error', error: reason });
        continue;
      }

      offStop();

      // CONSUME the batch on success AND on an explicit Stop; ABANDON every
      // other failure.
      //
      //   · success  — the turn is saved, the items are done.
      //   · stopped  — the person cancelled. runTurnForQueue already saved the
      //     user turn with no reply; consuming the items here is what makes
      //     Stop stick. Abandoning would leave them for the auto-trigger to
      //     re-fire, and the generation just stopped would start over — which
      //     is exactly the "Stop does nothing" this fixes.
      //   · other failure — abandon puts the lease back and leaves the items,
      //     so the batch is unchanged, the auto-trigger signature is unchanged,
      //     and an instantly-failing turn cannot re-fire forever.
      const consume = result.ok || result.stage === 'stopped';
      if (consume) {
        await release(
          t.being,
          t.convoId,
          c.claim.token,
          c.claim.items.map((i) => i.id),
        );
      } else {
        await abandon(t.being, t.convoId, c.claim.token);
      }
      outcomes.push({ being: t.being, convoId: t.convoId, ran: result.ok, result });
      // F46: a runner that says nothing is indistinguishable from one that is
      // broken — and the only person who can read this is whoever opens the
      // server console, because a detached pass has no response to answer in.
      console.log(
        result.ok
          ? `[runner] ran ${t.being}/${t.convoId} — saved ${result.messageId}`
          : result.stage === 'stopped'
            ? `[runner] stopped ${t.being}/${t.convoId} — cancelled by request`
            : `[runner] FAILED ${t.being}/${t.convoId} at ${result.stage}: ${result.reason}`,
      );
      // A stop is not an error: the watcher gets a notice, not an error frame.
      closeRelay(
        t.convoId,
        result.ok ? undefined
        : result.stage === 'stopped' ? { type: 'notice', content: 'Stopped.' }
        : { type: 'error', error: result.reason },
      );
    }
  } finally {
    // Nothing may leave a watcher hanging — including a target list that never
    // reached the conversation the relay was opened for.
    for (const convoId of [...open]) closeRelay(convoId, { type: 'notice', content: 'The runner finished without starting this turn.' });
  }

  return { attempted: targets.length, ran: outcomes.filter((o) => o.ran).length, outcomes };
}

export async function POST(req: Request) {
  try {
    let body: Record<string, unknown> = {};
    try { body = (await req.json()) || {}; } catch { /* {} is a valid tick */ }

    const auto = body.auto === true;
    const detach = body.detach === true;
    const oneBeing = typeof body.being === 'string' ? body.being.trim() : '';
    const oneConvo = typeof body.convoId === 'string' ? body.convoId.trim() : '';
    const origin = new URL(req.url).origin;

    // ── Who may run turns for this store ──────────────────────────────────
    const selfId = await installationId();
    const status = await runnerHostStatus(selfId);
    if (status !== 'host') {
      return NextResponse.json({
        ok: false,
        skipped: 'not-host',
        // The sentence, not just the status word: a runner that idles without
        // saying why is indistinguishable from one that is broken.
        reason: describeRunnerHost(status, selfId),
        self: selfId,
      });
    }

    if (detach) {
      if (!oneBeing || !oneConvo) {
        return NextResponse.json(
          { ok: false, reason: 'detach needs both being and convoId — a background pass over every being has no one watching it' },
          { status: 400 },
        );
      }
      // Already streaming: do NOT start a second pass. The claim would refuse
      // it anyway, and opening a second relay would disconnect whoever is
      // watching the first. The caller subscribes to the live one instead —
      // which is two tabs on one turn, the thing 4d is for.
      if (liveTurnStatus(oneConvo)?.live === true) {
        return NextResponse.json({ ok: true, started: false, attached: true, host: selfId });
      }
      const turnId = newTurnId();
      beginTurn(oneConvo, turnId);
      void runPass({ auto, oneBeing, oneConvo, selfId, origin, relayConvoId: oneConvo })
        .catch((e) => {
          console.error('[runner] detached pass threw:', e);
          endTurn(oneConvo, { type: 'error', error: String((e as Error)?.message || e) });
        });
      return NextResponse.json({ ok: true, started: true, attached: false, host: selfId, turnId });
    }

    const r = await runPass({ auto, oneBeing, oneConvo, selfId, origin, relayConvoId: null });
    return NextResponse.json({ ok: true, host: selfId, auto, ...r });
  } catch (e) {
    return fail(e, 'the runner tick failed');
  }
}
