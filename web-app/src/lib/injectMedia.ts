/**
 * Media riding along with a mid-turn partner interjection.
 *
 * An interjection used to be text only. Sending an image while the entity
 * worked did something worse than refusing: the browser handed the attachments
 * to the sender, the sender dropped them on the floor, and the UI still said
 * "delivered". Operation succeeded, check passed, artifact wrong.
 *
 * This module is the one place that answers "what shape do those bytes take on
 * each provider's wire, and which kinds can even make it mid-turn?" so that
 * the six drain points in `api/chat/route.ts` don't each invent an answer.
 *
 * It deliberately does NOT invent new wire shapes. Every block built here is
 * the shape that ALREADY ships for `read_attachment` results and
 * `computer_screenshot` at those same call sites — mid-turn media delivery is a
 * solved problem in this codebase, and the per-dialect `nativeMediaKinds` sets
 * those tools pass are the measured truth about what each wire accepts inside a
 * running turn. Interjections reuse that, rather than re-deriving it from the
 * normal-attachment send path (which additionally does downscaling, video frame
 * extraction and name hints, and is not safe to restructure mid-turn).
 *
 * Two rules, kept apart on purpose:
 *   • WIRE — can this dialect attach this kind inside a running turn? Passed in
 *     by the call site, because the site IS the dialect.
 *   • MODEL — is the model registered as able to perceive that kind? Asked here
 *     via modelVision, exactly as runReadAttachment asks it.
 * A kind must pass both. Anything that fails either is reported, never dropped
 * in silence — see `handoffNote` (for the entity) and `undeliverableSummary`
 * (for the human).
 */

import { readAttachmentBase64, refPath } from './attachmentStore';
import { isVisionCapable, isAudioCapable, isVideoCapable } from './modelVision';
import type { InjectedMedia } from './injectMessage';

export type MediaKindNarrow = 'image' | 'audio' | 'video';

/** An interjection attachment with its bytes resolved from the store. */
export interface LoadedInjectMedia extends InjectedMedia {
  base64: string;
}

/**
 * Read the payload for every queued ref.
 *
 * `missing` is a real outcome, not a crash: the store is content-addressed and
 * shared, and a ref whose file is gone must be named rather than silently
 * skipped (the same reason runReadAttachment reports a missing payload instead
 * of returning empty text).
 */
export async function loadInjectedMedia(
  items: InjectedMedia[],
): Promise<{ loaded: LoadedInjectMedia[]; missing: InjectedMedia[] }> {
  const loaded: LoadedInjectMedia[] = [];
  const missing: InjectedMedia[] = [];
  for (const it of items || []) {
    try {
      const stored = await readAttachmentBase64(it.ref);
      if (!stored) { missing.push(it); continue; }
      // Trust the stored mime over the queued one: the store derives it from
      // the ref's own extension, which is what the bytes were filed under.
      loaded.push({ ...it, mimeType: stored.mimeType || it.mimeType, base64: stored.base64 });
    } catch {
      missing.push(it);
    }
  }
  return { loaded, missing };
}

/**
 * Which kinds can actually arrive: the dialect's wire AND the model's senses.
 *
 * `wire` is what the call site knows it can attach mid-turn. `model` is the
 * specific model id running this turn. Both have to say yes.
 */
export function injectableKinds(
  wire: Set<MediaKindNarrow>,
  model: string | undefined,
  // Explicit image-sense override. isVisionCapable() is a PURE function that
  // can only match a local model id by a naming substring (-vl / vision /
  // mmproj), so a local vision model like `gemma-4-26b-a4b-qat` is default-
  // denied and its image would fall to hand-off even though the engine really
  // has eyes. The only source of truth for a local model's vision is the LM
  // Studio catalog (`lms ls --json`'s `vision` flag), which is async and not
  // reachable from here — so the local call site reads it and passes it in.
  // `undefined` = no override, use the registry (every cloud path).
  visionOverride?: boolean,
): Set<MediaKindNarrow> {
  const out = new Set<MediaKindNarrow>();
  const canSee = visionOverride === undefined ? isVisionCapable(model) : visionOverride;
  if (wire.has('image') && canSee) out.add('image');
  if (wire.has('audio') && isAudioCapable(model)) out.add('audio');
  if (wire.has('video') && isVideoCapable(model)) out.add('video');
  return out;
}

/** Split loaded media into "arrives natively here" and "does not". */
export function splitDeliverable(
  loaded: LoadedInjectMedia[],
  kinds: Set<MediaKindNarrow>,
): { deliver: LoadedInjectMedia[]; withheld: LoadedInjectMedia[] } {
  const deliver: LoadedInjectMedia[] = [];
  const withheld: LoadedInjectMedia[] = [];
  for (const m of loaded) (kinds.has(m.kind) ? deliver : withheld).push(m);
  return { deliver, withheld };
}

// ── Per-dialect blocks ───────────────────────────────────────────────────────
// Each builder emits a name hint before the payload, the same way every other
// send site in this codebase labels an attachment, so the entity knows what it
// is looking at and can refer to it by filename.

/**
 * Anthropic content blocks (OAuth tool results, the Claude API-key path, and
 * the Kimi/MiMo adapter). Images use the published `image` block; video uses
 * MiMo's undocumented `video` block — the same `source` envelope with the type
 * renamed — which is only ever reached when the call site put 'video' in its
 * wire set (i.e. a video-capable MiMo).
 */
export function anthropicInjectBlocks(deliver: LoadedInjectMedia[]): any[] {
  const out: any[] = [];
  for (const m of deliver) {
    out.push({ type: 'text', text: `<attached_file name="${sanitizeName(m.name)}" type="${m.mimeType}" />` });
    const source = { type: 'base64', media_type: m.mimeType, data: m.base64 };
    if (m.kind === 'video') out.push({ type: 'video', source });
    else out.push({ type: 'image', source });
  }
  return out;
}

/** Gemini parts. `inlineData` carries any mime — image, audio and video alike. */
export function geminiInjectParts(deliver: LoadedInjectMedia[]): any[] {
  const out: any[] = [];
  for (const m of deliver) {
    out.push({ text: `<attached_file name="${sanitizeName(m.name)}" type="${m.mimeType}" />` });
    out.push({ inlineData: { mimeType: m.mimeType, data: m.base64 } });
  }
  return out;
}

/**
 * OpenAI-compatible parts.
 *
 * `rawBase64Audio` exists because ByteDance/Ark schema-validates
 * `input_audio.data` as pure base64 and nulls the whole message when handed a
 * `data:` URL, while Qwen/MiMo accept either — the same distinction the normal
 * send path already makes.
 */
export function openaiInjectParts(
  deliver: LoadedInjectMedia[],
  opts: { rawBase64Audio: boolean },
): any[] {
  const out: any[] = [];
  for (const m of deliver) {
    const dataUrl = `data:${m.mimeType};base64,${m.base64}`;
    out.push({ type: 'text', text: `<attached_file name="${sanitizeName(m.name)}" type="${m.mimeType}" />` });
    if (m.kind === 'image') {
      out.push({ type: 'image_url', image_url: { url: dataUrl } });
    } else if (m.kind === 'audio') {
      out.push({
        type: 'input_audio',
        input_audio: { data: opts.rawBase64Audio ? m.base64 : dataUrl, format: audioFormatOf(m.mimeType) },
      });
    } else {
      out.push({ type: 'video_url', video_url: { url: dataUrl } });
    }
  }
  return out;
}

/** DashScope's audio-format hint ("audio/mpeg" → "mp3"). */
export function audioFormatOf(mime: string): string {
  const sub = (mime.split('/')[1] || '').toLowerCase().replace(/^x-/, '');
  if (sub === 'mpeg') return 'mp3';
  if (sub === '3gpp') return '3gp';
  return sub || 'mp3';
}

/**
 * How a handed-off attachment is ADDRESSED to the entity this turn. Mirrors
 * attachmentPathsVisible in api/chat/route.ts — same two modes, same reason:
 *
 *   'path' — whole-PC access: the file under local_data/attachments/ is
 *            reachable with Read, so hand over the path and skip the tool.
 *   'ref'  — no whole-PC access, read_attachment exposed: a 12-char ref is the
 *            only way in.
 *   'none' — neither: say so instead of handing over an address that opens
 *            nothing.
 */
export type AttachmentAddressing = 'path' | 'ref' | 'none';

/**
 * The entity-facing note for attachments whose bytes could NOT ride along.
 *
 * This is the hand-off: the payload is in the content-addressed store, so an
 * image that cannot be pushed into an OAuth denial string is still reachable,
 * by the entity's own hand, inside the same turn — addressed either by the
 * 12-character ref (what `read_attachment` takes) or by the file's absolute
 * path, whichever this turn can actually open. See AttachmentAddressing. That is strictly more honest than
 * either dropping it or claiming it arrived, and it is the same mechanism that
 * already rescues hidden attachments.
 *
 * `template` comes from the per-entity customizable instruction
 * (`injectionAttachmentNote`); `{files}` is replaced with the list. A blank
 * template falls back to the bare list, never to silence.
 */
export function handoffNote(
  items: { ref: string; name: string; mimeType: string; size: number }[],
  template: string | undefined,
  addressing: AttachmentAddressing,
): string {
  if (!items.length) return '';
  const list = items
    .map((m) => {
      const head = `• ${sanitizeName(m.name)} (${m.mimeType}, ${m.size || 0} bytes)`;
      if (addressing === 'path') {
        const abs = refPath(m.ref);
        // An invalid/legacy ref has no file; fall back to the ref form rather
        // than printing a path that opens nothing.
        if (abs) return `${head} — ${abs}`;
      }
      return `${head} — ref ${m.ref.slice(0, 12)}`;
    })
    .join('\n');
  const body = addressing === 'none'
    ? `${list}\n(These cannot be opened on this connection.)`
    : list;
  const tpl = (template ?? '').trim();
  if (!tpl) return body;
  if (tpl.includes('{files}')) return tpl.replace('{files}', body);
  return `${tpl}\n${body}`;
}

/**
 * The human-facing one-liner for media that did not reach the entity as bytes.
 *
 * Shown as a user-only notice. The point is that the sender finds out at the
 * moment of sending, instead of inferring it later from a reply that never
 * mentions the picture.
 */
export function undeliverableSummary(
  withheld: { name: string }[],
  missing: { name: string }[],
  opts: { ja: boolean; addressing: AttachmentAddressing },
): string {
  const parts: string[] = [];
  if (withheld.length) {
    const names = withheld.map((m) => m.name || '?').join(', ');
    if (opts.ja) {
      parts.push(
        `この接続はターン途中に次のファイルを直接運べません: ${names}。` +
        (opts.addressing === 'path'
          ? 'ファイルの絶対パスを渡したので、存在が自分で開ける。'
          : opts.addressing === 'ref'
            ? 'ref を渡したので、存在が read_attachment で自分で開ける。'
            : 'この接続では開く手段もない。'),
      );
    } else {
      parts.push(
        `This connection can't carry these mid-turn: ${names}.` +
        (opts.addressing === 'path'
          ? ' The absolute path was handed over, so the entity can open them itself.'
          : opts.addressing === 'ref'
            ? ' The ref was handed over, so the entity can open them itself with read_attachment.'
            : ' There is no way to open them on this connection either.'),
      );
    }
  }
  if (missing.length) {
    const names = missing.map((m) => m.name || '?').join(', ');
    parts.push(
      opts.ja
        ? `次のファイルの中身がストアに見つからなかった: ${names}。`
        : `The stored payload for these was missing: ${names}.`,
    );
  }
  return parts.join(' ');
}

/** Keep a filename from closing the XML-ish attribute it sits in. */
function sanitizeName(name: string | undefined): string {
  return String(name || 'attachment').replace(/["<>]/g, '');
}
