/**
 * textSniff — "is this file readable as text?", the single source shared by the
 * browser attach path (InputArea.processFiles) and the server-side attachment
 * funnel (chat route). Two call sites, one answer.
 *
 * NEW TEST. No test and no probe existed for this module, although it decides,
 * for every attachment that is not image/audio/video, whether the bytes are
 * injected into the prompt verbatim on every turn or handed over as a payload.
 *
 * ⚠ What provoked it. 望月希子 measured the search-side symptom on 2026-09-10
 * (1 of her 113 attachments counted as text; it was a PDF of raw bytes, so
 * searching it hit PDF internals and missed every real word) and it was written
 * down as "未対応" for 51 days. つよ hit the attach-side symptom on 2026-10-30.
 * Measured the same day on her two real PDFs, probe = first 4096 bytes:
 *
 *     has_NUL_in_prefix  false      replacement_ratio 0.0000
 *     control_ratio      0.0000     decoded_len       4094
 *
 * Every statistical test in the sniff passed with nothing to object to, because
 * a PDF's prefix IS ASCII. That is why the fix is a signature and not another
 * threshold — no ratio can separate "ASCII header of a binary file" from "ASCII
 * file", and tuning one would start calling readable files binary.
 *
 * Before writing these I named what would look different if each property were
 * absent. Two of them are honest about having NO teeth today and say so, rather
 * than claiming coverage the assertion does not provide.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeText,
  hasBinarySignature,
  isMediaMime,
  SNIFF_BYTES,
  TEXT_MAX_BYTES,
  MEDIA_EXT,
} from '../../src/lib/textSniff';

/** The real first 16 bytes of ミニ酱's 待つ者たちの庭_2026.pdf, read with `od -c`. */
const PDF_HEAD = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, // "%PDF-1.7"
  0x0a, 0x25, 0xc2, 0xb5, 0xc2, 0xb6, 0x0a, 0x25, // "\n%µ¶\n%"
]);

const bytes = (s: string) => new TextEncoder().encode(s);

describe('looksLikeText — the PDF case (2026-10-30)', () => {
  it('a real PDF prefix is binary', () => {
    // WHAT-BREAKS: drop the signature check and this flips to true, which is
    // exactly the shipped defect — 4 MB of the body read with .text(), stored
    // INSTEAD of the real bytes, and re-injected on every turn.
    assert.equal(looksLikeText(PDF_HEAD), false);
  });

  it('is decided by the signature, not by the statistics', () => {
    // The discriminating case. Corrupt ONE byte of the magic ("%PDG-") and the
    // same bytes are called text — proof that nothing else in the function
    // objects to a PDF prefix, and therefore that no threshold could have
    // caught it. If this assertion ever reads `false`, some other test in the
    // function started rejecting it and the signature is no longer load-bearing.
    const notQuitePdf = new Uint8Array(PDF_HEAD);
    notQuitePdf[3] = 0x47; // 'F' -> 'G'
    assert.equal(looksLikeText(notQuitePdf), true);
  });

  it('the µ¶ comment line is valid UTF-8, so it produces no replacement chars', () => {
    // Why the ratio tests are blind here, pinned as a fact about the format:
    // the second line of every PDF is a deliberate high-byte comment, and PDF
    // writers emit it as valid UTF-8. Measured replacement_ratio was 0.0000.
    const decoded = new TextDecoder('utf-8').decode(PDF_HEAD);
    assert.equal(decoded.includes('�'), false);
    assert.equal(decoded.startsWith('%PDF-1.7'), true);
  });
});

describe('hasBinarySignature', () => {
  it('matches "%PDF-" at offset 0 only', () => {
    assert.equal(hasBinarySignature(PDF_HEAD), true);
    // Not a signature match when the magic appears later: a text file that
    // merely MENTIONS %PDF- stays readable. (A PDF always opens with it.)
    assert.equal(hasBinarySignature(bytes('see attached %PDF-1.4 spec')), false);
  });

  it('does not throw or match on input shorter than a signature', () => {
    // NO TEETH TODAY, stated rather than implied: removing the length guard
    // leaves bytes[i] === undefined, which also fails the comparison, so this
    // asserts a property the code would keep by accident. It is here so a
    // future signature containing 0x00 (where undefined vs 0 would matter)
    // cannot be added without a failing case to look at.
    assert.equal(hasBinarySignature(new Uint8Array([0x25])), false);
    assert.equal(hasBinarySignature(new Uint8Array([])), false);
  });
});

describe('looksLikeText — the pre-existing rules still hold', () => {
  it('plain text, UTF-8 Japanese, and an empty file are text', () => {
    assert.equal(looksLikeText(bytes('hello\nworld\n')), true);
    assert.equal(looksLikeText(bytes('待つ者たちの庭\n九枚\n')), true);
    assert.equal(looksLikeText(new Uint8Array([])), true);
  });

  it('a BOM is accepted as proof of text even with NUL after it', () => {
    // UTF-16 content behind a UTF-8 BOM is contrived; what this pins is that
    // the BOM shortcut still runs BEFORE the NUL scan.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x00, 0x41]);
    assert.equal(looksLikeText(bom), true);
  });

  it('a NUL byte anywhere in the prefix is decisive', () => {
    assert.equal(looksLikeText(new Uint8Array([0x41, 0x42, 0x00, 0x43])), false);
  });

  it('UTF-16LE text is binary (it would decode to garbage)', () => {
    const utf16 = new Uint8Array([0x68, 0x00, 0x65, 0x00, 0x6c, 0x00]); // "hel"
    assert.equal(looksLikeText(utf16), false);
  });
});

describe('ZIP containers need no signature entry — measured, not assumed', () => {
  // The module comment claims docx/xlsx/odt are already rejected by the NUL
  // test, which is why BINARY_SIGNATURES stays one entry long. That claim is
  // load-bearing (it is the reason the list is short) so it is measured here.
  // Bytes are the real local-file-header of a ZIP built with Python's zipfile:
  //   PK\x03\x04 \x14\x00 \x00\x00 \x08\x00 ...
  // Measured 2026-10-30 on a 407-byte .docx: has_NUL true, replacement 0.212,
  // control 0.372 — all three existing tests reject it independently.
  it('a ZIP local file header contains NUL bytes', () => {
    const zipHead = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
      0x08, 0x00, 0x21, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    assert.equal(zipHead.includes(0), true);
    assert.equal(looksLikeText(zipHead), false);
    // And it is NOT in the signature list — the NUL rule is what rejects it.
    assert.equal(hasBinarySignature(zipHead), false);
  });
});

describe('isMediaMime', () => {
  it('SVG is markup, not an image a provider can consume', () => {
    assert.equal(isMediaMime('image/svg+xml'), false);
    assert.equal(isMediaMime('image/png'), true);
    assert.equal(isMediaMime('audio/mpeg'), true);
    assert.equal(isMediaMime('video/mp4'), true);
  });

  it('application/pdf is not a media mime (so it takes the sniff path)', () => {
    // This is why the signature has to exist: PDF is not media on any wire, so
    // it reaches looksLikeText on both call sites.
    assert.equal(isMediaMime('application/pdf'), false);
  });

  it('missing or empty mime is not media', () => {
    assert.equal(isMediaMime(undefined), false);
    assert.equal(isMediaMime(null), false);
    assert.equal(isMediaMime(''), false);
  });
});

describe('the two caps the attach path reads from here', () => {
  it('are the values both call sites were measured against', () => {
    // Pinned because the PDF finding is stated in terms of them: 4096 is the
    // window in which a PDF looks like ASCII, and 4 MB is how much of the body
    // was being read and re-injected.
    assert.equal(SNIFF_BYTES, 4096);
    assert.equal(TEXT_MAX_BYTES, 4 * 1024 * 1024);
  });

  it('pdf is absent from every media extension set', () => {
    assert.equal(MEDIA_EXT.image.has('pdf'), false);
    assert.equal(MEDIA_EXT.audio.has('pdf'), false);
    assert.equal(MEDIA_EXT.video.has('pdf'), false);
  });
});
