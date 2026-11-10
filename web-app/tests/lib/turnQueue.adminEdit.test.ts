/**
 * removePendingItem / editPendingItem — the admin's two hands on a WAITING
 * item (2026-11-10, つよ).
 *
 * NEW FUNCTIONS; neither existed before today.
 *
 * つよ: 「このメッセージさぁ、今はさぁ、『ある』ってわかるだけじゃん。でもさぁ、
 * 全然中身ってさぁ、見えないし、削除も編集もできないっしょ？」 and, for why a
 * hand is needed at all: 「そもそも壊れたらどうすんのよ？」
 *
 * A `discard` button lived in this module for one day (2026-11-01 → 11-02) and
 * was withdrawn, so the first question about these is "is that coming back".
 * It is not: discard was for a FAILED turn's leftovers, a case that no longer
 * reaches the panel at all. These are for a healthy item that has been typed,
 * queued, and not yet run — which withdrawing discard left with no exit from
 * any screen.
 *
 * Naming what would look different if each of these were absent:
 *
 *   NOT written from the implementation:
 *     "a CLAIMED item is refused" — absent, deleting one erases a message the
 *         running turn already read into memory: the answer arrives, the item
 *         is gone, and nothing anywhere says why. Editing one is worse than
 *         that — the turn answers the OLD text while the screen shows the new
 *         one, and both look correct. This is the whole reason the guard
 *         exists, and nothing type-errors without it.
 *     "a lease with NO claimedIds refuses everything" — absent, the code
 *         falls back to "no lease ⇒ all waiting" and deletes a message that
 *         may be in flight. `splitByLease` already reports this case instead
 *         of guessing (its own header says a guess there would tell someone
 *         their message is in flight when it is the one still waiting); here
 *         the same guess DELETES it.
 *     "the file keeps its name after an edit" — absent, a corrected message is
 *         rewritten under a fresh `at` and jumps the queue or falls to the
 *         back. FIFO in this module IS the filename. Same failure markReturned
 *         is guarded against, by the same mechanism, for a different writer.
 *     "attachments survive an edit" — absent, fixing a typo silently deletes
 *         an image. A hand that exists to prevent loss must not be the loss.
 *     "an edit cannot empty a message" — absent, the stock holds an item the
 *         runner will refuse to send (isEmptyTurnText) or, worse, will send as
 *         a real billed turn answering nothing. The route and the runner share
 *         that one rule; an edit that skipped it would be the third opinion.
 *     "a command is refused by KIND" — absent, `payload.text` is written onto
 *         a rerun, producing an item that is neither a command nor a message:
 *         `composeBatch` would then render it as text and the rerun it was
 *         pointing at never happens.
 *     "removing one leaves its neighbours alone" — absent, the scan matches on
 *         a prefix or the wrong slice offset and takes a sibling with it. The
 *         id is recovered from the filename at a fixed offset in this module
 *         and that offset has bitten it before.
 *     "an item addressed ELSEWHERE can still be removed" — absent, the one
 *         item nobody here will ever run is also the one nobody here can
 *         delete, which is the exact symptom addressing was invented to fix.
 *
 *   Written from the implementation (they restate it): the happy-path return
 *     shape, and `not-found` for an unknown id.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  enqueue, pending, claim, abandon, queueDir,
  removePendingItem, editPendingItem,
} from '../../src/lib/turnQueue';

let root = '';
let opts: { beingsDir: string };
const BEING = 'TestBeing';
const CONVO = 'convo-admin-edit';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-adminedit-'));
  opts = { beingsDir: root };
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(queueDir(BEING, CONVO, opts), { recursive: true, force: true });
});

const addMsg = (text: string, attachments?: unknown[]) =>
  enqueue(BEING, CONVO, {
    kind: 'user_message',
    from: 'つよ',
    payload: { text, ...(attachments ? { attachments } : {}) },
  }, opts);

const textOf = (p: unknown) => (p as { text?: string }).text;
const filesIn = async () =>
  (await fs.readdir(queueDir(BEING, CONVO, opts))).filter((n) => n.endsWith('.json')).sort();

describe('turnQueue — admin edit/remove of waiting items', () => {
  it('removes exactly one item and leaves its neighbours', async () => {
    const a = await addMsg('first');
    const b = await addMsg('second');
    const c = await addMsg('third');

    const r = await removePendingItem(BEING, CONVO, b.item.id, opts);
    assert.deepEqual(r, { ok: true });

    const left = await pending(BEING, CONVO, opts);
    assert.deepEqual(left.map((i) => i.id), [a.item.id, c.item.id]);
    // FIFO is the filename, so the survivors must also still be in order.
    assert.deepEqual(left.map((i) => textOf(i.payload)), ['first', 'third']);
  });

  it('reports not-found for an id that is not here', async () => {
    await addMsg('only');
    const r = await removePendingItem(BEING, CONVO, 'no-such-id', opts);
    assert.deepEqual(r, { ok: false, reason: 'not-found' });
    assert.equal((await pending(BEING, CONVO, opts)).length, 1);
  });

  it('edits the text and KEEPS the file name (FIFO is the name)', async () => {
    const a = await addMsg('typo heer');
    await addMsg('after');
    const namesBefore = await filesIn();

    const r = await editPendingItem(BEING, CONVO, a.item.id, 'typo here', opts);
    assert.deepEqual(r, { ok: true });

    assert.deepEqual(await filesIn(), namesBefore, 'the edited file was renamed');
    const items = await pending(BEING, CONVO, opts);
    assert.deepEqual(items.map((i) => textOf(i.payload)), ['typo here', 'after']);
    // `at` is what the name encodes; a changed stamp with an unchanged name
    // would make the two disagree, and the panel reads `at`.
    assert.equal(items[0].at, a.item.at);
  });

  it('keeps attachments through an edit', async () => {
    const a = await addMsg('look', [{ name: 'x.png', data: 'AAAA' }]);
    await editPendingItem(BEING, CONVO, a.item.id, 'look at this', opts);
    const [item] = await pending(BEING, CONVO, opts);
    const p = item.payload as { text: string; attachments: unknown[] };
    assert.equal(p.text, 'look at this');
    assert.deepEqual(p.attachments, [{ name: 'x.png', data: 'AAAA' }]);
  });

  it('refuses an edit that would empty the message', async () => {
    const a = await addMsg('something');
    const r = await editPendingItem(BEING, CONVO, a.item.id, '   ', opts);
    assert.deepEqual(r, { ok: false, reason: 'empty' });
    assert.equal(textOf((await pending(BEING, CONVO, opts))[0].payload), 'something');
  });

  it('allows an edit to blank TEXT when attachments remain', async () => {
    // The shared emptiness rule says an image with no caption IS a message,
    // so this must be accepted for the same reason the enqueue route accepts
    // it. Stricter here would mean the stock can hold something that could
    // not be sent, and could not be turned back into it.
    const a = await addMsg('caption', [{ name: 'x.png' }]);
    const r = await editPendingItem(BEING, CONVO, a.item.id, '', opts);
    assert.deepEqual(r, { ok: true });
  });

  it('refuses to edit a command by KIND, not by payload shape', async () => {
    const c = await enqueue(BEING, CONVO, {
      kind: 'rerun', from: 'つよ', payload: { targetMsgId: 'm1' },
    }, opts);
    const r = await editPendingItem(BEING, CONVO, c.item.id, 'hello', opts);
    assert.deepEqual(r, { ok: false, reason: 'unsupported-kind' });
    const [item] = await pending(BEING, CONVO, opts);
    assert.deepEqual(item.payload, { targetMsgId: 'm1' });
  });

  it('removing a command IS allowed — it has no body, but it can be wrong', async () => {
    const c = await enqueue(BEING, CONVO, {
      kind: 'rerun', from: 'つよ', payload: { targetMsgId: 'm1' },
    }, opts);
    assert.deepEqual(await removePendingItem(BEING, CONVO, c.item.id, opts), { ok: true });
    assert.equal((await pending(BEING, CONVO, opts)).length, 0);
  });

  it('refuses BOTH hands on a claimed item, and allows them on one queued after', async () => {
    const claimed = await addMsg('being answered right now');
    const c = await claim(BEING, CONVO, 'test', opts);
    assert.equal(c.ok, true);
    // Arrives DURING the turn, so it is a different file and was never claimed.
    const later = await addMsg('arrived during the turn');

    assert.deepEqual(
      await removePendingItem(BEING, CONVO, claimed.item.id, opts),
      { ok: false, reason: 'claimed' }
    );
    assert.deepEqual(
      await editPendingItem(BEING, CONVO, claimed.item.id, 'changed', opts),
      { ok: false, reason: 'claimed' }
    );
    // The claimed item is untouched — text AND presence.
    const all = await pending(BEING, CONVO, opts);
    assert.equal(all.length, 2);
    assert.equal(textOf(all[0].payload), 'being answered right now');

    assert.deepEqual(await removePendingItem(BEING, CONVO, later.item.id, opts), { ok: true });
    assert.equal((await pending(BEING, CONVO, opts)).length, 1);

    if (c.ok) await abandon(BEING, CONVO, c.claim.token, opts);
  });

  it('refuses EVERYTHING when the lease does not say which ids it took', async () => {
    const a = await addMsg('maybe running, maybe not');
    const c = await claim(BEING, CONVO, 'test', opts);
    assert.equal(c.ok, true);

    // A lease written before `claimedIds` existed, or whose id write failed.
    // Reproduced by stripping the field rather than by mocking: the shape on
    // disk is the thing being defended against.
    const leasePath = path.join(queueDir(BEING, CONVO, opts), '.lease');
    const lease = JSON.parse(await fs.readFile(leasePath, 'utf-8'));
    delete lease.claimedIds;
    await fs.writeFile(leasePath, JSON.stringify(lease));

    assert.deepEqual(
      await removePendingItem(BEING, CONVO, a.item.id, opts),
      { ok: false, reason: 'claimed-unknown' }
    );
    assert.deepEqual(
      await editPendingItem(BEING, CONVO, a.item.id, 'changed', opts),
      { ok: false, reason: 'claimed-unknown' }
    );
    assert.equal((await pending(BEING, CONVO, opts)).length, 1);

    if (c.ok) await abandon(BEING, CONVO, c.claim.token, opts);
  });

  it('can remove an item addressed to a DIFFERENT installation', async () => {
    // Nothing here will ever run it (itemIsForThisInstallation), which makes
    // it the item most in need of a delete button — so the guard must not
    // narrow by `accept` the way the panel's counts do.
    const other = await enqueue(BEING, CONVO, {
      kind: 'user_message', from: 'つよ',
      payload: { text: 'for the other clone' },
      host: 'C:\\dev\\somewhere-else',
    }, opts);
    assert.deepEqual(await removePendingItem(BEING, CONVO, other.item.id, opts), { ok: true });
    assert.equal((await pending(BEING, CONVO, opts)).length, 0);
  });
});
