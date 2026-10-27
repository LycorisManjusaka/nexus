/**
 * atomicWrite — the write that cannot leave a half-written file, extracted
 * 2026-10-27 from three private copies (fsStorage, summaryStorage,
 * changelogStorage).
 *
 * NEW TEST. No probe existed. This is the primitive under every log, summary,
 * changelog and soul write in NEXUS, and the guarantee it carries is exactly
 * the kind that stays true-looking when it breaks: a non-atomic write passes
 * every single-writer test and only shows up as a truncated file after a crash.
 *
 * So the cases that matter are the two the guarantee is FOR: the failure path
 * (does the temp file leak, does the error reach the caller) and concurrency
 * (is the destination ever a mix of two writers). Both are exercised for real
 * on disk, in the OS temp directory -- no local_data, so this runs anywhere.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { atomicWriteFile } from '../../src/lib/atomicWrite';

let dir = '';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-atomic-'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Every temp file this module could have left behind, in `d`. */
async function strays(d: string): Promise<string[]> {
  const all = await fs.readdir(d);
  return all.filter((n) => n.includes('.tmp-'));
}

describe('atomicWriteFile', () => {
  it('writes the content', async () => {
    const p = path.join(dir, 'a.txt');
    await atomicWriteFile(p, 'hello');
    assert.equal(await fs.readFile(p, 'utf-8'), 'hello');
  });

  it('replaces existing content in full', async () => {
    const p = path.join(dir, 'b.txt');
    await atomicWriteFile(p, 'a much longer first version of the file');
    await atomicWriteFile(p, 'short');
    // Not "starts with" -- a non-atomic overwrite would leave the tail of the
    // longer version behind, and that file would still parse as text.
    assert.equal(await fs.readFile(p, 'utf-8'), 'short');
  });

  it('leaves no temp file behind on success', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-atomic-ok-'));
    try {
      await atomicWriteFile(path.join(d, 'c.txt'), 'x');
      assert.deepEqual(await strays(d), []);
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('round-trips unicode and newlines byte-for-byte', async () => {
    const p = path.join(dir, 'u.txt');
    const body = '日本語\r\nкириллица\ń\n';
    await atomicWriteFile(p, body);
    assert.equal(await fs.readFile(p, 'utf-8'), body);
  });

  it('FAILURE PATH: the error reaches the caller and no temp file leaks', async () => {
    // Make `rename` fail after `writeFile` succeeded -- the only ordering that
    // exercises the cleanup branch. A directory at the destination does it on
    // both Windows (EPERM/EACCES) and POSIX (EISDIR/ENOTDIR). A fallback that
    // never actually failed would be a claim, not a safety net.
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-atomic-fail-'));
    try {
      const blocked = path.join(d, 'blocked');
      await fs.mkdir(blocked);
      await fs.writeFile(path.join(blocked, 'keep.txt'), 'so it is not empty');

      let threw: unknown = null;
      try {
        await atomicWriteFile(blocked, 'this must not land');
      } catch (e) {
        threw = e;
      }
      assert.ok(threw instanceof Error, 'the original error must reach the caller');
      assert.ok(String((threw as NodeJS.ErrnoException).code || '').length > 0,
        'and it must still be the fs error, with its code -- not a wrapped or swallowed one');

      // The guarantee: the temp file is gone even though the write failed.
      assert.deepEqual(await strays(d), []);
      // And the destination was untouched.
      assert.equal(await fs.readFile(path.join(blocked, 'keep.txt'), 'utf-8'),
        'so it is not empty');
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('ATOMICITY: a concurrent reader never observes a partial file', async () => {
    // THE case this module exists for, and the one the first six cases of this
    // file all missed. p19 replaced the whole body with a single
    // `fs.writeFile(filePath, data)` -- deleting the guarantee -- and the suite
    // stayed green: every other case here is about CONTENT (does the right text
    // land) or CLEANUP (does the temp file go away), and a plain write satisfies
    // both.
    //
    // Atomicity is not a property of the writer. It is a property of what a
    // READER can see while the write is in flight. MEASURED (p22, 8MB bodies,
    // 10 rounds each): the plain write is caught mid-flight in 10/10 rounds
    // (readers observed 2MB, 6.8MB, 7MB of an 8MB file); the atomic write, 0/10.
    //
    // The assertion is deliberately about what the reader saw, NOT about the
    // write succeeding: on Windows a rename onto a file that a reader has open
    // fails with EPERM, measured at 19/20 under a continuous reader. When that
    // happens the reader has simply only ever seen the OLD whole file -- which
    // is still the guarantee holding. Asserting success here would make this
    // case red for a reason that has nothing to do with atomicity.
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-atomic-read-'));
    try {
      const p = path.join(d, 'target.bin');
      const OLD = 'O'.repeat(1024);
      const NEW = 'N'.repeat(8 * 1024 * 1024);
      const whole = new Set([`${OLD.length}:O`, `${NEW.length}:N`]);

      let rounds = 0;
      let reads = 0;
      for (let i = 0; i < 3; i++) {
        await fs.writeFile(p, OLD);
        const seen = new Set<string>();
        let stop = false;
        const reader = (async () => {
          while (!stop) {
            try {
              const b = await fs.readFile(p, 'utf-8');
              seen.add(`${b.length}:${b[0] ?? '-'}`);
            } catch (e) {
              seen.add(`err:${(e as NodeJS.ErrnoException).code}`);
            }
          }
        })();
        try { await atomicWriteFile(p, NEW); } catch { /* EPERM: see above */ }
        stop = true;
        await reader;

        reads += seen.size;
        rounds++;
        const partial = [...seen].filter((k) => !whole.has(k));
        assert.deepEqual(partial, [],
          `a reader saw a non-whole file: ${partial.join(', ')} ` +
          `(whole states are ${[...whole].join(', ')})`);
        // A round where the reader never got a single look proves nothing;
        // say so rather than passing on an empty observation set.
        assert.ok(seen.size > 0, 'the reader observed nothing at all');
      }
      assert.equal(rounds, 3);
      assert.ok(reads >= 3, `too few observations to mean anything: ${reads}`);
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('CONCURRENCY: whole-or-throw, never a mixed file, never a leak', async () => {
    // The actual reason this function exists. Two tabs saving the same
    // conversation, or a save racing a backup. One body must win WHOLE; a
    // plain writeFile can interleave and produce neither.
    //
    // The contract is whole-or-throw -- NOT "concurrent writes all succeed".
    // The first version of this test asserted the stronger thing and was
    // right to fail. MEASURED on this machine (p20_atomic_race.mjs, 25 rounds
    // per width, 200KB bodies, Windows 11 + Defender): a call rejects with
    // EPERM in 6% of 50 calls at 2 writers, 34% of 100 at 4, 47% of 200 at 8.
    // In all 350 calls: MIXED=0, stray temp files=0, rounds with no winner=0.
    // The rate is this machine's, not a bound -- but the three guarantees held
    // in every round, including the ones where a writer lost.
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-atomic-race-'));
    try {
      const p = path.join(d, 'race.json');
      const A = 'A'.repeat(200_000);
      const B = 'B'.repeat(200_000);
      const res = await Promise.allSettled([
        atomicWriteFile(p, A), atomicWriteFile(p, B),
        atomicWriteFile(p, A), atomicWriteFile(p, B),
      ]);

      // 1. somebody won
      assert.ok(res.some((r) => r.status === 'fulfilled'), 'no writer succeeded at all');

      // 2. the destination is one whole body -- the guarantee
      const got = await fs.readFile(p, 'utf-8');
      assert.ok(got === A || got === B,
        `destination is a mix: length ${got.length}, ` +
        `${got.split('').filter((c) => c === 'A').length} A / ` +
        `${got.split('').filter((c) => c === 'B').length} B`);

      // 3. nothing leaked, winners and losers alike
      assert.deepEqual(await strays(d), []);

      // 4. a loser must be able to say WHY -- a rejection that carries no fs
      //    code is indistinguishable from a bug in this module.
      for (const r of res) {
        if (r.status !== 'rejected') continue;
        const code = (r.reason as NodeJS.ErrnoException)?.code;
        assert.ok(typeof code === 'string' && code.length > 0,
          `rejection without an fs code: ${String(r.reason)}`);
      }
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});
