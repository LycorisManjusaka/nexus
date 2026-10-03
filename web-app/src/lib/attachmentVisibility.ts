/**
 * Attachment visibility — the single place that answers "will the entity
 * actually receive this attachment, and in what form?"
 *
 * This exists because the answer was previously computed in two places that
 * disagreed: the send path (server) knew the truth, and the token counter /
 * attachment UI (client) assumed every non-excluded attachment reached the
 * model. On the OAuth-Claude path that assumption is false — the transcript is
 * flattened to TEXT, and only the last user message carries native image
 * blocks — so the UI counted image tokens for images the entity could not see
 * and drew them as "included". That is a lie told to the user, and the fix is
 * not to duplicate the rule more carefully: it is to have one rule.
 *
 * The same lie has a second, larger form that has nothing to do with billing:
 * the Anthropic content-block format has no audio or video block at all, so on
 * Claude/Kimi/MiMo those attachments are filtered out at the send site and the
 * entity receives nothing — on BOTH auth modes. Fixing only the OAuth image
 * case left a real conversation whose attachment total was still 73% video that
 * was never sent, which is exactly why switching billing looked like it changed
 * nothing. Both causes are answered by undeliverableReason() below.
 *
 * Both `api/chat/route.ts` (which sends) and `ChatArea.tsx` (which displays and
 * counts) import from here. If the delivery rule changes, it changes once.
 */

import { isVisionCapable, isAudioCapable, isVideoCapable } from './modelVision';
import { frameTokensForDuration } from './videoFramePlan';

/** Media class of an attachment, derived from its mime type. */
export type MediaKind = 'image' | 'audio' | 'video' | 'text' | 'other';

/** Which sense bridge (if any) will convert this attachment into text. */
export type BridgeKind = 'eyes' | 'ears' | 'watcher' | null;

export interface DeliveryContext {
  /** The primary model that will run the turn (e.g. 'claude-opus-5'). */
  specificModel: string;
  /**
   * The provider family that will run the turn ('Claude', 'Gemini', 'Kimi', …)
   * — what picks the wire format, and therefore which media kinds can be
   * attached at all. Empty string = not knowable in advance (automatic model
   * selection), and every wire question then answers "assume it carries",
   * because an unprovable claim of loss is just the old lie inverted.
   */
  aiName: string;
  /** True only when this turn really goes through the OAuth/Agent-SDK path. */
  isOAuthClaude: boolean;
  eyesEnabled: boolean;
  earsEnabled: boolean;
  watcherEnabled: boolean;
}

/** Classify a mime type. `isText` attachments are inlined and always arrive. */
export function mediaKindOf(mimeType: string | undefined | null): MediaKind {
  const m = (mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * Classify a stored attachment. Prefers the explicit `isText/isImage/isAudio/
 * isVideo` flags the browser wrote at attach time and falls back to the mime
 * type, because older logs carry attachments whose `type` is not a mime at all.
 */
export function attachmentKind(att: any): MediaKind {
  if (!att) return 'other';
  if (att.isText) return 'text';
  if (att.isImage) return 'image';
  if (att.isAudio) return 'audio';
  if (att.isVideo) return 'video';
  return mediaKindOf(att.type);
}

/**
 * Which bridge will describe this attachment, or null if it is passed through
 * (or dropped) as-is.
 *
 * Mirrors the send path exactly:
 *   useEyes    = eyes toggle on AND the primary model can't see
 *   useEars    = ears toggle on AND the primary model can't hear
 *   useWatcher = watcher toggle on AND the primary model can't watch
 *   plus the OAuth-Claude past-image exception: a vision-capable OAuth Claude
 *   is blind to every image except the current turn's, so with eyes on we
 *   describe the PAST ones only.
 */
export function resolveBridge(
  kind: MediaKind,
  isPastMessage: boolean,
  ctx: DeliveryContext,
): BridgeKind {
  const useEyes    = !!ctx.eyesEnabled    && !isVisionCapable(ctx.specificModel);
  const useEars    = !!ctx.earsEnabled    && !isAudioCapable(ctx.specificModel);
  const useWatcher = !!ctx.watcherEnabled && !isVideoCapable(ctx.specificModel);
  const oauthPastImageEyes = ctx.isOAuthClaude && !!ctx.eyesEnabled && !useEyes;

  if (kind === 'image') return (useEyes || (oauthPastImageEyes && isPastMessage)) ? 'eyes' : null;
  if (kind === 'audio') return useEars ? 'ears' : null;
  if (kind === 'video') return useWatcher ? 'watcher' : null;
  return null;
}

/**
 * Provider families whose wire format is the Anthropic content-block spec.
 * Anthropic's own spec has `image` blocks and nothing else — no audio block
 * type, no video block type — and two of the three send sites that build
 * those blocks (`api/chat/route.ts`: the OAuth/Agent-SDK path and the Claude
 * API-key path) still filter on `mimeType.startsWith('image/')` with no else
 * branch, so audio and video are dropped in silence there.
 *
 * The third site, the Kimi/MiMo adapter, is no longer purely image-only:
 * MiMo's endpoint accepts an undocumented `video` block (measured 2026-10-03)
 * and the adapter now sends it for video-capable MiMo models. Membership in
 * this list therefore no longer means "images only" by itself — the per-kind
 * branches in wireCarriesMedia() below are what decide.
 *
 * Gemini (`inlineData`, any mime) and the OpenAI-compatible path (`image_url`
 * + `input_audio` + `video_url`) really do carry all three, so they are not
 * listed here. Matched as a substring, the same way the server tests `aiName`.
 */
const ANTHROPIC_SHAPED_FAMILIES = ['claude', 'kimi', 'mimo'];

/**
 * The Local family is LM Studio, and LM Studio is stricter than the rest of the
 * OpenAI-compatible path: its request validator accepts exactly two content
 * types and 400s the WHOLE call on anything else. Measured 2026-09-19 against a
 * loaded gemma-4-26B-A4B, identical on `/v1/chat/completions` and
 * `/api/v0/chat/completions`, for `input_audio` (raw base64 and data-URL),
 * `audio_url`, bare `audio`, and `video_url`:
 *
 *   400 "Invalid 'content': 'content' objects must have a 'type' field that is
 *        either 'text' or 'image_url'."
 *
 * It is the validator, not the model — a text-only request to the same endpoint
 * answers 200, and there is no `/v1/audio/transcriptions` to upload to either.
 *
 * So on Local:
 *   • audio  — cannot arrive. Reported as undeliverable, which is the same
 *     honesty fix already applied to Claude/Kimi/MiMo, except that here the old
 *     behaviour was worse than a silent drop: it failed the entire turn.
 *   • video  — DOES arrive, as frames. The send path decodes the clip with
 *     ffmpeg and sends still images (see `videoFramePlan.ts`), which is how the
 *     model consumes video anyway.
 *   • image  — arrives natively.
 *
 * Caveat worth knowing before trusting this: `LOCAL_LLM_BASE` can be pointed at
 * something other than LM Studio (raw `llama-server` does accept `input_audio`
 * when its mmproj carries an audio tower). This rule describes the default
 * endpoint NEXUS ships with, so a non-LM-Studio local server would be
 * under-reported here — an over-cautious error, not a false claim of delivery.
 */
function localWireCarries(kind: MediaKind): boolean {
  return kind !== 'audio';
}

/** Can this provider's wire format carry this media kind at all? */
export function wireCarriesMedia(kind: MediaKind, ctx: DeliveryContext): boolean {
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return true;
  const family = String(ctx.aiName || '').toLowerCase();
  if (!family) return true;  // unknowable in advance — claim nothing
  if (ANTHROPIC_SHAPED_FAMILIES.some((f) => family.includes(f))) {
    if (kind === 'image') return true;
    // MiMo is the one Anthropic-shaped family with a real video block — same
    // `source` envelope as `image`, type renamed (measured; see the V2.6 note
    // in modelVision.ts for the four shapes that silently dropped). Gated on
    // the MODEL, not the family: mimo-v2.5-pro 404s on it, and Kimi has no
    // measured video surface at all — neither is in VIDEO_CAPABLE_MODELS, so
    // both fall through to false and keep their honest "won't arrive" label.
    // This must stay in lockstep with the adapter's own isVideoCapable() gate
    // in `streamViaAnthropicCompat`: if this said yes where the adapter says
    // no, the UI would promise delivery for bytes it then drops.
    if (kind === 'video' && family.includes('mimo')) return isVideoCapable(ctx.specificModel);
    return false;
  }
  if (family.includes('local')) return localWireCarries(kind);
  return true;
}

/** Why an attachment will not arrive, or null when it will. */
export type UndeliverableReason =
  /** The provider's wire format has no block type for this media kind. */
  | 'wire'
  /** OAuth Claude replays history as text, so past image bytes don't exist. */
  | 'oauth-transcript';

/**
 * Why this attachment will not reach the entity on the path that will run —
 * or null when it will (natively, or as a bridge description).
 *
 * Two independent causes, both verified by reading the send path rather than
 * inferred:
 *
 *   • 'wire' — audio/video addressed to an Anthropic-shaped family. Silently
 *     filtered out at the content-block builder. True on BOTH Claude auth
 *     modes; switching billing changes nothing.
 *   • 'oauth-transcript' — an image on a PAST message under OAuth Claude.
 *     "Past" means: not carried by the last user message. The Agent-SDK path
 *     builds native blocks from `lastUserMsg.mediaFiles` only; everything
 *     earlier is replayed as text with no image bytes. The last user message
 *     keeps its images because a rerun re-sends exactly those.
 *
 * A bridge outranks both: a described attachment arrives as text, which every
 * wire carries. Text attachments are inlined into the message body and always
 * arrive.
 *
 * Still NOT decided here: a model that isn't registered as able to accept a
 * kind its provider's wire does carry (a text-only model on the OpenAI path
 * with eyes off). There the provider typically errors, and a loud failure is
 * not the silent lie this module exists to remove — so it is left alone rather
 * than guessed at.
 */
export function undeliverableReason(
  kind: MediaKind,
  isPastMessage: boolean,
  ctx: DeliveryContext,
): UndeliverableReason | null {
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return null;
  if (resolveBridge(kind, isPastMessage, ctx)) return null;
  if (!wireCarriesMedia(kind, ctx)) return 'wire';
  if (ctx.isOAuthClaude && kind === 'image' && isPastMessage) return 'oauth-transcript';
  return null;
}

/** True when this attachment will not reach the entity at all. */
export function isUndeliverable(
  kind: MediaKind,
  isPastMessage: boolean,
  ctx: DeliveryContext,
): boolean {
  return undeliverableReason(kind, isPastMessage, ctx) !== null;
}

// ── Audio-session attachment auto-hide ───────────────────────────────────────
// How many of the NEWEST messages keep their attachments included while a
// VRChat/audio session is running. Counts MESSAGES, not attachments: one
// message carrying ten screenshots is one message.
//
// This constant exists because the default used to be written twice — the
// Preferences input fell back to 15, the effect that actually hides fell back
// to 3 — so an untouched setting displayed 15 and behaved as 3 (≈1 image in an
// alternating conversation). Editing the field wrote a value and the two agreed
// again, which is exactly the "touch the parameter and it starts working"
// symptom that was reported. One constant, both call sites.
export const AUDIO_SESSION_KEEP_MESSAGES_DEFAULT = 15;

/**
 * Clamp a stored/typed keep-count to the supported range.
 *
 * Blank is "unset", not zero. The number input hands back '' while the user is
 * mid-edit (and after clearing the field), and `Number('')` is 0 — which would
 * quietly mean "keep nothing, hide every attachment". An explicit 0 typed by
 * the user still means exactly that.
 */
export function resolveKeepMessages(raw: unknown): number {
  if (raw === null || raw === undefined) return AUDIO_SESSION_KEEP_MESSAGES_DEFAULT;
  if (typeof raw === 'string' && raw.trim() === '') return AUDIO_SESSION_KEEP_MESSAGES_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return AUDIO_SESSION_KEEP_MESSAGES_DEFAULT;
  return Math.min(100, Math.max(0, Math.floor(n)));
}

// ── The one auto-hide pass ───────────────────────────────────────────────────

export interface AutoHideOptions {
  /** VRChat/audio session is running AND the Preferences option is on. */
  sessionActive: boolean;
  /** Keep attachments on the newest N MESSAGES (only read when sessionActive). */
  keepMessages: number;
  /** Index of the last user message; everything before it is "past". */
  lastUserMsgIndex: number;
  ctx: DeliveryContext;
}

/**
 * Decide the hidden state of every attachment in one pass and return the new
 * message array (or the original array when nothing changed).
 *
 * There are two independent reasons to hide an attachment — it fell out of the
 * audio session's newest-N window, and the path that will run physically
 * cannot carry it (see undeliverableReason) — and they MUST be resolved
 * together. Two separate passes with two separate markers would fight each
 * other: whichever released first would un-hide what the other still wanted
 * hidden, and the attachment would flip on every render.
 *
 * The two reasons are NOT equal in authority, and conflating them is what made
 * the first version of this function do nothing at all:
 *
 *   • The audio-session window is a POLICY. A human who clicks the eye inside
 *     it has overruled a preference, and `autoHidden === false` records that
 *     for good — the automation stops touching that attachment.
 *   • Unreachability is a FACT. Clicking the eye cannot make OAuth-Claude see
 *     an image that is never sent; it only restores the false claim that it
 *     was. So `autoHidden === false` does NOT veto this one.
 *
 * That distinction is load-bearing. The conversation this feature was first
 * tested on had exactly one image, and that image had been eye-toggled by hand
 * a week earlier — so a stale POLICY opt-out silently vetoed a FACT, and the
 * whole feature measured as "no effect anywhere".
 *
 * Cost of the fact winning: forcing a hide overwrites a stale `autoHidden:
 * false`, so if the path later changes back the attachment is released with no
 * opt-out marker. That returns it to `excluded: false`, which is the state the
 * user had asked for anyway.
 *
 * One state is never touched, in either direction:
 *   • `excluded` with no `autoHidden` marker — excluded by hand. Not ours to
 *     release, and not ours to re-mark.
 *
 * Hiding is not a confession that the attachment is lost: the send path
 * surfaces a 12-char ref for every excluded attachment, so an image that was
 * silently invisible becomes one the entity can deliberately fetch with
 * read_attachment. That is strictly more reachable than before, not less.
 */
export function applyAutoHide<T extends { attachments?: any[] }>(
  messages: T[],
  opts: AutoHideOptions,
): { changed: boolean; next: T[] } {
  if (messages.length === 0) return { changed: false, next: messages };

  // Everything before this message index is "older than N messages back".
  const keepFrom = opts.sessionActive
    ? Math.max(0, messages.length - opts.keepMessages)
    : 0;

  let changed = false;
  const next = messages.map((m: any, mi: number) => {
    if (!Array.isArray(m.attachments)) return m;
    const isOld = opts.sessionActive && mi < keepFrom;
    const isPastMessage = mi < opts.lastUserMsgIndex;
    let msgChanged = false;
    const atts = m.attachments.map((a: any) => {
      // FACT — the path cannot carry it. Not overridable by a click.
      const unreachable = isUndeliverable(attachmentKind(a), isPastMessage, opts.ctx);
      // POLICY — it fell out of the audio session's newest-N window. A manual
      // decision (`autoHidden === false`) overrules this one.
      const windowed = isOld && a.autoHidden !== false;
      if (unreachable || windowed) {
        // Already hidden — by hand or by us. Leave it; re-marking a hand
        // exclusion would make us release it later, which is not ours to do.
        if (a.excluded) return a;
        msgChanged = true;
        return { ...a, excluded: true, autoHidden: true };
      }
      // No reason left to hide it (session ended, N raised, billing switched
      // back to the API key, eyes turned on): undo only our own hiding.
      if (a.autoHidden === true) {
        msgChanged = true;
        const { autoHidden, ...rest } = a;
        return { ...rest, excluded: false };
      }
      return a;
    });
    if (!msgChanged) return m;
    changed = true;
    return { ...m, attachments: atts };
  });

  return changed ? { changed, next } : { changed: false, next: messages };
}

/**
 * What ONE attachment actually costs on the path that will run.
 *
 * `att.tokens` is the size of the raw media, measured at attach time — true
 * only if those bytes reach the model. A bridged attachment arrives as a text
 * description, so it costs the description. An excluded attachment costs
 * nothing.
 *
 * `descriptionTokens` is written when the bridge runs, and back-filled by
 * ChatArea for descriptions that pre-date the field — without that back-fill
 * this returns 0 for text that really is being sent, which is the same kind of
 * under-report the whole module exists to remove. 0 here means "no description
 * yet, or not measured yet", never "free".
 *
 * Unreachability is checked HERE, not inferred from `excluded`. `applyAutoHide`
 * writes that flag as a side effect, one render later — so a counter that
 * trusted the flag would report the old lie for every render in between (and
 * for good, anywhere the effect does not run). The fact does not depend on a
 * flag having been written yet.
 */
export function attachmentTokens(att: any, isPastMessage: boolean, ctx: DeliveryContext): number {
  if (!att) return 0;
  if (att.excluded) return 0;
  const kind = attachmentKind(att);
  if (isUndeliverable(kind, isPastMessage, ctx)) return 0;
  const bridge = resolveBridge(kind, isPastMessage, ctx);
  if (bridge) return att.descriptionTokens || 0;
  // A video sent to a local model is not sent as a video: it is decoded to
  // frames, so it costs N images, not `att.tokens` (which was measured as
  // duration x a per-second video rate at attach time). Same plan the server
  // executes — see videoFramePlan.ts.
  //
  // `durationSec` is written at attach time. Attachments from before that field
  // existed have none, and there is no honest way to recover it here, so they
  // keep reporting the old video estimate rather than a number invented from
  // the old number.
  if (kind === 'video' && String(ctx.aiName || '').toLowerCase().includes('local')) {
    const framed = frameTokensForDuration(att.durationSec);
    if (framed > 0) return framed;
  }
  return att.tokens || 0;
}

/**
 * The exact text a stored description turns into on the way to the entity.
 *
 * The send path builds this wrapper when it re-uses a persisted description
 * (`api/chat/route.ts`), and the token counter must measure the same string or
 * it is counting something nobody sends. One construction, three callers.
 *
 * `modelOverride` is for the first run, where the bridge model that just
 * produced the text is known but has not been written to the attachment yet.
 */
export function bridgedDescriptionText(att: any, bridge: Exclude<BridgeKind, null>, modelOverride?: string): string {
  const tagName =
    bridge === 'eyes' ? 'image_description' :
    bridge === 'ears' ? 'audio_description' :
                        'video_description';
  const via = modelOverride || att?.descriptionModel || 'cached';
  return (
    `\n\n<${tagName} filename="${att?.name || bridge}" via="${via}">\n` +
    `${att?.description || ''}\n` +
    `</${tagName}>`
  );
}
