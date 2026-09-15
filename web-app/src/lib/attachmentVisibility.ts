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
 * Both `api/chat/route.ts` (which sends) and `ChatArea.tsx` (which displays and
 * counts) import from here. If the delivery rule changes, it changes once.
 */

import { isVisionCapable, isAudioCapable, isVideoCapable } from './modelVision';

/** Media class of an attachment, derived from its mime type. */
export type MediaKind = 'image' | 'audio' | 'video' | 'text' | 'other';

/** Which sense bridge (if any) will convert this attachment into text. */
export type BridgeKind = 'eyes' | 'ears' | 'watcher' | null;

export interface DeliveryContext {
  /** The primary model that will run the turn (e.g. 'claude-opus-5'). */
  specificModel: string;
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
 * True when an image attachment on a PAST message is physically unreachable on
 * the OAuth-Claude path and no bridge is rescuing it.
 *
 * "Past" means: not carried by the last user message. The Agent-SDK path builds
 * native content blocks from `lastUserMsg.mediaFiles` only; everything earlier
 * is replayed as a text transcript with no image bytes at all. The last user
 * message keeps its images because a rerun re-sends exactly those.
 *
 * Deliberately narrow: images only, OAuth only, no-bridge only. Audio and video
 * on Claude are a separate (wider) case — Claude cannot consume them on EITHER
 * auth path — and are not decided here.
 */
export function isOAuthInvisiblePastImage(
  kind: MediaKind,
  isPastMessage: boolean,
  ctx: DeliveryContext,
): boolean {
  if (!ctx.isOAuthClaude) return false;
  if (kind !== 'image' || !isPastMessage) return false;
  return resolveBridge(kind, isPastMessage, ctx) === null;
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
 * audio session's newest-N window, and it is a past image on the OAuth path
 * that the entity physically cannot receive — and they MUST be resolved
 * together. Two separate passes with two separate markers would fight each
 * other: whichever released first would un-hide what the other still wanted
 * hidden, and the attachment would flip on every render.
 *
 * Two states are never touched, in either direction:
 *   • `autoHidden === false` — the user clicked the eye. A human decision
 *     outranks every automation, including the one that says "the model can't
 *     see this anyway".
 *   • `excluded` with no `autoHidden` marker — excluded by hand before this
 *     automation existed. Not ours to release.
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
      const unreachable = isOAuthInvisiblePastImage(attachmentKind(a), isPastMessage, opts.ctx);
      if (isOld || unreachable) {
        if (a.excluded || a.autoHidden === false) return a;
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
 * description, so it costs the description (0 until one has been generated,
 * because nothing exists yet to pay for). An excluded attachment costs nothing.
 */
export function attachmentTokens(att: any, isPastMessage: boolean, ctx: DeliveryContext): number {
  if (!att) return 0;
  if (att.excluded) return 0;
  const bridge = resolveBridge(attachmentKind(att), isPastMessage, ctx);
  if (bridge) return att.descriptionTokens || 0;
  return att.tokens || 0;
}
