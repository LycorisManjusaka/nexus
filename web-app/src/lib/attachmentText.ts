// Client-safe rules for reading a text attachment's body out of whichever
// shape the conversation JSON happens to hold.
//
// Deliberately free of Node imports (same reason as attachmentUrl.ts): these
// run inside React components.
//
// THREE SHAPES, ALL PERMANENT — not a migration window:
//
//   textData     The whole file, inline. What the browser writes for a
//                brand-new attachment, and what every pre-migration
//                conversation and every existing backup holds.
//   textPreview  The first PREVIEW_STORE chars, inline, with `ref` carrying
//                the rest. Written by migrate-drop-text-data.mjs.
//   neither      Only `ref`. Nothing is rendered without a fetch.
//
// WHY A PREVIEW IS KEPT INLINE RATHER THAN DROPPING THE TEXT ENTIRELY
// attachmentStore.ts argues against externalizing text display, and one half
// of that argument is exactly right: "a fetch per preview". MessageBubble
// renders only the first 500 chars inline and puts the rest behind a click, so
// keeping 500 chars in the log costs ~0.5 KB per attachment and buys back a
// zero-fetch preview. Measured 2026-11-01 over this corpus: dropping textData
// outright saves 28.0% of gzipped conversation bytes, keeping a preview saves
// 26.3%. 1.7 points to never block a render on the network.
//
// HOW "IS THIS A CUT?" IS DECIDED, AND WHY NOT BY LENGTH
// For `textData` it is still `length > PREVIEW_CHARS` — that field is the
// whole file, so its length answers the question.
//
// For `textPreview` the ANSWER IS ALWAYS YES, from the field's existence
// alone. A length test was the first design and it was wrong: the migration
// must not cut between a surrogate pair (measured 2026-11-01: 2 of 2487
// candidates in this corpus split one at exactly 501), so a safe cut sometimes
// lands on 500 — and `length > 500` would then say "not truncated" and hide
// the only affordance that can reach the file. The migration only ever
// converts attachments LONGER than PREVIEW_STORE_CHARS, so the field being
// present IS the statement that bytes were left behind.

/** Chars actually rendered in the inline preview. */
export const PREVIEW_CHARS = 500;

/**
 * Chars the migration stores. One more than is rendered, so the preview still
 * visibly has something past the cut; the truncation test does not depend on
 * it (see above).
 */
export const PREVIEW_STORE_CHARS = PREVIEW_CHARS + 1;

/**
 * Cut a string without splitting a surrogate pair.
 *
 * JS string indices are UTF-16 code units, so slicing at a fixed offset can
 * land between the halves of an astral character (emoji, rare CJK) and emit a
 * lone surrogate — valid JSON, and a replacement glyph on screen. Measured in
 * this corpus: 2 attachments of 2487 split at 501.
 */
export function cutWithoutSplittingPair(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

/**
 * The fields needed to READ a text attachment — deliberately not a full
 * attachment type.
 *
 * An attachment carries 20+ fields (id, size, tokens, toolAction, excluded,
 * the isImage/isVideo/isAudio flags, …) and the components that render it take
 * `any`, as most of this file's neighbours do. Declaring a partial type here
 * and naming it for its purpose is honest; declaring an incomplete `Attachment`
 * would be a worse claim than no claim, because the next reader would believe
 * it was the whole shape.
 */
export type TextAttachment = {
  name?: string;
  isText?: boolean;
  textData?: string | null;
  textPreview?: string | null;
  ref?: string | null;
};

type TextAtt = TextAttachment | null | undefined;

/**
 * The text available WITHOUT a network round-trip, or null if there is none.
 *
 * `textData` wins when both are present: it is the whole file, so preferring it
 * means a conversation that has not been migrated behaves exactly as before.
 */
export function attachmentInlineText(att: TextAtt): string | null {
  if (!att) return null;
  if (typeof att.textData === 'string') return att.textData;
  if (typeof att.textPreview === 'string') return att.textPreview;
  return null;
}

/**
 * True when the inline text is a cut and the rest lives behind the ref.
 *
 * Returns false when there is no inline text at all — nothing is being
 * truncated if nothing is shown. Callers that need "can the full text be
 * reached" ask attachmentHasFullText instead.
 */
export function attachmentTextTruncated(att: TextAtt): boolean {
  if (!att) return false;
  // Whole file inline: its length answers the question.
  if (typeof att.textData === 'string') return att.textData.length > PREVIEW_CHARS;
  // A preview exists only because the migration left bytes behind. Asked by
  // length instead, a safe cut that landed on 500 would answer "no".
  return typeof att.textPreview === 'string';
}

/** The inline text, cut to what is actually rendered, pairs kept intact. */
export function attachmentPreviewSlice(att: TextAtt): string | null {
  const t = attachmentInlineText(att);
  return t === null ? null : cutWithoutSplittingPair(t, PREVIEW_CHARS);
}

/**
 * True when opening the full text requires fetching the ref.
 *
 * Only `textData` carries the whole file inline. A `textPreview` is by
 * definition a cut, so the modal has to fetch even though something is already
 * on screen.
 */
export function attachmentNeedsFetch(att: TextAtt): boolean {
  if (!att) return false;
  if (typeof att.textData === 'string') return false;
  return typeof att.ref === 'string' && !!att.ref;
}

/**
 * True when the full text is reachable at all — inline or by fetch.
 *
 * This gates the "view full text" affordances. Without it, a migrated
 * attachment whose payload went missing from the store would show a button
 * that can only ever fail.
 */
export function attachmentHasFullText(att: TextAtt): boolean {
  if (!att) return false;
  if (typeof att.textData === 'string') return true;
  return attachmentNeedsFetch(att);
}

/**
 * True when there is anything to render for this attachment as text.
 *
 * Note the deliberate asymmetry with the old `att.isText && att.textData`
 * test: an attachment with only a ref renders no preview but DOES get the
 * full-text button, because the button can fetch and the preview cannot.
 */
export function attachmentHasInlineText(att: TextAtt): boolean {
  return attachmentInlineText(att) !== null;
}
