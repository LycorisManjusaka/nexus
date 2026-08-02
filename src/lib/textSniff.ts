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
 * Decide whether a byte prefix is human-readable text.
 *
 * Deliberately permissive — the cost of a false "binary" (a readable file the
 * entity cannot see) is much worse than a false "text" (some mojibake the
 * entity can recognise and ignore). Rejects only what is clearly not text:
 *
 *   • a NUL byte — decisive; text files do not contain them
 *   • >10% U+FFFD after a UTF-8 decode — not UTF-8 in any useful sense
 *   • >30% non-printable control characters
 *
 * A UTF-16 file (NUL-heavy) is correctly rejected as "not UTF-8 text"; it would
 * decode to garbage, so calling it binary is the honest answer.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true; // empty file: harmless either way

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
