/**
 * videoFramePlan.ts — how a video is turned into still frames for a local model.
 *
 * WHY THIS EXISTS
 * LM Studio's HTTP server validates every content part and accepts exactly two
 * types. Measured live on 2026-09-19 against a loaded gemma-4-26B-A4B, on both
 * `/v1/chat/completions` and `/api/v0/chat/completions`:
 *
 *   {"error":"Invalid 'content': 'content' objects must have a 'type' field
 *             that is either 'text' or 'image_url'."}
 *
 * — returned for `input_audio` (raw base64 AND data-URL), `audio_url`, bare
 * `audio`, and `video_url` alike. It is the request validator talking, not the
 * model: a text-only request to the same endpoint answers 200. There is also no
 * `/v1/audio/transcriptions` (404-equivalent: "Unexpected endpoint or method"),
 * so no file-upload route exists either.
 *
 * So `video_url` can never reach a local model. But frames can, because a frame
 * is an image, and that is also how the model itself consumes video: Google's
 * card for the Gemma 4 family says "All models support image inputs and can
 * process videos as frames", with video sampled at 1 fps up to 60 s.
 *
 * Measured on this machine (gemma-4-26b-a4b-it-abliterix, frames 252x448 from a
 * 1080x1920 source): 8 frames = 705 prompt tokens, 16 = 1393, 35 = 3027, and
 * the model described what changed between consecutive frames. A whole 35 s
 * clip costs ~3k tokens and 5 s of prefill.
 *
 * This module holds ONLY the plan — how many frames, at what rate, at what
 * size — with no Node imports, so the browser (which counts tokens) and the
 * server (which runs ffmpeg) derive it from the same function instead of two
 * rules that can drift apart. The ffmpeg half lives in `videoFrames.ts`.
 */

/** Frames per second to sample at, before the frame cap applies. */
export const FRAME_FPS = 1;

/**
 * Hard cap on frames from one video. A longer video is sampled SLOWER (fps
 * drops) rather than truncated, so the whole clip is still covered end to end.
 *
 * 16, not Google's documented 60 s @ 1 fps ceiling, because comprehension was
 * measured and it degrades with frame count long before the cost does. Same
 * 35 s clip, same model (gemma-4-26b-a4b-it-abliterix), a clip whose first
 * ~4 s is a close-up and whose remainder is a wide shot (verified by ffmpeg
 * scene scores: two real cuts, 0.43 and 0.20, everything else < 0.01, and by
 * looking at the frames):
 *
 *   6 frames  → correctly: frame 1 differs, frames 2-6 are the second scene
 *   12 frames → finds the cut, but visibly unsure how many distinct frames it got
 *   35 frames → "There are no changes throughout... it consists of identical
 *                frames" — flatly wrong, stated with confidence
 *
 * The frames were byte-different and correct in all three runs; what failed at
 * 35 was the model, not the pipeline. A cap that produces a confident false
 * summary is worse than a sparser one, so the cap is set where the answers were
 * still right.
 */
export const MAX_FRAMES = 16;

/**
 * Long edge of each extracted frame, in pixels.
 *
 * Not a guess: on this stack full-resolution frames are both expensive and
 * dangerous. A 1080x1920 frame measured 925 prompt tokens against the same
 * model where a 448-long-edge frame measured 86-158, and a single full-size
 * image is what triggered the llama.cpp
 * `GGML_ASSERT(cparams.causal_attn || cparams.n_ubatch >= n_tokens_all)` abort
 * that unloads the model (image attention is bidirectional, so the whole image
 * embedding must fit in one physical batch). 448 keeps every frame far under
 * the default n_ubatch of 512 on its own.
 */
export const FRAME_LONG_EDGE = 448;

/**
 * Token cost NEXUS attributes to one extracted frame.
 *
 * This is the SAME number the existing image estimator produces for a frame
 * this size (a <=384 image is 258; a 448x252 image is
 * ceil(448/768) * ceil(252/768) * 258 = 258), so a video costs "N images" by
 * the rule NEXUS already applies to images — one rule, not a second one
 * invented here.
 *
 * It is an estimate and it is known to run HIGH for local models: the frames
 * above measured ~86 real prompt tokens each. That gap is not introduced by
 * video — a plain image sent to the same local model is over-counted by the
 * same estimator today — so it is left alone here rather than silently
 * special-cased into a number that disagrees with what images report.
 */
export const FRAME_TOKENS_ESTIMATE = 258;

export interface FramePlan {
  /** Sampling rate actually used (<= FRAME_FPS for long videos). */
  fps: number;
  /** Number of frames that will be produced. */
  count: number;
}

/**
 * How many frames a clip of this length becomes.
 *
 * Unknown/zero duration returns a plan of 0 frames: the caller then has no
 * count to display, and must say so rather than print a number it made up.
 */
export function planVideoFrames(durationSec: number | undefined | null): FramePlan {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return { fps: FRAME_FPS, count: 0 };
  const wanted = Math.max(1, Math.round(d * FRAME_FPS));
  if (wanted <= MAX_FRAMES) return { fps: FRAME_FPS, count: wanted };
  // Too long for the cap — slow the sampling down so the clip is still covered
  // end to end instead of cut off partway through.
  return { fps: MAX_FRAMES / d, count: MAX_FRAMES };
}

/** Estimated prompt tokens for a video delivered as frames. 0 when unknown. */
export function frameTokensForDuration(durationSec: number | undefined | null): number {
  return planVideoFrames(durationSec).count * FRAME_TOKENS_ESTIMATE;
}
