// Registry of models that accept image input directly via the chat completion
// API. Any model NOT in this set is treated as text-only — if NEXUS needs to
// show an image to a text-only model, it routes the image through the "eyes"
// feature (vision-bridging via a multimodal model) and substitutes the image
// with the returned text description.
//
// Default-deny by design: an unknown model is assumed text-only. This is
// conservative — worst case we run an unnecessary eyes call. The opposite
// default (assume vision) would fail in production with a 400/415 error.

export const VISION_CAPABLE_MODELS = new Set<string>([
  // ── Anthropic ──────────────────────────────────────────────────────────────
  // All current Claude models support vision.
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',

  // ── Google Gemini ──────────────────────────────────────────────────────────
  // All current Gemini models support vision.
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',

  // ── Qwen (DashScope international) ─────────────────────────────────────────
  // qwen3.8-max: the model card lists "Visual Understanding" as a first-class
  // capability ("native visual understanding runs through the full cycle of
  // planning, execution, and verification"). Image input only — there is no
  // published evidence of audio input, so it stays out of AUDIO_CAPABLE_MODELS,
  // and video claims are about long-video *analysis* rather than a documented
  // `video_url` content part, so it stays out of VIDEO_CAPABLE_MODELS too.
  // Both bridges therefore still fire for it, which is the safe default.
  'qwen3.8-max',
  'qwen3.7-max',
  // NOTE: the model table exposes this as `qwen3.6-max-preview`, and this set is
  // matched EXACTLY — so the bare `qwen3.6-max` below never matches anything
  // NEXUS can select, and 3.6 Max silently goes through the eyes bridge. Left
  // as-is rather than "fixed" blind: if the preview id is what DashScope serves,
  // the right change is to add the `-preview` id, and that needs one live call
  // to confirm. Flagged, not guessed.
  'qwen3.6-max',
  'qwen3.6-plus',
  'qwen3.5-omni-flash', // also handles audio/video
  'qwen3.5-omni-plus',  // omni-plus — image + audio + video, higher quality than -flash

  // ── DeepSeek ─────────────────────────────────────────────────────────────
  // Vision is now standard on the Flash line: V4.1-Flash ('deepseek-flash')
  // takes images natively, and the retired vision-exp id is just an alias for
  // it. Verified live on 2026-09-14 with real PNGs (64x64 / 512x512 /
  // 1024x768): correct colour answers, prompt tokens scaling with dimension
  // (197 / 197 / 509). Images are accepted in USER messages only — an image
  // part in a system or assistant message 400s.
  //
  // TRAP — 'deepseek-v4-pro' is NOT here, and its absence is load-bearing.
  // Pro does not reject images; it DISCARDS them silently: HTTP 200, text-only
  // prompt token count (18 on a request carrying a 512x512 PNG), a confident
  // wrong answer ("Black" for a blue image), and "No." when asked whether an
  // image is attached. Nothing in the response says anything went wrong. The
  // earlier comment here claimed every non-vision deepseek id returns a 400
  // "This model does not support image" — that is measured to be FALSE for
  // pro. Default-deny is what saves us: pro's images go through the Eyes
  // bridge instead of vanishing.
  //
  // Image parts use the standard OpenAI-compatible `image_url` shape, which
  // the shared OpenAI-compatible branch already emits, so no special
  // request-shape handling is needed. Thinking mode is supported (both
  // enabled and disabled), so the existing `thinking` toggle applies
  // unchanged. deepseek-v3.2 (DashScope) stays OUT.
  'deepseek-flash',
  'deepseek-v4-flash-vision-exp', // retired alias — still served by V4.1-Flash
  'deepseek-v4-flash',            // retired alias — remapped to deepseek-flash on the wire
  'deepseek-v4-flash-0731',       // retired (hard 400 upstream) — remapped to deepseek-flash on the wire
  'deepseek-chat',                // legacy alias, now served by V4.1-Flash (sees images — verified live)
  'deepseek-reasoner',            // legacy alias, now served by V4.1-Flash (sees images — verified live)

  // ── GLM (Z.AI) ─────────────────────────────────────────────────────────────
  // The 'v' variants AND glm-5.3-flash are multimodal. glm-5.3-flash is the
  // first natively multimodal GLM-5 model (image + video + file input, 1M
  // context). glm-5.3 / glm-5.2 / glm-5.1 / glm-5 / glm-5-turbo / glm-4.7 /
  // glm-4.6 / glm-4.5-air are text-only.
  'glm-5.3-flash',
  'glm-4.6v',
  'glm-4.6v-flash',
  'glm-5v-turbo',

  // ── Grok (xAI) ─────────────────────────────────────────────────────────────
  // 4.x family supports vision (text + image → text). code-fast / 4.1-fast are
  // conservative defaults. Grok is multimodal but NOT omnimodal — no native
  // audio/video in the chat API, so none appear in the audio/video sets.
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-4.3',
  'grok-4.20-reasoning',
  'grok-4.20-non-reasoning',

  // ── Kimi (Moonshot) ────────────────────────────────────────────────────────
  // All four live token-API models take image blocks (image input measured
  // 2026-09-19 on kimi-k3 and kimi-k2.7-code over both the OpenAI-compatible
  // and the Anthropic Messages surface). kimi-k2.5 was retired by Moonshot.
  'moonshotai/Kimi-K3',
  'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed',
  'moonshotai/Kimi-K2.6',

  // ── Cohere ─────────────────────────────────────────────────────────────────
  // Only the dedicated vision variant.
  'command-a-vision-07-2025',

  // ── MiniMax ────────────────────────────────────────────────────────────────
  // M3 is natively multimodal (image + video understanding, 1M context, MSA
  // architecture). M2.7 is text-only. Image/video parts are forwarded over the
  // OpenAI-compatible path; if MiniMax's compat endpoint rejects a modality the
  // eyes/watcher bridge still covers it when this is toggled off.
  'MiniMax-M3',
  'MiniMax-M2.7',

  // ── OpenAI (ChatGPT / GPT-5 family) ──────────────────────────────────────────
  // GPT-5 models accept image input via the chat-completions API. Audio/video
  // file input is NOT supported on this endpoint (that's the realtime/audio
  // models), so they stay out of the audio/video sets below and the ears/
  // watcher bridges handle those modalities.
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',

  // ── Xiaomi MiMo ──────────────────────────────────────────────────────────────
  // Measured 2026-09-22 against the hosted API with a real 512x512 PNG: BOTH
  // `mimo-v2.6-pro` and `mimo-v2.6-flash` accept image input (273 prompt tokens,
  // image_tokens=256) on the OpenAI-compatible AND the Anthropic endpoint.
  // The V2.6 series is natively fully multimodal across both tiers — the V2.5
  // split, where only the standard tier could see and `-pro` was TEXT-ONLY, is
  // gone. (The old note here said v2.5-pro returned 404 "No endpoints found that
  // support image input"; that was true of v2.5 and is not true of v2.6.)
  // v2.5-pro and v2.5 are deprecated 2026-10-21 and stay listed so existing
  // conversations keep working until then.
  'mimo-v2.6-pro',
  'mimo-v2.6-flash',
  'mimo-v2.5',
]);

/**
 * Returns true if the given model identifier is known to accept image input
 * directly. Used to gate the "eyes" feature — when this returns false and an
 * image needs to be sent, NEXUS routes the image through a vision-bridging
 * model and substitutes a text description.
 *
 * Falls back to a substring heuristic for local models because the same model
 * file can be loaded with or without a vision projector (mmproj). We look for
 * common naming hints: "-vl" (vision-language, e.g. Qwen-VL), "vision", or
 * "mmproj".
 */
export function isVisionCapable(specificModel: string | undefined | null): boolean {
  if (!specificModel) return false;
  if (VISION_CAPABLE_MODELS.has(specificModel)) return true;

  const lowered = specificModel.toLowerCase();
  if (lowered.includes('-vl') || lowered.includes('mmproj') || lowered.includes('vision')) {
    return true;
  }
  // ByteDance Seed 2.x family (BytePlus ModelArk / Volcengine) is multimodal
  // across every snapshot — Seed 2.0 (pro/lite/mini/code) and Seed 2.1
  // (pro/turbo) all accept image_url. IDs are date-versioned and regionally
  // prefixed (seed-2-0-pro-260328 int'l "dola-…"; dola-seed-2-1-turbo-260628),
  // so match by family fragment rather than pinning exact snapshot ids.
  if (lowered.includes('seed-2-0') || lowered.includes('seed-2-1')) return true;

  return false;
}

// ── Audio-capable models ─────────────────────────────────────────────────────
// Models known to accept audio input via the chat completion API. Used to gate
// the "ears" feature analogously to eyes — when this returns false and an
// audio file needs to be sent, NEXUS routes it through an audio-capable bridge
// model (default: qwen3.5-omni-flash) and substitutes the raw audio with a
// transcript + description.

export const AUDIO_CAPABLE_MODELS = new Set<string>([
  // Google Gemini — all current models handle audio inline.
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',

  // Qwen Omni — designed for audio/video/image input.
  'qwen3.5-omni-flash',
  'qwen3.5-omni-plus',
  // Xiaomi MiMo V2.5 — hosted API has a dedicated audio encoder and documents
  // native audio understanding. The pro tier is text-only, so only v2.5.
  'mimo-v2.5',
  // MiMo V2.6 is deliberately NOT added here, though its endpoint really does
  // take audio (measured: audio_tokens=51 on the OpenAI-compatible path).
  // NEXUS routes MiMo through the Anthropic-format adapter, which builds image
  // blocks only — and MiMo's ANTHROPIC endpoint silently DROPS input_audio
  // (measured: the same real 8s clip came back with input_tokens=17, the text
  // alone, and the model reported hearing nothing). Staying off this list makes
  // the ears bridge engage, so the user gets a real transcript instead of a
  // silent drop. Add V2.6 only when the adapter can actually carry audio.
]);

export function isAudioCapable(specificModel: string | undefined | null): boolean {
  if (!specificModel) return false;
  if (AUDIO_CAPABLE_MODELS.has(specificModel)) return true;
  // ByteDance Seed 2.0 *Lite* is the omni-modal tier — it natively understands
  // audio (image_url/video_url/input_audio all work). The pro/mini/code tiers do
  // NOT accept audio, so match ONLY the lite snapshots (date-versioned ids like
  // seed-2-0-lite-260428). Without this, the ears bridge wrongly engages over a
  // model that can already hear.
  if (specificModel.toLowerCase().includes('seed-2-0-lite')) return true;
  // Local models with audio support are rare and not auto-detected here —
  // user can disable the ears feature per-conversation if their local build
  // actually supports audio.
  return false;
}

// ── Video-capable models ─────────────────────────────────────────────────────
// Models known to accept video input. Used to gate the "video watcher"
// feature. Same providers as audio above — anything else falls back to the
// bridge.

export const VIDEO_CAPABLE_MODELS = new Set<string>([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'qwen3.5-omni-flash',
  'qwen3.5-omni-plus',
  // Xiaomi MiMo V2.5 — hosted API documents native video understanding
  // (platform.xiaomimimo.com .../multimodal-understanding/video-understanding).
  'mimo-v2.5',
  // MiMo V2.6 is deliberately NOT added here. Measured: MiMo's Anthropic
  // endpoint DOES accept a native video block (a real 4s clip came back with
  // 772 input tokens, video_tokens=720, and a description that matched the
  // actual frame) — but NEXUS's `streamViaAnthropicCompat` builds image blocks
  // only, so a video attached to a MiMo conversation never leaves the browser.
  // Staying off this list lets the video watcher engage and produce a real
  // description instead of a silent drop. Add V2.6 when the adapter carries it.
  // MiniMax M3 — natively multimodal, documents image + video understanding.
  'MiniMax-M3',
  // GLM-5.3-Flash — first natively multimodal GLM-5 model, documents image +
  // video + file input (1M context). Not audio.
  'glm-5.3-flash',
]);

export function isVideoCapable(specificModel: string | undefined | null): boolean {
  if (!specificModel) return false;
  if (VIDEO_CAPABLE_MODELS.has(specificModel)) return true;
  // ByteDance Seed 2.0 *Lite* (omni tier) natively watches video. Among Seed 2.0,
  // match only the lite snapshots — pro/mini/code stay default-deny (their video
  // support is unconfirmed, and a false positive would 400 on send).
  if (specificModel.toLowerCase().includes('seed-2-0-lite')) return true;
  // The entire Seed 2.1 line (pro + turbo, e.g. dola-seed-2-1-turbo-260628)
  // supports text + image + VIDEO input. Audio is NOT supported on Seed 2.1
  // (that stays exclusive to Seed 2.0 Lite), so it's absent from isAudioCapable.
  if (specificModel.toLowerCase().includes('seed-2-1')) return true;
  return false;
}

// Registry of Gemini models that reject `thinkingLevel: 'minimal'` outright
// (the API replies with "Thinking level MINIMAL is not supported for this
// model"). All Pro variants have always rejected it; Gemini 3.7 Flash rejects
// it too as of its launch (Google has said minimal support is a planned fast
// follow, not yet shipped) — this is a genuine model-specific gap, not a
// naming-convention thing, so it's tracked explicitly rather than inferred
// from a substring match on "flash". Gemini 3.8 Flash inherits the same gap
// (ai.google.dev/gemini-api/docs/latest-model: "the 'minimal' thinking level
// is not supported for Gemini 3.8 Flash and will return an error").
const GEMINI_NO_MINIMAL_THINKING = new Set<string>([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
]);

// Resolves the lowest thinking level a given Gemini model actually accepts.
// Used by every call site that wants "as close to off as this model allows":
// the Eyes/Ears/Watcher bridges (which always want minimal-effort captioning)
// and the main chat path / auto-model-select preflight (which map a user's
// "thinking off" choice to the lowest valid level for gemini-3.x). Pro
// variants and Gemini 3.7 Flash fall back to 'low'; everything else gets the
// true 'minimal'.
export function resolveGeminiMinThinkingLevel(specificModel: string | undefined | null): 'minimal' | 'low' {
  const model = (specificModel || '').toLowerCase();
  if (model.includes('pro')) return 'low';
  if (GEMINI_NO_MINIMAL_THINKING.has(specificModel || '')) return 'low';
  return 'minimal';
}
