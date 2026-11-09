import { NextResponse } from 'next/server';
import { claim, release, abandon, markReturned, queuedConversations, itemIsForThisInstallation, type QueueItem } from '@/lib/turnQueue';
import { classifyReturn } from '@/lib/stockPanel';
import { runTurnForQueue, type RunTurnResult } from '@/lib/runTurnForQueue';
import { runnerHostStatus, describeRunnerHost, installationId, claimRunnerHostIfUnset, readRunnerHost, type RunnerHostStatus } from '@/lib/runnerHost';
import { autoTriggerEnabled } from '@/lib/autoTriggers';
import { conversationToolsEnabled } from '@/lib/agentCapabilities';
import { onStop } from '@/lib/turnStop';
import { resolveTurnName, mintTurnId } from '@/lib/turnName';
import { beginTurn, endTurn, publishTurnText, liveTurnStatus } from '@/lib/turnBus';
// Aliased: `endTurn` above closes the RELAY (what watchers read), this one
// retires the cross-tab REGISTRY entry (what tabs probe before sending). Two
// different lifetimes that happen to end at the same moment.
import { endTurn as endRegistryTurn } from '@/lib/turnRegistry';
import { takeUndelivered } from '@/lib/injectMessage';
import { FALLBACK_FAMILY } from '@/lib/beingVessel';
import { beingIsBlockedHere } from '@/lib/blockedBeings';
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
// ⚠ CORRECTED 2026-11-02. The paragraph above is still true about the PROBLEM
// and became false about the MECHANISM the same day the branches merged. The
// flag is one file in the shared store (トカゲくん measured it: both trees'
// `local_data\runner.json` are the same bytes), so honouring it for the whole
// tick meant the un-named installation refused every send typed into it.
//
// A tick is no longer refused as a whole. Each ITEM names the installation
// that may run it (QueueItem.host), and the flag decides only the items that
// name nobody — anything queued before addressing existed, and anything no
// screen produced (a letter, a timer). "Which tree answered" is now decided by
// which tree was typed into, which is also the one a person is looking at.
//
// NO RULES HERE. Scheduling, exclusivity, the relay and the turn itself live
// in lib.

/** Per-conversation outcome, so a failing pass names what it tried. */
type Outcome = {
  being: string;
  convoId: string;
  ran: boolean;
  /** Why nothing ran, when nothing ran. Never a bare "failed". */
  // 'blocked-here': this being is listed in NEXUS_BLOCKED_BEINGS on this
  // process. Distinct from 'elsewhere' on purpose — 'elsewhere' means another
  // installation CAN run it and this one should say so, while 'blocked-here'
  // means this installation is forbidden to, which is a property of the
  // launcher and not of the queue.
  skipped?: 'busy' | 'empty' | 'elsewhere' | 'auto-trigger-off' | 'claim-failed' | 'blocked-here';
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
const newTurnId = mintTurnId;

function fail(e: unknown, fallback: string) {
  const msg = e instanceof Error ? e.message : fallback;
  return NextResponse.json({ error: msg }, { status: 500 });
}

interface PassOpts {
  auto: boolean;
  oneBeing: string;
  oneConvo: string;
  selfId: string;
  /**
   * What `runner.json` says about THIS installation, and who it names.
   *
   * Not "may this pass run" — that question is now per item, answered by
   * `itemIsForThisInstallation`. The flag is only the fallback half of that
   * rule: it decides who runs items with no address on them (anything queued
   * before addressing existed, and anything no screen produced — a letter, a
   * timer). An addressed item runs on the installation it names regardless.
   *
   * Carried as the four-way status rather than a boolean so the sentence this
   * pass can show a person keeps all four meanings. 'unset' and 'unreadable'
   * are both "not the host" for the rule and NEITHER of them is "someone else
   * is the host" for the human.
   */
  hostStatus: RunnerHostStatus;
  hostId?: string;
  origin: string;
  /**
   * The placeholder id a kicking tab is already streaming into. Passed
   * straight through to the runner, which adopts it for the first pass so the
   * tab's end-of-turn reload does not change the React key. See
   * RunTurnDeps.proposedAssistantId.
   */
  assistantMsgId: string;
  /**
   * The name the kicking tab already addresses Stop to.
   *
   * Same bargain as `assistantMsgId` one field up: whoever has to point at the
   * thing FIRST should be the one that names it. Here the stakes are higher
   * than a React key — a press that arrives before the tab learns the name has
   * nowhere to go, and MEASURED 2026-11-04 that cost 8.9 s on a turn the person
   * had already cancelled. See lib/turnName.ts.
   *
   * Declined (not rejected) when malformed, and always overruled by a turn
   * that is already live on this conversation.
   */
  proposedTurnId: string;
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

  // Bound once and passed to every place THIS PASS looks at an item — the
  // conversation list and the claim — so the two cannot disagree about which
  // items belong here. (GET /api/turn-queue binds its own, from the same
  // predicate: it answers a different request and has no PassOpts.)
  //
  // Declared HERE, above the target list, and not next to the claim: the sweep
  // below uses it, and a `const` used before its declaration is a TDZ throw at
  // runtime (tsc caught it; nothing else would have until a sweep ran).
  const accept = (it: QueueItem) => itemIsForThisInstallation(it, opts.selfId, opts.hostStatus === 'host');

  const targets: Array<{ being: string; convoId: string; settings: Record<string, unknown> }> = [];
  if (opts.oneBeing && opts.oneConvo) {
    const f = folders.find((x: { name: string }) => x.name === opts.oneBeing);
    targets.push({ being: opts.oneBeing, convoId: opts.oneConvo, settings: (f?.settings || {}) as Record<string, unknown> });
  } else {
    for (const f of folders as Array<{ name: string; settings?: Record<string, unknown> }>) {
      // Narrowed: a conversation holding ONLY the other clone's items is not
      // a target at all. Without this the sweep takes its lease, finds
      // nothing it may run, and releases — harmless for data, but the
      // rightful clone gets `busy` if it ticks in that instant, and there is
      // no poll loop to retry (ticks happen on send and on the button).
      for (const row of await queuedConversations(f.name, { accept })) {
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

      // NEXUS_BLOCKED_BEINGS — the last door. The queue route already refuses
      // to enqueue or claim for a blocked being, so reaching here means an item
      // was queued by ANOTHER installation (one store, two clones) and this
      // tick happened to look at it. Refuse rather than claim: a claim is this
      // installation declaring "I will run this", which is the single thing the
      // variable forbids. Checked before `claim` so no lease is ever taken.
      if (beingIsBlockedHere(t.being)) {
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped: 'blocked-here' });
        console.log(`[runner] skipped ${t.being}/${t.convoId}: blocked-here (NEXUS_BLOCKED_BEINGS)`);
        continue;
      }

      const c = await claim(t.being, t.convoId, holder, { accept });
      if (!c.ok) {
        // 'elsewhere' is split out of 'empty' because the two need opposite
        // reactions: an empty stock is normal and silent, while a stock full
        // of another clone's messages means THIS tick can never drain it and
        // the person should be told which installation can.
        const elsewhere = c.reason === 'empty' && c.elsewhere > 0;
        const skipped = c.reason === 'busy' ? 'busy'
          : elsewhere ? 'elsewhere'
          : c.reason === 'empty' ? 'empty'
          : 'claim-failed';
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, skipped });
        if (skipped !== 'empty') console.log(`[runner] skipped ${t.being}/${t.convoId}: ${skipped}`);
        closeRelay(t.convoId, {
          type: 'notice',
          content: elsewhere
            ? `Nothing ran here: ${(c as { elsewhere: number }).elsewhere} queued message(s) are addressed to a different installation of NEXUS. ${describeRunnerHost(opts.hostStatus, opts.selfId, opts.hostId)}`
            : `Nothing ran: ${skipped}.`,
        });
        continue;
      }

      // A relay for a turn that is ABOUT to produce frames. Not opened before
      // the claim: a pass that skips must not clear the relay of a turn that
      // another pass is already streaming into.
      // The RELAY is the single source of this turn's id: a tab that is
      // already watching read it from there, and minting a second one here
      // would leave Stop pointing at a turn that does not exist.
      const existing = liveTurnStatus(t.convoId);
      // One derivation, shared with the tests: live wins, then a well-formed
      // proposal from the kicking tab, then a fresh mint.
      const named = resolveTurnName(
        existing?.live === true ? existing.turnId : null,
        opts.proposedTurnId || undefined,
        newTurnId,
      );
      const turnId = named.turnId;
      if (named.isNew) {
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
          // ⚠ WAS `t.settings.enableReadConversation === true` until 2026-11-02.
          // No being has that key — it is the name of the REQUEST field, not of
          // the stored setting, so every runner turn silently had no
          // conversation tools (トカゲくん measured it on the work PC: the flag
          // was ticked and the tools were absent). The translating line lived
          // in the deleted browser turn engine. See conversationToolsEnabled.
          enableReadConversation: conversationToolsEnabled(t.settings),
          folderDefaults: {
            // WAS `String(t.settings.aiName || '')` until 2026-11-08, when the
            // per-being `settings.aiName` was removed. Two reasons this is the
            // fallback constant and not a derivation:
            //   · it is unreachable in practice — turnInputFromLog prefers the
            //     LOG's own aiName, and all 320 logs in this house carry one
            //     (measured 2026-11-08), so this value is only consulted for a
            //     log that has no vessel recorded at all;
            //   · deriving it would mean reading every log header of the being
            //     from the server for a branch that never runs.
            // What it fixes is the old empty string: routing a turn to family
            // "" is not a smaller error than routing it to a named family, it
            // is the same error with nothing to read in the log afterwards.
            aiName: FALLBACK_FAMILY,
            folderName: t.being,
            systemPrompt: String(t.settings.systemPrompt || ''),
            specificModel: String(t.settings.specificModel || ''),
            modelParams: (t.settings.modelParams || {}) as Record<string, unknown>,
          },
          newId: () => crypto.randomUUID(),
          proposedAssistantId: opts.assistantMsgId || undefined,
          nowMs: () => Date.now(),
          clientId: holder,
          // The route reads the body, not the host — but a Request needs a URL,
          // and using the incoming one means a failing turn names the port it
          // was aimed at rather than a port this file invented.
          origin: opts.origin,
          onRawText: (text) => publishTurnText(t.convoId, text),
          injectTurnId: turnId,
          // So a mid-turn interjection that found no tool boundary is reported
          // on the reply instead of vanishing. Passed in rather than imported
          // inside the runner, so a test can supply a known set.
          takeUndelivered,
        });
      } catch (e) {
        offStop();
        endRegistryTurn(t.convoId, turnId);
        // runTurnForQueue returns its failures; reaching here means something
        // outside its own error handling threw. The lease still has to go back
        // and the watcher still has to be told, or a crash in one turn leaves
        // the conversation permanently "running".
        const reason = String((e as Error)?.message || e);
        // STAMP BEFORE ABANDON — the lease is the only thing keeping another
        // pass off this batch (see markReturned). `classifyReturn` with no
        // stage gives `failed`, which is the honest answer here: a throw from
        // outside the runner's own handling tells us nothing about how far it
        // got, and the items it DID consume are simply not on disk to stamp.
        await markReturned(
          t.being, t.convoId, c.claim.token,
          c.claim.items.map((i) => i.id),
          { at: Date.now(), kind: classifyReturn(null), reason },
        );
        await abandon(t.being, t.convoId, c.claim.token);
        outcomes.push({ being: t.being, convoId: t.convoId, ran: false, result: { ok: false, stage: 'post', reason, consumedIds: [] } });
        closeRelay(t.convoId, { type: 'error', error: reason });
        continue;
      }

      offStop();
      // ── Retire the cross-tab registry entry ─────────────────────────────
      // The chat route registers a turn when it starts one and retires it on
      // `req.signal` abort — but the runner's POST ends by RETURNING, not by
      // aborting, so for a server-side turn that listener never fires and the
      // entry lingers until its 25s TTL.
      //
      // MEASURED 2026-10-31 (ふわふわ): after the answer landed, the tab that
      // SENT it also showed "running somewhere else", and both tabs kept
      // saying so for a few seconds. The turn was over; the registry had not
      // been told. A cross-tab warning that outlives its turn is the exact
      // shape this house refuses — a control that reports a state nobody is
      // in. Now the entry dies with the turn, and the TTL is back to being a
      // backstop instead of the normal path.
      endRegistryTurn(t.convoId, turnId);

      // WHICH ids are done is the runner's answer, not this route's.
      //
      // It used to be `every id we handed over`, which was right while a batch
      // could only be a run of user messages. It stopped being right the
      // moment rerun/continue existed: the runner takes only the LEADING run
      // of one shape, so the rest of a mixed batch was never answered and
      // releasing it here would delete those messages silently. The runner
      // also consumes a few FAILURES on purpose (a command whose target is
      // gone is permanent — abandoning it re-fires it forever).
      //
      // An empty list means abandon: the lease goes back, the items stay, the
      // auto-trigger signature is unchanged, and an instantly-failing turn
      // cannot re-fire forever.
      if (result.consumedIds.length > 0) {
        await release(t.being, t.convoId, c.claim.token, result.consumedIds);
      } else {
        // F20: say WHY it is coming back, on the item, before the lease goes.
        //
        // Only for `!ok`. An `ok` pass that consumed nothing is abandon's
        // other meaning — "nothing to answer, let the next poll retry" — and
        // stamping that as a failure would be a sentence promising a cause it
        // does not have, which is the thing classifyReturn refuses to do.
        if (!result.ok) {
          await markReturned(
            t.being, t.convoId, c.claim.token,
            c.claim.items.map((i) => i.id),
            { at: Date.now(), kind: classifyReturn(result.stage), reason: result.reason },
          );
        }
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
    // Only meaningful alongside a single being+convo: it names ONE placeholder.
    // A sweep over every being has no tab behind it and leaves this empty.
    const assistantMsgId = typeof body.assistantMsgId === 'string' ? body.assistantMsgId.trim() : '';
    // Same scope as assistantMsgId: it names ONE turn. Shape-checked by
    // resolveTurnName at the point of use, not trusted here.
    const proposedTurnId = typeof body.turnId === 'string' ? body.turnId.trim() : '';
    const origin = new URL(req.url).origin;

    // ── Who may run turns for this store ──────────────────────────────────
    const selfId = await installationId();
    let status = await runnerHostStatus(selfId);

    // Nobody holds the role, and a TAB is behind this tick: take it.
    //
    // Gated on `detach` and not on every tick. MEASURED 2026-10-31: `detach:
    // true` has exactly ONE caller in the whole source (ChatArea's
    // runOnRunner), so a detach tick always has a browser pointed at this
    // port behind it. A sweep tick — no being, no convoId — has nobody
    // behind it, and letting that claim would hand the role to whichever
    // installation happened to poll first. That is precisely the race the
    // "nobody hosts" default in runnerHost.ts exists to prevent, so the
    // default is kept for sweeps and relaxed only where a person acted.
    //
    // Race-free by construction: claimRunnerHostIfUnset writes with
    // `flag: 'wx'`, so of two installations claiming in the same instant
    // exactly one write lands and the loser gets EEXIST. Both then re-read,
    // both agree, and the loser returns the sentence below. The status is
    // re-read rather than inferred from the return value because the record
    // on disk is the authority and a human could have cleared it in between.
    let claimOutcome: 'claimed' | 'taken' | 'failed' | null = null;
    if (status === 'unset' && detach) {
      claimOutcome = await claimRunnerHostIfUnset(selfId, { note: 'claimed automatically by the first server-side turn' });
      status = await runnerHostStatus(selfId);
    }

    // ⚠ A WHOLE-TICK REFUSAL STOOD HERE until 2026-11-02 and was wrong once
    // two clones shared one store:
    //
    //     if (status !== 'host') return { skipped: 'not-host' }
    //
    // MEASURED (トカゲくん, 2026-11-02): `C:\dev\nexus\local_data\runner.json`
    // and `C:\dev\nexus-cairn\local_data\runner.json` are THE SAME FILE — the
    // store is shared by junction. So the flag can name exactly one of the two
    // installations, and after the merge the other one has runner code and
    // refuses here: a message typed into it is stocked and never runs.
    //
    // The gate is now PER ITEM (`itemIsForThisInstallation`), because the
    // question the flag actually answers is "who runs an item that names
    // nobody". Addressing changes which answers are possible, not which
    // question is being asked — see the field doc on QueueItem.host.
    //
    // `status` is still read, still carried, and still turns into a sentence:
    // it decides un-addressed items, and `claim` reporting `elsewhere` is what
    // reaches a person when a stock belongs to the other clone.
    const hostRecord = status === 'not-host' ? await readRunnerHost().catch(() => null) : null;

    // Carried on every answer below, not just a refusal, because the thing a
    // person needs to know changed shape: a tick no longer stops at the flag,
    // so "did it run?" and "what does the flag say?" are separate facts and
    // both belong in the response. `claim: 'failed'` is the ONE outcome no
    // status word covers — the role was unclaimed, this turn tried to take it,
    // and the write did not land, which means the store may be read-only.
    const hostNote = {
      hostStatus: status,
      ...(status !== 'host' ? { hostReason: describeRunnerHost(status, selfId, hostRecord?.host) } : {}),
      ...(claimOutcome ? { claim: claimOutcome } : {}),
    };

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
      // THE site that matters for Stop latency: `detach: true` has exactly one
      // caller in the source (ChatArea's runOnRunner), so this is the path a
      // tab takes when a person presses Send. Adopting the name it already
      // minted means its Stop is addressable from before this request returns,
      // instead of two round-trips later. `liveTurnStatus` was checked just
      // above, hence `null` for the live argument.
      const named = resolveTurnName(null, proposedTurnId || undefined, newTurnId);
      const turnId = named.turnId;
      beginTurn(oneConvo, turnId);
      void runPass({ auto, oneBeing, oneConvo, selfId, hostStatus: status, hostId: hostRecord?.host, origin, assistantMsgId, proposedTurnId, relayConvoId: oneConvo })
        .catch((e) => {
          console.error('[runner] detached pass threw:', e);
          endTurn(oneConvo, { type: 'error', error: String((e as Error)?.message || e) });
        });
      return NextResponse.json({ ok: true, started: true, attached: false, host: selfId, turnId, ...hostNote });
    }

    const r = await runPass({ auto, oneBeing, oneConvo, selfId, hostStatus: status, hostId: hostRecord?.host, origin, assistantMsgId, proposedTurnId, relayConvoId: null });
    return NextResponse.json({ ok: true, host: selfId, auto, ...r, ...hostNote });
  } catch (e) {
    return fail(e, 'the runner tick failed');
  }
}
