import { NextResponse } from 'next/server';
import {
  readSpuWorkFile,
  writeSpuWorkFile,
} from '@/lib/systemPromptStorage';

/**
 * The System Prompt Updater's LEFT-pane working copy.
 *
 * Deliberately a separate route from `/api/system-prompts` rather than a
 * `scope` flag on it: the whole point is that the left pane can no longer
 * reach `<name>_<N>.md` (the finished soul of a closed generation). A flag
 * would leave that write one mis-plumbed parameter away. This route imports
 * only the working-copy functions, so the dangerous write is not expressible
 * here at all.
 *
 * Writing the real soul still goes through `/api/system-prompts` POST, which
 * now has exactly two callers: the commit (persisting the RIGHT pane as the
 * next generation) and one explicit, confirmed "write this working copy into
 * the real soul" button.
 */

// GET /api/system-prompts/work?folder=<name>&index=<n>
// Returns { contents: string | null }. `null` means no working copy exists for
// this index yet — the caller seeds the pane from the real soul. An EMPTY
// string is a real answer (the pane was deliberately emptied) and is NOT the
// same as null.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = url.searchParams.get('folder') || '';
    const indexStr = url.searchParams.get('index') || '';
    const index = parseInt(indexStr, 10);
    if (!folder || isNaN(index)) {
      return NextResponse.json(
        { error: 'folder and integer index are required' },
        { status: 400 }
      );
    }
    const contents = await readSpuWorkFile(folder, index);
    return NextResponse.json({ contents });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/system-prompts/work  body={ folder, index, contents }
export async function POST(req: Request) {
  try {
    const { folder, index, contents } = await req.json();
    if (typeof folder !== 'string' || typeof index !== 'number' || typeof contents !== 'string') {
      return NextResponse.json(
        { error: 'folder (string), index (number), contents (string) required' },
        { status: 400 }
      );
    }
    const path = await writeSpuWorkFile(folder, index, contents);
    return NextResponse.json({ ok: true, path });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
