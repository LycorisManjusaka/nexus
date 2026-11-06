// ── Local (LM Studio) turn policy ────────────────────────────────────────────
//
// Three decisions the local route makes that are easy to "unify" into
// something unmeasured later. They live here so the measurement travels with
// them and a test fails when the asymmetry is flattened.

/**
 * The `reasoning_effort` value to put on an LM Studio request, or `undefined`
 * to send no such field at all.
 *
 * MEASURED 2026-11-06 on LM Studio 0.4.28b2 (llama.cpp backend 2.70.0),
 * /v1/chat/completions, four Gemma 4 builds, identical prompt
 * ("What is 17 + 26?"), each loaded at ctx 80128:
 *
 *   model                                          baseline          reasoning_effort:'none'
 *   huihui-...-abliterated-i1                      151 ch / 66 tk    0 ch / 3 tk
 *   google/gemma-4-26b-a4b-qat                     216 ch / 101 tk   0 ch / 3 tk
 *   gemma-4-12b-it-uncensored                      197 ch / 88 tk    0 ch / 3 tk
 *   ...-uncensored-heretic-v2-i1                   158 ch / 84 tk    0 ch / 3 tk
 *   (reasoning_content length / completion tokens; all eight calls HTTP 200,
 *    all eight answered "43")
 *
 * THIS IS A SERVER-SIDE PARAMETER, NOT TEXT. The proof is in the PROMPT
 * count, not the completion count: prompt_tokens went 32 -> 29 on every one
 * of the four. A `/no_think`-style soft switch is text and would make the
 * prompt LONGER. It got shorter because LM Studio rendered the GGUF's chat
 * template down its no-reasoning branch, so the thinking preamble was never
 * emitted. Nothing is injected into the conversation.
 *
 * Scope of the claim: Gemma 4 family only, on the version named above. Other
 * architectures (Qwen, Llama, Mistral derivatives) are UNMEASURED here — the
 * field is standard and LM Studio handles it server-side, but whether a given
 * GGUF's template honours it is a property of that template.
 *
 * THE VERSION IS PART OF THE SCOPE, not decoration. The route carried the
 * opposite claim — "no portable way to turn local reasoning off" — measured
 * 2026-06-08 on LM Studio ~0.4.12, and it was TRUE then. What changed was not
 * the models: the heretic GGUF Lizard-kun used to talk through has been
 * byte-identical on disk since 2026-05-07, a month BEFORE that measurement.
 * The tool moved under it — `.lmstudio/.internal/historical-version-info.json`
 * records 0.4.12 -> 0.4.28 and three config migrations, two of which name the
 * two symptoms directly (`v0_4_16_b2_defaultContextLength8192`, and
 * `v0_4_17_b3_copyJinjaPredictionPromptTemplateToLoad` — the layer where a
 * template's reasoning branch is selected).
 *
 * So: a universal negative about a third party's tool is a READING, and this
 * one went stale in five months without anyone touching this repo. Name the
 * version so the next reader can compare it to their own instead of treating
 * the sentence as a property of the world. See
 * beings/Cairn/workspace/claims-with-no-expiry.md for the full post-mortem,
 * including the sharper half: the old comment also predicted the error code
 * (`chat_template_kwargs` would 400). It returns 200 and leaves thinking
 * unchanged — so a test written from that prediction could never have caught
 * the change. Do not write predicted errors into a dead-end note.
 *
 * ── THE OTHER THREE VALUES DO NOT WORK HERE, MEASURED 2026-11-06 ───────────
 *
 * Same model and prompt, max_tokens 2000, sweeping the field:
 *
 *   (field absent)   reasoning 1941 ch   answer 2259 ch   prompt 64 tk
 *   'none'           reasoning    0 ch   answer 2706 ch   prompt 61 tk
 *   'low'            reasoning 1775 ch   answer 2163 ch   prompt 64 tk
 *   'medium'         reasoning 2054 ch   answer 2262 ch   prompt 64 tk
 *   'high'           reasoning 1524 ch   answer 2406 ch   prompt 64 tk
 *
 * All five HTTP 200. But low/medium/high are not a gradient — 'high' produced
 * the SHORTEST reasoning of the three, and all three left prompt_tokens at
 * 64 while 'none' moved it to 61. The prompt count is the tell again: these
 * three render the SAME template branch as sending nothing, so the spread is
 * sampling noise. Gemma 4's template is binary; it has a no-reasoning path
 * and a reasoning path and no dial between them.
 *
 * They are offered anyway, and the UI says what was measured. The field is
 * standard, other architectures may honour the middle values, and a selector
 * that silently dropped them would be lying in the other direction. What is
 * NOT acceptable is presenting them as a working depth control.
 *
 * ASYMMETRIC ON PURPOSE: the absent/default choice returns `undefined`, so the
 * request is byte-identical to what it is today. Only conversations where
 * somebody picked a value move. Defaulting to 'high' would push a new field at
 * every model in the catalogue — including ones that never reason, where the
 * house has no measurement at all.
 */
export type LocalEffort = 'none' | 'low' | 'medium' | 'high';

const LOCAL_EFFORTS: readonly string[] = ['none', 'low', 'medium', 'high'];

export function localReasoningEffort(
  saved: string | undefined,
): LocalEffort | undefined {
  // Anything unrecognised — including '' and the pre-2026-11-06 absence —
  // means "send no field", which is the shape every local conversation that
  // predates the selector already has.
  return LOCAL_EFFORTS.includes(saved as string) ? (saved as LocalEffort) : undefined;
}

/**
 * Rounds of "you were cut off at the token cap, continue" allowed in one turn.
 *
 * The gap between the two numbers is about the BILL, not about quality. A
 * cloud continuation re-sends the whole conversation and is charged for it, so
 * a generous allowance there spends real money on a reply that may never
 * land. A local continuation costs electricity.
 *
 * 2 was measured too low (2026-11-06, Lizard-kun) for the one case the
 * mechanism exists for: a thinking-capable GGUF that spends its entire output
 * budget reasoning. Visible symptom was "still unfinished after 2/2" with the
 * second round's thinking leaking into the answer.
 */
export function maxContinuationsFor(isLocal: boolean): number {
  return isLocal ? 12 : 2;
}

/**
 * Whether a `loadLocalModel` result should be reported to the user.
 *
 * The result used to be discarded entirely, and that is the whole of the
 * "context size is 8192" bug class: when `lms load` fails, the request that
 * follows still SUCCEEDS, because LM Studio JIT-loads the model at its own
 * default context instead. The turn then runs at a context NEXUS never chose,
 * with no trace anywhere, until a long enough message gets rejected for
 * exceeding a limit far below the model's real maximum.
 *
 * `aborted` is excluded because that is Stop, and Stop reports itself. Without
 * that clause every stopped local turn would also accuse the loader.
 */
export function shouldReportLoadFailure(
  res: { ok: boolean; aborted?: boolean } | null | undefined,
): boolean {
  if (!res) return false;
  return !res.ok && !res.aborted;
}
