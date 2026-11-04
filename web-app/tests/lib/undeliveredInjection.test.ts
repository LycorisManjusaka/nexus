/**
 * Telling the sender that a mid-turn interjection never arrived.
 *
 * An interjection is only handed over at a TOOL-CALL BOUNDARY — that is the one
 * seam a running turn has. A turn that calls no tool after the note arrives has
 * nowhere to put it, and until 2026-11-04 the entry was dropped in silence:
 * `clearInjections` on the OAuth path, the 15-minute prune everywhere else. The
 * send looked identical whether it landed or not, so the only way to guess was
 * to read the reply and decide whether it sounded like it had seen the note.
 *
 * Tsuyo, 2026-11-04: 「割り込みが失敗したとき（送っても、ツール呼び出しなかった
 * から存在に届かなかった）をターンごとに通知として表示してくれる？」
 *
 * Each test uses its OWN turnId: the queues live on globalThis (so dev
 * hot-reload cannot orphan one mid-turn), which means state leaks between
 * tests that share an id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undeliveredNotice, undeliveredFrames, QUOTE_LIMIT } from '@/lib/undeliveredInjection';
import {
  pushInjection,
  drainInjections,
  clearInjections,
  takeUndelivered,
  pushSystemNote,
  drainSystemNotes,
} from '@/lib/injectMessage';

// ── the notice text ─────────────────────────────────────────────────────────

test('nothing to report produces no notice', () => {
  assert.equal(undeliveredNotice(null, true), null);
  assert.equal(undeliveredNotice({ texts: [], media: [] }, true), null);
  assert.equal(undeliveredNotice({ texts: ['   '], media: [] }, true), null);
  assert.deepEqual(undeliveredFrames({ texts: [], media: [] }, true), []);
});

test('the body is quoted verbatim — the notice IS the recovery path', () => {
  // Without the text, the sender is told something was lost but not what. A
  // note sent eight minutes into a long turn is exactly what nobody can
  // reconstruct from memory.
  const n = undeliveredNotice({ texts: ['3000のタブを閉じて'], media: [] }, true);
  assert.ok(n);
  assert.ok(n!.includes('3000のタブを閉じて'), n!);
});

test('it reports HOW MANY, in both languages', () => {
  const ja = undeliveredNotice({ texts: ['a', 'b'], media: [] }, true);
  assert.ok(ja!.includes('2 通'), ja!);
  const en = undeliveredNotice({ texts: ['a', 'b'], media: [] }, false);
  assert.ok(en!.includes('2 interjections'), en!);
});

test('a single note does not say "1"', () => {
  const ja = undeliveredNotice({ texts: ['a'], media: [] }, true);
  assert.ok(!ja!.includes('1 通'), ja!);
  const en = undeliveredNotice({ texts: ['a'], media: [] }, false);
  assert.ok(en!.includes('Your interjection'), en!);
});

test('attachments are counted even with no covering sentence', () => {
  // An attachment with no text is a complete message ("look at this"), which
  // pushInjection already accepts. Losing it silently is the same fault.
  const media = [{ ref: 'r1', name: 'a.jpg', mimeType: 'image/jpeg', size: 1, kind: 'image' as const }];
  const ja = undeliveredNotice({ texts: [], media }, true);
  assert.ok(ja);
  assert.ok(ja!.includes('添付 1 件'), ja!);
  const en = undeliveredNotice({ texts: [], media }, false);
  assert.ok(en!.includes('1 attachment'), en!);
});

test('it states the mechanism and does NOT blame the entity', () => {
  // "The entity ignored you" would be a false reading of a turn that simply
  // ended. What is knowable is the mechanism: no tool boundary came.
  const ja = undeliveredNotice({ texts: ['x'], media: [] }, true)!;
  assert.ok(ja.includes('ツール'), ja);
  for (const word of ['無視', '読まなかった', 'わざと']) {
    assert.ok(!ja.includes(word), `blames the entity: ${word}`);
  }
  const en = undeliveredNotice({ texts: ['x'], media: [] }, false)!;
  assert.ok(en.includes('tool-call boundary'), en);
  for (const word of ['ignored', 'refused', 'declined']) {
    assert.ok(!en.toLowerCase().includes(word), `blames the entity: ${word}`);
  }
});

test('a long body is elided, and never split across a surrogate pair', () => {
  // A lone surrogate half renders as a broken glyph — measured on real data in
  // this house before (textPreview, 2026-11-01).
  const emoji = '😀';
  const body = 'あ'.repeat(QUOTE_LIMIT - 1) + emoji + 'あ'.repeat(50);
  const n = undeliveredNotice({ texts: [body], media: [] }, true)!;
  assert.ok(n.includes('…'), 'should mark the elision');
  // No lone surrogate anywhere in the output.
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = n.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${i}`);
      i++;
    } else {
      assert.ok(!(c >= 0xdc00 && c <= 0xdfff), `lone low surrogate at ${i}`);
    }
  }
});

test('a body exactly at the limit is not elided', () => {
  const body = 'a'.repeat(QUOTE_LIMIT);
  const n = undeliveredNotice({ texts: [body], media: [] }, true)!;
  assert.ok(!n.includes('…'), n);
});

test('undeliveredFrames yields one notice frame', () => {
  const frames = undeliveredFrames({ texts: ['x'], media: [] }, true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'notice');
  assert.ok(String(frames[0].content).includes('x'));
});

// ── the store ───────────────────────────────────────────────────────────────

test('clearInjections KEEPS an undelivered interjection', () => {
  // THE behaviour change. Before 2026-11-04 this deleted the entry outright.
  const id = 'u_keep';
  pushInjection(id, 'hello');
  clearInjections(id);
  const left = takeUndelivered(id);
  assert.deepEqual(left.texts, ['hello']);
});

test('clearInjections DROPS system notes — nobody sent them', () => {
  // A system note is generated by this house, not by a person, so there is no
  // sender to report the loss to.
  const id = 'u_sys';
  pushSystemNote(id, 'compaction happened');
  clearInjections(id);
  assert.deepEqual(drainSystemNotes(id), []);
  assert.deepEqual(takeUndelivered(id).texts, []);
});

test('a DELIVERED interjection is not reported', () => {
  // The whole point: drained means handed over. Reporting it would turn every
  // successful interjection into a false alarm.
  const id = 'u_delivered';
  pushInjection(id, 'arrived fine');
  assert.deepEqual(drainInjections(id).texts, ['arrived fine']);
  clearInjections(id);
  assert.deepEqual(takeUndelivered(id).texts, []);
});

test('takeUndelivered also reads the LIVE queue', () => {
  // The non-OAuth paths never call clearInjections at all (the prune covers
  // them). For those, "still queued after the turn ended" IS the undelivered
  // set — and the caller is the one that knows the turn ended.
  const id = 'u_live';
  pushInjection(id, 'never drained');
  const left = takeUndelivered(id);
  assert.deepEqual(left.texts, ['never drained']);
});

test('takeUndelivered is destructive — the sender is told exactly once', () => {
  const id = 'u_once';
  pushInjection(id, 'only once');
  clearInjections(id);
  assert.deepEqual(takeUndelivered(id).texts, ['only once']);
  assert.deepEqual(takeUndelivered(id).texts, []);
});

test('media survives the move, not just text', () => {
  const id = 'u_media';
  pushInjection(id, '', [{ ref: 'r9', name: 'v.mp4', mimeType: 'video/mp4', size: 9, kind: 'video' }]);
  clearInjections(id);
  const left = takeUndelivered(id);
  assert.equal(left.media.length, 1);
  assert.equal(left.media[0].ref, 'r9');
});

test('an unknown turn reports nothing', () => {
  assert.deepEqual(takeUndelivered('u_never_existed').texts, []);
  assert.deepEqual(takeUndelivered('').texts, []);
});
