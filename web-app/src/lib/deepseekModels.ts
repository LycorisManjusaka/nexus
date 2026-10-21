// ── DeepSeek wire-model mapping ──────────────────────────────────────────────
// api.deepseek.com serves a very small catalog and renames it without notice.
// GET /models on 2026-09-14 returned EXACTLY two ids:
//
//   deepseek-flash    = DeepSeek-V4.1-Flash. 1M context. Vision YES.
//                       max_tokens live range [1, 393216]. thinking
//                       {type:'enabled'|'disabled'} both accepted.
//   deepseek-v4-pro   = V4-Pro-0813. Pricing unchanged. Vision NO — and it
//                       fails SILENTLY: HTTP 200, text-only prompt token
//                       count, confidently wrong answers about the image.
//                       (See modelVision.ts — pro is not on the allowlist, so
//                       NEXUS routes its images through the Eyes bridge.)
//
// Ids that are NOT in /models but are still ACCEPTED and served by V4.1-Flash
// at the Flash price (verified live, 2026-09-14): deepseek-v4-flash,
// deepseek-v4-flash-vision-exp, deepseek-chat, deepseek-reasoner.
//
// Ids that now HARD 400: deepseek-v4-flash-0731 (the id the NEXUS dropdown
// used to ship as the default Flash), deepseek-v4-flash-vision,
// deepseek-v4.1-flash.
//
// RE-MEASURED 2026-10-21, after "DeepSeek V4.1 Flash 1017" started appearing on
// third-party model trackers. GET /models still returns EXACTLY the same two
// ids, and the 400 body is itself the authority — DeepSeek enumerates its own
// catalog in the error:
//
//   "The supported API model names are deepseek-flash, deepseek-v4-pro, but
//    you passed deepseek-v4.1-flash-1017."
//
// Same 400 for 'deepseek-flash-1017'. So the dated build is NOT a second route:
// 'deepseek-flash' is a rolling pointer and 1017 is a name for what is behind
// it today — which is why the header above opens with "renames it without
// notice". Nothing to implement; the dated spellings are normalised below so a
// user who copies one off a tracker gets the model it describes instead of a
// 400. NOTE this mapping asserts only "the live Flash is the Flash you meant" —
// it does NOT assert that today's deepseek-flash weights are the 1017 build,
// which api.deepseek.com publishes no way to check.
//
// Rather than let old conversations break — a saved conversation carries its
// model id forever — every retired/alias Flash id is normalised to
// 'deepseek-flash' at the wire. The UI only offers the two live ids; this map
// is what keeps everything written before 2026-09-14 working.
//
// deepseek-v3.2 is DELIBERATELY absent: it is served by Alibaba DashScope, not
// by api.deepseek.com, and its callers never reach this function.
const DEEPSEEK_WIRE_ALIASES: Record<string, string> = {
  'deepseek-v4-flash-0731': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4-flash-vision': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-1-flash': 'deepseek-flash',
  // Dated spellings of the same rolling Flash (both 400 upstream, 2026-10-21).
  'deepseek-v4.1-flash-1017': 'deepseek-flash',
  'deepseek-v4-1-flash-1017': 'deepseek-flash',
  'deepseek-flash-1017': 'deepseek-flash',
  // deepseek-chat / deepseek-reasoner are left alone on purpose: api.deepseek.com
  // still accepts them, and they are the documented legacy aliases, so a user who
  // typed one gets exactly what they asked for.
};

/** The current default Flash id on api.deepseek.com. */
export const DEEPSEEK_FLASH = 'deepseek-flash';

/** Normalise a UI/stored DeepSeek model id to one api.deepseek.com accepts. */
export function deepseekWireModel(model: string): string {
  return DEEPSEEK_WIRE_ALIASES[model] ?? model;
}
