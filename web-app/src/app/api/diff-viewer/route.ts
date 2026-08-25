import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { spawn, execFile } from 'child_process';
import path from 'path';
import os from 'os';

// External diff-tool bridge for the System Prompt Updater.
//
//   POST { action: 'open', viewerPath, leftText, rightText, leftName, rightName }
//     Writes temp copies of both panes and spawns the configured diff tool
//     detached (Nexus does not hold the process). Returns the temp paths.
//   POST { action: 'read', leftFile, rightFile }
//     Returns the current contents of both temp files — the client polls this
//     so edits saved in the external tool flow back into the SPU panes.
//   POST { action: 'close', leftFile, rightFile }
//     Best-effort delete of the temp files (if the tool still holds them open,
//     Windows refuses and the files age out of the OS temp dir on their own).
//
// The viewer path is configured in Preferences → Other. Two forms:
//   1. Plain executable path  →  invoked as  <exe> <leftFile> <rightFile>
//      (WinMerge, TortoiseMerge, kdiff3, Beyond Compare, …)
//   2. Command template containing {left} / {right} placeholders, for tools
//      that need flags:  "C:\...\Code.exe" --diff {left} {right}
//      The executable is the first token (quoted if it contains spaces).

const DIFF_ROOT = path.join(os.tmpdir(), 'nexus-diff');

// sessionDir -> exe basename, so `read` can report whether the viewer is still
// running (the client stops polling once the tool is closed).
const activeSessions = new Map<string, string>();

// Only ever read/delete files we created under DIFF_ROOT — the route takes
// client-supplied paths, so this is the guard against arbitrary file access.
function safeSessionFile(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  const resolved = path.resolve(p);
  if (!resolved.startsWith(DIFF_ROOT + path.sep)) return null;
  return resolved;
}

// Soul-file names travel from the client; keep them to a conservative charset
// so they can never escape the session directory.
function safeName(p: unknown, fallback: string): string {
  if (typeof p !== 'string') return fallback;
  const cleaned = path.basename(p).replace(/[^\w.\-]+/g, '_');
  return cleaned || fallback;
}

function buildSpawnSpec(viewerPath: string, leftFile: string, rightFile: string): { exe: string; args: string[] } | null {
  const hasPlaceholders = viewerPath.includes('{left}') || viewerPath.includes('{right}');
  if (!hasPlaceholders) {
    return { exe: viewerPath, args: [leftFile, rightFile] };
  }
  // Template form: executable (optionally quoted) followed by flag tokens.
  let rest = viewerPath.trim();
  let exe: string;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    if (end === -1) return null;
    exe = rest.slice(1, end);
    rest = rest.slice(end + 1);
  } else {
    const sp = rest.search(/\s/);
    if (sp === -1) {
      exe = rest;
      rest = '';
    } else {
      exe = rest.slice(0, sp);
      rest = rest.slice(sp);
    }
  }
  if (!exe) return null;
  const args = rest
    .split(/\s+/)
    .filter(Boolean)
    .map((a) => a.split('{left}').join(leftFile).split('{right}').join(rightFile));
  return { exe, args };
}

// Ask Windows whether a process with this executable name is still running.
// Used instead of tracking the spawned pid because many diff tools are
// single-instance (a second launch forwards into the already-running window
// and exits immediately) — the pid is then meaningless while the exe lives on.
function isExeRunning(exeBase: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exeBase}`, '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) {
        // Couldn't determine → assume still open so we never stop syncing
        // prematurely.
        resolve(true);
        return;
      }
      resolve(stdout.toLowerCase().includes(exeBase.toLowerCase()));
    });
  });
}

// Launch the viewer via cmd's `start` so its window opens in the FOREGROUND.
// A plain detached spawn from a background server lands the window behind
// other apps (Windows foreground-activation rules). The `"Nexus Diff"` token
// is `start`'s window title — it also stops the first quoted arg being misread
// as the title when the exe path itself needs quoting.
function spawnDetached(exe: string, args: string[]): void {
  const child = spawn('cmd.exe', ['/c', 'start', 'Nexus Diff', exe, ...args], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'open') {
      const viewerPath: string = typeof body.viewerPath === 'string' ? body.viewerPath.trim() : '';
      if (!viewerPath) {
        return NextResponse.json({ error: 'No diff viewer path configured (Preferences → Other).' }, { status: 400 });
      }
      // The plain-path form must point at a real file. (The template form's
      // exe is checked after parsing.)
      const spec = buildSpawnSpec(viewerPath, '', '');
      const exeToCheck = spec ? spec.exe : viewerPath;
      let statOk = false;
      try {
        const st = await fs.stat(exeToCheck);
        statOk = st.isFile();
      } catch {
        statOk = false;
      }
      if (!statOk) {
        return NextResponse.json(
          { error: `Diff viewer executable not found: ${exeToCheck}` },
          { status: 400 },
        );
      }

      // Per-session temp dir keeps concurrent sessions from colliding, while
      // the file names themselves stay the real soul-file names so the tool's
      // tab titles read <name>_<N>.md / <name>_<N+1>.md.
      const sessionDir = path.join(DIFF_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      await fs.mkdir(sessionDir, { recursive: true });
      const leftName = safeName(body.leftName, 'left.md');
      const rightName = safeName(body.rightName, 'right.md');
      const leftFile = path.join(sessionDir, leftName);
      const rightFile = path.join(sessionDir, rightName);
      await fs.writeFile(leftFile, typeof body.leftText === 'string' ? body.leftText : '', 'utf-8');
      await fs.writeFile(rightFile, typeof body.rightText === 'string' ? body.rightText : '', 'utf-8');

      const spawnSpec = buildSpawnSpec(viewerPath, leftFile, rightFile);
      if (!spawnSpec) {
        return NextResponse.json({ error: 'Could not parse the diff viewer command.' }, { status: 400 });
      }
      try {
        spawnDetached(spawnSpec.exe, spawnSpec.args);
      } catch (e: any) {
        return NextResponse.json(
          { error: `Failed to launch diff viewer: ${e?.message ?? e}` },
          { status: 500 },
        );
      }
      activeSessions.set(sessionDir, path.basename(spawnSpec.exe));
      return NextResponse.json({ ok: true, leftFile, rightFile });
    }

    if (action === 'read') {
      const leftFile = safeSessionFile(body.leftFile);
      const rightFile = safeSessionFile(body.rightFile);
      if (!leftFile || !rightFile) {
        return NextResponse.json({ error: 'Invalid temp file path.' }, { status: 400 });
      }
      const readSafe = async (p: string): Promise<string | null> => {
        try {
          return await fs.readFile(p, 'utf-8');
        } catch {
          return null; // deleted or tool not done writing yet — client keeps old text
        }
      };
      const [leftText, rightText] = await Promise.all([readSafe(leftFile), readSafe(rightFile)]);
      // Report whether the viewer is still running so the client can stop
      // polling once it's closed. Unknown/restarted sessions default to alive
      // so we never tear down a session we lost track of.
      const exeBase = activeSessions.get(path.dirname(leftFile));
      const alive = exeBase ? await isExeRunning(exeBase) : true;
      return NextResponse.json({ ok: true, leftText, rightText, alive });
    }

    if (action === 'close') {
      const leftFile = safeSessionFile(body.leftFile);
      const rightFile = safeSessionFile(body.rightFile);
      const rm = async (p: string | null) => {
        if (!p) return;
        try {
          await fs.unlink(p);
        } catch {
          // Tool still holds it open, or already gone — fine either way.
        }
        // Drop the session dir too when it's empty.
        try {
          await fs.rmdir(path.dirname(p));
        } catch {
          // Not empty (other session) or already removed — fine.
        }
      };
      await Promise.all([rm(leftFile), rm(rightFile)]);
      if (leftFile) activeSessions.delete(path.dirname(leftFile));
      if (rightFile) activeSessions.delete(path.dirname(rightFile));
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action: ${action || '(none)'}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unknown error' }, { status: 500 });
  }
}
