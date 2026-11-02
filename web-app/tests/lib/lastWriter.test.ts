/**
 * lastWriter — who wrote the version that is on disk (phase 4b-5 prereq,
 * 2026-10-28).
 *
 * NEW TEST. No probe existed; this module did not exist an hour ago.
 *
 * Written by naming, for each property, what would look different if it were
 * absent — BEFORE checking whether the code achieves it. The honest split:
 *
 *   NOT written from the implementation (these are the ones worth having):
 *     "an unknown version yields null, never a neighbour's id" — this is the
 *         whole safety direction. If a lookup returned the id of a DIFFERENT
 *         version, the client would adopt a file somebody else wrote and
 *         overwrite their work: exactly the measured failure the concurrency
 *         guard exists to prevent (fsStorage.ts, above the guard). The wrong
 *         answer here is worse than no answer, and nothing on screen would
 *         show it — the save would simply succeed over the top.
 *     "a write with no clientId is not recorded" — absent, a null entry makes
 *         "we do not know who wrote this" indistinguishable from "we know
 *         nobody did". The callers with no tab to name are real: backup
 *         restore, import, duplicate.
 *     "records never cross conversations" — absent, two conversations saved in
 *         the same second could adopt each other's versions. The ids are
 *         timestamps, so collisions are not hypothetical.
 *     "the per-conversation window is bounded and drops the OLDEST" — absent,
 *         a long session grows without limit; dropping the newest instead
 *         would silently stop recognising our own most recent write, which is
 *         the only one that ever matters.
 *     "re-recording the same version replaces the holder" — absent, two saves
 *         landing on one millisecond leave the FIRST one named, and the second
 *         is the one actually on disk.
 *
 *   Written from the implementation (they restate it, and will not catch a bug
 *   that is in it today — they catch tomorrow's change):
 *     the plain round-trip, the reset helper, the size helper.
 *
 * ⚠ Scope NOT covered: this module is memory only, so nothing here measures
 * what a restart does. That is deliberate and stated in the module header —
 * after a restart every answer is null, which is today's behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordWrite,
  whoWrote,
  resetLastWriterForTests,
  lastWriterSizeForTests,
} from '@/lib/lastWriter';

test('lastWriter: round-trip — a recorded version names its writer', () => {
  resetLastWriterForTests();
  recordWrite('c1', 1000, 'tab_aaa');
  assert.equal(whoWrote('c1', 1000), 'tab_aaa');
});

test('lastWriter: an UNKNOWN version yields null, never a neighbour id', () => {
  resetLastWriterForTests();
  recordWrite('c1', 1000, 'tab_aaa');
  recordWrite('c1', 2000, 'tab_bbb');
  // The versions we did record still answer.
  assert.equal(whoWrote('c1', 1000), 'tab_aaa');
  assert.equal(whoWrote('c1', 2000), 'tab_bbb');
  // Anything else must be null — NOT the nearest, newest, or any other id.
  assert.equal(whoWrote('c1', 1500), null);
  assert.equal(whoWrote('c1', 2001), null);
  assert.equal(whoWrote('c1', 999), null);
  assert.equal(whoWrote('c1', 0), null);
});

test('lastWriter: an unseen conversation yields null (fresh restart)', () => {
  resetLastWriterForTests();
  recordWrite('c1', 1000, 'tab_aaa');
  assert.equal(whoWrote('c2', 1000), null);
});

test('lastWriter: records never cross conversations', () => {
  resetLastWriterForTests();
  // Same updatedAt in two conversations — two saves in the same millisecond.
  recordWrite('c1', 5000, 'tab_one');
  recordWrite('c2', 5000, 'tab_two');
  assert.equal(whoWrote('c1', 5000), 'tab_one');
  assert.equal(whoWrote('c2', 5000), 'tab_two');
});

test('lastWriter: a write with NO clientId is not recorded', () => {
  resetLastWriterForTests();
  recordWrite('c1', 1000, undefined);
  recordWrite('c1', 1001, null);
  recordWrite('c1', 1002, '');
  recordWrite('c1', 1003, 42);
  assert.equal(whoWrote('c1', 1000), null);
  assert.equal(whoWrote('c1', 1001), null);
  assert.equal(whoWrote('c1', 1002), null);
  assert.equal(whoWrote('c1', 1003), null);
  // And nothing was stored at all — not even an empty conversation entry that
  // would occupy one of the 64 slots.
  assert.deepEqual(lastWriterSizeForTests(), { convos: 0, records: 0 });
});

test('lastWriter: a malformed updatedAt is not recorded and not looked up', () => {
  resetLastWriterForTests();
  recordWrite('c1', NaN, 'tab_aaa');
  recordWrite('c1', Infinity, 'tab_aaa');
  recordWrite('', 1000, 'tab_aaa');
  assert.deepEqual(lastWriterSizeForTests(), { convos: 0, records: 0 });
  assert.equal(whoWrote('c1', NaN), null);
  assert.equal(whoWrote('c1', '1000' as unknown as number), null);
  assert.equal(whoWrote('', 1000), null);
});

test('lastWriter: re-recording one version REPLACES the holder', () => {
  resetLastWriterForTests();
  recordWrite('c1', 7000, 'tab_first');
  recordWrite('c1', 7000, 'tab_second');
  assert.equal(whoWrote('c1', 7000), 'tab_second');
  // Replacement, not an append: the window is not consumed twice.
  assert.deepEqual(lastWriterSizeForTests(), { convos: 1, records: 1 });
});

test('lastWriter: the per-conversation window is bounded, dropping the OLDEST', () => {
  resetLastWriterForTests();
  // 20 versions into a 16-slot window.
  for (let i = 1; i <= 20; i++) recordWrite('c1', i, `tab_${i}`);
  const size = lastWriterSizeForTests();
  assert.equal(size.convos, 1);
  assert.equal(size.records, 16);
  // The four oldest are gone...
  assert.equal(whoWrote('c1', 1), null);
  assert.equal(whoWrote('c1', 4), null);
  // ...and the recent tail — the only part that can be the disk head — is kept.
  assert.equal(whoWrote('c1', 5), 'tab_5');
  assert.equal(whoWrote('c1', 20), 'tab_20');
});

test('lastWriter: the conversation map is bounded too', () => {
  resetLastWriterForTests();
  for (let i = 1; i <= 70; i++) recordWrite(`c${i}`, 1000, `tab_${i}`);
  const size = lastWriterSizeForTests();
  assert.ok(size.convos <= 64, `convos ${size.convos} should not exceed 64`);
  // The newest conversation is still answerable; an early one has been evicted.
  assert.equal(whoWrote('c70', 1000), 'tab_70');
  assert.equal(whoWrote('c1', 1000), null);
});

test('lastWriter: a runner id is just another clientId', () => {
  resetLastWriterForTests();
  // Phase 4b: the runner saves under its own id, and a tab asking "was that
  // me?" must get a truthful NO rather than a null that reads as "unknown".
  recordWrite('c1', 9000, 'runner:c:\\dev\\nexus');
  assert.equal(whoWrote('c1', 9000), 'runner:c:\\dev\\nexus');
  assert.notEqual(whoWrote('c1', 9000), 'tab_aaa');
});
