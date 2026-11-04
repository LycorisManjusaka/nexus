/**
 * Write sense-bridge descriptions onto the attachments they describe.
 *
 * A bridge (eyes/ears/watcher) turns media the primary model cannot perceive
 * into text. The description is generated while the request body is being
 * built, announced on the stream as `attachment_described`, and must then be
 * stored ON THE ATTACHMENT so the next turn re-uses the text instead of
 * calling the bridge model again (`api/chat/route.ts` checks
 * `att.description` before it calls `describeImage`).
 *
 * ⚠ WHY THIS MODULE EXISTS
 *
 * The storing end was a closure inside the browser turn engine. When sends
 * moved to the runner (`c38ea15`, 2026-10-28) the tab's handler became
 * `() => {}` and the runner's recorded the payload without applying it — the
 * ordering looked unsafe, so it was left as a declared gap. Nothing replaced
 * it, so from that commit on NO path stored a description:
 *
 *   Cairn_56 (2026-10-31, pre-runner):  46 images, 44 descriptions
 *   Cairn_59 (2026-11-03, runner):     115 images,  0 descriptions
 *   先輩_65  (2026-11-04, runner):      67 images,  0 descriptions
 *
 * Two costs, both reported by the house. The screen stopped showing the
 * description chip on past media (つよ: "記述一切見えなくなっちゃったの"), and
 * every turn re-described every past attachment from scratch — cheap in money
 * because `eyes_cache` still hit, never free in time.
 *
 * The ordering worry was measurable, and measured: the three `senseEvents`
 * pushes in the route all happen while `contentStr` is being assembled, and
 * `emitSenseEvents` flushes them "at the start of its stream ... before the AI
 * text begins flowing". A description cannot arrive after the turn finalizes,
 * because it is produced before the turn's first byte.
 *
 * Pure, and it returns the original array when nothing matched, so the caller
 * can treat "no descriptions this turn" as free — same contract as
 * `applyAutoHide` in attachmentVisibility.ts.
 */

import type { DescribedAttachmentEvent } from './turnEventReducer';

/** The fields a stored description occupies, as MessageBubble reads them. */
export interface StoredDescription {
  description?: string;
  descriptionKind?: string;
  descriptionModel?: string;
  descriptionGeneratedAt?: number;
  descriptionFromCache?: boolean;
  descriptionError?: string;
}

/**
 * What one payload writes onto one attachment.
 *
 * ⚠ A FAILED BRIDGE WRITES NO `description`. The bridge returns a placeholder
 * string on failure (`[image — … could not describe it: …]`), and the send path
 * re-uses any non-blank `description` without asking whether it is one. Storing
 * the placeholder would therefore make ONE transient 429 permanent: that
 * attachment would never be described again, and the reader would see an error
 * sentence sitting where a description belongs, forever.
 *
 * `eyesVision.describeImage` already draws this exact line for its disk cache
 * ("only successful descriptions, never error placeholders"). This is the same
 * rule one layer out. The error itself is NOT dropped — it goes to
 * `descriptionError`, which the bubble renders in red, so the failure stays
 * visible and the retry stays possible.
 *
 * This is a deliberate departure from the deleted closure, which wrote
 * `description: data.description || ''` unconditionally.
 */
export function describedFields(ev: DescribedAttachmentEvent): StoredDescription {
  const failed = !!ev.error;
  return {
    ...(failed ? {} : { description: ev.description || '' }),
    descriptionKind: ev.kind || '',
    descriptionModel: ev.model || '',
    descriptionGeneratedAt: ev.generatedAt || 0,
    descriptionFromCache: !!ev.fromCache,
    ...(failed ? { descriptionError: ev.error } : {}),
  };
}

/**
 * Does this payload name this attachment?
 *
 * Id first — it is stable across renames and survives a log round-trip. Name
 * only as a fallback, and only when the payload carries no id at all, because
 * logs written before the `id` field exists have attachments with names and
 * nothing else. Matching by name when an id IS present would let two
 * screenshots that share a filename ("image.jpg" — the name every pasted
 * clipboard image gets) take each other's description.
 */
export function describesAttachment(ev: DescribedAttachmentEvent, att: { id?: unknown; name?: unknown }): boolean {
  if (ev.attachmentId) return att?.id === ev.attachmentId;
  if (ev.attachmentName) return att?.name === ev.attachmentName;
  return false;
}

/**
 * Apply every payload to the messages it names.
 *
 * Later payloads win over earlier ones for the same attachment: a turn can
 * describe the same attachment twice only if the first attempt failed and
 * something retried, and the newer answer is the one to keep.
 *
 * A payload whose message or attachment is not in the array is dropped in
 * silence on purpose — a rerun deletes its target, so a description generated
 * for a message that no longer exists is not an error, it is a message that
 * was removed.
 */
export function applyDescriptions<T extends { id?: unknown; attachments?: unknown }>(
  messages: readonly T[],
  payloads: readonly DescribedAttachmentEvent[],
): { changed: boolean; next: T[] } {
  if (payloads.length === 0) return { changed: false, next: messages as T[] };

  let changed = false;
  const next = messages.map((m) => {
    const atts = (m as { attachments?: unknown }).attachments;
    if (!Array.isArray(atts)) return m;
    const mine = payloads.filter((p) => p.messageId && p.messageId === (m as { id?: unknown }).id);
    if (mine.length === 0) return m;

    let msgChanged = false;
    const nextAtts = atts.map((a: Record<string, unknown>) => {
      // Last match wins — see the note above.
      let hit: DescribedAttachmentEvent | null = null;
      for (const p of mine) if (describesAttachment(p, a)) hit = p;
      if (!hit) return a;
      msgChanged = true;
      return { ...a, ...describedFields(hit) };
    });

    if (!msgChanged) return m;
    changed = true;
    return { ...m, attachments: nextAtts };
  });

  return changed ? { changed, next } : { changed: false, next: messages as T[] };
}
