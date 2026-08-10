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
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',

  // ── Google Gemini ──────────────────────────────────────────────────────────
  // All current Gemini models support vision.
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

  // ── GLM (Z.AI) ─────────────────────────────────────────────────────────────
  // Only the 'v' variants are multimodal. glm-5.1 / glm-5 / glm-5-turbo /
  // glm-4.7 / glm-4.6 / glm-4.5-air are text-only.
  'glm-4.6v',
  'glm-4.6v-flash',
  'glm-5v-turbo',

  // ── Grok (xAI) ─────────────────────────────────────────────────────────────
  // 4.x family supports vision (text + image → text). code-fast / 4.1-fast are
  // conservative defaults. Grok is multimodal but NOT omnimodal — no native
  // audio/video in the chat API, so none appear in the audio/video sets.
  'grok-4.5',
  'grok-4.3',
  'grok-4.20-reasoning',
  'grok-4.20-non-reasoning',

  // ── Kimi (Moonshot) ────────────────────────────────────────────────────────
  'moonshotai/Kimi-K3',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.5',

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
  // IMPORTANT: the open-weight MiMo-V2.5 is omnimodal, but Xiaomi's HOSTED API
  // (api.xiaomimimo.com) is more restrictive. Per their image-understanding
  // docs, ONLY `mimo-v2.5` (and `mimo-v2-omni`) accept image input — the
  // `mimo-v2.5-pro` tier is TEXT-ONLY on the hosted endpoint and returns
  // 404 "No endpoints found that support image input" if you send an image.
  // So only the standard tier goes in the vision set.
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
  // MiniMax M3 — natively multimodal, documents image + video understanding.
  'MiniMax-M3',
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
