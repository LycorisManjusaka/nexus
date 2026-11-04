/**
 * markReturned — why an item is still in the stock (F20, 2026-11-04).
 *
 * NEW TEST; the function did not exist an hour ago.
 *
 * つよ, after the 3000/3001 collision ate a turn: 「なんであたしの失敗した
 * メッセージをスタックに保存してんの？なんで普通にログに出さない？スタック
 * ってさ、そういう役割じゃないっしょ。」
 *
 * Her reading was right about the role and wrong about the cause, and both
 * halves are the bug. The stock is where a message LIVES until the save that
 * answers it lands — consuming it first would mean a refused save deletes the
 * message with nowhere to put it back. So an item that was run and handed back
 * is unclaimed again and sits in the same directory, with the same shape, as
 * one nobody has touched. The mark is the only difference there can be.
 *
 * Its own file rather than more lines in turnQueue.test.ts, for the reason
 * runTurnForQueue's stop/rebase/handoff probes are split: the failure modes
 * below are one subject, and a reader who comes here after a stamp went wrong
 * should not have to walk the whole module to find them.
 *
 * Naming what would look different if each of these were absent:
 *
 *   NOT written from the implementation:
 *     "the file keeps its name" — absent, a stamped item is rewritten under a
 *         fresh `at` and either JUMPS THE QUEUE or falls to the back. FIFO in
 *         this module IS the filename; nothing type-errors, `pending` still
 *         returns every item, and only the order is wrong. A message that came
 *         back has not lost its place in the line.
 *     "a wrong token stamps nothing" — absent, anything that polls can write
 *         "this failed" onto a batch another pass is running right now. That
 *         is the cross-tab warning which outlived its turn (ふわふわ,
 *         2026-10-31), except on disk, where it outlives the tab too.
 *     "an id that is already gone is skipped, not thrown" — absent, the path
 *         where a pass consumed part of a batch and handed back the rest
 *         throws instead of returning — and the caller's very next line is
 *         the one that gives the LEASE back. A lost stamp costs the person one
 *         sentence; a lost lease leaves the conversation permanently
 *         "running".
 *     "a second attempt REPLACES the mark" — absent, the obvious shape is an
 *         array of attempts and the item file quietly becomes a log. What a
 *         person reads is "why is it still here", which is about the last try.
 *     "items queued WHILE the turn ran are left alone" — absent, a batch's
 *         mark lands on messages that arrived after the claim and were never
 *         attempted. This is why it stamps BY ID and not by directory.
 *     "the return time is not the enqueue time" — absent, the panel's
 *         "arrived {time}" starts lying about when the message was sent.
 *
 *   Written from the implementation (they restate it): the happy-path field
 *     values, and the empty-list early return.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { enqueue, pending, claim, abandon, markReturned } from '../../src/lib/turnQueue';

let root = '';
let opts: { beingsDir: string };
const CONVO = 'convo-returned';
const MARK = { at: 1_700_000_000_000, kind: 'save-refused', reason: '409 refused by a newer version' };

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-returned-'));
  opts = { beingsDir: root };
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/* A fresh being per scenario — a shared fixture let a later assertion pass on
   an earlier run's leftovers once already (2026-10-26, the migrate tool). */
let n = 0;
let being = '';
beforeEach(() => {
  being = `ZZ_Returned_${++n}`;
});

describe('markReturned: the mark', () => {
  it('stamps the claimed item and leaves everything else about it alone', async () => {
    await enqueue(being, CONVO, { from: 'つよ', payload: { text: 'one' } }, opts);
    const c = await claim(being, CONVO, 'test', opts);
    assert.equal(c.ok, true);
    if (!c.ok) return;

    const r = await markReturned(being, CONVO, c.claim.token, c.claim.items.map((i) => i.id), MARK, opts);
    assert.deepEqual(r, { ok: true, stamped: 1 });

    const [item] = await pending(being, CONVO, opts);
    assert.deepEqual(item.returned, MARK);
    // The body and the sender label survive a rewrite. The stamp is an
    // addition, not a replacement of the item.
    assert.deepEqual(item.payload, { text: 'one' });
    assert.equal(item.from, 'つよ');
  });

  it('replaces the previous mark rather than accumulating attempts', async () => {
    await enqueue(being, CONVO, { from: 'a', payload: { text: '1' } }, opts);
    const first = await claim(being, CONVO, 'test', opts);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const ids = first.claim.items.map((i) => i.id);
    await markReturned(being, CONVO, first.claim.token, ids, MARK, opts);
    await abandon(being, CONVO, first.claim.token, opts);

    const second = await claim(being, CONVO, 'test', opts);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const later = { at: MARK.at + 5_000, kind: 'failed', reason: 'stream died' };
    await markReturned(being, CONVO, second.claim.token, ids, later, opts);

    const [item] = await pending(being, CONVO, opts);
    assert.deepEqual(item.returned, later);
  });
});

describe('markReturned: a stamped item does not lose its place', () => {
  it('keeps the FIFO order when only the middle item is stamped', async () => {
    await enqueue(being, CONVO, { from: 'a', payload: { text: '1' } }, opts);
    await new Promise((r) => setTimeout(r, 2));
    await enqueue(being, CONVO, { from: 'b', payload: { text: '2' } }, opts);
    await new Promise((r) => setTimeout(r, 2));
    await enqueue(being, CONVO, { from: 'c', payload: { text: '3' } }, opts);

    assert.deepEqual((await pending(being, CONVO, opts)).map((i) => i.from), ['a', 'b', 'c']);

    const c = await claim(being, CONVO, 'test', opts);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    const mid = c.claim.items.find((i) => i.from === 'b');
    assert.ok(mid);
    await markReturned(being, CONVO, c.claim.token, [mid.id], MARK, opts);

    const after = await pending(being, CONVO, opts);
    assert.deepEqual(after.map((i) => i.from), ['a', 'b', 'c']);
    assert.deepEqual(after.map((i) => !!i.returned), [false, true, false]);
  });

  it('does not move the enqueue time onto the return time', async () => {
    await enqueue(being, CONVO, { from: 'a', payload: { text: '1' } }, opts);
    const c = await claim(being, CONVO, 'test', opts);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    const enqueuedAt = c.claim.items[0].at;
    await markReturned(being, CONVO, c.claim.token, [c.claim.items[0].id], MARK, opts);

    const [item] = await pending(being, CONVO, opts);
    assert.equal(item.at, enqueuedAt);
    assert.notEqual(item.at, MARK.at);
    assert.equal(item.returned?.at, MARK.at);
  });
});

describe('markReturned: only the lease holder may write a verdict', () => {
  it('stamps nothing with a token it does not hold', async () => {
    await enqueue(being, CONVO, { from: 'つよ', payload: { text: 'one' } }, opts);
    const c = await claim(being, CONVO, 'test', opts);
    assert.equal(c.ok, true);
    if (!c.ok) return;

    const r = await markReturned(being, CONVO, 'not-the-token', c.claim.items.map((i) => i.id), MARK, opts);
    assert.deepEqual(r, { ok: false, stamped: 0 });
    assert.equal((await pending(being, CONVO, opts))[0].returned, undefined);
  });

  it('stamps nothing when no lease is held at all', async () => {
    await enqueue(being, CONVO, { from: 'つよ', payload: { text: 'one' } }, opts);
    const items = await pending(being, CONVO, opts);
    const r = await markReturned(being, CONVO, 'any', items.map((i) => i.id), MARK, opts);
    assert.deepEqual(r, { ok: false, stamped: 0 });
    assert.equal((await pending(being, CONVO, opts))[0].returned, undefined);
  });
});

describe('markReturned: it never costs the caller its lease', () => {
  it('skips ids that are already gone instead of throwing', async () => {
    // The real shape: a pass consumes the leading run and hands back the rest,
    // or throws having consumed an unknown amount.
    await enqueue(being, CONVO, { from: 'a', payload: { text: '1' } }, opts);
    const c = await claim(being, CONVO, 'test', opts);
    assert.equal(c.ok, true);
    if (!c.ok) return;

    const r = await markReturned(
      being, CONVO, c.claim.token,
      [...c.claim.items.map((i) => i.id), 'an-id-that-was-consumed'],
      MARK, opts,
    );
    assert.deepEqual(r, { ok: true, stamped: 1 });
  });

  it('does nothing, successfully, for an empty id list', async () => {
    const r = await markReturned(being, CONVO, 'any', [], MARK, opts);
    assert.deepEqual(r, { ok: true, stamped: 0 });
  });

  it('does nothing, successfully, when the queue directory never existed', async () => {
    const r = await markReturned(being, 'no-such-convo', 'any', ['some-id'], MARK, opts);
    assert.equal(r.stamped, 0);
  });
});

describe('markReturned: stamping is by id, not by directory', () => {
  it('leaves items queued WHILE the turn ran unmarked', async () => {
    await enqueue(being, CONVO, { from: 'claimed', payload: { text: '1' } }, opts);
    const c = await claim(being, CONVO, 'test', opts);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    // Arrives after the claim, so it was never attempted. Stamping the whole
    // directory would tell its sender their message failed.
    await enqueue(being, CONVO, { from: 'later', payload: { text: '2' } }, opts);

    await markReturned(being, CONVO, c.claim.token, c.claim.items.map((i) => i.id), MARK, opts);

    const items = await pending(being, CONVO, opts);
    assert.equal(items.length, 2);
    assert.ok(items.find((i) => i.from === 'claimed')?.returned);
    assert.equal(items.find((i) => i.from === 'later')?.returned, undefined);
  });
});
