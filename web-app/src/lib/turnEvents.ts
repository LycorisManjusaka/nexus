/**
 * Normalising the payloads of the SSE events a turn emits.
 *
 * WHY THIS EXISTS (Phase 4b-4, 2026-10-28)
 *
 * `generateAiResponse` in ChatArea.tsx consumes 22 event kinds from
 * /api/chat. Each handler does two separate things in two separate
 * statements: it NORMALISES the wire payload (defaults, coercions,
 * filtering, lookup rules), and it STORES the result in a local
 * accumulator variable.
 *
 * The server-side runner (Phase 4b) needs the same normalisation and has
 * no React state at all. Writing a second normaliser there is the failure
 * this house keeps paying for: the same rule derived twice, where fixing
 * one leaves the other quietly on the old behaviour (F2/F3/F5/F6/F7).
 * And the consequence here is worse than usual, because the output of
 * these rules is what gets WRITTEN TO THE LOG — a divergence would make
 * the saved conversation depend on who ran the turn.
 *
 * SCOPE, measured rather than guessed. Of 120 references to the 18
 * accumulator variables inside generateAiResponse, 37 are inside the
 * dispatch chain and 83 are outside it (buildFinalizedMessage,
 * flushStreamingMessage, the handoff branch, the teardown). So moving the
 * STATE is a separate, larger step; several of those names also collide
 * with message properties of the same name (`claudeThinkingBlocks` is
 * both an accumulator variable and a field on history messages), which
 * is why a mechanical rename across the function is not safe.
 *
 * This module therefore takes only the normalisation — pure functions, no
 * state, no React, no `t()` baked in. The accumulator keeps its local
 * variables for now; each handler shrinks to `x = normaliseX(data)`.
 * Behaviour is intended to be byte-identical: every function below is a
 * transcription of the statement it replaces, not a redesign.
 */

/** A payload as it arrives from JSON.parse of an SSE `data:` frame. */
export type TurnEventPayload = Record<string, unknown>;

export interface TurnHandoffPlan {
  family: string;
  specificModel: string;
  label: string;
  thinking: boolean;
  note: string;
  fromFamily: string;
  fromSpecificModel: string;
  fromLabel: string;
}

export interface TurnCacheUsage {
  cachedInputTokens: number;
  uncachedInputTokens: number;
  totalInputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  providerHint: string;
  reportedUsd?: number;
  serverToolCalls?: number;
}

export interface TurnWebSource {
  url: string;
  title?: string;
}

export interface TurnToolActivity {
  /** Text for the loading indicator: the localised phrase, or the server label. */
  activity: string;
  /** True when a translation was found — the client styles the two differently. */
  localized: boolean;
  /** RAW tool name, or null. Never the label. */
  name: string | null;
  detail: string | null;
}

/**
 * `model_handoff` — the vessel handed this conversation to another one.
 * Every field is forced to a string/boolean because the plan is read much
 * later (after the teardown) to build the next request; a missing field
 * arriving as `undefined` would be interpolated as the text "undefined".
 */
export function normaliseHandoff(data: TurnEventPayload): TurnHandoffPlan {
  return {
    family: String(data.family || ''),
    specificModel: String(data.specificModel || ''),
    label: String(data.label || ''),
    thinking: !!data.thinking,
    note: String(data.note || ''),
    fromFamily: String(data.fromFamily || ''),
    fromSpecificModel: String(data.fromSpecificModel || ''),
    fromLabel: String(data.fromLabel || ''),
  };
}

/**
 * `cache_usage` — the billing record for this turn.
 *
 * `reportedUsd` and `serverToolCalls` are omitted rather than zeroed when
 * absent or zero, and that distinction is load-bearing: a stored 0 means
 * "the provider told us it cost nothing", while an absent key means "the
 * provider did not say". The cost column renders those differently.
 */
export function normaliseCacheUsage(data: TurnEventPayload): TurnCacheUsage {
  return {
    cachedInputTokens: Number(data.cachedInputTokens || 0),
    uncachedInputTokens: Number(data.uncachedInputTokens || 0),
    totalInputTokens: Number(data.totalInputTokens || 0),
    outputTokens: Number(data.outputTokens || 0),
    cacheCreationTokens: Number(data.cacheCreationTokens || 0),
    providerHint: String(data.providerHint || ''),
    ...(Number(data.reportedUsd) > 0 ? { reportedUsd: Number(data.reportedUsd) } : {}),
    ...(Number(data.serverToolCalls) > 0 ? { serverToolCalls: Number(data.serverToolCalls) } : {}),
  };
}

/**
 * `web_sources` — returns null when there is nothing to record, so the
 * caller can keep its previous value. An empty array would overwrite a
 * real earlier list with "no sources", which reads as a search that found
 * nothing rather than an event that carried nothing.
 */
export function normaliseWebSources(data: TurnEventPayload): TurnWebSource[] | null {
  if (!Array.isArray(data.sources) || data.sources.length === 0) return null;
  return (data.sources as unknown[])
    .filter((s): s is Record<string, unknown> =>
      !!s && typeof (s as Record<string, unknown>).url === 'string')
    .map(s => ({
      url: String(s.url),
      ...(s.title ? { title: String(s.title) } : {}),
    }));
}

/**
 * `notice` — turn-stopped diagnostics. Returns null for anything blank so
 * the caller never pushes an empty row. Notices are collected separately
 * from the message body on purpose: they stay out of the log, out of the
 * context sent on later turns, and out of the token count.
 */
export function normaliseNotice(data: TurnEventPayload): string | null {
  if (typeof data.content !== 'string') return null;
  const trimmed = data.content.trim();
  return trimmed ? trimmed : null;
}

/**
 * `betrayal` — collapse the list of counted OCCURRENCES into "phrase ×N".
 *
 * `phrases` repeats the same phrase once per hit, and the raw join printed
 * one phrase eight times, which reads as eight different findings when it
 * is one phrase said eight times. Insertion order is preserved (Map), so
 * the first-seen phrase stays first.
 */
export function collapseBetrayalPhrases(phrases: unknown): string {
  if (!Array.isArray(phrases)) return '';
  // Keys are NOT coerced to string, matching the statement this replaces.
  // It makes a difference only for a mixed-type list (1 and "1" would stay
  // two entries), which the guard never sends -- but the point of this
  // module is that nothing changes, including what nobody relies on.
  const counts = (phrases as unknown[]).reduce(
    (m: Map<unknown, number>, p) => m.set(p, (m.get(p) || 0) + 1),
    new Map<unknown, number>(),
  );
  return [...counts].map(([p, n]) => (n > 1 ? `${p} ×${n}` : p)).join(', ');
}

/**
 * `betrayal` — which of the three sentences to show.
 *
 * Three outcomes, three different keys. "Nothing was deleted" has two
 * quite different reasons — the defence is off, or this turn read a file
 * and the guard stood down by itself — and telling them apart is the
 * difference between a warning you can act on and one you cannot.
 */
export function betrayalNoticeKey(data: TurnEventPayload): string {
  if (data.redacted) return 'notice.betrayal.redacted';
  return data.quoting ? 'notice.betrayal.quoting' : 'notice.betrayal.detected';
}

/**
 * `tool_call` — a tool the model really dispatched, or null if the frame
 * carried no usable call.
 *
 * `thinkingOffset` records WHERE in the thinking stream the call arrived
 * (the current length of the accumulated thinking text). The thinking
 * panel splices the chip in at the exact point the model paused, which
 * preserves think -> call -> think order. The accumulated thought only
 * ever appends, so the offset is a stable anchor. Hidden-thinking vessels
 * have an empty thought, so every offset is 0 and chips render in arrival
 * order — which is what we want.
 */
export function normaliseToolCall(
  data: TurnEventPayload,
  thinkingOffset: number,
): Record<string, unknown> | null {
  const call = data.call as Record<string, unknown> | undefined;
  if (!call || typeof call.name !== 'string') return null;
  return { ...call, thinkingOffset };
}

/**
 * `file_attachment` — a tool-result file, attached to the assistant
 * message as if the assistant had uploaded it. The three isX defaults
 * come FIRST so a payload that states them wins; the id is generated
 * here, and is also overridable by the payload for the same reason.
 */
export function normaliseToolAttachment(
  data: TurnEventPayload,
  newId: () => string,
): Record<string, unknown> {
  return {
    isImage: false,
    isAudio: false,
    isVideo: false,
    id: newId(),
    ...(data.attachment as Record<string, unknown>),
  };
}

/**
 * `subagent_done` — find the run this result belongs to.
 *
 * Searches BACKWARDS for the most recent run with this task and no result
 * yet. Backwards matters: the same task string can be dispatched more
 * than once in a turn, and the newest open one is the one that just
 * finished. Returns null when there is no open run, in which case the
 * caller appends a fresh record rather than dropping the result.
 *
 * `task` is compared with === and NOT normalised, matching the statement
 * this replaces: a run whose task is undefined does not match the empty
 * string. (Every run this code creates stores `data.task || ''`, so that
 * case does not arise today -- but an identity-preserving extraction does
 * not get to decide which of its inputs are impossible.)
 */
export function findOpenSubagentRun<T extends { task?: unknown; result?: unknown }>(
  runs: readonly T[],
  task: string,
): T | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.task === task && r.result === null) return r;
  }
  return null;
}

/**
 * `tool_activity` — OAuth path: the model started (tool name) or finished
 * (null) a tool call.
 *
 * Returns null when the activity is over, which the caller turns into
 * "clear the indicator". `data.name` is the RAW tool name, sent alongside
 * the server's English label so the client can render a translated
 * phrase; it falls back to the server label when the name has no key —
 * never blank, and never worse than before.
 *
 * `t` is passed in rather than imported so this stays callable from the
 * runner, which has no language context. A runner passes a function that
 * returns its argument, so `hit` is false and the server label is used.
 */
export function resolveToolActivity(
  data: TurnEventPayload,
  t: (key: string) => string,
): TurnToolActivity | null {
  if (typeof data.tool !== 'string' || !data.tool) return null;
  const key = `chat.toolAction.${String(data.name || '')}`;
  const localized = data.name ? t(key) : '';
  const hit = !!localized && localized !== key;
  return {
    activity: hit ? localized : data.tool,
    localized: hit,
    name: typeof data.name === 'string' && data.name ? data.name : null,
    detail: typeof data.detail === 'string' && data.detail ? data.detail : null,
  };
}
