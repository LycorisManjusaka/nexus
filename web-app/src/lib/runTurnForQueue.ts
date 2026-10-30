/**
 * Run ONE queued turn, server-side, and write the result to disk.
 *
 * This is the piece that makes "send it, close the tab, come back and it is
 * finished" true. Everything it needs to READ a turn was extracted over the
 * previous nights; this module is the part that was never in the browser at
 * all — the browser's turn ends by setting React state, and a runner's turn
 * ends by saving a file.
 *
 * ── WHY THE SAVE IS HALF THE WORK ──────────────────────────────────────────
 *
 * MEASURED: `fetch('/api/chat')` happens in 2 client places and 0 server
 * places; the save happens in 1 client place and 0 server places. A runner
 * that only POSTs would complete the turn with NOBODY TO WRITE IT DOWN —
 * which is worse than not running it, because the tokens are spent and the
 * provider has already answered. So POST and save ship together.
 *
 * ── EVERY DEPENDENCY IS INJECTED ───────────────────────────────────────────
 *
 * Not for purity. MEASURED 2026-10-27: `next/server` cannot be imported
 * outside Next's own runtime, so a module that imports the chat route is
 * untestable — which is why 68 API routes have no unit test. Taking the route
 * handler as a function keeps the rules here reachable by `npm test`, and
 * leaves exactly one untestable line (the import) in the caller.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * No retry. A turn whose FIRST pass failed leaves the queue items alone
 * (`abandon`, not `release`), so the next poll sees the same batch and the
 * auto-trigger signature is unchanged — the same guard the client-side drain
 * uses, for the same reason: a turn that fails instantly must not re-fire
 * forever. Once any pass has SAVED, the batch is consumed instead; see the
 * pass chain for why re-firing then would duplicate the conversation.
 *
 * No attachment-description write-back. See runnerSink's RunnerSinkReport.
 *
 * ── CORRECTION (2026-10-30) ────────────────────────────────────────────────
 *
 * This list used to begin "No handoff follow-up", and that is why it is worth
 * leaving the correction here rather than quietly editing the line: the claim
 * was true of this file and false of NEXUS. While normal sends still POSTed
 * from the browser, ChatArea ran the second request; when every send moved
 * here, nothing did, so `change_model` reported a switch that never happened.
 * The hop now runs here — see the pass chain below.
 */

import { buildSlimHistory, type SlimHistoryMessage } from '@/lib/slimHistory';
import { buildTurnRequestBody } from '@/lib/turnRequestBody';
import { turnInputFromLog } from '@/lib/turnInputFromLog';
import { createTurnAccState, assertFinalizable } from '@/lib/turnAccState';
import { finalizeTurnMessage } from '@/lib/finalizeTurnMessage';
import { runTurnStream } from '@/lib/turnStreamLoop';
import { createRunnerSink, createTurnFlags } from '@/lib/runnerSink';
import { effectiveFullAccess } from '@/lib/agentCapabilities';
import {
  composeBatch, splitLeadingTurn, isCommandKind,
  type QueueItem, type CommandPayload,
} from '@/lib/turnQueue';
import type { TurnEventDeps } from '@/lib/turnEventReducer';
import type { TurnHandoffPlan } from '@/lib/turnEvents';
import { describeProviderError } from '@/lib/providerErrors';

/** What the runner could not do itself. */
export interface RunTurnDeps {
  /** fsStorage.loadLog */
  loadLog: (convoId: string) => Promise<Record<string, unknown> | null>;
  /** fsStorage.saveLog */
  saveLog: (
    convoId: string,
    logData: Record<string, unknown>,
    opts?: { expectedUpdatedAt?: number; clientId?: unknown },
  ) => Promise<{
    ok: boolean;
    conflict?: unknown;
    error?: unknown;
    /**
     * The version actually written. REQUIRED in practice for a multi-pass
     * turn: see `saveMessages` for what happens when a second save is still
     * guarded against the version the first one replaced.
     */
    writtenUpdatedAt?: number;
  }>;
  /** The chat route's POST handler, called with a Request this builds. */
  chatPost: (req: Request) => Promise<Response>;
  /** local_data/user_settings.json, already parsed. */
  globalSettings: Record<string, unknown> | null;
  /** FOLDER setting for this being. */
  enableReadConversation: boolean;
  /** What ChatArea would have had in props. */
  folderDefaults: {
    aiName: string;
    folderName: string;
    systemPrompt: string;
    specificModel: string;
    modelParams: Record<string, unknown>;
  };
  /** Fresh message / turn / attachment ids. */
  newId: () => string;
  /** Clock, injected so a test is deterministic. */
  nowMs: () => number;
  /** This runner's identity, for lastWriter and the turn registry. */
  clientId: string;
  /**
   * Absolute origin for the Request this builds. The chat route reads the
   * body and the headers, not the host — but a Request needs a valid URL, and
   * inventing one here rather than taking it would hide which port a failing
   * turn was aimed at.
   */
  origin: string;
  /**
   * Hand every decoded chunk to a live relay (lib/turnBus), so a tab that is
   * not running this turn can still watch it.
   *
   * Injected rather than imported for the reason the rest of this file is:
   * the runner stays a pure function of its dependencies, and `beginTurn` /
   * `endTurn` stay with the caller that knows the turn's whole lifetime —
   * including the paths that end before this function is ever entered.
   */
  onRawText?: (text: string) => void;
  /**
   * The name this turn answers to for an out-of-band Stop and for
   * interjections.
   *
   * REQUIRED, and taken rather than generated, because the relay has to
   * publish it before this function is entered — a tab subscribes the instant
   * its kick returns, and an id invented here would arrive after the watcher
   * had already decided it had none. Optional-with-a-fallback was the other
   * option and is worse: the relay and the turn would disagree silently, and
   * Stop would answer "no such turn" with every button still on screen.
   */
  injectTurnId: string;
  /**
   * Was an explicit Stop requested for this turn? Read only when the stream
   * throws, to tell "the person cancelled" (save the user turn, consume the
   * batch, never re-run) from "a transient failure" (abandon, let the next
   * poll retry). A callback and not `isStopRequested` on purpose: the chat
   * route calls forgetStop the instant it aborts, so the record is gone by the
   * time this throw is caught. The tick route holds the real flag — it
   * registered an onStop listener before the turn began, because it knows the
   * turnId first.
   */
  wasStopped?: () => boolean;
}

/**
 * Which queue ids this turn finished with, for the caller to `release`.
 *
 * ALWAYS present, including on failures, because "consume or abandon" is a
 * decision only this function can make correctly and the tick route used to
 * make it by consuming every id it had handed over. Two cases break that:
 *
 *   · a MIXED batch — only the leading run was processed, so releasing the
 *     rest would delete messages nobody answered;
 *   · an UNPROCESSABLE command — its target is gone and will not come back,
 *     so abandoning it means the auto-trigger re-fires it forever.
 *
 * An empty array means "abandon": leave the items, let the next poll retry.
 */
interface Consumed { consumedIds: string[] }

export type RunTurnResult =
  /**
   * The turn ran and the log was written.
   *
   * `handoffHops` counts the EXTRA passes a `change_model` opened (0 for an
   * ordinary turn). `handoffError` is present when a later pass could not run
   * — the turn still produced an answer, so this is ok:true with the problem
   * named rather than a failure that would make the tick route abandon a
   * batch whose first pass is already on disk.
   */
  | ({
      ok: true;
      messageId: string;
      savedAt: number;
      unappliedDescriptions: number;
      handoffHops: number;
      handoffError?: string;
    } & Consumed)
  /**
   * Nothing was run. `reason` names which precondition failed, never a
   * generic failure: a runner that logs "could not run" tells the operator
   * nothing they can act on.
   */
  | ({ ok: false; stage: 'no-log' | 'post' | 'stream' | 'save'; reason: string } & Consumed)
  /**
   * A rerun/continue whose target cannot be acted on — the id is not in the
   * log any more, it is not the last message, or continue was pointed at a
   * user turn. Separate from the failures above because it is PERMANENT:
   * retrying cannot change the answer, so this consumes its item.
   */
  | ({ ok: false; stage: 'target'; reason: string } & Consumed)
  /**
   * The person pressed Stop. The user's message was saved with NO reply — the
   * browser Stop keeps the user turn and drops the partial the same way — so
   * the batch must be CONSUMED (the tick route releases it, not abandons it)
   * or the auto-trigger re-fires the very generation that was just stopped,
   * which from the outside looks exactly like "Stop does nothing". ok:false
   * because no assistant turn was produced, but unlike the failures above this
   * is not an error.
   */
  | ({ ok: false; stage: 'stopped'; reason: string } & Consumed);

/**
 * The reducer's dependencies, for a host with no translator.
 *
 * `t` is identity. MEASURED (turnEvents.resolveToolActivity): an identity
 * translator makes `localized` false, which is the runner case the extraction
 * already has a test for. The server's own label travels instead of a UI
 * string — correct, because nobody is reading a status line here.
 */
function runnerEventDeps(deps: RunTurnDeps): TurnEventDeps {
  return {
    t: (key: string) => key,
    settings: deps.globalSettings,
    newAttachmentId: deps.newId,
  };
}

export async function runTurnForQueue(
  being: string,
  convoId: string,
  items: QueueItem[],
  deps: RunTurnDeps,
): Promise<RunTurnResult> {
  const log = await deps.loadLog(convoId);
  if (!log) {
    return { ok: false, stage: 'no-log', reason: `no log on disk for ${convoId}`, consumedIds: [] };
  }

  // Only the leading run of one shape. A command cannot merge with text, and
  // taking the claim whole would make composeBatch skip the command while the
  // caller released its id anyway — the message would vanish with no error.
  const { take } = splitLeadingTurn(items);
  if (take.length === 0) {
    return { ok: false, stage: 'target', reason: 'empty batch', consumedIds: [] };
  }
  const consumedIds = take.map((i) => i.id);

  const stored = Array.isArray(log.messages) ? (log.messages as SlimHistoryMessage[]) : [];
  const nowStart = deps.nowMs();

  // ── What shape of turn is this? ────────────────────────────────────────────
  //
  //   send      history = stored + a NEW user message        save: + assistant
  //   rerun     history = stored MINUS the last message      save: + assistant
  //   continue  history = stored (ends on the target)        save: target REPLACED
  //
  // `base` is what finalizeTurnMessage spreads: a fresh skeleton for send and
  // rerun, the TARGET ITSELF for continue — which is how the browser does it
  // (`setMessages(prev => prev.map(m => m.id === msgId ? buildFinalized(m) : m))`),
  // and the reason a continued message keeps its id, role, name and timestamp
  // instead of becoming a new message that merely looks similar.
  const command = isCommandKind(take[0].kind) ? take[0] : null;

  let history: SlimHistoryMessage[];
  let keep: SlimHistoryMessage[];        // what survives in front of the reply
  let base: Record<string, unknown>;
  let seed = { continuedSeed: '', continuedThought: '', continuedBlocks: [] as Array<{ thinking: string; signature: string }> };
  let continueFromMessageId: string | null = null;

  if (command) {
    const targetMsgId = (command.payload as CommandPayload | null)?.targetMsgId;
    if (typeof targetMsgId !== 'string' || !targetMsgId) {
      return { ok: false, stage: 'target', reason: `${command.kind} item has no targetMsgId`, consumedIds };
    }
    const idx = stored.findIndex((m) => String((m as Record<string, unknown>).id) === targetMsgId);
    if (idx === -1) {
      return { ok: false, stage: 'target', reason: `message ${targetMsgId} is not in this log`, consumedIds };
    }
    // REFUSE when the target is not last. The buttons are only offered on the
    // last message (ChatArea: `msgIdx === messages.length - 1`), so this can
    // only happen when something landed between the click and this read — and
    // then a rerun would silently delete whatever that was. The browser cannot
    // hit this case because it acts on its own in-memory array; a runner reads
    // the log fresh, so the precondition has to be re-checked here.
    if (idx !== stored.length - 1) {
      return {
        ok: false,
        stage: 'target',
        reason: `message ${targetMsgId} is no longer the last message (${stored.length - 1 - idx} after it)`,
        consumedIds,
      };
    }
    const target = stored[idx] as Record<string, unknown>;

    if (command.kind === 'rerun') {
      // Throw the answer away and ask again from the same point.
      history = stored.slice(0, idx);
      keep = history;
      base = { id: deps.newId(), role: 'assistant', timestamp: nowStart };
    } else {
      if (target.role === 'user') {
        return { ok: false, stage: 'target', reason: 'cannot continue a user message', consumedIds };
      }
      // The model must see its own unfinished text as its own turn; the chat
      // route appends the "carry on" user turn server-side (an assistant in
      // last position is a prefill, which Claude rejects while thinking is on).
      history = stored;
      keep = stored.slice(0, idx);
      base = { ...target };
      continueFromMessageId = targetMsgId;
      seed = {
        continuedSeed: typeof target.content === 'string' ? target.content : '',
        // Carried for the same reason the browser carries it: every flush
        // REPLACES thoughtProcess/claudeThinkingBlocks, so an empty seed
        // erases the first half's thinking on the continuation's first chunk.
        continuedThought: typeof target.thoughtProcess === 'string' ? target.thoughtProcess : '',
        continuedBlocks: Array.isArray(target.claudeThinkingBlocks)
          ? [...(target.claudeThinkingBlocks as Array<{ thinking: string; signature: string }>)]
          : [],
      };
    }
  } else {
    // The queue batch becomes ONE user message, exactly as the client-side
    // drain composes it: `[label]\ntext` per item, FIFO, skipped items
    // contributing nothing at all (including their attachments).
    const batch = composeBatch(take);
    const userMessage = {
      id: deps.newId(),
      role: 'user',
      content: batch.text,
      attachments: batch.attachments,
      timestamp: nowStart,
    };
    history = [...stored, userMessage as SlimHistoryMessage];
    keep = history;
    base = { id: deps.newId(), role: 'assistant', timestamp: nowStart };
  }

  // Write the log back WHOLE, with only `messages` replaced. The other ~55
  // fields are the ones the browser last saved; rebuilding them here would
  // mean a runner's save could differ from a tab's save in a field neither of
  // us is looking at. One helper so the success save and the Stop save (which
  // saves the user turn with no reply) cannot drift apart.
  //
  // ⚠ `updatedAt` must NOT travel. MEASURED 2026-10-29: fsStorage.saveLog does
  // `logData.updatedAt = logData.updatedAt || Date.now()` — it stamps a new
  // version only when the caller did not bring one. The browser never brings
  // one; spreading the loaded log DOES, and the result is a write that keeps
  // the OLD version number, so every open tab's optimistic lock sees
  // base === disk and overwrites the runner's turn with its own stale copy
  // (MEASURED: a turn saved six messages and was back to four a second later).
  // Dropping the key is the whole fix: saveLog then stamps now, as it does for
  // a tab.
  const { updatedAt: _carriedVersion, ...logWithoutVersion } = log;
  void _carriedVersion;
  // ⚠ The guard has to ADVANCE after every successful save. MEASURED
  // 2026-10-30, live, on the first real handoff: pass 1 saved, pass 2 was
  // refused with `from runner:..., by runner:...` — the runner racing ITSELF,
  // because both passes were still guarded against the version pass 1 had
  // already replaced. The hop ran, the model answered, and the answer was
  // thrown away by my own lock.
  //
  // `writtenUpdatedAt` exists for exactly this and says so in its doc comment
  // in fsStorage: "the client needs this as the base for its NEXT save —
  // without it, the first successful guarded save would make every following
  // one look stale". The browser reads it. The second implementation of the
  // same interface did not, because the browser only ever saves once per turn
  // and so never needed the field its own contract provides.
  let guardVersion = typeof log.updatedAt === 'number' ? log.updatedAt : undefined;
  const saveMessages = async (messages: unknown[]) => {
    const r = await deps.saveLog(
      convoId,
      { ...logWithoutVersion, messages },
      { expectedUpdatedAt: guardVersion, clientId: deps.clientId },
    );
    if (r.ok && typeof r.writtenUpdatedAt === 'number') guardVersion = r.writtenUpdatedAt;
    return r;
  };

  // ── ONE PASS = one POST, one stream, one saved message ────────────────────
  //
  // A turn is usually a single pass. `change_model` makes it more than one: the
  // vessel that hands over finishes its OWN message, and the vessel it hands to
  // answers in a SECOND pass as a second assistant message. That is how the
  // browser does it (ChatArea:4259), and it is also what makes cost come out
  // right without touching the billing code — cost is derived per message from
  // that message's own modelSpecific, so each vessel pays for its own words.
  //
  // Until 2026-10-30 this file stopped after one pass, and the header said so,
  // justified by つよ's outside measurement that the NEXT queued turn starts on
  // the saved default. That measurement is true and is about a DIFFERENT thing.
  // While normal sends still POSTed from the browser, `generateAiResponse` ran
  // the hop; when every send moved here, the hop had no host left — so
  // `change_model` answered "switched" and nothing whatsoever happened. A tool
  // that reports success and does nothing is the beings' version of a button
  // you can press that does nothing, and that one was MINE.
  const MAX_HANDOFF_CHAIN = 3;

  // `label` is carried for the failure report only — it is the name a reader
  // recognises ("Claude Opus 4.8"), not the wire id.
  type PassVessel = { family: string; specificModel: string; thinking: boolean; label: string };

  interface PassPlan {
    /** What the model sees this pass. */
    history: SlimHistoryMessage[];
    /** What survives in FRONT of this pass's reply when it is saved. */
    keep: SlimHistoryMessage[];
    /** What finalizeTurnMessage spreads — the target itself for a continue. */
    base: Record<string, unknown>;
    seed: {
      continuedSeed: string;
      continuedThought: string;
      continuedBlocks: Array<{ thinking: string; signature: string }>;
    };
    continueFromMessageId: string | null;
    /** Set only on a pass that a handoff opened. */
    vessel: PassVessel | null;
    /** The note the previous vessel wrote; the server injects it as a user turn. */
    handoffFrom?: unknown;
    /** A report that a switch failed. Mutually exclusive with handoffFrom server-side. */
    handoffFailed?: unknown;
    /** Notices to carry onto this pass's message (a dead vessel's error). */
    carryNotices: string[];
  }

  type PassResult =
    | {
        ok: true;
        assistant: Record<string, unknown>;
        handoff: TurnHandoffPlan | null;
        sawOutput: boolean;
        unapplied: number;
      }
    | {
        ok: false;
        stage: 'post' | 'stream';
        reason: string;
        /** The person pressed Stop (only ever true for a 'stream' failure). */
        stopped: boolean;
        /**
         * Did this pass produce anything at all before it failed? Load-bearing
         * for the handoff-failure report: a vessel that streamed text and THEN
         * died did receive the handoff and did read the note, so "it could not
         * answer" would be false.
         */
        sawOutput: boolean;
      };

  const runPass = async (plan: PassPlan): Promise<PassResult> => {
    const passStart = deps.nowMs();

    // ONE derivation of "which vessel is answering". turnInputFromLog resolves
    // it (log value, folder default, or this pass's handoff override) and
    // buildSlimHistory is then told that same name. The first version of this
    // file computed it separately for the gate, and two rules for the same
    // question disagree in exactly the case that matters: on a handoff pass the
    // thinking filter would judge against the OLD vessel while the wire went to
    // the new one, so the new vessel would be handed reasoning it must not see.
    const shell = turnInputFromLog(log, {
      convoId,
      messages: [],
      enableReadConversation: deps.enableReadConversation,
      globalSettings: deps.globalSettings,
      injectTurnId: deps.injectTurnId,
      clientId: deps.clientId,
      folderDefaults: deps.folderDefaults,
      vesselOverride: plan.vessel,
    });
    const slim = buildSlimHistory(plan.history, {
      hiddenAttachmentsAccessible: log.hiddenAttachmentsAccessible === true,
      attachmentPathsVisible: effectiveFullAccess(
        log.agentFullSystemAccess === true,
        log.agentDangerousTools === true,
      ),
      toolHistoryEnabled: log.toolHistoryEnabled === true,
      saveThinkingToLog: log.saveThinkingToLog === true,
      turnAiName: shell.aiName,
    });
    // The chat route only reads `continueFromMessage` as a BOOLEAN: when the
    // history ends on an assistant turn it appends the resume instruction
    // itself. Passing the id anyway keeps one name for the thing across the
    // browser path and this one.
    const body = buildTurnRequestBody(
      { ...shell, messages: slim as unknown as SlimHistoryMessage[] },
      {
        ...(plan.continueFromMessageId ? { continueFromMessageId: plan.continueFromMessageId } : {}),
        ...(plan.handoffFrom ? { handoffFrom: plan.handoffFrom } : {}),
        ...(plan.handoffFailed ? { handoffFailed: plan.handoffFailed } : {}),
      },
    );

    let res: Response;
    try {
      res = await deps.chatPost(
        new Request(`${deps.origin}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    } catch (e) {
      return {
        ok: false, stage: 'post', reason: String((e as Error)?.message || e),
        stopped: false, sawOutput: false,
      };
    }
    if (!res.ok || !res.body) {
      return {
        ok: false, stage: 'post',
        reason: `route answered ${res.status}${res.body ? '' : ' with no body'}`,
        stopped: false, sawOutput: false,
      };
    }

    // Empty for a send or a rerun; the target's own half for a continue (see
    // the shape block above for why the thinking has to travel too). Notices
    // are seeded rather than empty so a previous vessel's failure text reaches
    // the reader on the message that reports it.
    const acc = createTurnAccState({ ...plan.seed, notices: [...plan.carryNotices] });
    const flags = createTurnFlags();
    const sink = createRunnerSink();

    try {
      await runTurnStream(res.body.getReader(), acc, flags, sink, runnerEventDeps(deps), {
        onRawText: deps.onRawText,
      });
    } catch (e) {
      // `wasStopped` is read HERE and not by the caller because the chat route
      // calls forgetStop the instant it aborts — asking later asks a record
      // that has already been deleted.
      return {
        ok: false, stage: 'stream', reason: String((e as Error)?.message || e),
        stopped: deps.wasStopped?.() === true,
        sawOutput: flags.sawOutput,
      };
    }

    // ⚠ `attachments` — see F34. finalizeTurnMessage does NOT set it; in the
    // browser the streaming flush has already written tool attachments onto the
    // message being finalized. A runner has no flush, so it must put them on
    // the base itself or a file a tool produced vanishes with no error anywhere.
    //
    // For a CONTINUE, `base` is the target message itself, so the files its
    // first half produced are already in there — append rather than replace, or
    // continuing a reply would silently drop the attachments it had earned.
    const assistant = finalizeTurnMessage(
      {
        ...plan.base,
        attachments: [
          ...(Array.isArray(plan.base.attachments) ? plan.base.attachments : []),
          ...flags.toolAttachments,
        ],
        ...(acc.currentThought ? { thoughtProcess: acc.currentThought } : {}),
      },
      assertFinalizable(acc),
      {
        // This PASS's start, not the turn's: a handoff hop that inherited
        // nowStart would report the first vessel's thinking time as its own.
        genStartTime: passStart,
        nowMs: deps.nowMs(),
        // VRChat auto-play is a browser behaviour; a saved message that claims
        // it would make the next tab that opens this log start speaking.
        autoPlay: false,
        tokenModel: acc.chosenModelFamily || shell.aiName,
      },
    );

    return {
      ok: true,
      assistant,
      handoff: flags.pendingHandoff,
      sawOutput: flags.sawOutput,
      unapplied: sink.report.unappliedDescriptions.length,
    };
  };

  // ── The pass chain ────────────────────────────────────────────────────────
  //
  // ⚠ ONCE A PASS HAS SAVED, THE BATCH IS SPENT. From that point `consumedIds`
  // travels on every return, whatever a later pass does. Abandoning after a
  // successful save would let the auto-trigger re-fire the WHOLE turn: the
  // queue items are still there, so the user message would be composed from
  // them a second time and posted again. One dead second vessel would turn
  // into a conversation that answers itself twice, forever.

  let plan: PassPlan = {
    history, keep, base,
    seed,
    continueFromMessageId,
    vessel: null,
    carryNotices: [],
  };
  let saved = false;
  let lastMessageId = '';
  let lastSavedAt = 0;
  let unapplied = 0;
  let depth = 0;
  let handoffNote: string | undefined;
  /** The vessel of the pass that handed over — null means the saved default. */
  let prevVessel: PassVessel | null = null;
  /** One failure report per turn, so a pair of dead vessels cannot ping-pong. */
  let reportedFailure = false;

  for (;;) {
    const pass = await runPass(plan);

    if (!pass.ok) {
      if (pass.stopped) {
        // The person pressed Stop: save the user's turn with NO reply and
        // report 'stopped', so the tick route CONSUMES the batch instead of
        // abandoning it. Abandoning would leave the items for the auto-trigger
        // to re-fire — the generation just stopped would start over, which
        // looks exactly like "Stop does nothing" (MEASURED: that is the bug
        // this fixes). The partial the model produced is dropped, as the
        // browser Stop drops its own partial.
        //
        // `plan.history` is the right thing to write for all three shapes:
        //   send      stored + the user message  → the user turn, no reply
        //   rerun     stored MINUS the target    → the rewind stands, no reply
        //   continue  stored UNCHANGED           → the half-finished message is
        //                                          left exactly as it was
        // On a handoff pass it is what is already on disk, so the write is a
        // no-op in content and still refreshes the version — which is correct:
        // this runner did touch the conversation.
        const stopSave = await saveMessages(plan.history);
        if (!stopSave.ok) {
          return {
            ok: false, stage: 'save',
            reason: stopSave.conflict
              ? 'refused: the conversation changed on disk while this turn ran'
              : `save failed: ${String(stopSave.error || 'unknown')}`,
            consumedIds: saved ? consumedIds : [],
          };
        }
        return { ok: false, stage: 'stopped', reason: 'stopped by request', consumedIds };
      }

      // A HANDOFF pass failed with nothing to show: no credit, a dead key, the
      // provider down. The vessel that asked for the switch is owed that news
      // in its own voice — "report, do not stop". A failure that only reaches
      // the human leaves the being believing it moved somewhere it never
      // arrived.
      //
      // `!pass.sawOutput` is load-bearing (the browser says so too): a vessel
      // that streamed text and THEN died did receive the handoff and did read
      // the note, so "it could not answer" would be a lie — and re-posting
      // would discard that text along with its billing.
      if (saved && plan.vessel && !pass.sawOutput && !reportedFailure) {
        reportedFailure = true;
        plan = {
          // Unchanged: the failed vessel produced nothing, so there is nothing
          // new for the original vessel to read except the report itself.
          history: plan.history,
          keep: plan.keep,
          base: { id: deps.newId(), role: 'assistant', timestamp: deps.nowMs() },
          seed: { continuedSeed: '', continuedThought: '', continuedBlocks: [] },
          continueFromMessageId: null,
          // `null` means literally "the being's saved vessel" here. The browser
          // needs an explicit forceSavedVessel flag because it has a React
          // handoffOverride to overrule; a runner holds no such state.
          vessel: prevVessel,
          handoffFailed: {
            family: plan.vessel.family,
            specificModel: plan.vessel.specificModel,
            label: plan.vessel.label || plan.vessel.specificModel,
            error: pass.reason,
          },
          // The human's copy of the same news. Without this the dead vessel's
          // error leaves no trace a reader can check.
          carryNotices: [describeProviderError(pass.reason)],
        };
        // Deliberately NOT incrementing depth: the hop that failed was already
        // counted, and the cap still bounds a being that keeps reaching for a
        // vessel that is not there.
        continue;
      }

      // A later pass failed. The turn DID produce an answer, so the result is
      // still ok:true — with the failure named, because a handoff that lost
      // its destination is exactly what the operator needs to see in the log.
      if (saved) {
        return {
          ok: true,
          messageId: lastMessageId,
          savedAt: lastSavedAt,
          unappliedDescriptions: unapplied,
          handoffHops: depth,
          handoffError: `${pass.stage}: ${pass.reason}`,
          consumedIds,
        };
      }

      // The FIRST pass failed and nothing is on disk. What the model produced
      // before that point is NOT saved — same as the browser, where an
      // un-finalized streaming message is dropped on an error that is not an
      // abort. Saving a partial turn here would put a truncated answer on disk
      // with nothing marking it as truncated.
      return { ok: false, stage: pass.stage, reason: pass.reason, consumedIds: [] };
    }

    // Saved through the one helper built above (see it for why `updatedAt` is
    // dropped), so the success save and the Stop save cannot drift apart.
    // `keep` is history for a send or a rerun, and everything BEFORE the
    // target for a continue — where `assistant` carries the target's own id,
    // so this replaces it in place instead of appending a near-duplicate.
    const result = await saveMessages([...plan.keep, pass.assistant]);
    if (!result.ok) {
      return {
        ok: false, stage: 'save',
        reason: result.conflict
          ? 'refused: the conversation changed on disk while this turn ran'
          : `save failed: ${String(result.error || 'unknown')}`,
        // A handoff pass that cannot save has still spent the first pass's
        // answer, which IS on disk — so the batch stays consumed.
        consumedIds: saved ? consumedIds : [],
      };
    }
    saved = true;
    lastMessageId = String(pass.assistant.id);
    lastSavedAt = deps.nowMs();
    unapplied += pass.unapplied;

    const handoff = pass.handoff;
    if (!handoff) break;

    // Chain guard: a fresh vessel can call change_model on its very first
    // turn, and two vessels that each prefer the other would ping-pong
    // forever, spending real money per hop. After the cap the switch simply
    // stops being followed — and because a queued turn always starts on the
    // saved default, nothing carries into the next turn either (the browser
    // keeps an override in React state here; a runner has no between-turn
    // state at all, which is the same end state by a shorter road).
    if (depth >= MAX_HANDOFF_CHAIN) {
      handoffNote = `handoff chain capped at ${MAX_HANDOFF_CHAIN}`;
      break;
    }
    depth += 1;

    // The next pass sees everything up to and including the message that
    // handed over, and writes a NEW assistant message after it.
    //
    // The browser needs a replace-or-append decision here (ChatArea:4284:
    // a continue's `history` already contains the target, so a blind append
    // puts one id in the array twice — MEASURED in 先輩_64). This composition
    // cannot produce that: `keep` is by construction everything in front of
    // the reply, so `[...keep, assistant]` contains each id exactly once for
    // all three shapes.
    const nextHistory = [...plan.keep, pass.assistant as unknown as SlimHistoryMessage];
    prevVessel = plan.vessel;
    plan = {
      history: nextHistory,
      keep: nextHistory,
      base: { id: deps.newId(), role: 'assistant', timestamp: deps.nowMs() },
      seed: { continuedSeed: '', continuedThought: '', continuedBlocks: [] },
      continueFromMessageId: null,
      vessel: {
        family: handoff.family,
        specificModel: handoff.specificModel,
        thinking: handoff.thinking,
        label: handoff.label,
      },
      handoffFrom: {
        family: handoff.fromFamily,
        specificModel: handoff.fromSpecificModel,
        label: handoff.fromLabel,
        note: handoff.note,
      },
      carryNotices: [],
    };
  }

  return {
    ok: true,
    messageId: lastMessageId,
    savedAt: lastSavedAt,
    unappliedDescriptions: unapplied,
    handoffHops: depth,
    ...(handoffNote ? { handoffError: handoffNote } : {}),
    consumedIds,
  };
}
