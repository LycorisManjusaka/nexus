import { NextResponse } from 'next/server';
import { claim, release, abandon, queuedConversations } from '@/lib/turnQueue';
import { runTurnForQueue, type RunTurnResult } from '@/lib/runTurnForQueue';
import { runnerHostStatus, describeRunnerHost, installationId } from '@/lib/runnerHost';
import { autoTriggerEnabled } from '@/lib/autoTriggers';
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
// POST { being, convoId }          → just that one
// POST { auto: true }              → ALSO require the behaviour checkbox
//
// This is the thing that makes "send it, close the tab, come back and it is
// finished" true: the turn runs here and the result is written to disk by this
// process, not by a browser.
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
// NO RULES HERE. Scheduling, exclusivity and the turn itself live in lib.

/** Per-conversation outcome, so a failing pass names what it tried. */
type Outcome = {
  being: string;
  convoId: string;
  ran: boolean;
  /** Why nothing ran, when nothing ran. Never a bare "failed". */
  skipped?: 'busy' | 'empty' | 'auto-trigger-off' | 'claim-failed';
  result?: RunTurnResult;
};

function fail(e: unknown, fallback: string) {
  const msg = e instanceof Error ? e.message : fallback;
  return NextResponse.json({ error: msg }, { status: 500 });
}

export async function POST(req: Request) {
  try {
    let body: Record<string, unknown> = {};
    try { body = (await req.json()) || {}; } catch { /* {} is a valid tick */ }

    const auto = body.auto === true;
    const oneBeing = typeof body.being === 'string' ? body.being.trim() : '';
    const oneConvo = typeof body.convoId === 'string' ? body.convoId.trim() : '';

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

    const folders = await listFolders();
    const globalSettings = (await loadUserSettings()) || null;
    const holder = `runner:${selfId}`;

    // ── What to attempt ───────────────────────────────────────────────────
    const targets: Array<{ being: string; convoId: string; settings: Record<string, unknown> }> = [];
    if (oneBeing && oneConvo) {
      const f = folders.find((x: { name: string }) => x.name === oneBeing);
      targets.push({ being: oneBeing, convoId: oneConvo, settings: (f?.settings || {}) as Record<string, unknown> });
    } else {
      for (const f of folders as Array<{ name: string; settings?: Record<string, unknown> }>) {
        for (const row of await queuedConversations(f.name)) {
          targets.push({ being: f.name, convoId: row.convoId, settings: f.settings || {} });
        }
      }
    }

    const outcomes: Outcome[] = [];
    for (const t of targets) {
      const log = await loadLog(t.convoId);

      // The checkbox lives on the CONVERSATION, so it is read from the log
      // and not from folder settings — the same place the client-side drain
      // reads it. A folder default only reaches new conversations.
      if (auto && !autoTriggerEnabled(log?.autoTriggers, 'stock')) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'auto-trigger-off' });
        continue;
      }

      const c = await claim(t.being, t.convoId, holder);
      if (!c.ok) {
        outcomes.push({
          being: t.being,
          convoId: t.convoId,
          ran: false,
          skipped: c.reason === 'busy' ? 'busy' : c.reason === 'empty' ? 'empty' : 'claim-failed',
        });
        continue;
      }

      const result = await runTurnForQueue(t.being, t.convoId, c.claim.items, {
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
        origin: new URL(req.url).origin,
      });

      // Release only on success. A failure ABANDONS, which puts the lease
      // back and leaves the items untouched — so the batch is unchanged, the
      // auto-trigger signature is unchanged, and an instantly-failing turn
      // cannot re-fire forever. The same guard the client-side drain uses.
      if (result.ok) {
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
    }

    return NextResponse.json({
      ok: true,
      host: selfId,
      auto,
      attempted: targets.length,
      ran: outcomes.filter((o) => o.ran).length,
      outcomes,
    });
  } catch (e) {
    return fail(e, 'the runner tick failed');
  }
}
