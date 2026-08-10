import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { ensureWorkspace } from '@/lib/fsStorage';

/**
 * Ensures the per-folder agent workspace exists and opens it in the OS file
 * explorer. Used by the "folder" button in the chat header.
 *
 * Local-only convenience — exec'ing into the OS is fine on a developer machine
 * but obviously not appropriate in any hosted deployment.
 */
export async function POST(req: Request) {
  try {
    const { folderName } = await req.json();
    if (!folderName || typeof folderName !== 'string') {
      return NextResponse.json({ error: 'folderName is required' }, { status: 400 });
    }
    const workspacePath = await ensureWorkspace(folderName);

    // Platform-specific open command
    let cmd: string;
    if (process.platform === 'win32') {
      // start "" "<path>" — empty title literal is required so explorer
      // doesn't treat the path as the title.
      cmd = `start "" "${workspacePath}"`;
    } else if (process.platform === 'darwin') {
      cmd = `open "${workspacePath}"`;
    } else {
      cmd = `xdg-open "${workspacePath}"`;
    }

    exec(cmd, (err) => {
      if (err) console.error('[open-workspace] exec error:', err);
    });

    return NextResponse.json({ ok: true, path: workspacePath });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}
