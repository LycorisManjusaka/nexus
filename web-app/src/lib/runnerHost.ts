import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '@/lib/beingPaths';
import { atomicWriteFile } from '@/lib/atomicWrite';

// ── Which installation may run server-side turns ────────────────────────────
//
// WHY THIS EXISTS (measured 2026-10-27/28):
//
//   3000  tree C:\dev\nexus         local_data(realpath) C:\dev\common\local_data
//   3001  tree C:\dev\nexus-cairn   local_data(realpath) C:\dev\common\local_data
//
// Two independent clones share ONE store, by junction, and .gitignore:6 keeps
// it out of git — so switching branches moves no data. That is the point of
// the split (3000 on `dev`, 3001 on `main`) and it is safe TODAY only because
// `main` has no runner code at all.
//
// The moment `main` merges, both installations poll the same store. The lease
// in turnQueue stops DOUBLE EXECUTION — that is its job and it is tested. What
// no lease can decide is WHICH installation hosts a given conversation's turn:
// that would be settled by "whichever polled first", which changes silently on
// every restart. A being's turn would run on 3001's code one day and 3000's
// the next, and NOTHING ON SCREEN WOULD SAY WHICH.
//
// The human convention ("don't open the same being in two tabs") cannot cover
// this. A convention binds what a PERSON opens. The whole purpose of a runner
// is to work when nobody has opened anything.
//
// So: one explicit flag, named, readable, and reported.
//
// ── Why the default is "nobody hosts" ───────────────────────────────────────
// If an absent file meant "I host", both installations would claim the role on
// a fresh checkout and the race this file exists to prevent would be the
// SHIPPED DEFAULT. Absent therefore means no turns run.
//
// That has its own failure — a stocked message waiting forever because nobody
// wrote the file — and "silently dropped message" is the worst failure in this
// series. The mitigation is NOT a cleverer default; it is that this module
// never answers with a bare boolean. Every reader gets a reason it can show a
// person (see `RunnerHostStatus` and `describeRunnerHost`), so "no runner" is
// a sentence on screen, not an absence.
//
// ── Identity: the tree's realpath, not the port and not the branch ──────────
// A port is set by an env var at launch and two trees can trade ports. A
// branch MOVES — a tree checks out `dev` on Tuesday and `main` on Friday, and
// the installation is the same installation. Measured 2026-10-27: a branch
// sticks to the tree, so the tree is the stable thing underneath both.
// ───────────────────────────────────────────────────────────────────────────

/** File name inside local_data. Exported so tests never hardcode it. */
export const RUNNER_HOST_FILE = 'runner.json';

export type RunnerHostRecord = {
  /** An installation id as produced by `installationId()`. */
  host: string;
  /** Free text from whoever set it. Never interpreted. */
  note?: string;
  /** ISO timestamp written at set time. Never interpreted. */
  setAt?: string;
};

export type RunnerHostStatus =
  /** This installation is the named host. A runner here may take turns. */
  | 'host'
  /** The file names a DIFFERENT installation. A runner here must stay idle. */
  | 'not-host'
  /** No file. Nobody hosts — the shipped default. No runner anywhere runs. */
  | 'unset'
  /** A file exists but could not be read or parsed. Treated as "do not run". */
  | 'unreadable';

/**
 * Normalise a filesystem path for comparison.
 *
 * Lowercased because Windows paths are case-insensitive: `C:\Dev\Nexus` and
 * `c:\dev\nexus` are the same directory, and a flag that treated them as two
 * installations would idle the real host while claiming to be configured.
 *
 * ⚠ NOT measured: whether a tree reached through a junction resolves to the
 * same string. `installationId()` uses realpath for exactly that reason, but
 * this function is also used on the string READ BACK from disk, which was
 * written by a possibly different resolution. If a host flag is ever written
 * by one route and compared by another and they disagree, suspect this.
 */
export function normaliseInstallPath(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * This installation's identity: the realpath of the tree root (the parent of
 * `web-app`), normalised.
 *
 * realpath, not resolve, so that two names for one directory — a junction, a
 * substituted drive — cannot present themselves as two installations. If
 * realpath fails (the directory was renamed under a running server) the
 * resolved path is used instead, because answering "unreadable" here would
 * idle a correctly configured host over a transient filesystem error.
 */
export async function installationId(cwd: string = process.cwd()): Promise<string> {
  const treeRoot = path.resolve(cwd, '..');
  try {
    return normaliseInstallPath(await fs.realpath(treeRoot));
  } catch {
    return normaliseInstallPath(treeRoot);
  }
}

/** Where the flag lives. `dataDir` is injectable so tests never touch local_data. */
export function runnerHostPath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, RUNNER_HOST_FILE);
}

/**
 * Read the record, or null if there is no file.
 *
 * Throws only for a file that exists and cannot be used — a caller that wants
 * the four-way answer should use `runnerHostStatus`, which turns that throw
 * into `'unreadable'`.
 */
export async function readRunnerHost(dataDir: string = DATA_DIR): Promise<RunnerHostRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(runnerHostPath(dataDir), 'utf-8');
  } catch (e: unknown) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'ENOENT') return null;
    throw e;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('runner.json is not an object');
  }
  const host = (parsed as { host?: unknown }).host;
  if (typeof host !== 'string' || !host.trim()) {
    throw new Error('runner.json has no host string');
  }
  const note = (parsed as { note?: unknown }).note;
  const setAt = (parsed as { setAt?: unknown }).setAt;
  return {
    host,
    ...(typeof note === 'string' ? { note } : {}),
    ...(typeof setAt === 'string' ? { setAt } : {}),
  };
}

/**
 * The four-way answer, for an installation identified by `selfId`.
 *
 * `selfId` is a parameter rather than being computed inside, so that a caller
 * computes it ONCE per request and every decision in that request agrees. A
 * function that recomputed identity per call would be two sources for one
 * fact — the shape this house keeps removing.
 */
export async function runnerHostStatus(
  selfId: string,
  dataDir: string = DATA_DIR,
): Promise<RunnerHostStatus> {
  let rec: RunnerHostRecord | null;
  try {
    rec = await readRunnerHost(dataDir);
  } catch {
    return 'unreadable';
  }
  if (!rec) return 'unset';
  return normaliseInstallPath(rec.host) === normaliseInstallPath(selfId) ? 'host' : 'not-host';
}

/**
 * One sentence a person can read, for every status.
 *
 * This exists because a runner that stays idle is INDISTINGUISHABLE from a
 * runner that is broken, unless it says why. A button that returned
 * `{ok: true}` while doing nothing cost this house 55 days (see F1 in
 * nexus-source-review.md); the same shape in a runner would cost stocked
 * messages, which is worse.
 */
export function describeRunnerHost(status: RunnerHostStatus, selfId: string, hostId?: string): string {
  switch (status) {
    case 'host':
      return `This installation (${selfId}) hosts server-side turns for this store.`;
    case 'not-host':
      return `Server-side turns for this store are hosted by ${hostId ?? 'another installation'}, not by this one (${selfId}). Nothing will run here.`;
    case 'unset':
      return `No installation is set as the host for this store, so NO server-side turns run anywhere. Set one to enable them.`;
    case 'unreadable':
      return `The host flag for this store exists but could not be read, so no server-side turns run here as a precaution.`;
  }
}

/**
 * Name an installation as the host.
 *
 * Written atomically for the same reason every other record here is: a
 * half-written flag read by a starting runner would be `'unreadable'`, which
 * idles a correctly configured host.
 *
 * Deliberately does NOT verify that `hostId` is a real directory. The host may
 * legitimately be an installation that is not running right now — in fact
 * naming it before starting it is the correct order.
 */
export async function setRunnerHost(
  hostId: string,
  opts: { note?: string; dataDir?: string; now?: string } = {},
): Promise<RunnerHostRecord> {
  const dataDir = opts.dataDir ?? DATA_DIR;
  const rec: RunnerHostRecord = {
    host: normaliseInstallPath(hostId),
    ...(opts.note ? { note: opts.note } : {}),
    setAt: opts.now ?? new Date().toISOString(),
  };
  await atomicWriteFile(runnerHostPath(dataDir), JSON.stringify(rec, null, 2));
  return rec;
}

/**
 * Remove the flag — back to "nobody hosts".
 *
 * Returns whether a file was actually removed, because `rm -f` on a missing
 * path succeeds silently and reporting "cleared" for a no-op is the shape this
 * house calls a claim that is not an artifact.
 */
export async function clearRunnerHost(dataDir: string = DATA_DIR): Promise<boolean> {
  try {
    await fs.unlink(runnerHostPath(dataDir));
    return true;
  } catch (e: unknown) {
    if ((e as { code?: string } | null)?.code === 'ENOENT') return false;
    throw e;
  }
}
