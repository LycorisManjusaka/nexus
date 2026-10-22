import fs from 'fs/promises';
import path from 'path';

// ───────────────────────────────────────────────────────────────────────────
// Which build of NEXUS is this?
//
// Why this exists: every install updates on its own schedule (UPDATE.bat is
// literally `git pull`), so two people running "NEXUS" can be running
// different code. When a fault is reported from a machine we cannot reach,
// the FIRST question is always "which build?" — and without an answer in the
// report itself, every bug hunt starts by trying to reconstruct it.
//
// Read straight out of `.git` with plain fs, NOT by shelling out to `git`:
//   * no child process, so this cannot hang a request;
//   * works on a checkout where git is not on PATH (the installer does not
//     guarantee it, only that a clone exists).
//
// Deliberately NOT reported: package.json's "version" (0.1.0). It has never
// been incremented, so printing it would be a claim about versioning that
// isn't true. The commit sha is the thing that actually identifies the code.
// ───────────────────────────────────────────────────────────────────────────

export interface BuildInfo {
  /** Short commit sha (7 chars), or null when this isn't a git checkout. */
  commit: string | null;
  /** Branch name, or null when HEAD is detached / unreadable. */
  branch: string | null;
  /**
   * When this checkout last MOVED (mtime of the ref HEAD points at) — i.e.
   * roughly when UPDATE.bat was last run here. NOT the commit's author date;
   * naming it `checkoutUpdatedAt` keeps those two apart on purpose.
   */
  checkoutUpdatedAt: number | null;
  /** One-line human/copy-paste form, e.g. "33c3f28 main 2026-09-15 21:00". */
  label: string;
}

function repoRoot(): string {
  // The Next.js server runs with cwd = <repo>/web-app (same assumption the
  // data directory makes: resolve(cwd, '..', 'local_data')).
  return path.resolve(process.cwd(), '..');
}

/** Resolve the real .git directory, following the `gitdir:` indirection a
 *  worktree/submodule checkout uses (there `.git` is a FILE, not a dir). */
async function gitDir(): Promise<string | null> {
  const p = path.join(repoRoot(), '.git');
  try {
    const st = await fs.stat(p);
    if (st.isDirectory()) return p;
    if (st.isFile()) {
      const txt = await fs.readFile(p, 'utf8');
      const m = txt.match(/^gitdir:\s*(.+)\s*$/m);
      if (!m) return null;
      const target = m[1].trim();
      return path.isAbsolute(target) ? target : path.resolve(repoRoot(), target);
    }
  } catch { /* not a checkout */ }
  return null;
}

async function readTrimmed(p: string): Promise<string | null> {
  try { return (await fs.readFile(p, 'utf8')).trim(); } catch { return null; }
}

async function mtimeMs(p: string): Promise<number | null> {
  try { return (await fs.stat(p)).mtimeMs; } catch { return null; }
}

/** "YYYY-MM-DD HH:MM" in the machine's LOCAL timezone (see call site). */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function compute(): Promise<BuildInfo> {
  const empty: BuildInfo = { commit: null, branch: null, checkoutUpdatedAt: null, label: 'unknown build' };
  const gd = await gitDir();
  if (!gd) return empty;

  const head = await readTrimmed(path.join(gd, 'HEAD'));
  if (!head) return empty;

  let branch: string | null = null;
  let sha: string | null = null;
  let stampFile = path.join(gd, 'HEAD');

  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (refMatch) {
    const ref = refMatch[1].trim();                       // e.g. refs/heads/main
    branch = ref.replace(/^refs\/heads\//, '');
    const loose = path.join(gd, ...ref.split('/'));
    sha = await readTrimmed(loose);
    if (sha) {
      stampFile = loose;
    } else {
      // Freshly cloned checkouts keep refs in packed-refs instead of as files.
      const packed = await readTrimmed(path.join(gd, 'packed-refs'));
      if (packed) {
        for (const line of packed.split('\n')) {
          if (line.startsWith('#') || line.startsWith('^')) continue;
          const [s, r] = line.trim().split(/\s+/);
          if (r === ref && s) { sha = s; stampFile = path.join(gd, 'packed-refs'); break; }
        }
      }
    }
  } else if (/^[0-9a-f]{40}$/i.test(head)) {
    sha = head;                                            // detached HEAD
  }

  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return empty;

  const commit = sha.slice(0, 7);
  const checkoutUpdatedAt = await mtimeMs(stampFile);
  // Local time on purpose, not toISOString()'s UTC: the server IS the user's
  // own machine, so "when did this update" means their wall clock. Includes
  // HH:MM — two pulls on the same day are otherwise indistinguishable.
  const stamp = checkoutUpdatedAt ? localStamp(checkoutUpdatedAt) : null;
  const label = [commit, branch, stamp].filter(Boolean).join(' ');

  return { commit, branch, checkoutUpdatedAt, label };
}

// Cached with a short TTL: a pull while the server is up should surface
// without a restart, but a settings dialog opening must not stat the repo on
// every render either.
let cache: { at: number; value: BuildInfo } | null = null;
const TTL_MS = 60_000;

export async function getBuildInfo(): Promise<BuildInfo> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = await compute();
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Drop the cache NOW.
 *
 * The TTL exists so a settings dialog does not stat `.git` on every render;
 * it is wrong in exactly one situation — the moment something in this process
 * MOVED the checkout. `/api/update` calls this straight after a successful
 * pull, so the build label it reports back is the build that is now on disk
 * and not the one from up to a minute ago.
 */
export function invalidateBuildInfo(): void {
  cache = null;
}
