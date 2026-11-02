/**
 * runnerHost — which installation may run server-side turns (phase 4b-2 prereq,
 * 2026-10-28).
 *
 * NEW TEST. No probe existed; this module did not exist an hour ago.
 *
 * Written by naming, for each property, what would look different if it were
 * absent — BEFORE checking whether the code achieves it. The honest split:
 *
 *   NOT written from the implementation (these are the ones worth having):
 *     "absent file means nobody hosts" — absent, a fresh checkout has BOTH
 *         installations claiming the role, so the race this module exists to
 *         prevent becomes the shipped default. Invisible: both run, the lease
 *         serialises them, and which code ran is unknowable afterwards.
 *     "a file naming another installation yields not-host" — absent, the flag
 *         is decorative and the first poller wins, which changes on restart.
 *     "a corrupt file does not read as host" — absent, a half-written or
 *         hand-edited flag re-opens the race. This one has a direction: the
 *         WRONG failure is falling back to 'host', not to 'unset'.
 *     "clear reports whether anything was removed" — absent, `rm -f` on a
 *         missing path succeeds and we report "cleared" for a no-op; this
 *         house calls that a claim that is not an artifact.
 *
 *   Written from the implementation (they restate it, and will not catch a bug
 *   that is in it today — they catch tomorrow's change):
 *     the round-trip, the note/setAt passthrough, the path-normalisation cases.
 *
 * ⚠ Scope NOT covered: `installationId()` resolves against the real process
 * cwd and the real filesystem. It is exercised once below only for its shape
 * (a non-empty normalised string), not for its value — asserting a value would
 * be asserting where the test runner happens to live.
 *
 * Nothing here touches local_data: every case gets a fresh os.tmpdir() dir.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  RUNNER_HOST_FILE,
  normaliseInstallPath,
  installationId,
  runnerHostPath,
  readRunnerHost,
  runnerHostStatus,
  describeRunnerHost,
  setRunnerHost,
  clearRunnerHost,
  claimRunnerHostIfUnset,
} from '@/lib/runnerHost';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-runnerhost-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const SELF = 'C:\\dev\\nexus';
const OTHER = 'C:\\dev\\nexus-cairn';

describe('runnerHost: the default is that nobody hosts', () => {
  it('reports unset when no file exists', async () => {
    assert.equal(await runnerHostStatus(SELF, dir), 'unset');
    assert.equal(await runnerHostStatus(OTHER, dir), 'unset');
  });

  it('reports unset for BOTH installations — neither may claim the role', async () => {
    // The point of the whole module: on a fresh store, no installation is the
    // host. If either of these said 'host', two runners would poll one store.
    const a = await runnerHostStatus(SELF, dir);
    const b = await runnerHostStatus(OTHER, dir);
    assert.equal(a, 'unset');
    assert.equal(b, 'unset');
    assert.notEqual(a, 'host');
    assert.notEqual(b, 'host');
  });

  it('readRunnerHost returns null rather than throwing for a missing file', async () => {
    assert.equal(await readRunnerHost(dir), null);
  });
});

describe('runnerHost: naming a host', () => {
  it('round-trips, and only the named installation is the host', async () => {
    await setRunnerHost(SELF, { dataDir: dir });
    assert.equal(await runnerHostStatus(SELF, dir), 'host');
    assert.equal(await runnerHostStatus(OTHER, dir), 'not-host');
  });

  it('a file naming the other installation keeps this one idle', async () => {
    await setRunnerHost(OTHER, { dataDir: dir });
    assert.equal(await runnerHostStatus(SELF, dir), 'not-host');
  });

  it('keeps note and setAt, and never interprets them', async () => {
    const rec = await setRunnerHost(SELF, { dataDir: dir, note: 'dev tree', now: '2026-10-28T00:00:00.000Z' });
    assert.equal(rec.note, 'dev tree');
    assert.equal(rec.setAt, '2026-10-28T00:00:00.000Z');
    const back = await readRunnerHost(dir);
    assert.equal(back?.note, 'dev tree');
    assert.equal(back?.setAt, '2026-10-28T00:00:00.000Z');
    // A note that said "not the host" must not change the answer.
    await setRunnerHost(SELF, { dataDir: dir, note: 'not the host' });
    assert.equal(await runnerHostStatus(SELF, dir), 'host');
  });

  it('setting a new host moves the role, it does not add a second one', async () => {
    await setRunnerHost(SELF, { dataDir: dir });
    await setRunnerHost(OTHER, { dataDir: dir });
    assert.equal(await runnerHostStatus(SELF, dir), 'not-host');
    assert.equal(await runnerHostStatus(OTHER, dir), 'host');
  });

  it('writes exactly one file, named by the exported constant', async () => {
    await setRunnerHost(SELF, { dataDir: dir });
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, [RUNNER_HOST_FILE]);
    assert.equal(runnerHostPath(dir), path.join(dir, RUNNER_HOST_FILE));
  });
});

describe('runnerHost: a corrupt flag must not read as host', () => {
  // Direction matters: failing to 'unset' idles everything (safe, visible via
  // describeRunnerHost). Failing to 'host' re-opens the race.
  const corrupt: Array<[string, string]> = [
    ['not json', '{ this is not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['no host key', '{"note":"hello"}'],
    ['host is not a string', '{"host":42}'],
    ['host is empty', '{"host":"   "}'],
    ['truncated mid-write', '{"host":"C:\\\\dev\\\\nex'],
  ];

  for (const [label, body] of corrupt) {
    it(`reports unreadable for ${label}`, async () => {
      await fs.writeFile(runnerHostPath(dir), body);
      const st = await runnerHostStatus(SELF, dir);
      assert.equal(st, 'unreadable');
      assert.notEqual(st, 'host');
    });
  }

  it('a corrupt flag is unreadable for every installation, not just one', async () => {
    await fs.writeFile(runnerHostPath(dir), '{"host":42}');
    assert.equal(await runnerHostStatus(SELF, dir), 'unreadable');
    assert.equal(await runnerHostStatus(OTHER, dir), 'unreadable');
  });
});

describe('runnerHost: path comparison', () => {
  it('is case-insensitive — a configured host must not idle on casing', async () => {
    await setRunnerHost('C:\\Dev\\Nexus', { dataDir: dir });
    assert.equal(await runnerHostStatus('c:\\dev\\nexus', dir), 'host');
  });

  it('ignores a trailing separator', async () => {
    await setRunnerHost('C:\\dev\\nexus\\', { dataDir: dir });
    assert.equal(await runnerHostStatus('C:\\dev\\nexus', dir), 'host');
  });

  it('does not treat a prefix as a match', async () => {
    // C:\dev\nexus is a prefix of C:\dev\nexus-cairn as a STRING. These are
    // different installations and a substring comparison would merge them.
    await setRunnerHost('C:\\dev\\nexus', { dataDir: dir });
    assert.equal(await runnerHostStatus('C:\\dev\\nexus-cairn', dir), 'not-host');
  });

  it('normaliseInstallPath is idempotent', () => {
    const once = normaliseInstallPath('C:\\Dev\\Nexus\\');
    assert.equal(normaliseInstallPath(once), once);
  });
});

describe('runnerHost: clearing', () => {
  it('reports true when a file was removed and false when there was none', async () => {
    await setRunnerHost(SELF, { dataDir: dir });
    assert.equal(await clearRunnerHost(dir), true);
    assert.equal(await runnerHostStatus(SELF, dir), 'unset');
    // The second call removes nothing. Saying "cleared" here would be a claim
    // with no artifact behind it.
    assert.equal(await clearRunnerHost(dir), false);
  });
});

describe('runnerHost: every status has a sentence a person can read', () => {
  it('names a reason for all four, and never returns an empty string', () => {
    const all = ['host', 'not-host', 'unset', 'unreadable'] as const;
    for (const st of all) {
      const s = describeRunnerHost(st, SELF, OTHER);
      assert.ok(s.length > 0, `${st} produced no sentence`);
      // "no runner" must be a sentence, not an absence — F1's 55-day lesson.
      assert.notEqual(s.trim(), '');
    }
    // The idle cases must say WHY, not merely that nothing is happening.
    assert.match(describeRunnerHost('unset', SELF), /host/i);
    assert.match(describeRunnerHost('not-host', SELF, OTHER), new RegExp(OTHER.replace(/\\/g, '\\\\')));
  });
});

describe('runnerHost: installationId', () => {
  it('produces a non-empty normalised path (shape only, not value)', async () => {
    const id = await installationId();
    assert.ok(id.length > 0);
    assert.equal(id, normaliseInstallPath(id));
    assert.equal(id, id.toLowerCase());
  });

  it('resolves the tree root as the PARENT of the given cwd', async () => {
    // Identity is the tree, not web-app: both installations have a web-app.
    const id = await installationId(path.join(dir, 'web-app'));
    assert.equal(id, normaliseInstallPath(dir));
  });
});


/**
 * claimRunnerHostIfUnset — 2026-10-31.
 *
 * Added for 1.4: a user should not have to press a button called "runner:
 * this environment" before a message they sent will run.
 *
 * NOT written from the implementation (these catch a real inversion):
 *   "claims when unset"      — absent, the shipped experience for every
 *       single-installation user is: send a message, get nothing, and the
 *       reason lives in a panel behind a badge they have never clicked.
 *   "never steals"           — absent, the dev tree takes the role from the
 *       house tree on the next send and turns run on the wrong code with
 *       NOTHING on screen saying which. This is the exact failure the
 *       "nobody hosts" default exists to prevent, re-introduced from the
 *       other side.
 *   "does not rewrite its OWN record" — absent, every send rewrites setAt,
 *       so the one timestamp that says when the role was decided becomes a
 *       timestamp of the last message. A field that silently retargets.
 *   "a claim makes runnerHostStatus say host" — the route re-reads status
 *       after claiming rather than trusting the return value; absent, that
 *       re-read could disagree with the claim and the turn would be refused
 *       immediately after successfully taking the role.
 *
 * Written from the implementation (they restate it): the note/now passthrough.
 */
describe('runnerHost: claiming the role automatically', () => {
  it('claims when nobody holds it, and names THIS installation', async () => {
    assert.equal(await claimRunnerHostIfUnset(SELF, { dataDir: dir }), 'claimed');
    const rec = await readRunnerHost(dir);
    assert.equal(rec?.host, normaliseInstallPath(SELF));
  });

  it('a claim makes runnerHostStatus report host — and only for the claimer', async () => {
    await claimRunnerHostIfUnset(SELF, { dataDir: dir });
    assert.equal(await runnerHostStatus(SELF, dir), 'host');
    assert.equal(await runnerHostStatus(OTHER, dir), 'not-host');
  });

  it('NEVER steals a role another installation holds', async () => {
    await setRunnerHost(OTHER, { dataDir: dir, now: '2020-01-01T00:00:00.000Z' });
    assert.equal(await claimRunnerHostIfUnset(SELF, { dataDir: dir }), 'taken');
    const rec = await readRunnerHost(dir);
    // Both halves matter: the right answer AND an untouched record.
    assert.equal(rec?.host, normaliseInstallPath(OTHER));
    assert.equal(rec?.setAt, '2020-01-01T00:00:00.000Z');
    assert.equal(await runnerHostStatus(SELF, dir), 'not-host');
  });

  it('does not rewrite its own record on a second claim', async () => {
    await setRunnerHost(SELF, { dataDir: dir, now: '2020-01-01T00:00:00.000Z', note: 'by hand' });
    assert.equal(await claimRunnerHostIfUnset(SELF, { dataDir: dir, now: '2026-10-31T00:00:00.000Z' }), 'taken');
    const rec = await readRunnerHost(dir);
    assert.equal(rec?.setAt, '2020-01-01T00:00:00.000Z');
    assert.equal(rec?.note, 'by hand');
  });

  it('carries the note and the timestamp it was given', async () => {
    await claimRunnerHostIfUnset(SELF, { dataDir: dir, note: 'auto', now: '2026-10-31T12:00:00.000Z' });
    const rec = await readRunnerHost(dir);
    assert.equal(rec?.note, 'auto');
    assert.equal(rec?.setAt, '2026-10-31T12:00:00.000Z');
  });

  it('a cleared flag is claimable again', async () => {
    await setRunnerHost(OTHER, { dataDir: dir });
    assert.equal(await claimRunnerHostIfUnset(SELF, { dataDir: dir }), 'taken');
    assert.equal(await clearRunnerHost(dir), true);
    assert.equal(await claimRunnerHostIfUnset(SELF, { dataDir: dir }), 'claimed');
    assert.equal(await runnerHostStatus(SELF, dir), 'host');
  });

  it('reports failed — not taken — when the store cannot be written', async () => {
    // A directory that does not exist stands in for an unwritable store. The
    // distinction is load-bearing: 'taken' sends a reader looking for a
    // competing installation, and there is none.
    const gone = path.join(dir, 'no', 'such', 'dir');
    assert.equal(await claimRunnerHostIfUnset(SELF, { dataDir: gone }), 'failed');
  });
});
