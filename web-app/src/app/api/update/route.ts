import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { getBuildInfo, invalidateBuildInfo } from '@/lib/buildInfo';
import { classifyChangedFiles, parseChangedFiles } from '@/lib/updateClassify';

const run = promisify(execFile);

export const dynamic = 'force-dynamic';

// ───────────────────────────────────────────────────────────────────────────
// Update this install — `git pull --ff-only`, and NOTHING else.
//
// WHY THERE IS NO RESTART HERE
//
// The button was declined once (2026-10-09) and the reason on record is not
// "a restart is scary" — it is that THERE IS NO WAY BACK. `RUN.bat` ends with
//     npm run dev -- -p 3000
//     pause
// with no supervisor loop around it, so a process that kills node leaves the
// window sitting at `pause` and nothing restarts the server. For someone
// holding a phone over a VPN, that is NEXUS gone with no hands left to bring
// it back. A button whose failure mode is "the app no longer exists" is not a
// button.
//
// And measured (PID-confirmed, four separate times): under `npm run dev`
// Turbopack hot-reloads server-side modules too — `route.ts` and `lib/*`, not
// just client code — so a pull is picked up by the RUNNING process without a
// restart. `next.config.ts` is the one file that needs one, and changing it
// makes Next restart itself.
//
// So the restart is not a compromise this endpoint makes. It is a step that
// does not exist in this house, and the two cases where something more IS
// needed are both reported by name instead of being attempted:
//   * package-lock.json moved → `npm ci` (minutes long; deletes node_modules
//     out from under the running server) — reported, never run.
//   * next.config.ts moved → Next restarts itself; say so, don't pre-empt it.
//
// There is no input of any kind: no path, no ref, no remote. The only thing
// this route can do is move THIS checkout forward along its own branch.
// ───────────────────────────────────────────────────────────────────────────

/** The Next server runs with cwd = <repo>/web-app — same assumption buildInfo
 *  and the data directory already make. */
function repoRoot(): string {
  return path.resolve(process.cwd(), '..');
}

function isCheckout(root: string): boolean {
  try { return fs.existsSync(path.join(root, '.git')); } catch { return false; }
}

/**
 * Git must never be able to BLOCK this request.
 *
 * A private remote with no cached credential will otherwise sit waiting for a
 * username on a terminal that does not exist, or pop a Credential Manager
 * window on a machine nobody is sitting at. These turn that hang into an
 * ordinary non-zero exit with a message we can show. `LC_ALL=C` keeps git's
 * own wording stable, since that wording is what reaches the screen.
 */
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
  LC_ALL: 'C',
};

type GitResult = { code: number; stdout: string; stderr: string; failure?: string };

async function git(root: string, args: string[], timeout = 180_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd: root,
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: GIT_ENV,
    });
    return { code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (e: any) {
    // execFile rejects on non-zero exit, on ENOENT, and on timeout (killed).
    const failure =
      e?.code === 'ENOENT' ? 'git-missing' :
      e?.killed ? 'timeout' :
      'nonzero';
    return {
      code: typeof e?.code === 'number' ? e.code : -1,
      stdout: String(e?.stdout || ''),
      stderr: String(e?.stderr || e?.message || ''),
      failure,
    };
  }
}

/** Read-only precheck, so the UI can decline to offer a button that cannot work. */
export async function GET() {
  const root = repoRoot();
  const build = await getBuildInfo();
  return NextResponse.json({
    isRepo: isCheckout(root),
    root,
    commit: build.commit,
    branch: build.branch,
    label: build.label,
  });
}

export async function POST() {
  const root = repoRoot();

  if (!isCheckout(root)) {
    return NextResponse.json({
      ok: false,
      code: 'not-a-repo',
      root,
      message: `No .git next to ${root}. This install was not created by cloning, so there is nothing to pull.`,
    });
  }

  const before = await git(root, ['rev-parse', 'HEAD'], 20_000);
  if (before.failure) {
    return NextResponse.json({
      ok: false,
      code: before.failure === 'git-missing' ? 'git-missing' : 'head-unreadable',
      root,
      message: before.failure === 'git-missing'
        ? 'git is not on PATH for the NEXUS server process.'
        : (before.stderr.trim() || 'could not read HEAD'),
    });
  }
  const beforeSha = before.stdout.trim();

  const pull = await git(root, ['pull', '--ff-only']);
  if (pull.failure) {
    return NextResponse.json({
      ok: false,
      code: pull.failure === 'git-missing' ? 'git-missing'
          : pull.failure === 'timeout' ? 'timeout'
          : 'pull-failed',
      root,
      beforeSha,
      stdout: pull.stdout,
      stderr: pull.stderr,
      // `--ff-only` is why this can fail cleanly instead of inventing a merge
      // commit: local commits or a dirty tree stop it with a message, and the
      // checkout is left exactly where it was.
      message: (pull.stderr.trim() || pull.stdout.trim() || 'git pull failed').slice(0, 4000),
    });
  }

  const after = await git(root, ['rev-parse', 'HEAD'], 20_000);
  const afterSha = after.stdout.trim();

  invalidateBuildInfo();
  const build = await getBuildInfo();

  if (!afterSha || afterSha === beforeSha) {
    return NextResponse.json({
      ok: true, upToDate: true, root,
      beforeSha, afterSha: afterSha || beforeSha,
      changed: [], lockfileChanged: false, nextConfigChanged: false,
      stdout: pull.stdout, label: build.label,
    });
  }

  const diff = await git(root, ['diff', '--name-only', beforeSha, afterSha], 60_000);
  const changed = parseChangedFiles(diff.stdout);

  return NextResponse.json({
    ok: true,
    upToDate: false,
    root,
    beforeSha,
    afterSha,
    changed,
    ...classifyChangedFiles(changed),
    stdout: pull.stdout,
    label: build.label,
  });
}
