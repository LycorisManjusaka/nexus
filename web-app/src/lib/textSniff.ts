// ─────────────────────────────────────────────────────────────────────────────
// "Is this file readable as text?" — shared by the browser attach path and the
// server-side attachment funnel, so both answer the question identically.
//
// The rule NEXUS used to apply was an extension allowlist
// (txt|md|csv|json|py|js|ts|jsx|tsx|css|html). Anything else — .srt, .log,
// .yaml, .ini, .sql, .rs, .go, .toml, .vtt — was classified as binary, sent to
// the provider as a media block carrying a mime type no provider accepts, and
// silently dropped. The entity would report, correctly, that it could not see
// the attachment.
//
// What actually determines readability is the bytes, not the filename. So:
// anything that is not image/audio/video is a text CANDIDATE, and a content
// sniff decides. A new subtitle format needs no code change.
// ─────────────────────────────────────────────────────────────────────────────

/** How much of a file to inspect before deciding. Never decode the whole thing. */
export const SNIFF_BYTES = 4096;

/**
 * Cap on text pulled into an attachment. `textData` is injected into the prompt
 * VERBATIM ON EVERY TURN, so an unbounded read is a context-window accident:
 * one 40 MB log would poison every subsequent turn of the conversation. 4 MB is
 * far above any subtitle file, source file, or transcript, and far below the
 * point where it does damage.
 */
export const TEXT_MAX_BYTES = 4 * 1024 * 1024;

/** Extensions that carry a native modality, used when `file.type` is empty. */
export const MEDIA_EXT = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico']),
  audio: new Set(['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'amr']),
  video: new Set(['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts']),
};

/**
 * Byte signatures of binary containers whose FIRST 4 KB reads as clean ASCII.
 *
 * The statistical tests in `looksLikeText` below are deliberately permissive,
 * and a PDF defeats every one of them. Measured 2026-10-30 on two real PDFs
 * (29.9 MB and 4.4 MB, probe = the first 4096 bytes):
 *
 *     has_NUL_in_prefix  false
 *     replacement_ratio  0.0000
 *     control_ratio      0.0000
 *
 * Zero. The header and the object dictionary that follow `%PDF-` are ASCII; the
 * compressed content streams start further in than the sniff ever looks. So the
 * prefix is not "mostly" text — it IS text, and there was nothing for a content
 * test to object to. The damage is downstream: 4 MB of the body is read with
 * `.text()`, stored INSTEAD of the real bytes, and injected into the prompt
 * verbatim on every turn. 望月希子 measured the search-side half of this on
 * 2026-09-10 (1 of her 113 attachments counted as text; it was a PDF of raw
 * bytes, so searching it hit PDF internals and missed every real word).
 *
 * This is still a CONTENT test, not a filename test — the signature is in the
 * bytes, and renaming the file changes nothing. The list is deliberately SHORT:
 * every entry is a chance to call a readable file binary, which is the
 * expensive direction (an entity that cannot see an attachment it was given).
 * Only formats MEASURED to defeat the sniff belong here. ZIP containers
 * (docx/xlsx/odt) are not listed because they carry NUL bytes in their local
 * file headers and the NUL test already rejects them — that is measured in
 * tests/lib/textSniff.test.ts, not assumed.
 */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
];

/** True when `bytes` opens with one of the signatures above. */
export function hasBinarySignature(bytes: Uint8Array): boolean {
  for (const sig of BINARY_SIGNATURES) {
    if (bytes.length < sig.length) continue;
    let match = true;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Decide whether a byte prefix is human-readable text.
 *
 * Deliberately permissive — the cost of a false "binary" (a readable file the
 * entity cannot see) is much worse than a false "text" (some mojibake the
 * entity can recognise and ignore). Rejects only what is clearly not text:
 *
 *   • a known binary-container signature — see BINARY_SIGNATURES above
 *   • a NUL byte — decisive; text files do not contain them
 *   • >10% U+FFFD after a UTF-8 decode — not UTF-8 in any useful sense
 *   • >30% non-printable control characters
 *
 * A UTF-16 file (NUL-heavy) is correctly rejected as "not UTF-8 text"; it would
 * decode to garbage, so calling it binary is the honest answer.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true; // empty file: harmless either way

  // Checked BEFORE the BOM shortcut: a signature is a positive statement about
  // what the file IS, and the statistical tests below cannot see past a prefix
  // that happens to be ASCII. (No listed signature collides with a BOM, so the
  // order is not observable today — it is written this way so that adding a
  // signature later cannot be silently outvoted by a BOM.)
  if (hasBinarySignature(bytes)) return false;

  // A BOM is positive proof of a text file, and UTF-8/UTF-16 BOMs would
  // otherwise trip the NUL check below.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return true;

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return false;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8').decode(bytes);
  } catch {
    return false;
  }

  let replacement = 0;
  let control = 0;
  for (const ch of decoded) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd) replacement++;
    // Allow tab (9), LF (10), CR (13), and form feed (12) — all legitimate.
    else if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) control++;
  }
  const n = decoded.length || 1;
  if (replacement / n > 0.1) return false;
  if (control / n > 0.3) return false;
  return true;
}

/** True when this mime type has a native modality a provider can consume. */
export function isMediaMime(mime: string | undefined | null): boolean {
  const m = (mime || '').toLowerCase();
  // SVG is an image mime, but no provider accepts it AS an image — it is markup
  // and belongs on the text path.
  if (m.startsWith('image/svg')) return false;
  return m.startsWith('image/') || m.startsWith('audio/') || m.startsWith('video/');
}
