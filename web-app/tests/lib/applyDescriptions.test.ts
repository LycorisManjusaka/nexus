import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDescriptions, describedFields, describesAttachment } from '@/lib/applyDescriptions';

const att = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, isImage: true, ...extra });

const msg = (id: string, attachments: unknown[] = []) =>
  ({ id, role: 'user', content: 'hi', attachments });

const ev = (over: Record<string, unknown> = {}) => ({
  messageId: 'm1',
  attachmentId: 'a1',
  attachmentName: 'shot.jpg',
  description: 'a cairn on a ridge',
  kind: 'eyes',
  model: 'gemini-3.5-flash-lite',
  generatedAt: 1762000000000,
  fromCache: false,
  ...over,
});

// ── The whole point: a description reaches the attachment ───────────────────

test('a description is written onto the attachment it names', () => {
  const msgs = [msg('m1', [att('a1', 'shot.jpg')])];
  const { changed, next } = applyDescriptions(msgs, [ev()]);
  assert.equal(changed, true);
  const a = (next[0].attachments as Record<string, unknown>[])[0];
  assert.equal(a.description, 'a cairn on a ridge');
  assert.equal(a.descriptionKind, 'eyes');
  assert.equal(a.descriptionModel, 'gemini-3.5-flash-lite');
  assert.equal(a.descriptionGeneratedAt, 1762000000000);
  assert.equal(a.descriptionFromCache, false);
  // Untouched fields survive.
  assert.equal(a.isImage, true);
  assert.equal(a.name, 'shot.jpg');
});

test('no payloads returns the SAME array (free when nothing was described)', () => {
  const msgs = [msg('m1', [att('a1', 'shot.jpg')])];
  const r = applyDescriptions(msgs, []);
  assert.equal(r.changed, false);
  assert.equal(r.next, msgs);
});

// ── The line that matters most: a failed bridge stores NO description ───────

test('a failed bridge writes descriptionError and NO description', () => {
  // Storing the placeholder would make one transient 429 permanent: the send
  // path re-uses any non-blank `description` without asking whether it is an
  // error sentence.
  const msgs = [msg('m1', [att('a1', 'shot.jpg')])];
  const { next } = applyDescriptions(msgs, [ev({
    description: '[image — gemini-3.5-flash-lite could not describe it: 429 rate limit]',
    error: '429 rate limit',
  })]);
  const a = (next[0].attachments as Record<string, unknown>[])[0];
  assert.equal(a.description, undefined, 'the placeholder must not be stored');
  assert.equal(a.descriptionError, '429 rate limit');
  // The retry has to stay possible: the send path checks `description`.
  assert.ok(!a.description, 'next turn must be free to call the bridge again');
});

test('a failed bridge does not erase a description from an earlier turn', () => {
  const msgs = [msg('m1', [att('a1', 'shot.jpg', { description: 'from last turn' })])];
  const { next } = applyDescriptions(msgs, [ev({ description: '[image — …]', error: 'timeout' })]);
  const a = (next[0].attachments as Record<string, unknown>[])[0];
  assert.equal(a.description, 'from last turn');
  assert.equal(a.descriptionError, 'timeout');
});

test('a successful retry clears nothing but writes the real text', () => {
  const msgs = [msg('m1', [att('a1', 'shot.jpg')])];
  const { next } = applyDescriptions(msgs, [
    ev({ description: '[image — …]', error: 'timeout' }),
    ev({ description: 'the real description' }),
  ]);
  const a = (next[0].attachments as Record<string, unknown>[])[0];
  assert.equal(a.description, 'the real description');
  assert.equal(a.descriptionError, undefined, 'the stale error must not outlive the success');
});

// ── Matching ────────────────────────────────────────────────────────────────

test('id wins: a same-named attachment does NOT take the description', () => {
  // "image.jpg" is the name EVERY pasted clipboard image gets, so name-matching
  // in the presence of an id would hand one screenshot another's description.
  const msgs = [msg('m1', [att('a1', 'image.jpg'), att('a2', 'image.jpg')])];
  const { next } = applyDescriptions(msgs, [ev({ attachmentId: 'a2', attachmentName: 'image.jpg' })]);
  const [first, second] = next[0].attachments as Record<string, unknown>[];
  assert.equal(first.description, undefined);
  assert.equal(second.description, 'a cairn on a ridge');
});

test('name is the fallback only when the payload carries no id', () => {
  // Logs written before the `id` field exists have attachments with names only.
  const msgs = [msg('m1', [{ name: 'old.png', isImage: true }])];
  const { changed, next } = applyDescriptions(msgs, [ev({ attachmentId: undefined, attachmentName: 'old.png' })]);
  assert.equal(changed, true);
  assert.equal((next[0].attachments as Record<string, unknown>[])[0].description, 'a cairn on a ridge');
});

test('a payload naming neither id nor name matches nothing', () => {
  const msgs = [msg('m1', [att('a1', 'shot.jpg')])];
  const r = applyDescriptions(msgs, [ev({ attachmentId: undefined, attachmentName: undefined })]);
  assert.equal(r.changed, false);
  assert.equal(r.next, msgs);
});

test('describesAttachment: id mismatch is a miss even when the name matches', () => {
  assert.equal(describesAttachment(ev(), { id: 'other', name: 'shot.jpg' }), false);
  assert.equal(describesAttachment(ev(), { id: 'a1', name: 'renamed.jpg' }), true);
});

// ── Scope ───────────────────────────────────────────────────────────────────

test('only the named message is touched', () => {
  const msgs = [
    msg('m0', [att('a0', 'other.jpg')]),
    msg('m1', [att('a1', 'shot.jpg')]),
  ];
  const { next } = applyDescriptions(msgs, [ev()]);
  assert.equal(next[0], msgs[0], 'an unrelated message must be the SAME object');
  assert.notEqual(next[1], msgs[1]);
});

test('a payload for a message that is gone is dropped in silence', () => {
  // A rerun deletes its target: a description for a removed message is not an
  // error, and must not throw or append anything.
  const msgs = [msg('m1', [att('a1', 'shot.jpg')])];
  const r = applyDescriptions(msgs, [ev({ messageId: 'deleted-by-rerun' })]);
  assert.equal(r.changed, false);
  assert.equal(r.next, msgs);
});

test('a message with no attachments array is left alone', () => {
  const msgs = [{ id: 'm1', role: 'assistant', content: 'text only' }];
  const r = applyDescriptions(msgs, [ev()]);
  assert.equal(r.changed, false);
  assert.equal(r.next, msgs);
});

test('payloads for several messages all land', () => {
  const msgs = [
    msg('m1', [att('a1', 'one.jpg')]),
    msg('m2', [att('a2', 'two.jpg')]),
  ];
  const { next } = applyDescriptions(msgs, [
    ev({ messageId: 'm1', attachmentId: 'a1', description: 'first' }),
    ev({ messageId: 'm2', attachmentId: 'a2', description: 'second' }),
  ]);
  assert.equal((next[0].attachments as Record<string, unknown>[])[0].description, 'first');
  assert.equal((next[1].attachments as Record<string, unknown>[])[0].description, 'second');
});

// ── The three bridges ───────────────────────────────────────────────────────

test('ears and watcher store their own kind', () => {
  assert.equal(describedFields(ev({ kind: 'ears' })).descriptionKind, 'ears');
  assert.equal(describedFields(ev({ kind: 'watcher' })).descriptionKind, 'watcher');
});

test('a cached description is marked as cached', () => {
  assert.equal(describedFields(ev({ fromCache: true })).descriptionFromCache, true);
});
