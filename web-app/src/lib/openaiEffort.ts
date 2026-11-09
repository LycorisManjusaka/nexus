// ── OpenAI reasoning_effort vocabulary ───────────────────────────────────────
//
// `reasoning_effort` is NOT one vocabulary across the ChatGPT family, and the
// differences are 400s, not degradations. Full matrix, measured 2026-10-21
// against api.openai.com/v1/chat/completions — every cell a real call:
//
//   value 'minimal'  -> 400 on EVERY id tested (gpt-5.4, gpt-5.6-terra,
//                       gpt-6.1-sol, gpt-6-sol, gpt-6-astra, gpt-6-luna).
//                       NEXUS sent exactly this for thinking-OFF, so the OFF
//                       toggle was ALREADY broken for ChatGPT before any GPT-6
//                       id existed. It surfaced only because a control was put
//                       on an id that already ships — "broken" and "broken for
//                       everyone including today" look identical without one.
//   value 'none'     -> 200 on gpt-5.4, gpt-5.4-mini, gpt-5.5, all gpt-5.6-*,
//                       gpt-6-sol, gpt-6-luna, and gpt-6.1-terra (measured
//                       2026-11-09). REJECTED by gpt-6.1-sol and gpt-6-astra,
//                       whose published vocabulary is exactly low|medium|high|
//                       xhigh. NOTE the 6.1 pair SPLITS: gpt-6.1-terra takes
//                       'none' (so tools + 'none' -> 200, get_weather called),
//                       gpt-6.1-sol does not. Same generation, different
//                       vocabulary — do not infer one from the other.
//   function tools   -> on this endpoint tools REQUIRE reasoning_effort 'none':
//                       "Function tools with reasoning_effort are not supported
//                        for <id> in /v1/chat/completions. To use function
//                        tools, use /v1/responses or set reasoning_effort to
//                        'none'". Omitting the field does NOT help on gpt-5.6-*
//                        or gpt-6-* (400 as well). It DOES work on gpt-5.5 /
//                        gpt-5.4 / gpt-5.4-mini — which is why the caller
//                        leaves those three alone instead of "unifying" them
//                        into something unmeasured.
//
// The two facts compose into a dead end: gpt-6.1-sol and gpt-6-astra cannot
// take function tools here AT ALL — the only value that enables tools is the one
// value they refuse. /v1/responses is the documented route and NEXUS does not
// implement it for OpenAI. So the chat route refuses that combination UP FRONT
// with this reason instead of letting every turn 400.
//
// This lives in its own module so the matrix above is testable: route.ts cannot
// be imported outside Next, and a hand-copied predicate in a probe would only
// ever agree with itself.

/** Ids whose reasoning_effort vocabulary has no 'none' (low|medium|high|xhigh). */
const EFFORT_HAS_NO_NONE = /gpt-6\.1-sol|gpt-6-astra/i;

/** Ids that need an explicit 'none' alongside tools; omitting the field 400s. */
const TOOLS_NEED_EXPLICIT_NONE = /gpt-5\.6|gpt-6/i;

/** True when this OpenAI id cannot use function tools on /v1/chat/completions. */
export function openAiCannotUseTools(model: string): boolean {
  return EFFORT_HAS_NO_NONE.test(model || '');
}

/** The reasoning_effort value meaning "as little as possible" for this id.
 *  'minimal' is in no model's vocabulary; 'none' is in most. */
export function openAiOffEffort(model: string): 'none' | 'low' {
  return EFFORT_HAS_NO_NONE.test(model || '') ? 'low' : 'none';
}

/** True when a tools-bearing request to this id must carry reasoning_effort
 *  'none'. False for gpt-5.5 / 5.4 / 5.4-mini, where omission is what works. */
export function openAiToolsNeedNoneEffort(model: string): boolean {
  return TOOLS_NEED_EXPLICIT_NONE.test(model || '');
}
