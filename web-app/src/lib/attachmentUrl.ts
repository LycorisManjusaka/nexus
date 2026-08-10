// Client-safe attachment helpers.
//
// Deliberately separate from `attachmentStore.ts`: that module touches `fs` and
// can only run on the server, while these helpers are needed inside React
// components. Keep this file free of Node imports.

/**
 * The URL to display an attachment from, supporting both storage shapes.
 *
 *   • `ref`     — content-addressed payload, served by /api/attachments/<ref>.
 *   • `dataUrl` — inline base64. The original format; every existing backup and
 *                 every un-migrated conversation is in this shape.
 *
 * `ref` wins when both are present: it is canonical, it streams instead of
 * occupying the document as a string, and the browser can cache it.
 *
 * Returns null for text attachments and anything with no payload — callers use
 * that to fall back to an icon.
 */
export function attachmentSrc(att: any): string | null {
  if (!att) return null;
  if (typeof att.ref === 'string' && att.ref) return `/api/attachments/${att.ref}`;
  if (typeof att.dataUrl === 'string' && att.dataUrl) return att.dataUrl;
  return null;
}

/**
 * Approximate payload size in bytes, from whichever shape the attachment uses.
 * Externalized attachments carry a real `size`; inline ones are derived from
 * the base64 length (4 chars ≈ 3 bytes), which is what the UI showed before.
 */
export function attachmentByteSize(att: any): number {
  if (!att) return 0;
  if (typeof att.size === 'number' && att.size > 0) return att.size;
  if (typeof att.dataUrl === 'string' && att.dataUrl) {
    return Math.ceil((att.dataUrl.length * 3) / 4);
  }
  if (typeof att.textData === 'string') return att.textData.length;
  return 0;
}

/**
 * Send attachment bytes to the content-addressed store and get back its ref.
 *
 * Raw bytes, not base64 in a JSON envelope: a Blob/File streams from the
 * browser straight to disk, while base64 would inflate it ~33% and force both
 * sides to hold it as a string — the exact pattern that capped conversations at
 * ~512 MB in the first place.
 *
 * Returns null on failure rather than throwing. Callers fall back to keeping
 * the payload inline, so a failed upload degrades to the old behavior instead
 * of losing the attachment.
 */
export async function uploadAttachment(
  blob: Blob,
  mime?: string
): Promise<{ ref: string; size: number } | null> {
  try {
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'Content-Type': mime || blob.type || 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.ref) throw new Error('response contained no ref');
    return { ref: data.ref, size: data.size ?? blob.size };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[attachments] upload failed, keeping payload inline:', e);
    return null;
  }
}

/**
 * Convert a `data:` URL into a Blob so it can be uploaded as raw bytes.
 * Only needed for payloads that were produced in-page (canvas conversions,
 * VRChat captures) — a real File is uploaded directly with no conversion.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0 || !dataUrl.startsWith('data:')) return null;
    const header = dataUrl.slice(5, comma);
    const mime = header.split(';')[0] || 'application/octet-stream';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/**
 * True when an attachment's bytes are held inline in the conversation JSON —
 * i.e. it still counts against the conversation's serialized size. Used to
 * report what a conversation would gain from migration.
 */
export function isInlineAttachment(att: any): boolean {
  return !!(att && typeof att.dataUrl === 'string' && att.dataUrl && !att.ref);
}
