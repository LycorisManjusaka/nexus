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
  composeBatch,
  splitByLease,
  isEmptyTurnText,
  itemIsForThisInstallation,
  LEASE_NAME,
} from '../../src/lib/turnQueue';
import type { QueueItem } from '../../src/lib/turnQueue';

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

/**
 * composeBatch — requirement A/B rendering. Pure; no disk.
 *
 * The first three cases were written from the REQUIREMENT and the failure mode,
 * before reading the body:
 *
 *   "one item is byte-identical to a direct send" — if this ever gains a header
 *       or a label, the stock becomes a second log format for the commonest
 *       path in the product, and no reader of a log can tell which produced it.
 *   "nothing vanishes" — every input is in the text or in `skipped`. A message
 *       lost between the stock and the log is the failure this module exists
 *       to make impossible, and the formatter is inside that path.
 *   "a label is never doubled" — the `[name]` prefix has an owner upstream
 *       (InputArea). Emitting it again is the obvious way to get `[A]\n[A]\n…`.
 */
describe('turnQueue.composeBatch', () => {
  const item = (over: Partial<QueueItem> & { payload: unknown }): QueueItem => ({
    id: over.id || 'id-' + Math.random().toString(36).slice(2),
    at: over.at ?? 1,
    kind: over.kind || 'user_message',
    from: over.from ?? '',
    payload: over.payload,
  });

  it('one item is byte-identical to a direct send — nothing added at all', () => {
    const text = '[トカゲくん]\nhello\n\nsecond paragraph';
    const b = composeBatch([item({ from: 'トカゲくん', payload: { text } })]);
    assert.equal(b.text, text);
    assert.deepEqual(b.attachments, []);
    assert.deepEqual(b.skipped, []);
  });

  it('one item with no identity is still verbatim (no "[]" label appears)', () => {
    const b = composeBatch([item({ from: '', payload: { text: 'bare text' } })]);
    assert.equal(b.text, 'bare text');
    assert.ok(!b.text.includes('['));
  });

  it('nothing vanishes: every input is either rendered or reported', () => {
    const items = [
      item({ id: 'a', from: 'A', payload: { text: 'one' } }),
      item({ id: 'b', kind: 'letter', payload: { subject: 'no text field' } }),
      item({ id: 'c', from: 'C', payload: { text: 'three' } }),
      item({ id: 'd', payload: null }),
    ];
    const b = composeBatch(items);
    const textOf = (i: QueueItem) => (i.payload as { text?: unknown } | null)?.text;
    const rendered = items.filter((i) => typeof textOf(i) === 'string' && b.text.includes(String(textOf(i))));
    const reported = b.skipped.map((s) => s.id).sort();
    assert.deepEqual(reported, ['b', 'd']);
    assert.equal(rendered.length + b.skipped.length, items.length);
    for (const s of b.skipped) assert.ok(s.reason.length > 0, 'a skip must say why');
  });

  it('two items carry sender labels and keep FIFO order', () => {
    const b = composeBatch([
      item({ from: 'A', payload: { text: 'first' } }),
      item({ from: 'B', payload: { text: 'second' } }),
    ]);
    assert.equal(b.text, '[A]\nfirst\n\n[B]\nsecond');
  });

  it('a label is never doubled when the text already carries it', () => {
    const b = composeBatch([
      item({ from: 'トカゲくん', payload: { text: '[トカゲくん]\nfirst' } }),
      item({ from: 'トカゲくん', payload: { text: '[トカゲくん]\nsecond' } }),
    ]);
    assert.equal(b.text, '[トカゲくん]\nfirst\n\n[トカゲくん]\nsecond');
    assert.equal(b.text.match(/\[トカゲくん\]/g)?.length, 2);
  });

  it('an unlabelled item among labelled ones gets its label from `from`', () => {
    const b = composeBatch([
      item({ from: 'トカゲくん', payload: { text: '[トカゲくん]\nfrom the box' } }),
      item({ from: '睡', kind: 'letter', payload: { text: 'a letter body' } }),
    ]);
    assert.equal(b.text, '[トカゲくん]\nfrom the box\n\n[睡]\na letter body');
  });

  it('attachments are concatenated in item order', () => {
    const b = composeBatch([
      item({ from: 'A', payload: { text: 'x', attachments: [{ id: 1 }, { id: 2 }] } }),
      item({ from: 'B', payload: { text: 'y', attachments: [{ id: 3 }] } }),
    ]);
    assert.deepEqual(b.attachments, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  /**
   * CORRECTED EXPECTATION (2026-10-27). This case first asserted that a skipped
   * item's attachments still ride along. The code disagreed, and the code was
   * right: a skipped item is NOT consumed by the caller (it stays in the stock
   * for a kind-aware renderer later), so delivering its bytes now means
   * delivering them AGAIN then. And the report would lie — "1 skipped" while
   * its attachments went through. A skipped item contributes nothing.
   */
  it('a skipped item contributes nothing — not even its attachments', () => {
    const b = composeBatch([item({ kind: 'system', payload: { attachments: [{ id: 9 }] } })]);
    assert.equal(b.text, '');
    assert.deepEqual(b.attachments, []);
    assert.equal(b.skipped.length, 1);
  });

  it('an empty batch is empty, not an error', () => {
    assert.deepEqual(composeBatch([]), { text: '', attachments: [], skipped: [] });
  });
});

/**
 * WRITTEN FROM THE FAILURE MODE, not from the implementation.
 *
 * The measured symptom (つよ, 2026-10-27): the banner said 「ストックに 1 通」
 * for the whole turn that was running that very item, because the only number
 * anyone had was "files on disk" and release happens after the turn resolves.
 * "In flight" and "still waiting" are opposite facts and printed the same.
 *
 * What would be different if claimedIds / splitByLease were absent: a reader
 * could not answer "is my message being worked on?" at all. So the cases that
 * matter are the ones where the two populations COEXIST — a claim holding one
 * item while another arrives behind it — and the one where the information is
 * missing, where the answer must be "I don't know" rather than a guess.
 */
describe('turnQueue: telling in-flight from waiting', () => {
  it('records which ids the claim took', async () => {
    await put('one');
    await put('two');
    const r = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const lease = await readLease(being, CONVO, opts);
    assert.deepEqual(lease?.claimedIds, r.claim.items.map((i) => i.id));
  });

  it('a message arriving mid-turn is WAITING, not in flight', async () => {
    await put('before');
    const r = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(r.ok, true);
    await put('after');

    const items = await pending(being, CONVO, opts);
    const lease = await readLease(being, CONVO, opts);
    const split = splitByLease(items, lease);

    assert.equal(split.claimedUnknown, false);
    assert.deepEqual(texts(split.claimed), ['before']);
    assert.deepEqual(texts(split.waiting), ['after']);
  });

  it('with no lease, everything is waiting and nothing is running', async () => {
    await put('one');
    const items = await pending(being, CONVO, opts);
    const split = splitByLease(items, await readLease(being, CONVO, opts));
    assert.equal(split.claimed.length, 0);
    assert.equal(split.claimedUnknown, false);
    assert.deepEqual(texts(split.waiting), ['one']);
  });

  it('a lease with no id list says "unknown" instead of guessing', async () => {
    // A lease written before claimedIds existed, or whose id write failed.
    await put('one');
    const r = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(r.ok, true);
    const leasePath = path.join(queueDir(being, CONVO, opts), LEASE_NAME);
    const raw = JSON.parse(await fs.readFile(leasePath, 'utf-8'));
    delete raw.claimedIds;
    await fs.writeFile(leasePath, JSON.stringify(raw));

    const items = await pending(being, CONVO, opts);
    const split = splitByLease(items, await readLease(being, CONVO, opts));
    assert.equal(split.claimedUnknown, true);
    assert.equal(split.claimed.length, 0, 'must not guess which item is in flight');
    assert.equal(split.waiting.length, 1);
  });

  /**
   * The auto-drain in ChatArea refuses to re-enter while the stock's SIGNATURE
   * is unchanged, and that signature is built from the waiting items' IDS. So
   * "a failed drain cannot start a loop" rests on abandon putting the items
   * back with the same ids — not merely the same text. The existing abandon
   * case asserts the texts; this asserts the thing the loop guard reads.
   *
   * Half of that argument lives in a React component and is not reachable from
   * this harness. This is the half that is.
   */
  it('abandon restores the same IDS, which is what the loop guard compares', async () => {
    await put('one');
    await put('two');
    const before = (await pending(being, CONVO, opts)).map((i) => i.id);
    const r = await claim(being, CONVO, 'a', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    await abandon(being, CONVO, r.claim.token, opts);
    const after = (await pending(being, CONVO, opts)).map((i) => i.id);
    assert.deepEqual(after, before, 'a changed id would earn a second attempt, and loop');
  });

  it('after release there is no lease, so nothing reads as in flight', async () => {
    await put('one');
    const r = await claim(being, CONVO, 'nexus:3000', opts);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    await release(being, CONVO, r.claim.token, r.claim.items.map((i) => i.id), opts);
    const items = await pending(being, CONVO, opts);
    const split = splitByLease(items, await readLease(being, CONVO, opts));
    assert.deepEqual(split, { claimed: [], waiting: [], claimedUnknown: false });
  });
});

/**
 * isEmptyTurnText — one rule, two ends.
 *
 * The enqueue route refuses a blank send; the runner refuses to POST a blank
 * turn. They look at different inputs and must agree, because the shape of
 * disagreement is silent: an empty user message is a real, billed request with
 * an answer to nothing (REPORTED 2026-11-01).
 */
describe('turnQueue: isEmptyTurnText', () => {
  it('blank text with no files is empty', () => {
    assert.equal(isEmptyTurnText('', []), true);
    assert.equal(isEmptyTurnText('   \n\t ', []), true);
  });

  it('attachments alone are a message', () => {
    assert.equal(isEmptyTurnText('', [{ name: 'a.png' }]), false,
      'an image with no caption is something someone sent');
  });

  it('text alone is a message', () => {
    assert.equal(isEmptyTurnText('hi', []), false);
  });

  it('a missing or non-string field is empty, not a crash', () => {
    assert.equal(isEmptyTurnText(undefined, undefined), true);
    assert.equal(isEmptyTurnText(null, null), true);
    assert.equal(isEmptyTurnText(42, 'not-an-array'), true,
      'composeBatch yields text:"" for a payload like this; it must not be sent');
  });
});

describe('turnQueue: an item can name the installation that runs it', () => {
  /*
   * NOT written from the implementation. Written from the measurement
   * (トカゲくん, 2026-11-02): `C:\dev\nexus\local_data\runner.json` and
   * `C:\dev\nexus-cairn\local_data\runner.json` are THE SAME FILE, because
   * both trees reach one store through a junction. So the store-level host
   * flag can name exactly one of the two installations, and after the merge
   * the other one has runner code and refuses every tick: a message typed
   * into it is stocked and never runs.
   *
   * Each case below says what would be different without it, because the
   * three answers of `itemIsForThisInstallation` fail in three different
   * directions and two of them are silent.
   */

  const ME = 'c:\\dev\\nexus-cairn';
  const THEM = 'c:\\dev\\nexus';

  it('runs an item addressed to me even when I am NOT the host', () => {
    // Without this the field changes nothing at all: the un-named clone still
    // idles, which is the whole symptom.
    assert.equal(itemIsForThisInstallation({ host: ME }, ME, false), true);
  });

  it('refuses an item addressed elsewhere even when I AM the host', () => {
    // Without this the host drains the other clone's stock and answers it
    // with its own code — the exact failure runnerHost.ts's header is about,
    // arriving through the fix for it.
    assert.equal(itemIsForThisInstallation({ host: THEM }, ME, true), false);
  });

  it('gives an un-addressed item to the host, and to nobody else', () => {
    // Both halves matter. The first keeps anything queued before this field
    // existed — and anything no screen produced (a letter, a timer) — running
    // at all. The second stops "whoever polled first" from coming back.
    assert.equal(itemIsForThisInstallation({}, ME, true), true);
    assert.equal(itemIsForThisInstallation({}, ME, false), false);
  });

  it('treats a blank or whitespace host as un-addressed', () => {
    // A route that writes `host: ''` must not produce an item NOTHING can
    // run: '' matches no installation id, so without the trim this item
    // would sit forever on both clones.
    assert.equal(itemIsForThisInstallation({ host: '' }, ME, true), true);
    assert.equal(itemIsForThisInstallation({ host: '   ' }, ME, false), false);
    // ⚠ This third line is the only one that tests the trim, and it was added
    // while DESIGNING the mutation that removes it. Without `isHost: true`,
    // dropping `.trim()` changes nothing either test can see: '   ' is truthy,
    // so the un-trimmed path falls through to `'   ' === selfId` → false, and
    // both lines above expect false anyway. A whitespace host must reach the
    // host, not nobody.
    assert.equal(itemIsForThisInstallation({ host: '   ' }, ME, true), true);
  });

  it('enqueue writes the host only when one is given', () => {
    // The absent key is the backward-compatible shape AND the right shape for
    // an item nobody typed. A `host: ''` on every item would make every one
    // of them un-runnable-by-name while LOOKING addressed.
    return (async () => {
      const a = await enqueue('H', 'c1', { from: '', payload: { text: 'x' }, host: ME }, { beingsDir: root });
      const b = await enqueue('H', 'c1', { from: '', payload: { text: 'y' } }, { beingsDir: root });
      assert.equal(a.item.host, ME);
      assert.equal('host' in b.item, false);
      const onDisk = await pending('H', 'c1', { beingsDir: root });
      assert.equal(onDisk.length, 2);
    })();
  });

  it('pendingWithErrors splits mine from elsewhere, and hides neither', () => {
    // `elsewhere` is reported rather than dropped for the same reason
    // `unreadable` is: three different situations print the same empty list
    // otherwise, and "the other NEXUS has not picked yours up" is the one a
    // person is waiting on.
    return (async () => {
      await enqueue('H', 'c2', { from: '', payload: { text: 'mine' }, host: ME }, { beingsDir: root });
      await enqueue('H', 'c2', { from: '', payload: { text: 'theirs' }, host: THEM }, { beingsDir: root });
      const scan = await pendingWithErrors('H', 'c2', {
        beingsDir: root,
        accept: (it) => itemIsForThisInstallation(it, ME, false),
      });
      assert.equal(scan.items.length, 1);
      assert.equal(scan.elsewhere.length, 1);
      assert.deepEqual((scan.items[0].payload as { text: string }).text, 'mine');
      // Unfiltered still sees both — the filter is per CALL, not a property
      // of the store, because the same files have two right answers.
      const all = await pendingWithErrors('H', 'c2', { beingsDir: root });
      assert.equal(all.items.length, 2);
      assert.equal(all.elsewhere.length, 0);
    })();
  });

  it('claim takes only my items and leaves theirs on disk', () => {
    return (async () => {
      await enqueue('H', 'c3', { from: '', payload: { text: 'mine' }, host: ME }, { beingsDir: root });
      await enqueue('H', 'c3', { from: '', payload: { text: 'theirs' }, host: THEM }, { beingsDir: root });
      const c = await claim('H', 'c3', 'runner:me', {
        beingsDir: root,
        accept: (it) => itemIsForThisInstallation(it, ME, false),
      });
      assert.equal(c.ok, true);
      if (c.ok) {
        assert.equal(c.claim.items.length, 1);
        await release('H', 'c3', c.claim.token, c.claim.items.map((i) => i.id), { beingsDir: root });
      }
      // The other clone's message is untouched — not consumed, not claimed.
      const left = await pending('H', 'c3', { beingsDir: root });
      assert.equal(left.length, 1);
      assert.equal((left[0].payload as { text: string }).text, 'theirs');
    })();
  });

  it('claim reports how many belong elsewhere, and GIVES THE LEASE BACK', () => {
    // The lease is taken before the items are read (deliberate, see `claim`),
    // so an installation that may run none of them holds it for a moment. If
    // it kept the lease, the clone that CAN run them would get `busy` forever
    // — a deadlock produced by the fix for a stall.
    return (async () => {
      await enqueue('H', 'c4', { from: '', payload: { text: 'theirs' }, host: THEM }, { beingsDir: root });
      const c = await claim('H', 'c4', 'runner:me', {
        beingsDir: root,
        accept: (it) => itemIsForThisInstallation(it, ME, false),
      });
      assert.equal(c.ok, false);
      if (!c.ok && c.reason === 'empty') assert.equal(c.elsewhere, 1);
      assert.equal(await readLease('H', 'c4', { beingsDir: root }), null);
      // And the rightful owner can now take it.
      const theirs = await claim('H', 'c4', 'runner:them', {
        beingsDir: root,
        accept: (it) => itemIsForThisInstallation(it, THEM, false),
      });
      assert.equal(theirs.ok, true);
      if (theirs.ok) {
        assert.equal(theirs.claim.items.length, 1);
        await release('H', 'c4', theirs.claim.token, theirs.claim.items.map((i) => i.id), { beingsDir: root });
      }
    })();
  });

  it('distinguishes a genuinely empty stock from one belonging elsewhere', () => {
    // Both are `{ ok: false, reason: 'empty' }`. Only the second one needs a
    // sentence on screen, and `elsewhere: 0` is what lets the caller tell.
    return (async () => {
      const c = await claim('H', 'c5', 'runner:me', {
        beingsDir: root,
        accept: (it) => itemIsForThisInstallation(it, ME, false),
      });
      assert.equal(c.ok, false);
      if (!c.ok && c.reason === 'empty') assert.equal(c.elsewhere, 0);
    })();
  });
});
