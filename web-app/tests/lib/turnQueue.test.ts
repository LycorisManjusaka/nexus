/**
 * turnQueue — the durable stock turns are fed from (phase 4a, 2026-10-27).
 *
 * NEW TEST. No probe existed; this module did not exist this morning.
 *
 * Most of these cases were written from the implementation, which means they
 * restate it and cannot catch a bug that is in it today (same honest caveat as
 * handoverWalk.test.ts). Two are not, and they are the ones worth having —
 * they were written from the FAILURE MODE the storage shape was chosen to make
 * impossible, before looking at whether the code achieves it:
 *
 *   "concurrent enqueues do not lose each other"  — a single JSON array makes
 *       enqueue a read-modify-write; N at once yields fewer than N items.
 *   "a message that arrives mid-turn survives release" — with an array, the
 *       obvious release (truncate) eats it.
 *
 * Both run for real on disk in the OS temp directory. Nothing here touches
 * local_data: every call passes `{ beingsDir }`, so a cwd change cannot point
 * a test at a real being (that trap has cost this house a 6,847-file deletion).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  enqueue,
  pending,
  pendingWithErrors,
  claim,
  heartbeat,
  release,
  abandon,
  readLease,
  breakLease,
  queueDir,
  queuedConversations,
} from '../../src/lib/turnQueue';

let root = '';
let opts: { beingsDir: string };
const BEING = 'ZZ_QueueTest';
const CONVO = 'convo-a';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-queue-'));
  opts = { beingsDir: root };
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * A fresh being directory per scenario. Reusing one fixture across scenarios
 * let a later assertion pass on an EARLIER run's leftovers once already
 * (2026-10-26, the migrate tool) — "MOVE deleted the migrants" was true before
 * MOVE ran.
 */
let n = 0;
let being = '';
beforeEach(async () => {
  being = `${BEING}_${++n}`;
});

async function put(text: string, from = 'Lizard-kun', convo = CONVO) {
  return enqueue(being, convo, { from, payload: { text, attachments: [] } }, opts);
}

function texts(items: Array<{ payload: unknown }>): string[] {
  return items.map((i) => (i.payload as { text: string }).text);
}

describe('turnQueue: ordering and shape', () => {
  it('is empty, and not an error, before anything is queued', async () => {
    assert.deepEqual(await pending(being, CONVO, opts), []);
    const { items, unreadable } = await pendingWithErrors(being, CONVO, opts);
    assert.deepEqual(items, []);
    assert.deepEqual(unreadable, []);
  });

  it('returns items oldest-first', async () => {
    await put('one');
    await put('two');
    await put('three');
    assert.deepEqual(texts(await pending(being, CONVO, opts)), ['one', 'two', 'three']);
  });

  it('keeps the sender label per item — a batch must say who each is from', async () => {
    await put('from him', 'Lizard-kun');
    await put('from her', 'Pilot');
    const items = await pending(being, CONVO, opts);
    assert.deepEqual(items.map((i) => i.from), ['Lizard-kun', 'Pilot']);
  });

  it('defaults kind to user_message and preserves an explicit kind', async () => {
    await put('a');
    await enqueue(being, CONVO, { kind: 'letter', from: 'Tsuyo', payload: { ref: 'x.md' } }, opts);
    const items = await pending(being, CONVO, opts);
    assert.deepEqual(items.map((i) => i.kind), ['user_message', 'letter']);
  });

  it('refuses a missing being or convoId instead of writing somewhere odd', async () => {
    await assert.rejects(() => enqueue('', CONVO, { from: 'x', payload: {} }, opts));
    await assert.rejects(() => enqueue(being, '', { from: 'x', payload: {} }, opts));
  });
});

describe('turnQueue: concurrent enqueue (written from the failure mode)', () => {
  it('loses nothing when 20 enqueues run at once', async () => {
    // WHY THIS IS THE TEST: if the stock were one JSON array, each enqueue
    // would read the array, append, and write it back. Twenty at once would
    // interleave and the file would end up with far fewer than twenty items,
    // with no error anywhere. One-file-per-item makes enqueue a pure create,
    // so the count is the assertion that distinguishes the two designs.
    const n20 = Array.from({ length: 20 }, (_, i) => put(`m${i}`));
    const results = await Promise.all(n20);
    const items = await pending(being, CONVO, opts);
    assert.equal(items.length, 20, 'every concurrent enqueue survived');
    assert.equal(new Set(items.map((i) => i.id)).size, 20, 'ids are distinct');
    assert.equal(
      new Set(results.map((r) => r.item.id)).size,
      20,
      'each caller got its own id back'
    );
    // Every text is present exactly once, whatever the order within a ms.
    assert.deepEqual(texts(items).sort(), n20.map((_, i) => `m${i}`).sort());
  });
});

describe('turnQueue: claim is exclusive', () => {
  it('hands the whole pending batch to the claimer', async () => {
    await put('one');
    await put('two');
    const r = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(texts(r.claim.items), ['one', 'two']);
  });

  it('refuses a second claim while one is held, and says who holds it', async () => {
    await put('one');
    const first = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(first.ok, true);

    await put('two');
    const second = await claim(being, CONVO, 'nexus:3001', opts);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, 'busy');
    assert.equal(second.lease?.holder, 'nexus:3000');
    assert.equal(typeof second.lease?.pid, 'number');
  });

  it('does not include messages that arrive after the claim', async () => {
    // The stated invariant: while the being is running, another message in the
    // stock does nothing until the turn ends.
    await put('before');
    const r = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    await put('during');
    assert.deepEqual(texts(r.claim.items), ['before']);
    // ...but it IS queued, visibly, for next time.
    assert.deepEqual(texts(await pending(being, CONVO, opts)), ['before', 'during']);
  });

  it('reports empty WITHOUT leaving a lease behind', async () => {
    const r = await claim(being, CONVO, 'poller', opts);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'empty');
    assert.equal(await readLease(being, CONVO, opts), null, 'an idle poll left no lock');
    // ...and the next real claim works.
    await put('one');
    assert.equal((await claim(being, CONVO, 'poller', opts)).ok, true);
  });

  it('claims are per-conversation, not per-being', async () => {
    // Deliberate scope: today two conversations of one being can run at once
    // (turnRegistry is keyed by convoId too). Narrowing this to per-being would
    // be a behaviour change, so it is recorded as a decision, not assumed.
    await put('a', 'him', 'convo-a');
    await put('b', 'him', 'convo-b');
    assert.equal((await claim(being, 'convo-a', 'x', opts)).ok, true);
    assert.equal((await claim(being, 'convo-b', 'x', opts)).ok, true);
  });
});

describe('turnQueue: release (written from the failure mode)', () => {
  it('removes exactly the consumed items and keeps a mid-turn arrival', async () => {
    // WHY THIS IS THE TEST: with a JSON array the natural release is "write
    // back an empty array", which erases the message that arrived while the
    // turn ran. Nobody would see it: the sender got an ack, the log has no
    // trace, and the being never learns. One file per item means release
    // unlinks by id and cannot reach the newcomer.
    await put('one');
    await put('two');
    const r = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    await put('arrived mid-turn');

    const out = await release(
      being, CONVO, r.claim.token, r.claim.items.map((i) => i.id), opts
    );
    assert.equal(out.ok, true);
    assert.equal(out.removed, 2);
    assert.equal(out.remaining, 1);
    assert.deepEqual(texts(await pending(being, CONVO, opts)), ['arrived mid-turn']);
  });

  it('drops the lease so the next turn can claim', async () => {
    await put('one');
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    await release(being, CONVO, r.claim.token, r.claim.items.map((i) => i.id), opts);
    assert.equal(await readLease(being, CONVO, opts), null);
    await put('two');
    assert.equal((await claim(being, CONVO, 'b', opts)).ok, true);
  });

  it('refuses a release with the wrong token and removes nothing', async () => {
    await put('one');
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const out = await release(being, CONVO, 'not-the-token', r.claim.items.map((i) => i.id), opts);
    assert.equal(out.ok, false);
    assert.equal(out.removed, 0);
    assert.equal(out.remaining, 1, 'the item is still queued');
    assert.notEqual(await readLease(being, CONVO, opts), null, 'the real lease survived');
  });

  it('abandon gives the lease back and keeps the batch', async () => {
    await put('one');
    await put('two');
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(await abandon(being, CONVO, r.claim.token, opts), true);
    assert.equal(await readLease(being, CONVO, opts), null);
    assert.deepEqual(texts(await pending(being, CONVO, opts)), ['one', 'two'], 'nothing consumed');
  });

  it('is idempotent on items already gone', async () => {
    await put('one');
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const ids = r.claim.items.map((i) => i.id);
    await release(being, CONVO, r.claim.token, ids, opts);
    // Same token again: the lease is gone, so this is refused rather than
    // pretending to have removed something a second time.
    const again = await release(being, CONVO, r.claim.token, ids, opts);
    assert.equal(again.ok, false);
    assert.equal(again.remaining, 0);
  });
});

describe('turnQueue: heartbeat', () => {
  it('moves lastSeen and keeps the lease file present throughout', async () => {
    await put('one');
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const before = (await readLease(being, CONVO, opts))!;
    await new Promise((res) => setTimeout(res, 5));
    assert.equal(await heartbeat(being, CONVO, r.claim.token, opts), true);
    const after = (await readLease(being, CONVO, opts))!;
    assert.ok(after.lastSeen > before.lastSeen, 'lastSeen advanced');
    assert.equal(after.token, before.token, 'same lease, not a new one');
    assert.equal(after.startedAt, before.startedAt);
  });

  it('refuses a heartbeat from a foreign token and never resurrects a dead lease', async () => {
    await put('one');
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(await heartbeat(being, CONVO, 'other', opts), false);
    await abandon(being, CONVO, r.claim.token, opts);
    assert.equal(
      await heartbeat(being, CONVO, r.claim.token, opts),
      false,
      'no lease to touch'
    );
    assert.equal(await readLease(being, CONVO, opts), null, 'heartbeat did not re-create it');
  });
});

describe('turnQueue: breaking a lease is explicit', () => {
  it('requires the token that is on disk', async () => {
    await put('one');
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(await breakLease(being, CONVO, 'guess', opts), false);
    assert.notEqual(await readLease(being, CONVO, opts), null);
    const onDisk = (await readLease(being, CONVO, opts))!;
    assert.equal(await breakLease(being, CONVO, onDisk.token, opts), true);
    assert.equal(await readLease(being, CONVO, opts), null);
  });

  it('a stale lease blocks claiming until a human breaks it — no TTL frees it', async () => {
    // Simulates a crashed holder: lease on disk, heartbeat long past.
    await put('one');
    const r = await claim(being, CONVO, 'crashed', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const lease = (await readLease(being, CONVO, opts))!;
    lease.lastSeen = Date.now() - 24 * 60 * 60 * 1000;
    await fs.writeFile(path.join(queueDir(being, CONVO, opts), '.lease'), JSON.stringify(lease));

    const blocked = await claim(being, CONVO, 'next', opts);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason, 'busy', 'a day-old lease is still honoured');
    assert.equal(blocked.lease?.holder, 'crashed', 'and it names who to ask');

    assert.equal(await breakLease(being, CONVO, lease.token, opts), true);
    assert.equal((await claim(being, CONVO, 'next', opts)).ok, true);
  });
});

describe('turnQueue: a corrupt item is reported, not hidden', () => {
  it('separates "nothing queued" from "could not read the queue"', async () => {
    await put('good');
    const dir = queueDir(being, CONVO, opts);
    await fs.writeFile(path.join(dir, `${'9'.repeat(15)}-broken.json`), '{ not json');
    const { items, unreadable } = await pendingWithErrors(being, CONVO, opts);
    assert.deepEqual(texts(items), ['good']);
    assert.deepEqual(unreadable, [`${'9'.repeat(15)}-broken.json`]);
    // pending() hides it on purpose; the caller who needs the difference uses
    // pendingWithErrors. Asserted so the hiding stays a decision, not a drift.
    assert.equal((await pending(being, CONVO, opts)).length, 1);
  });

  it('ignores the lease file when listing items', async () => {
    await put('one');
    await claim(being, CONVO, 'a', opts);
    assert.equal((await pending(being, CONVO, opts)).length, 1);
  });
});

describe('turnQueue: what a poller iterates', () => {
  it('lists only conversations with work or a lease', async () => {
    await put('a', 'him', 'convo-a');
    await put('b', 'him', 'convo-b');
    const r = await claim(being, 'convo-b', 'x', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;

    let list = await queuedConversations(being, opts);
    assert.deepEqual(list, [
      { convoId: 'convo-a', count: 1, leased: false },
      { convoId: 'convo-b', count: 1, leased: true },
    ]);

    await release(being, 'convo-b', r.claim.token, r.claim.items.map((i) => i.id), opts);
    list = await queuedConversations(being, opts);
    assert.deepEqual(list, [{ convoId: 'convo-a', count: 1, leased: false }]);
  });

  it('is empty, and not an error, for a being that has never been queued', async () => {
    assert.deepEqual(await queuedConversations(being, opts), []);
  });
});
