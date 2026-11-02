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
 * No retry, and (since 2026-11-02) no abandon for a pass that RAN. Every
 * ending of a pass — finished, stopped, failed — commits a message and
 * CONSUMES the batch. A failed send therefore looks like it did before the
 * server existed: the user message stays, the assistant message is empty, and
 * the person presses "retry" if they want it. Nothing re-fires on its own, so
 * nothing can re-fire forever, and nothing waits in the stock panel for an
 * answer the person never wanted to give.
 *
 * THREE things still abandon, and all three are a batch that never became a
 * turn: no log on disk, an empty batch, and a save that failed before anything
 * of this turn was written (there is no record to retry FROM, so consuming
 * would delete the text instead of keeping it). The tick route abandons for
 * the same class of reason when the runner itself throws. ⚠ The first of them
 * re-fires forever if a conversation is deleted while items wait for it — see
 * pending-tasks; it predates this change and is not fixed by it.
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
  composeBatch, splitLeadingTurn, isCommandKind, isEmptyTurnText,
  type QueueItem, type CommandPayload,
} from '@/lib/turnQueue';
import type { TurnEventDeps } from '@/lib/turnEventReducer';
import type { TurnHandoffPlan } from '@/lib/turnEvents';
import { describeProviderError } from '@/lib/providerErrors';
import { promotePendingMarker, type ResolvedMarker } from '@/lib/firstOriginal';

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
  /**
   * The id the CALLER has already painted a placeholder under, adopted as the
   * first pass's assistant message id.
   *
   * ⚠ This is not cosmetic. ChatArea renders the message list with
   * `key={msg.id}`, and a watching tab reloads from disk when the relay
   * closes. If the id this runner saves differs from the id the tab streamed
   * into, that reload unmounts the streaming bubble and mounts a new one --
   * taking every ref inside it with it. Streaming TTS keeps its processed
   * offset, its ordered audio slots and its in-flight synthesis fetches
   * there, so a long reply stops being spoken partway through with no error
   * anywhere. MEASURED 2026-10-31.
   *
   * Ignored (and `newId` used instead) when absent, empty, or already present
   * in the log: a duplicate id is worse than a remount.
   *
   * Only the FIRST pass. A handoff's second pass is a genuinely new message
   * that no tab has painted, so it keeps minting its own.
   */
  proposedAssistantId?: string;
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

/**
 * The three things a `turn_saved` frame carries ABOUT THIS PASS; the two
 * version numbers and the marker come from the save itself and are filled in
 * by `saveMessages`.
 *
 * Deliberately not `{ kind: 'send' | 'rerun' | 'continue' }`: the shape is
 * already fully described by which fields are present, and a `kind` that
 * disagreed with the fields would be a second source of truth about one
 * event. See lib/turnSaved.ts for the applying end.
 */
interface TurnSavedPublish {
  assistant: unknown;
  user?: unknown;
  dropId?: string | null;
}

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

  // The first pass's assistant id: the caller's if it is usable, ours if not.
  // Collision check against the log is the whole reason this is a function and
  // not a `??` -- two messages with one id breaks dedupe, rerun's "is it last"
  // check, and every edit-by-id path at once.
  const firstPassAssistantId = (): string => {
    const proposed = deps.proposedAssistantId;
    if (typeof proposed !== 'string' || !proposed) return deps.newId();
    if (stored.some((m) => String((m as Record<string, unknown>).id) === proposed)) {
      return deps.newId();
    }
    return proposed;
  };

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
  /** rerun only: the answer being discarded, so a watcher can drop it too. */
  let dropId: string | null = null;
  /** send only: the composed batch, because the queue never reports bodies. */
  let announcedUser: Record<string, unknown> | null = null;
  /**
   * send only: the two "copied vs original" fields, when THIS turn's new user
   * message resolves a boundary the clone left pending.
   *
   * ⚠ Empty for rerun and continue, and that is the point — neither adds a
   * user message, so neither may move the boundary. Spread into the save
   * unconditionally, so there is no second place deciding whether to apply it.
   */
  let markerPatch: Partial<ResolvedMarker> = {};

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
      // ── A rerun needs an ANSWER to throw away ───────────────────────────
      // `slice(0, idx)` means "everything in front of the target", which is
      // right for an assistant (drop the reply, ask again from the same point)
      // and silently wrong for a user message: it would drop THAT message too
      // and post a history with nothing in it — an empty turn, billed, with
      // the sender's own text deleted from the log.
      //
      // MessageBubble only offers rerun on `!isUser`, so the UI cannot reach
      // this. That is exactly why it is checked here anyway: the precondition
      // below it ("still last") exists for the same reason, in this file's own
      // words — "the browser cannot hit this case because it acts on its own
      // in-memory array; a runner reads the log fresh, so the precondition has
      // to be re-checked here". Refused rather than reinterpreted as "answer
      // this again": inventing a second meaning for a button nobody can press
      // would be a feature with no asker.
      if (target.role === 'user') {
        return { ok: false, stage: 'target', reason: 'cannot rerun a user message', consumedIds };
      }
      // Throw the answer away and ask again from the same point.
      history = stored.slice(0, idx);
      keep = history;
      base = { id: firstPassAssistantId(), role: 'assistant', timestamp: nowStart };
      dropId = targetMsgId;
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
    // ── Never POST a blank turn ─────────────────────────────────────────────
    // REPORTED 2026-11-01 (トカゲくん): after a failed turn left an item in
    // the stock, pressing "Run now" "sends an empty message to the model".
    // composeBatch answers `text: ''` whenever NO item in the batch carried a
    // string payload.text — the unproduced kinds (letter/schedule/system) and
    // anything malformed — and this branch then wrapped that '' in a user
    // message and sent it. An empty user turn is a real request: it costs
    // money, it gets an answer to nothing, and it lands in the log as a blank
    // bubble nobody typed.
    //
    // CONSUMED, not abandoned, and that is the difference between a bug and a
    // loop: nothing about these items will ever become runnable, so putting
    // them back means the panel says "1 waiting" forever and every auto-
    // trigger tries them again. The reason travels to the relay, so the stock
    // panel says what was dropped instead of counting it silently.
    if (isEmptyTurnText(batch.text, batch.attachments)) {
      const kinds = take.map((i) => i.kind).join(', ');
      return {
        ok: false, stage: 'target', consumedIds,
        reason: `nothing to send: ${take.length} queued item(s) [${kinds}] carried no text and no attachments`,
      };
    }
    const userMessage = {
      id: deps.newId(),
      role: 'user',
      content: batch.text,
      attachments: batch.attachments,
      timestamp: nowStart,
    };
    history = [...stored, userMessage as SlimHistoryMessage];
    keep = history;
    base = { id: firstPassAssistantId(), role: 'assistant', timestamp: nowStart };
    announcedUser = userMessage as Record<string, unknown>;
    // The clone workflow's second half. `NexusApp` sets `firstOriginalIsNext`
    // when it clones a conversation forward and its comment says the flag is
    // "consumed by ChatArea.handleSend" — which stopped being true when sends
    // moved here, because the id the marker has to name is `userMessage.id`,
    // minted in this process, after the tab's send has already returned. (A
    // comment that counts lines instead of naming the thing is wrong the next
    // time anyone edits above it; this one said "four lines up" and meant 15.)
    markerPatch = promotePendingMarker(log, userMessage.id) ?? {};
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
  const saveMessages = async (messages: unknown[], published?: TurnSavedPublish) => {
    // Read BEFORE the save: this is the version the patch is a continuation
    // of, and it is the only thing that lets a tab prove the patch applies to
    // the array it is holding. Taken here rather than at the call site so the
    // success save and the Stop save cannot disagree about it.
    const readVersion = guardVersion;
    const r = await deps.saveLog(
      convoId,
      // `markerPatch` AFTER `messages`: it must win over the pending fields
      // carried in `logWithoutVersion`, which are what the tab last saved.
      { ...logWithoutVersion, messages, ...markerPatch },
      { expectedUpdatedAt: guardVersion, clientId: deps.clientId },
    );
    if (r.ok && typeof r.writtenUpdatedAt === 'number') guardVersion = r.writtenUpdatedAt;
    // ── TELL THE TABS WHAT LANDED, so they do not re-download the log ───────
    //
    // MEASURED 2026-11-01 over 293 conversations: this frame is p50 7,891 B
    // and the full reload it replaces is p50 438,368 B — 55.6x. Paid once per
    // finished turn, by every tab watching.
    //
    // Only on `r.ok`. A refused save (409) left disk unchanged, so there is no
    // patch to apply and the tab must reload to see whose version won.
    // And only when the caller asked: see `publishableSave`.
    if (r.ok && published) {
      deps.onRawText?.(`data: ${JSON.stringify({
        type: 'turn_saved',
        readUpdatedAt: readVersion ?? null,
        writtenUpdatedAt: typeof r.writtenUpdatedAt === 'number' ? r.writtenUpdatedAt : null,
        user: published.user ?? null,
        assistant: published.assistant,
        dropId: published.dropId ?? null,
        // Read through the closure, so a promotion that happened earlier in
        // THIS turn travels with the save that persisted it. Empty for a
        // rerun/continue, which cannot move the boundary.
        marker: Object.keys(markerPatch).length > 0 ? markerPatch : null,
      })}\n\n`);
    }
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
    /**
     * Corrections a WATCHING tab needs, set only on the FIRST pass.
     *
     * Not part of what the model sees or what gets saved — these two travel
     * with the plan because the plan is what the announcement is made from,
     * and a handoff pass must announce a NEW bubble with neither of them.
     */
    dropId?: string | null;
    announcedUser?: Record<string, unknown> | null;
  }

  interface PassFailure {
    stage: 'post' | 'stream';
    reason: string;
    /**
     * Did this pass produce anything at all before it failed? Load-bearing
     * for the handoff-failure report: a vessel that streamed text and THEN
     * died did receive the handoff and did read the note, so "it could not
     * answer" would be false.
     */
    sawOutput: boolean;
    /**
     * REQUIRED on every failure, not just a Stop (2026-11-02).
     *
     * The reason it is required rather than optional is the one the Stop
     * variant used to give on its own: the partial has to exist by the time
     * the chain reads the failure, or a later reader has to decide whether
     * its absence meant "nothing arrived" or "nobody built it". That was
     * true for a stop and it is true for a failure — a failed send owes the
     * log an empty assistant message so the person can press "retry".
     */
    assistant: Record<string, unknown>;
  }

  type PassResult =
    | {
        ok: true;
        assistant: Record<string, unknown>;
        handoff: TurnHandoffPlan | null;
        sawOutput: boolean;
        unapplied: number;
      }
    // A failure. `stopped` separates a DECISION from an accident — it decides
    // the notice the watcher gets and whether the log says so, but both now
    // commit (see PassFailure.assistant). `stopped: true` is only ever produced
    // for a 'stream' failure.
    | ({ ok: false; stopped: boolean } & PassFailure);

  const runPass = async (plan: PassPlan): Promise<PassResult> => {
    const passStart = deps.nowMs();

    // ── Tell every WATCHING tab which bubble this pass writes ───────────────
    //
    // Emitted here, at the top of EVERY pass, rather than once before the
    // chain: a handoff opens a second pass with a freshly minted id, and a
    // watcher told only about the first would paint the second vessel's answer
    // into the first vessel's message. One site, so the two cannot drift.
    //
    // Before the post, so it is the first frame of this pass in the relay and
    // therefore the first frame of any later subscriber's replay. See
    // normaliseTurnPlan for why a frame and not a response header.
    //
    // `onRawText` is the relay hook (lib/turnBus); this is the one place the
    // runner feeds it something the provider did not say.
    deps.onRawText?.(`data: ${JSON.stringify({
      type: 'turn_plan',
      assistantId: String(plan.base.id || ''),
      dropId: plan.dropId ?? null,
      user: plan.announcedUser ?? null,
      continuedSeed: plan.seed.continuedSeed,
      continuedThought: plan.seed.continuedThought,
      continuedBlocks: plan.seed.continuedBlocks,
    })}\n\n`);

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

    // Empty for a send or a rerun; the target's own half for a continue (see
    // the shape block above for why the thinking has to travel too). Notices
    // are seeded rather than empty so a previous vessel's failure text reaches
    // the reader on the message that reports it.
    const acc = createTurnAccState({ ...plan.seed, notices: [...plan.carryNotices] });
    const flags = createTurnFlags();
    const sink = createRunnerSink();

    // Built HERE, above BOTH the post and the stream, because EVERY exit needs
    // it: the pass that finishes, the pass someone stops, and (since
    // 2026-11-02) the pass that fails. Until 2026-10-30 only the success path
    // finalized, and a Stop therefore threw the partial away — measured by
    // Lizard-kun on all three shapes (send, rerun, change_model).
    //
    // ⚠ `attachments` — see F34. finalizeTurnMessage does NOT set it; in the
    // browser the streaming flush has already written tool attachments onto the
    // message being finalized. A runner has no flush, so it must put them on
    // the base itself or a file a tool produced vanishes with no error anywhere.
    //
    // For a CONTINUE, `base` is the target message itself, so the files its
    // first half produced are already in there — append rather than replace, or
    // continuing a reply would silently drop the attachments it had earned.
    const finalizeAssistant = () => finalizeTurnMessage(
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

    // ── POST, below the finalizer, because a POST failure also has to COMMIT ──
    //
    // Moved here 2026-11-02. These two exits used to return with no `assistant`
    // at all, which forced the chain to abandon the batch. Lizard-kun named the
    // behaviour the server version owes the browser one: "the USER message stays
    // as it is, the ASSISTANT message stays empty, and 'retry' is easy to press
    // — if the assistant message is not kept, 'retry' cannot be pressed." That
    // needs a message to EXIST, so both exits finalize like every other one.
    //
    // For a send the finalized message is empty (nothing streamed). For a
    // CONTINUE it carries `plan.seed` — the half the target already had — so a
    // continue whose post dies keeps the text it was extending instead of
    // replacing it with a blank.
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
        stopped: false, sawOutput: false, assistant: finalizeAssistant(),
      };
    }
    if (!res.ok || !res.body) {
      return {
        ok: false, stage: 'post',
        reason: `route answered ${res.status}${res.body ? '' : ' with no body'}`,
        stopped: false, sawOutput: false, assistant: finalizeAssistant(),
      };
    }

    try {
      await runTurnStream(res.body.getReader(), acc, flags, sink, runnerEventDeps(deps), {
        onRawText: deps.onRawText,
      });
    } catch (e) {
      const reason = String((e as Error)?.message || e);
      // `wasStopped` is read HERE and not by the caller because the chat route
      // calls forgetStop the instant it aborts — asking later asks a record
      // that has already been deleted.
      if (deps.wasStopped?.() === true) {
        // A partial reply saved with no marker CLAIMS to be a complete one: a
        // reader opening the log later cannot tell a stopped turn from a terse
        // one. The notice channel is the right place — `notices` is not in
        // buildSlimHistory's allowlist, so this reaches the reader and never
        // reaches the model (a stop explanation replayed as context would
        // teach the model about being stopped).
        const lang = (deps.globalSettings as { language?: string } | null)?.language;
        acc.notices.push(
          lang === 'ja'
            ? 'このターンは停止されました。返答はここまでです。'
            : 'Turn stopped by request — this reply is as far as it got.',
        );
        return {
          ok: false, stage: 'stream', reason,
          stopped: true,
          sawOutput: flags.sawOutput,
          assistant: finalizeAssistant(),
        };
      }
      return {
        ok: false, stage: 'stream', reason,
        stopped: false,
        sawOutput: flags.sawOutput,
        // No stop notice: nobody decided anything. The text that DID arrive
        // before the stream broke is kept for the same reason a stop keeps it —
        // it was generated, and it was paid for.
        assistant: finalizeAssistant(),
      };
    }

    return {
      ok: true,
      assistant: finalizeAssistant(),
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
    dropId,
    announcedUser,
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

    /**
     * What this pass's save should publish to the tabs — or nothing.
     *
     * ⚠ A HANDOFF CHAIN CANNOT BE PATCHED, and this is the one place that
     * decides it (both saves below go through here, so they cannot disagree).
     *
     * `turn_plan` is FIRST-PLAN-ONLY on a watching tab (ChatArea: `if
     * (watchId) return`), deliberately — so the second vessel's text is
     * appended to the FIRST vessel's bubble on screen, while disk holds two
     * separate messages. A patch would then ALSO append the second message and
     * leave the concatenated text in the first: the same answer twice. The
     * full reload splits them correctly for every tab, which is what it
     * already did before this frame existed, so a handoff turn keeps using it.
     *
     * TWO conditions, and they catch different passes. `depth > 0` is a LATER
     * pass of a chain. `handoff` is the FIRST pass of one — the pass whose
     * patch would be correct on its own and then be invalidated by the text
     * that follows it into the same bubble.
     *
     * `handoff` is a PARAMETER and not `pass.handoff`, because the type says
     * only the success variant has that field: a Stop is always a 'stream'
     * failure, so the pass that was stopped did not hand over, and the caller
     * states that by passing null. (`depth` still applies there — Stop can
     * land on the second pass of a chain.)
     */
    const publishableSave = (
      assistant: unknown,
      handoff: TurnHandoffPlan | null,
    ): TurnSavedPublish | undefined => {
      if (depth > 0 || handoff) return undefined;
      return { assistant, user: plan.announcedUser ?? null, dropId: plan.dropId ?? null };
    };

    /**
     * Commit a pass that did not finish, and SPEND the batch.
     *
     * One helper for the two ways a pass ends badly (stopped, failed) because
     * they want the identical three things — the same composition, the same
     * version guard, the same consume decision — and two derivations of that
     * drift in exactly the field nobody is looking at.
     *
     * `[...plan.keep, assistant]` is the SAME composition the success path
     * uses, and is right for all four shapes for the same reason: `keep` is by
     * construction everything in FRONT of this pass's reply.
     *   send      stored + the user message  → reply appended (empty if the
     *                                          post never got through)
     *   rerun     stored MINUS the target    → reply takes its place
     *   continue  everything before target   → `base` IS the target, so the
     *                                          half-written reply extends in
     *                                          place, keeping its id
     *   handoff   + the handing-over reply   → appended after it
     *
     * `null` for the handoff argument: neither a stop nor a failure handed over
     * to anybody, so the chain ends here and the tab may patch rather than
     * re-download.
     */
    const commitUnfinished = async (
      assistant: Record<string, unknown>,
      outcome: { stage: 'stopped' | 'post' | 'stream'; reason: string },
    ): Promise<RunTurnResult> => {
      const r = await saveMessages([...plan.keep, assistant], publishableSave(assistant, null));
      if (!r.ok) {
        return {
          ok: false, stage: 'save',
          reason: r.conflict
            ? 'refused: the conversation changed on disk while this turn ran'
            : `save failed: ${String(r.error || 'unknown')}`,
          consumedIds: saved ? consumedIds : [],
        };
      }
      return { ok: false, stage: outcome.stage, reason: outcome.reason, consumedIds };
    };

    if (!pass.ok) {
      if (pass.stopped) {
        // The person pressed Stop: COMMIT THE PARTIAL and report 'stopped', so
        // the tick route CONSUMES the batch instead of abandoning it.
        // Abandoning would leave the items for the auto-trigger to re-fire —
        // the generation just stopped would start over, which looks exactly
        // like "Stop does nothing" (MEASURED 2026-10-29).
        //
        // ⚠ CORRECTION of this file's own earlier comment. Until 2026-10-30
        // this branch wrote `plan.history` — the turn WITHOUT a reply — and
        // justified it by claiming "the browser Stop drops its own partial".
        // That claim was false and I never checked it. ChatArea:4221 says the
        // opposite in its own words: "Commit whatever the turn accumulated —
        // partial text, tool calls, cache usage — even when the partner
        // stopped it (AbortError), so billing and the 🔧 tool report are saved
        // to the log instead of lost." MEASURED by Lizard-kun as three
        // separate symptoms (send / rerun / change_model), which were one bug.
        //
        return commitUnfinished(pass.assistant, {
          stage: 'stopped',
          reason: 'stopped by request',
        });
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

      // The FIRST pass failed, not by request, and nothing is on disk yet.
      //
      // ⚠ CORRECTION, 2026-11-02 — of a comment I wrote in this file and then
      // reasoned from for days. It said:
      //
      //   "'Commit the partial' and 'let it be retried' are the two coherent
      //    answers to a failure and they exclude each other"
      //
      // Lizard-kun named the THIRD, which is the one the browser always gave:
      // commit, and let a PERSON retry. In his words: "In the pre-server
      // version the USER message stays as it is, the ASSISTANT message stays
      // empty, and 'retry' is easy to press — if the assistant message is not
      // kept, 'retry' cannot be pressed either. I expect the same behaviour on
      // the server version. So there is no 'run now' and no 'discard' here at
      // all; on a failure this just stays, and the rest is the admin's
      // judgement."
      //
      // The two answers I named excluded each other only because I had assumed
      // the retry must be AUTOMATIC. Commit-and-consume has neither failure
      // mode: no duplicate user message (the batch is spent, so no poll
      // re-composes it) and no lost text (it is in the log, where a reader can
      // see it and a tab paints it). The text the person typed is NOT in the
      // queue item alone — InputArea clears its localStorage draft on send, so
      // before this change the only copies were the queue item and an
      // optimistic bubble that a reload erases.
      //
      // This also removes the only thing that ever pushed a failed SEND into
      // the stock panel, which is why the two buttons are gone with it.
      return commitUnfinished(pass.assistant, { stage: pass.stage, reason: pass.reason });
    }

    // Saved through the one helper built above (see it for why `updatedAt` is
    // dropped), so the success save and the Stop save cannot drift apart.
    // `keep` is history for a send or a rerun, and everything BEFORE the
    // target for a continue — where `assistant` carries the target's own id,
    // so this replaces it in place instead of appending a near-duplicate.
    const result = await saveMessages(
      [...plan.keep, pass.assistant],
      publishableSave(pass.assistant, pass.handoff),
    );
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
