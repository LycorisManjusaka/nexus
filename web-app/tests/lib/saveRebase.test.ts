import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameMessageSpine, planRebase } from '@/lib/saveRebase';

const msg = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, role, content, ...extra });

test('sameMessageSpine: identical arrays match', () => {
  const a = [msg('1', 'user', 'hi'), msg('2', 'assistant', 'hello')];
  const b = [msg('1', 'user', 'hi'), msg('2', 'assistant', 'hello')];
  assert.equal(sameMessageSpine(a, b), true);
});

test('sameMessageSpine: per-message metadata is ignored', () => {
  // This is the case that made the whole fix necessary: a tab mirrors a turn
  // and writes it back WITH token counts the runner never had.
  const mine = [msg('1', 'user', 'hi')];
  const disk = [msg('1', 'user', 'hi', { tokens: 412, textTokens: 400, autoPlay: false })];
  assert.equal(sameMessageSpine(disk, mine), true);
});

test('sameMessageSpine: an appended message does NOT match', () => {
  const mine = [msg('1', 'user', 'hi')];
  const disk = [msg('1', 'user', 'hi'), msg('2', 'user', 'and one more')];
  assert.equal(sameMessageSpine(disk, mine), false);
});

test('sameMessageSpine: edited content does NOT match', () => {
  const mine = [msg('1', 'user', 'hi')];
  const disk = [msg('1', 'user', 'hi, edited')];
  assert.equal(sameMessageSpine(disk, mine), false);
});

test('sameMessageSpine: a deletion does NOT match', () => {
  const mine = [msg('1', 'user', 'hi'), msg('2', 'assistant', 'hello')];
  const disk = [msg('1', 'user', 'hi')];
  assert.equal(sameMessageSpine(disk, mine), false);
});

test('sameMessageSpine: block-array content is compared, not stringified by accident', () => {
  const mine = [msg('1', 'user', [{ type: 'text', text: 'a' }])];
  const same = [msg('1', 'user', [{ type: 'text', text: 'a' }])];
  const diff = [msg('1', 'user', [{ type: 'text', text: 'b' }])];
  assert.equal(sameMessageSpine(same, mine), true);
  assert.equal(sameMessageSpine(diff, mine), false);
});

test('sameMessageSpine: a non-array is never the same spine', () => {
  assert.equal(sameMessageSpine(undefined, []), false);
  assert.equal(sameMessageSpine([], undefined), false);
});

test('planRebase: unchanged disk → retry against the disk version', () => {
  const mine = [msg('1', 'user', 'hi')];
  const plan = planRebase({ updatedAt: 777, messages: [msg('1', 'user', 'hi', { tokens: 9 })] }, mine);
  assert.deepEqual(plan, { retry: true, onto: 777 });
});

test('planRebase: a real second message → no retry, with a reason', () => {
  const mine = [msg('1', 'user', 'hi')];
  const plan = planRebase({ updatedAt: 777, messages: [...mine, msg('2', 'user', 'x')] }, mine);
  assert.equal(plan.retry, false);
  assert.match((plan as { why: string }).why, /changed on disk/);
});

test('planRebase: no fresh log → no retry', () => {
  const plan = planRebase(null, []);
  assert.equal(plan.retry, false);
  assert.match((plan as { why: string }).why, /could not be re-read/);
});

test('planRebase: an unchanged log with no version → no retry, never unguarded', () => {
  // The dangerous shape: content matches, so the rebase is tempting, but there
  // is nothing to guard the retry with. Refusing costs this turn; writing
  // unguarded would cost whatever the other writer just saved.
  const mine = [msg('1', 'user', 'hi')];
  const plan = planRebase({ messages: mine }, mine);
  assert.equal(plan.retry, false);
  assert.match((plan as { why: string }).why, /no version/);
});
