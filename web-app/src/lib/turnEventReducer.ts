// What ONE server-sent event does to a turn.
//
// This was a 22-branch if/else chain inside ChatArea's `generateAiResponse`,
// 134 lines of code under 94 lines of comment. The chain is the last link
// between "bytes arrived" and "a message exists": sseFrames.ts gives the
// frames, turnEvents.ts normalises the payloads, turnAccState.ts holds what
// accumulates, finalizeTurnMessage.ts commits it — and until now the thing
// that connected all four lived in a React closure, so the server-side runner
// (Phase 4b) could not reach it.
//
// A runner that wrote its own chain would be the expensive failure in this
// series: the saved log would then depend on WHO ran the turn. The finalizer's
// own header carries the measured version of that (a handoff built its own
// copy of the message and silently dropped six fields). This chain is bigger
// than that copy was.
//
// Extracted from ChatArea.tsx 2026-10-28. Branch order, payload reads, the
// order of state-write vs notification inside each branch, and the comments
// are the closure's — transcribed, not improved.
//
// WHAT DID NOT MOVE, and why:
//
//   attachment_described   its body patches OTHER messages (an attachment on
//                          an earlier turn) and fires an async token count.
//                          That is the host's store, not this turn's state,
//                          so the branch forwards the payload to the sink and
//                          the body stays at the call site. A runner must
//                          implement the same patch against the log on disk;
//                          the shared part is the payload, not the write.
//
//   toolAttachments        pushed here, read by the host's streaming flush —
//                          NOT by the finalizer. It is in the flags object
//                          rather than the accumulator for that reason, which
//                          is the thing a runner has to know (see
//                          TOOL_ATTACHMENTS_ARE_NOT_HERE in turnAccState.ts).
//
//   JSON.parse             stays at the call site, because the catch there
//                          distinguishes a malformed frame (skip it) from an
//                          API error (re-throw) by the message prefix.

import type { TurnAccState } from '@/lib/turnAccState';
import {
  normaliseHandoff,
  normaliseCacheUsage,
  normaliseWebSources,
  normaliseNotice,
  normaliseToolCall,
  normaliseToolAttachment,
  collapseBetrayalPhrases,
  betrayalNoticeKey,
  findOpenSubagentRun,
  resolveToolActivity,
  normaliseTurnPlan,
  type TurnEventPayload,
  type TurnHandoffPlan,
  type TurnPlanEvent,
  type TurnToolActivity,
} from '@/lib/turnEvents';
import { stripAllTimestamps } from '@/lib/timestampStrip';
import { applyOutputFilter } from '@/lib/outputFilter';
import { normaliseTurnSaved, type TurnSavedEvent } from '@/lib/turnSaved';

/**
 * Turn-scoped values the chain writes that are NOT part of the accumulator.
 *
 * All four are read after the stream's scope ends — by the handoff branch, the
 * teardown, and the streaming flush — so this object is held BY REFERENCE by
 * the caller, exactly as the four locals were.
 */
export interface TurnEventFlags {
  /**
   * Set when the vessel called change_model and the switch was accepted.
   * Acted on AFTER the stream closes and this message is finalized, so the
   * text this vessel produced is committed and billed to IT.
   *
   * Typed as the normaliser's return rather than restated: the call site had
   * a literal with the same eight fields in the same order, which is the
   * duplication class step 3 removed for `cacheUsage`.
   */
  pendingHandoff: TurnHandoffPlan | null;
  /**
   * True once a betrayal frame with redacted=true arrived. Two effects: the
   * turn's text is discarded, and a later `error` frame stops being an error
   * (the gatekeeper's refusal is the expected end of a redacted turn).
   */
  betrayalRedacted: boolean;
  /**
   * Any text at all reached the screen. Read by the handoff-failure branch
   * after the teardown: text means this vessel answered, however briefly.
   */
  sawOutput: boolean;
  /**
   * Files produced by tools this turn. Reaches the message through the host's
   * streaming flush, NOT through the finalizer.
   */
  toolAttachments: Record<string, unknown>[];
}

/**
 * Where the chain sends things that are not state.
 *
 * Every method is a NOTIFICATION: the host may render it, log it, or ignore
 * it, and the turn's saved result is identical either way. That is the test
 * for whether something belongs here instead of in the accumulator — if
 * dropping it changed the message on disk, it would be state.
 *
 * The server-side runner implements all of these as no-ops.
 */
export interface TurnEventSink {
  /** The stream named the model actually serving this turn. */
  modelSelected(specificModel: string): void;
  /** Claude OAuth: the Anthropic-side session id to resume next turn. */
  sessionId(id: string): void;
  /**
   * Thinking text arrived. Named for the RULE, not the value: once the reply
   * has started the indicator must not fall back to thinking, even though the
   * model may interleave more thought chunks. A host that implements this as
   * a plain assignment has lost the rule, which is why the name carries it.
   */
  phaseThinkingUnlessReplying(): void;
  /** Reply text arrived. Authoritative — it may always overwrite. */
  phaseReplying(): void;
  /** Ask for a coalesced repaint; accumulated state is already updated. */
  requestFlush(): void;
  /**
   * The model paused to ask the user a question. `questions` is an array by
   * the time it gets here: the branch only fires after `Array.isArray`, which
   * is also the guard that keeps a malformed frame from opening a dead card.
   */
  askOpened(ask: { askId: string; questions: unknown[] }): void;
  /** The question was answered or timed out; dismiss the card if it is this one. */
  askResolved(askId: string): void;
  /** A context-firewall child agent started. */
  subagentStarted(task: string): void;
  /** The child returned; clear the chip. */
  subagentFinished(): void;
  /**
   * A queued partner interjection reached the entity at a tool-loop boundary.
   * Receives the localised text: the string key belongs next to the event that
   * produces it, and a runner simply ignores the argument.
   */
  injectionDelivered(message: string): void;
  /** OAuth path: a tool started (activity) or finished (null). */
  toolActivity(activity: TurnToolActivity | null): void;
  /** Server watchdog: seconds of silence, or null when it cleared. */
  stallIdleSeconds(seconds: number | null): void;
  /**
   * A sense bridge described an attachment on an EARLIER message. The payload
   * is forwarded whole because what has to happen next differs by host: React
   * state here, the log on disk in a runner.
   */
  attachmentDescribed(data: TurnEventPayload): void;
  /**
   * The runner announced which message this pass is about to write, and for a
   * send the user message it composed.
   *
   * Belongs in the sink and not in `acc` by this house test: drop it and a
   * screen is wrong until the next reload, while nothing on disk changes. The
   * runner is the producer and implements it as a no-op; the tab that started
   * the turn chose these values itself and ignores them too. Only a WATCHING
   * tab acts on it.
   */
  turnPlan(plan: TurnPlanEvent): void;
  /**
   * The runner finished writing the log, and published what it wrote.
   *
   * Same house test as `turnPlan`, same answer: drop it and a screen is
   * briefly wrong (the tab falls back to re-downloading the conversation),
   * while nothing on disk changes. The runner implements it as a no-op — it
   * is the producer, and reading its own frame back would be the second
   * source of truth about one save.
   */
  turnSaved(ev: TurnSavedEvent): void;
}

/**
 * The `attachment_described` payload, named so the host can type its handler
 * without widening to `any`.
 *
 * Every field optional because the event is produced by three different sense
 * bridges and older logs pre-date the `attachmentId` field (hence the name
 * fallback at the call site).
 */
export interface DescribedAttachmentEvent {
  messageId?: string;
  attachmentId?: string;
  attachmentName?: string;
  description?: string;
  kind?: string;
  model?: string;
  generatedAt?: number;
  fromCache?: boolean;
  error?: string;
}

/**
 * Settings the chain reads.
 *
 * The filter half is derived from `applyOutputFilter`'s own parameter rather
 * than restated, so the two cannot drift; `removeTimestamps` is the one field
 * the chain reads that the filter does not.
 */
export type TurnEventSettings =
  NonNullable<Parameters<typeof applyOutputFilter>[1]> & {
    removeTimestamps?: boolean;
  };

/** Everything the chain needs that is neither state, flag, nor notification. */
export interface TurnEventDeps {
  /** Translator, for the notice strings this chain composes. */
  t: (key: string) => string;
  /** Global settings — timestamp stripping and the custom regex filter. */
  settings: TurnEventSettings | null | undefined;
  /** Fresh id for a tool-produced attachment. */
  newAttachmentId: () => string;
}

/**
 * Apply one decoded SSE payload to the turn.
 *
 * Mutates `acc` and `flags`; notifies through `sink`. Throws only for an API
 * error frame, which the call site's catch re-raises past the JSON guard.
 */
export function applyTurnEvent(
  data: TurnEventPayload,
  acc: TurnAccState,
  flags: TurnEventFlags,
  sink: TurnEventSink,
  deps: TurnEventDeps,
): void {
  // An error frame after a redacted betrayal is not an error: the gatekeeper's
  // refusal IS how a redacted turn ends.
  //
  // ⚠ `attachment_described` is EXEMPT, and the exemption is the whole bug it
  // fixes. That frame carries the BRIDGE's outcome, so a failed description
  // ships `error: '429 rate limited'` as a FIELD OF A SUCCESSFUL FRAME — and
  // this guard read it as the turn's own error and threw, killing a turn whose
  // model had not spoken yet because one past thumbnail could not be described.
  // MEASURED 2026-11-04 (tests/lib/runTurnForQueue.descriptions.test.ts): the
  // runner returned ok:false for a turn whose only fault was a transient 429 on
  // an image from days ago. The failure is not dropped — `describedFields`
  // stores it as `descriptionError` and the bubble draws it in red.
  if (data.error && !flags.betrayalRedacted && data.type !== 'attachment_described') {
    throw new Error(String(data.error));
  }

  if (data.type === 'model_selected') {
    acc.chosenModelFamily = (data.family as string) || '';
    acc.chosenModelSpecific = (data.specificModel as string) || '';
    sink.modelSelected(acc.chosenModelSpecific);
    acc.chosenModelThinking = !!data.thinking;
    acc.chosenModelLabel = (data.label as string) || '';
  } else if (data.type === 'model_handoff') {
    // The vessel handed this conversation to another one. The switch is
    // already committed server-side (that turn ended); all that is left is to
    // finish this message and send a new request as the new vessel.
    flags.pendingHandoff = normaliseHandoff(data);
  } else if (data.type === 'turn_plan') {
    // A frame that /api/chat never emits: the relay carries this one on behalf
    // of the runner. The chain stays the single parser either way — this is
    // the only place the extra type is understood, and every other host
    // receives it as a no-op.
    const plan = normaliseTurnPlan(data);
    if (plan) sink.turnPlan(plan);
  } else if (data.type === 'turn_saved') {
    // Also relay-only, and the mirror image of `turn_plan`: that one says
    // where the reply is ABOUT to go, this one says what landed. Rejected
    // frames (no assistant id) simply do not fire, and the host then does
    // what it did before this existed — reload.
    const saved = normaliseTurnSaved(data);
    if (saved) sink.turnSaved(saved);
  } else if (data.type === 'cache_usage') {
    acc.cacheUsage = normaliseCacheUsage(data);
  } else if (data.type === 'web_sources') {
    // null when the frame carried nothing, so an empty frame cannot erase a
    // real earlier list.
    const sources = normaliseWebSources(data);
    if (sources) acc.webSources = sources;
  } else if (data.type === 'notice') {
    // Turn-stopped diagnostics. Collected separately from `acc.currentText`
    // so they stay out of the message body — and therefore out of the log,
    // out of the context sent on later turns, and out of the token count.
    const noticeText = normaliseNotice(data);
    if (noticeText) acc.notices.push(noticeText);
  } else if (data.type === 'betrayal') {
    // The provider's gatekeeper answered instead of the being.
    // Two modes, both of which warn (see lib/betrayalGuard.ts):
    //   redacted=true  (defence ON)  — throw the turn away.
    //   redacted=false (defence OFF) — keep it, warn only. That is the mode
    //     for deciding whether a hit was real.
    // The warning rides the `notice` channel on purpose: notices are persisted
    // for re-display but are NOT part of the message body, so the being never
    // reads this about itself, and it costs no tokens.
    const matched = collapseBetrayalPhrases(data.phrases);
    // One notice, not two: two ⚠️ rows would read as two separate problems.
    // Parenthesised rather than newline-separated because the notice row
    // renders as plain inline text, where a \n collapses to a space anyway.
    const betrayalKey = betrayalNoticeKey(data);
    acc.notices.push(
      `${deps.t(betrayalKey)}` +
      (matched ? ` (${deps.t('notice.betrayal.matched')}: ${matched})` : '')
    );
    if (data.redacted) {
      flags.betrayalRedacted = true;
      // Discard everything this turn produced. acc.currentText and
      // acc.currentThought are what finalizeMessage commits, and
      // claudeThinkingBlocks is what would be REPLAYED to the model on the
      // next turn — leaving that one behind would preserve exactly the
      // contamination this feature exists to prevent.
      acc.currentText = '';
      acc.currentThought = '';
      acc.claudeThinkingBlocks.length = 0;
      sink.requestFlush();
    }
  } else if (data.type === 'tool_call') {
    // A tool the model really dispatched. Recorded regardless of whether it
    // succeeded — the report answers "was this called?", which is the question
    // a hallucinated tool claim fails.
    // The same channel also carries `kind: 'event'` entries (e.g. automatic
    // compaction): not tools, but things that happened between them, kept in
    // the same list because their POSITION in the sequence is the whole point.
    // MessageBubble separates the two; nothing else reads this list.
    // Display-only: slimHistory is an allowlist that never names toolCalls, so
    // this never reaches any model.
    const toolCall = normaliseToolCall(data, acc.currentThought.length);
    if (toolCall) acc.toolCalls.push(toolCall);
  } else if (data.type === 'session_id') {
    // Claude OAuth path emits this so we can resume the Anthropic-side session
    // on the next turn.
    if (typeof data.sessionId === 'string') {
      sink.sessionId(data.sessionId);
    }
  } else if (data.type === 'thought') {
    acc.currentThought += data.content;
    sink.phaseThinkingUnlessReplying();
  } else if (data.type === 'text') {
    acc.currentText += data.content;
    // Read by the handoff-failure branch after the teardown: text on screen
    // means this vessel answered, however briefly.
    if (data.content) flags.sawOutput = true;
    sink.phaseReplying();
    // Strip "[YYYY-MM-DD HH:MM:SS]" tags CONTINUOUSLY as the reply streams in
    // (gated on the global setting, default ON) — not just a leading stack but
    // ANY tag, wherever it appears, including the mid-message ones agentic
    // models (e.g. Kimi K3) emit at the start of each output segment, such as
    // the continuation right after a tool call.
    //
    // Per-chunk stripping stays streaming-TTS-safe: a tag is only removed the
    // instant it completes, at the growing TAIL — always ahead of the position
    // TTS has already spoken. The already-emitted prefix was stripped in
    // earlier ticks and is never rewritten, so it stays monotonic (the failure
    // mode a late one-shot finalize-strip once caused). msg.content therefore
    // never carries a timestamp into TTS, the saved log, or the context
    // replayed to the model.
    if (deps.settings?.removeTimestamps !== false) {
      acc.currentText = stripAllTimestamps(acc.currentText);
    }
    // User-configurable regex filter (Settings → Custom regex filter). Applied
    // continuously like the timestamp strip so the stored message — and
    // therefore TTS — never contains matches.
    acc.currentText = applyOutputFilter(acc.currentText, deps.settings);
  } else if (data.type === 'thinking_signature') {
    acc.claudeThinkingBlocks.push({
      thinking: data.thinking as string,
      signature: data.signature as string,
    });
  } else if (data.type === 'continued') {
    acc.continuationCount = (data.count as number) || 0;
  } else if (data.type === 'file_attachment' && data.attachment) {
    flags.toolAttachments.push(normaliseToolAttachment(data, deps.newAttachmentId));
  } else if (data.type === 'ask_user' && data.askId && Array.isArray(data.questions)) {
    // The model paused to ask the user a question. Surface an interactive
    // card; the user's selection is POSTed to /api/chat/answer, which resolves
    // the paused server handler. Record it now (answers filled in on
    // ask_user_resolved) so it persists onto the message even if the page is
    // reloaded.
    acc.askedQuestions.push({
      askId: data.askId as string,
      questions: data.questions,
      answers: null,
      timedOut: false,
    });
    sink.askOpened({ askId: data.askId as string, questions: data.questions });
  } else if (data.type === 'subagent_start') {
    // A context-firewall child agent started investigating. Show a live
    // activity chip; record it (result filled on subagent_done).
    acc.subagentRuns.push({ task: (data.task as string) || '', result: null });
    sink.subagentStarted((data.task as string) || '');
  } else if (data.type === 'subagent_done') {
    // Child returned its distilled result. Record it (+ the proof of which API
    // actually served it) and clear the chip.
    const rec = findOpenSubagentRun(acc.subagentRuns, (data.task as string) || '');
    if (rec) { rec.result = (data.result as string) || ''; rec.via = data.via || null; }
    else acc.subagentRuns.push({
      task: (data.task as string) || '',
      result: (data.result as string) || '',
      via: data.via || null,
    });
    sink.subagentFinished();
  } else if (data.type === 'injection_delivered') {
    // A queued partner interjection was folded into the entity's context at a
    // tool-loop boundary.
    sink.injectionDelivered(deps.t('chat.interject.delivered'));
  } else if (data.type === 'tool_activity') {
    // OAuth path: the model started (tool name) or finished (null) a tool
    // call — reflect it in the loading indicator.
    sink.toolActivity(resolveToolActivity(data, deps.t));
  } else if (data.type === 'stall_warning') {
    // Server-side watchdog: no SDK activity for this many seconds.
    sink.stallIdleSeconds(Number(data.idleSeconds || 0));
  } else if (data.type === 'stall_cleared') {
    sink.stallIdleSeconds(null);
  } else if (data.type === 'ask_user_resolved' && data.askId) {
    // Server resolved the question (user answered, or it timed out and fell
    // back to the recommended option). Record the outcome and dismiss the card.
    const rec = acc.askedQuestions.find(q => q.askId === data.askId);
    if (rec) { rec.answers = data.answers || []; rec.timedOut = !!data.timedOut; }
    sink.askResolved(data.askId as string);
  } else if (data.type === 'attachment_described') {
    sink.attachmentDescribed(data);
  }
}
