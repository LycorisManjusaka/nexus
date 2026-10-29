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
 * No retry. A failed turn leaves the queue items alone (`abandon`, not
 * `release`), so the next poll sees the same batch and the auto-trigger
 * signature is unchanged — the same guard the client-side drain uses, for the
 * same reason: a turn that fails instantly must not re-fire forever.
 *
 * No handoff follow-up. `change_model` ends the turn server-side and ChatArea
 * sends a SECOND request as the new vessel. A runner stops after the first:
 * the message is saved with the handoff recorded on it, and the next queued
 * turn starts from the being's saved default — which is what a fresh user
 * turn does anyway (MEASURED by つよ from the outside, 2026-10-28).
 *
 * No attachment-description write-back. See runnerSink's RunnerSinkReport.
 */

import { buildSlimHistory, type SlimHistoryMessage } from '@/lib/slimHistory';
import { buildTurnRequestBody } from '@/lib/turnRequestBody';
import { turnInputFromLog } from '@/lib/turnInputFromLog';
import { createTurnAccState, assertFinalizable } from '@/lib/turnAccState';
import { finalizeTurnMessage } from '@/lib/finalizeTurnMessage';
import { runTurnStream } from '@/lib/turnStreamLoop';
import { createRunnerSink, createTurnFlags } from '@/lib/runnerSink';
import { effectiveFullAccess } from '@/lib/agentCapabilities';
import { composeBatch, type QueueItem } from '@/lib/turnQueue';
import type { TurnEventDeps } from '@/lib/turnEventReducer';

/** What the runner could not do itself. */
export interface RunTurnDeps {
  /** fsStorage.loadLog */
  loadLog: (convoId: string) => Promise<Record<string, unknown> | null>;
  /** fsStorage.saveLog */
  saveLog: (
    convoId: string,
    logData: Record<string, unknown>,
    opts?: { expectedUpdatedAt?: number; clientId?: unknown },
  ) => Promise<{ ok: boolean; conflict?: unknown; error?: unknown }>;
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
}

export type RunTurnResult =
  /** The turn ran and the log was written. */
  | { ok: true; messageId: string; savedAt: number; unappliedDescriptions: number }
  /**
   * Nothing was run. `reason` names which precondition failed, never a
   * generic failure: a runner that logs "could not run" tells the operator
   * nothing they can act on.
   */
  | { ok: false; stage: 'no-log' | 'post' | 'stream' | 'save'; reason: string };

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
    return { ok: false, stage: 'no-log', reason: `no log on disk for ${convoId}` };
  }

  // The queue batch becomes ONE user message, exactly as the client-side
  // drain composes it: `[label]\ntext` per item, FIFO, skipped items
  // contributing nothing at all (including their attachments).
  const batch = composeBatch(items);
  const nowStart = deps.nowMs();
  const userMessage = {
    id: deps.newId(),
    role: 'user',
    content: batch.text,
    attachments: batch.attachments,
    timestamp: nowStart,
  };

  const stored = Array.isArray(log.messages) ? (log.messages as SlimHistoryMessage[]) : [];
  const history = [...stored, userMessage as SlimHistoryMessage];

  // A queued turn is a fresh user turn, so turnAiName is the being's saved
  // vessel family, not a handoff override (there is none to carry in).
  const aiName = (log.aiName as string) ?? deps.folderDefaults.aiName;
  const slim = buildSlimHistory(history, {
    hiddenAttachmentsAccessible: log.hiddenAttachmentsAccessible === true,
    attachmentPathsVisible: effectiveFullAccess(
      log.agentFullSystemAccess === true,
      log.agentDangerousTools === true,
    ),
    toolHistoryEnabled: log.toolHistoryEnabled === true,
    saveThinkingToLog: log.saveThinkingToLog === true,
    turnAiName: aiName,
  });

  // Taken, not generated: see RunTurnDeps.injectTurnId.
  const injectTurnId = deps.injectTurnId;
  const input = turnInputFromLog(log, {
    convoId,
    messages: slim as unknown as SlimHistoryMessage[],
    enableReadConversation: deps.enableReadConversation,
    globalSettings: deps.globalSettings,
    injectTurnId,
    clientId: deps.clientId,
    folderDefaults: deps.folderDefaults,
  });
  const body = buildTurnRequestBody(input);

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
    return { ok: false, stage: 'post', reason: String((e as Error)?.message || e) };
  }
  if (!res.ok || !res.body) {
    return {
      ok: false,
      stage: 'post',
      reason: `route answered ${res.status}${res.body ? '' : ' with no body'}`,
    };
  }

  const acc = createTurnAccState({
    continuedSeed: '',
    continuedThought: '',
    continuedBlocks: [],
    notices: [],
  });
  const flags = createTurnFlags();
  const sink = createRunnerSink();

  try {
    await runTurnStream(res.body.getReader(), acc, flags, sink, runnerEventDeps(deps), {
      onRawText: deps.onRawText,
    });
  } catch (e) {
    // The stream threw: an API error frame, or a transport failure. What the
    // model produced before that point is NOT saved — same as the browser,
    // where an un-finalized streaming message is dropped on an error that is
    // not an abort. Saving a partial turn here would put a truncated answer
    // on disk with nothing marking it as truncated.
    return { ok: false, stage: 'stream', reason: String((e as Error)?.message || e) };
  }

  // ⚠ `attachments` — see F34. finalizeTurnMessage does NOT set it; in the
  // browser the streaming flush has already written tool attachments onto the
  // message being finalized. A runner has no flush, so it must put them on
  // the base itself or a file a tool produced vanishes with no error anywhere.
  const assistant = finalizeTurnMessage(
    {
      id: deps.newId(),
      role: 'assistant',
      timestamp: deps.nowMs(),
      attachments: flags.toolAttachments,
      ...(acc.currentThought ? { thoughtProcess: acc.currentThought } : {}),
    },
    assertFinalizable(acc),
    {
      genStartTime: nowStart,
      nowMs: deps.nowMs(),
      // VRChat auto-play is a browser behaviour; a saved message that claims
      // it would make the next tab that opens this log start speaking.
      autoPlay: false,
      tokenModel: acc.chosenModelFamily || aiName,
    },
  );

  // The log is written back WHOLE, with only `messages` replaced. The other
  // ~55 fields are the ones the browser last saved; rebuilding them here
  // would mean a runner's save could differ from a tab's save in a field
  // neither of us is looking at.
  //
  // ⚠ EXCEPT `updatedAt`, which must NOT travel. MEASURED 2026-10-29:
  // fsStorage.saveLog does `logData.updatedAt = logData.updatedAt || Date.now()`
  // — it stamps a new version only when the caller did not bring one. The
  // browser never brings one (its save payload has no such field), so for a
  // tab this is invisible. Spreading the loaded log DOES bring one, and the
  // result is a write that keeps the OLD version number:
  //
  //   · every open tab's optimistic lock sees base === disk and happily
  //     overwrites the runner's turn with its own stale copy (MEASURED: a
  //     turn ran, saved six messages, and was back to four a second later)
  //   · lastWriter records a version nobody will ever ask about
  //   · the sidebar sorts by updatedAt, so a runner turn never moves its
  //     conversation up
  //
  // Dropping the key is the whole fix: saveLog then stamps now, exactly as it
  // does for a tab.
  const { updatedAt: _carriedVersion, ...logWithoutVersion } = log;
  void _carriedVersion;
  const result = await deps.saveLog(
    convoId,
    { ...logWithoutVersion, messages: [...history, assistant] },
    {
      expectedUpdatedAt: typeof log.updatedAt === 'number' ? log.updatedAt : undefined,
      clientId: deps.clientId,
    },
  );
  if (!result.ok) {
    return {
      ok: false,
      stage: 'save',
      reason: result.conflict
        ? 'refused: the conversation changed on disk while this turn ran'
        : `save failed: ${String(result.error || 'unknown')}`,
    };
  }

  return {
    ok: true,
    messageId: String(assistant.id),
    savedAt: deps.nowMs(),
    unappliedDescriptions: sink.report.unappliedDescriptions.length,
  };
}
