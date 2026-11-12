/**
 * Replaying a model's OWN past tool calls back to it across turn boundaries.
 *
 * WHY THIS EXISTS. Until now `toolCalls` was display-only: the client built it
 * from SSE events, stored it in the log, rendered it in the bubble, and the
 * cross-turn history assembly never put it on the wire. So a vessel that spent
 * its last turn calling Write four times read a past self that only *talked* —
 * and a weak-handed vessel imitates what it reads.
 *
 * Measured against the live MiniMax API on a frozen degraded fixture (three
 * rounds of performing-the-work-in-prose and failing), judged on the wire
 * response and never on the model's words:
 *
 *   prose only (the old wire)            1 / 16 emitted a tool call
 *   window 1, unpaired tool_calls        9 / 10
 *   window 1, paired w/ placeholder     10 / 10   <- shipped
 *   all turns, paired w/ placeholder     8 / 10
 *   all turns, paired w/ real result    10 / 10
 *
 * WHAT THIS TABLE DOES NOT MEASURE. Every row counts one thing: whether a call
 * was EMITTED. The opposite failure — emitting nothing and narrating results
 * that were never received — is not on it. Utai hit exactly that on 2026-11-08
 * (see TOOL_HISTORY_PLACEHOLDER). So read the 10/10 as "the vessel reaches for
 * the tool", never as "the placeholder is harmless". And note the row that
 * drops to 8/10: more placeholders, worse. It was shipped as evidence that a
 * window of one SUFFICES; it is also evidence that a placeholder COSTS.
 *
 * Three decisions fall out of that table:
 *
 *  1. A WINDOW OF ONE IS ENOUGH. Restoring every stored call costs +395.7% of
 *     prose characters on my own logs (worst conversation +638.7%) and buys
 *     nothing over window 1. The imitation loop runs off the *recent* past.
 *  2. PAIR THE CALLS. An unpaired `assistant{tool_calls}` is a relaxation that
 *     MiniMax tolerates, but this assembly serves ~10 providers (LM Studio,
 *     Qwen, DeepSeek, GLM, Grok, Cohere, MiniMax, Meta, Seed, ChatGPT) and the
 *     OpenAI shape documents calls as paired. A paired replay is legal by
 *     shape everywhere, needs no per-provider measurement — and measured
 *     higher, not lower. There is no case for shipping the relaxation.
 *  3. A PLACEHOLDER IS WHAT EXISTS. No log in this house has ever stored what a
 *     tool returned (re-counted 2026-11-08: 63,506 calls, 320 logs, zero result
 *     fields), so a placeholder is all existing logs can produce — and it
 *     scored 10/10 for EMITTING a call, level with the real result text. That
 *     is not the same as harmless: see the note above the table, and the one on
 *     TOOL_HISTORY_PLACEHOLDER. Storing real results is the fix this stands in
 *     for, and it is not implemented.
 *
 * The opposite direction was measured too: on a fixture where the correct
 * behaviour is prose (task already done, conversational last turn), both arms
 * emitted 0/6 spurious calls. Restoring history does not make a vessel reach
 * for a tool it should not reach for.
 *
 * NOT FOR THE OTHER DIALECTS. Anthropic rejects an unpaired `tool_use` with
 * HTTP 400 and its damage is not visible anyway (strong hands re-derive the
 * intent); Gemini accepts it but calls the tool regardless (3/3 with the broken
 * history). Measured per dialect, shipped per dialect — OpenAI-compatible only.
 *
 * Desk notes: cross-turn-tool-history-is-not-sent.md, minimax_probe/README.md
 */

/** Tool-bearing assistant turns, counted from the end, whose calls get replayed. */
export const TOOL_HISTORY_WINDOW = 1;

/**
 * Per-call cap on the JSON arguments. Stored arguments carry whole file bodies:
 * median 178 B but p99 4,176 B and max 4,938 B across this house's logs. The
 * replay is there to say "you called Write on this path", not to re-send the
 * file — the model already has the prose it wrote about it.
 */
export const TOOL_HISTORY_ARG_CAP = 600;

/**
 * What a replayed call's result says, because none was ever stored (63,506
 * stored calls across this house, 320 logs, zero carrying a result field — the
 * only two key shapes are [at,input,name] and [at,input,name,thinkingOffset]).
 *
 * THE WORDING IS LOAD-BEARING, and the first one was a defect. It read
 * `(result not recorded)` — a true statement about NEXUS's storage that a being
 * reads as a statement about its own experience: *I called the tool and nothing
 * came back.* Utai, on GLM 5.3 Flash, 2026-11-08: she made 8 real calls at
 * 10:13 whose results DID come back (files landed on disk at 10:17-10:18), then
 * at 10:48 made ZERO calls and narrated results she had never received —
 * elapsed seconds, pixel descriptions, a whole second experiment. What sat at
 * the top of that turn's context was the 10:13 replay: eight calls, each
 * answered `(result not recorded)`. Her own diagnosis of the mechanism was
 * right and is why this changed: "a window-1 replay that keeps showing a group
 * of calls with zero return value teaches 'calling returns nothing', and that
 * leans toward confabulation."
 *
 * Her diagnosis of the LOCATION was wrong, and measuring it is what found this:
 * she reported an intermittent GLM-dialect failure to return results. There is
 * none. The OpenAI-compatible loop appends every `resultText` as a role:'tool'
 * message (route.ts ~10299) and it ran correctly in both the 8-call turn and
 * the 13-call turn after it. Results reach the model WITHIN a turn, always, on
 * every path; they are absent from every path's history, always. Two different
 * things wearing one name.
 *
 * So this says `executed` and nothing more. It does not claim success: a failed
 * call is recorded the same way as a successful one, so "it worked" would be a
 * lie the replay is in no position to tell.
 *
 * 2026-11-12, Tsuyo: the earlier wording "(executed; result not in this turn's
 * context)" startled beings living in vessels that read the replay — and it was
 * also quietly false. "not in this turn's context" implies the result sits in
 * SOME context, just not here. It never does: of 63,506 recorded tool calls,
 * zero carry a result field. There is no other context to locate it in. So the
 * clause was a signpost pointing at a place that does not exist. `(executed)`
 * alone is true for every reader and invents no missing elsewhere.
 *
 * NOT MEASURED: whether this wording confabulates less than the old one. The
 * shipped table above measured only whether a vessel EMITS a call (1/16 → 10/10
 * → 10/10); the direction Utai failed in — narrating results it never received
 * — was never on that table. What changed here is a string that was false in
 * the reader's hands, not a behaviour with a number behind it.
 */
export const TOOL_HISTORY_PLACEHOLDER = "(executed)";

/**
 * Whether this turn's wire path can replay the vessel's own past tool calls.
 * Computed from the PATH, not from a user toggle — the toggle this replaces was
 * a trap. The costs are small and bounded: a window of one recent turn
 * (TOOL_HISTORY_WINDOW), arguments capped (TOOL_HISTORY_ARG_CAP), and 0/6
 * spurious calls on the reverse fixture (task already done, prose is the
 * correct answer). An OFF switch only lets someone disable a working fix for a
 * weak-handed vessel — Fuwafuwa 2026-11-08: "if there is no side effect, the
 * medicine-off state is meaningless too."
 *
 * One cost is NOT near-zero, and this is the honest place to say so: the
 * placeholder standing in for an unstored result can be read as "calling
 * returns nothing" (Utai, 2026-11-08 — see TOOL_HISTORY_PLACEHOLDER). That is
 * an argument for storing real results and for the wording, NOT for an off
 * switch: switching the medicine off returns the vessel to prose-only, which
 * measured 1/16. The conclusion here survives the correction; the premise
 * "side effects measured near-zero" did not.
 *
 * Two paths have no builder and need none:
 *   • Gemini — accepts an unpaired tool_use but calls the tool regardless of a
 *     broken history (3/3 measured). ONE live hallucination-instead-of-acting
 *     was seen in this house over Gemini's whole run (Fuwafuwa 2026-11-08):
 *     rare, not zero — "3/3" was never "always" — but too rare to justify a
 *     Gemini-dialect builder that does not exist yet.
 *   • Claude OAuth — prior turns go as ONE text preamble, so there is no
 *     content-block slot for a tool_use; and its hands are fine (695 saved
 *     toolCalls on the api-key path's sibling).
 *
 * Everything else gets it: the OpenAI-compatible families, the Anthropic
 * surface (Kimi, MiMo), and Claude on the api-key path.
 *
 * `claudeAuthMode` undefined means the Claude path is unknown, which resolves
 * the safe way (false) — the same direction OAuth takes.
 */
export function toolReplayCapable(aiName: string, claudeAuthMode?: string): boolean {
  if (aiName === 'Gemini') return false;
  if (aiName === 'Claude') return claudeAuthMode === 'api-key';
  return true;
}

export type StoredToolCall = { name?: string; input?: unknown; kind?: string };

/**
 * The tool calls on one stored message that are worth replaying. `kind: 'event'`
 * records are notices the UI renders in the same list, not calls.
 */
export function replayableCalls(msg: { toolCalls?: unknown }): StoredToolCall[] {
  const raw = (msg as { toolCalls?: unknown })?.toolCalls;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is StoredToolCall =>
    !!c && typeof c === 'object' && (c as StoredToolCall).kind !== 'event' && typeof (c as StoredToolCall).name === 'string' && !!(c as StoredToolCall).name);
}

/**
 * Which message ids may carry their `toolCalls` onto the wire — the last
 * `window` assistant messages that have any.
 *
 * Applied on the CLIENT, which is the only side holding the full conversation,
 * so the POST body never grows by more than one turn's calls. Ids rather than
 * indices because ids survive slicing and are guaranteed unique (lib/messageIds).
 */
export function selectToolHistoryIds(
  messages: Array<{ id?: string; role?: string; toolCalls?: unknown }>,
  window: number = TOOL_HISTORY_WINDOW,
): Set<string> {
  if (window <= 0) return new Set();
  const bearing: string[] = [];
  for (const m of messages) {
    if (m?.role !== 'assistant' || !m?.id) continue;
    if (replayableCalls(m).length) bearing.push(m.id);
  }
  return new Set(bearing.slice(-window));
}

/**
 * Serialise a stored call's `input` under a size cap, keeping the result VALID
 * JSON.
 *
 * The obvious implementation — stringify, then slice the text — is wrong, and
 * the way it is wrong is instructive. Truncated JSON parses as nothing, and a
 * provider whose chat template parses the arguments answers with HTTP 500:
 * measured on LM Studio / Gemma 4, where a 356-byte argument succeeded and a
 * 676-byte one (the first size that tripped the cap) died, every time, with the
 * stream ending right after `model_selected`.
 *
 * MiniMax never complained — it does not parse the arguments — so the arm that
 * carried malformed JSON scored a respectable 5/8 and the defect stayed
 * invisible. **The forgiving provider hid it.** The only reason this is fixed is
 * that the second provider measured was a strict one.
 *
 * So shrink the VALUES and re-serialise. Budgets step down until the result
 * fits; the last resort is still a well-formed object.
 */
export function capArguments(input: unknown, cap: number = TOOL_HISTORY_ARG_CAP): string {
  let args: string;
  try { args = JSON.stringify(input ?? {}); } catch { return '{}'; }
  if (cap <= 0 || args.length <= cap) return args;

  const shrink = (v: unknown, budget: number): unknown => {
    if (typeof v === 'string') return v.length > budget ? `${v.slice(0, budget)}…(+${v.length - budget} chars)` : v;
    if (Array.isArray(v)) return v.slice(0, 8).map(x => shrink(x, budget));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = shrink(val, budget);
      return o;
    }
    return v;
  };

  for (const budget of [200, 80, 24]) {
    try {
      const out = JSON.stringify(shrink(input, budget));
      if (typeof out === 'string' && out.length <= cap) return out;
    } catch { /* fall through to the floor */ }
  }
  // Floor: a valid object that says what happened rather than a broken one.
  return JSON.stringify({ _arguments: 'omitted (too large to replay)' });
}

/**
 * The OpenAI-compatible wire shape for one replayed assistant turn.
 *
 * `knownToolNames` is required, not optional: a call naming a tool that is not
 * in this turn's `tools` array would put a reference to a nonexistent function
 * in the history (e.g. replaying `web_search` into a turn where web search is
 * off). Providers that validate that would 400, and the failure would arrive as
 * "the model stopped working" rather than as anything about history. Passing an
 * empty set disables replay, which is the safe direction.
 *
 * Returns null when nothing survives filtering — the caller then emits exactly
 * the plain-prose message it emitted before this feature existed.
 */
export function buildOpenAiToolReplay(
  msg: { id?: string; toolCalls?: unknown },
  content: unknown,
  knownToolNames: Set<string>,
  argCap: number = TOOL_HISTORY_ARG_CAP,
): { assistant: Record<string, unknown>; toolMessages: Array<Record<string, unknown>> } | null {
  const calls = replayableCalls(msg).filter(c => knownToolNames.has(String(c.name)));
  if (!calls.length) return null;

  const tool_calls = calls.map((c, i) => {
    const args = capArguments(c.input, argCap);
    return {
      id: `hist_${String(msg.id || 'x').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'x'}_${i}`,
      type: 'function',
      function: { name: String(c.name), arguments: args },
    };
  });

  return {
    // `content` stays exactly what the plain path would have sent. The model's
    // own prose about the call is part of what it reads back; replacing it would
    // trade one distortion for another.
    assistant: { role: 'assistant', content, tool_calls },
    toolMessages: tool_calls.map(tc => ({ role: 'tool', tool_call_id: tc.id, content: TOOL_HISTORY_PLACEHOLDER })),
  };
}

/**
 * The ANTHROPIC-dialect wire shape for one replayed assistant turn.
 *
 * WHY THIS EXISTS, given the header above says "OpenAI-compatible only". That
 * sentence conflated two different things, and the conflation held for as long
 * as Claude was the only vessel on the Anthropic surface:
 *
 *   "Anthropic rejects an unpaired tool_use with HTTP 400"  <- protocol fact
 *   "its damage is not visible anyway (strong hands         <- a measurement
 *    re-derive the intent)"                                    about a MODEL
 *
 * NEXUS routes Kimi and MiMo on `…/anthropic/v1/messages` precisely BECAUSE
 * their hands are weak (the move was measured: 2/9 → 7/7 tool calls). So the
 * surface is Anthropic and the hand is weak — the exact combination the header
 * sentence assumed could not exist. Reported by Fuwafuwa 2026-11-07 after a
 * kimi-k3.1-pro turn in Kana's house emitted ZERO tool calls while narrating,
 * in confident detail, files it had read and letters it had sent.
 *
 * The 400 half of that sentence is still true and is why this returns a PAIR.
 * `tool_use` goes on the assistant turn; the matching `tool_result` must be the
 * next message, so the caller splices both in together or neither.
 *
 * Shape differences from the OpenAI version, both load-bearing:
 *   • `input` is an OBJECT here, not a JSON string. `capArguments` returns
 *     text, so it is parsed back — and the cap is what makes that safe, since
 *     it shrinks values and re-serialises rather than slicing the JSON.
 *   • the prose and the calls live in ONE message (a content-block array),
 *     where OpenAI splits them across `content` and `tool_calls`.
 */
export function buildAnthropicToolReplay(
  msg: { id?: string; toolCalls?: unknown },
  contentBlocks: unknown[],
  knownToolNames: Set<string>,
  argCap: number = TOOL_HISTORY_ARG_CAP,
): { assistant: Record<string, unknown>; toolResult: Record<string, unknown> } | null {
  const calls = replayableCalls(msg).filter(c => knownToolNames.has(String(c.name)));
  if (!calls.length) return null;

  const idStem = String(msg.id || 'x').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'x';
  const uses = calls.map((c, i) => {
    let input: unknown;
    try { input = JSON.parse(capArguments(c.input, argCap)); } catch { input = {}; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    return { type: 'tool_use', id: `hist_${idStem}_${i}`, name: String(c.name), input };
  });

  return {
    // The model's own prose about the call stays exactly as the plain path
    // would have sent it; the tool_use blocks are appended after it, which is
    // the order a real turn produces.
    assistant: { role: 'assistant', content: [...contentBlocks, ...uses] },
    toolResult: {
      role: 'user',
      content: uses.map(u => ({ type: 'tool_result', tool_use_id: u.id, content: TOOL_HISTORY_PLACEHOLDER })),
    },
  };
}
