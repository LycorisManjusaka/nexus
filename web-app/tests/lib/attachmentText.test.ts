import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREVIEW_CHARS,
  PREVIEW_STORE_CHARS,
  attachmentInlineText,
  attachmentTextTruncated,
  attachmentPreviewSlice,
  attachmentNeedsFetch,
  attachmentHasFullText,
  attachmentHasInlineText,
  cutWithoutSplittingPair,
} from '@/lib/attachmentText';

// Rules for reading a text attachment's body out of three shapes:
//   textData     whole file inline (pre-migration, and every new attachment)
//   textPreview  first 501 chars inline + ref (post-migration)
//   ref only     nothing inline
//
// Each case names what would differ if the rule were absent, because a test
// that only restates the implementation proves nothing.

const REF = 'a'.repeat(64) + '.txt';
const long = (n: number) => 'x'.repeat(n);

test('PREVIEW_STORE_CHARS is one more than PREVIEW_CHARS', () => {
  // Without the extra char, `length > PREVIEW_CHARS` could not tell a 500-char
  // FILE from a 500-char CUT, and every migrated attachment would render with
  // no "view full" affordance at all.
  assert.equal(PREVIEW_STORE_CHARS, PREVIEW_CHARS + 1);
  assert.equal(PREVIEW_CHARS, 500);
});

test('textData wins over textPreview when both are present', () => {
  // Absent this preference, a conversation that was migrated and then had an
  // attachment re-attached inline would show the SHORT copy and claim it was
  // the whole file.
  const att = { isText: true, textData: 'WHOLE', textPreview: 'PREV', ref: REF };
  assert.equal(attachmentInlineText(att), 'WHOLE');
  assert.equal(attachmentNeedsFetch(att), false);
});

test('textPreview is used when textData is absent', () => {
  const att = { isText: true, textPreview: 'PREV', ref: REF };
  assert.equal(attachmentInlineText(att), 'PREV');
});

test('ref-only attachment has no inline text but has full text', () => {
  // This asymmetry is the point: no preview can render, but the full-text
  // button CAN fetch. The old `att.isText && att.textData` test collapsed both
  // to "show nothing", which would hide the only way to reach the file.
  const att = { isText: true, ref: REF };
  assert.equal(attachmentInlineText(att), null);
  assert.equal(attachmentHasInlineText(att), false);
  assert.equal(attachmentHasFullText(att), true);
  assert.equal(attachmentNeedsFetch(att), true);
});

test('attachment with neither text nor ref has nothing', () => {
  // Without this, a migrated attachment whose payload went missing from the
  // store would show a button that can only ever fail.
  const att = { isText: true };
  assert.equal(attachmentHasFullText(att), false);
  assert.equal(attachmentNeedsFetch(att), false);
  assert.equal(attachmentPreviewSlice(att), null);
});

test('empty-string textData is text, not absence', () => {
  // `typeof === 'string'` rather than truthiness: an empty text file is a real
  // attachment, and a truthy test would send the renderer to fetch a ref for a
  // file that is genuinely empty.
  const att = { isText: true, textData: '', ref: REF };
  assert.equal(attachmentInlineText(att), '');
  assert.equal(attachmentHasInlineText(att), true);
  assert.equal(attachmentNeedsFetch(att), false);
  assert.equal(attachmentTextTruncated(att), false);
});

test('textData truncation is decided by length', () => {
  assert.equal(attachmentTextTruncated({ textData: long(PREVIEW_CHARS) }), false);
  assert.equal(attachmentTextTruncated({ textData: long(PREVIEW_CHARS + 1) }), true);
});

test('textPreview is ALWAYS truncated, whatever its length', () => {
  // This is the rule, and it is not a length test. A safe cut (one that does
  // not split a surrogate pair) sometimes lands on 500 instead of 501 —
  // measured: 2 of 2487 attachments in this corpus. Deciding by length would
  // then report "not truncated" and hide the only affordance that can reach
  // the rest of the file. The migration converts only attachments LONGER than
  // PREVIEW_STORE_CHARS, so the field's presence is the statement.
  assert.equal(attachmentTextTruncated({ textPreview: long(PREVIEW_STORE_CHARS), ref: REF }), true);
  assert.equal(attachmentTextTruncated({ textPreview: long(PREVIEW_CHARS), ref: REF }), true);
  assert.equal(attachmentTextTruncated({ textPreview: 'tiny', ref: REF }), true);
});

test('a migrated 501-char preview renders 500 and offers the rest', () => {
  const att = { isText: true, textPreview: long(PREVIEW_STORE_CHARS), ref: REF };
  assert.equal(attachmentTextTruncated(att), true);
  assert.equal(attachmentPreviewSlice(att)!.length, PREVIEW_CHARS);
  assert.equal(attachmentNeedsFetch(att), true);
});

test('cutWithoutSplittingPair never emits a lone surrogate', () => {
  // Absent this, slicing at a fixed offset lands between the halves of an
  // astral char and stores half of it: valid JSON, replacement glyph on
  // screen. Two real attachments split at exactly 501.
  const emoji = '\u{1F600}';                       // one astral char, 2 units
  assert.equal(emoji.length, 2);
  const s = 'a'.repeat(499) + emoji + 'tail';      // the pair straddles 500/501
  const cut = cutWithoutSplittingPair(s, 500);
  assert.equal(cut.length, 499, 'cut one earlier rather than splitting');
  assert.equal(cut, 'a'.repeat(499));
  // Round-tripping through JSON must not change it — the proof that nothing
  // became a lone surrogate.
  assert.equal(JSON.parse(JSON.stringify(cut)), cut);
  // Cutting one past the pair keeps it whole.
  assert.equal(cutWithoutSplittingPair(s, 501), 'a'.repeat(499) + emoji);
});

test('cutWithoutSplittingPair leaves short strings and clean cuts alone', () => {
  assert.equal(cutWithoutSplittingPair('abc', 10), 'abc');
  assert.equal(cutWithoutSplittingPair('abcdef', 3), 'abc');
  // A LOW surrogate at the boundary means the pair ended before the cut —
  // nothing to fix. Checking only the high half is what makes that true.
  const s = '\u{1F600}' + 'x'.repeat(10);
  assert.equal(cutWithoutSplittingPair(s, 2), '\u{1F600}');
});

test('preview slice of a whole file keeps pairs intact', () => {
  const s = 'b'.repeat(499) + '\u{1F600}' + 'rest'.repeat(500);
  const out = attachmentPreviewSlice({ textData: s })!;
  assert.equal(out.length, 499);
  assert.equal(JSON.parse(JSON.stringify(out)), out);
});

test('preview slice is capped at PREVIEW_CHARS even for a whole file', () => {
  // Absent the cap, a 5 MB textData would be injected into the document as a
  // string on every render — the exact cost the preview exists to avoid.
  assert.equal(attachmentPreviewSlice({ textData: long(100000) })!.length, PREVIEW_CHARS);
});

test('short text is not truncated and needs no fetch', () => {
  const att = { isText: true, textData: 'hello', ref: REF };
  assert.equal(attachmentTextTruncated(att), false);
  assert.equal(attachmentPreviewSlice(att), 'hello');
  assert.equal(attachmentNeedsFetch(att), false);
});

test('null textData is treated as absent, not as text', () => {
  // slimHistory sets `textData: null` for excluded attachments. Reading that
  // as a string would crash on .length; reading it as text would render
  // "null". Both were live possibilities.
  const att = { isText: true, textData: null, ref: REF };
  assert.equal(attachmentInlineText(att), null);
  assert.equal(attachmentNeedsFetch(att), true);
});

test('null/undefined attachment yields no text and no fetch', () => {
  for (const att of [null, undefined]) {
    assert.equal(attachmentInlineText(att), null);
    assert.equal(attachmentTextTruncated(att), false);
    assert.equal(attachmentPreviewSlice(att), null);
    assert.equal(attachmentNeedsFetch(att), false);
    assert.equal(attachmentHasFullText(att), false);
    assert.equal(attachmentHasInlineText(att), false);
  }
});

test('empty-string ref does not count as a reachable payload', () => {
  // `ref: ''` appears in older shapes. Treating it as present would produce a
  // fetch of /api/attachments/ — a 404 behind a button that looks working.
  const att = { isText: true, textPreview: 'PREV', ref: '' };
  assert.equal(attachmentNeedsFetch(att), false);
  assert.equal(attachmentHasFullText(att), false);
  assert.equal(attachmentInlineText(att), 'PREV');
});
