import { NextResponse } from 'next/server';
import { readWorkspaceFile, writeWorkspaceFile } from '@/lib/fsStorage';

// Applies the Indexer agent's (式神ζ) "files to externalize" proposal to a
// being's own workspace. The agent itself has NO write access (Utai's
// explicit design — read-only Read/Glob/Grep only, see agentReadOnlyTools in
// /api/chat); this route is the only place that actually touches the desk on
// the indexer's behalf, and it is called by the SPU UI, never by the agent.
//
// Semantics match the agent files' own wording ("新規作成・追記" / "new or
// appended"): a path that does not exist yet is CREATED with the proposed
// content; a path that already exists is APPENDED to, never overwritten —
// externalizing is additive by design, and silently replacing an existing
// desk file would be exactly the kind of destructive move-without-a-trace
// the rest of Nexus (Layer 4/5 injection, summary writes) deliberately avoids.
export async function POST(req: Request) {
  try {
    const { folderName, files } = await req.json();
    if (!folderName || typeof folderName !== 'string') {
      return NextResponse.json({ error: 'folderName is required' }, { status: 400 });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'files must be a non-empty array' }, { status: 400 });
    }

    const results: Array<{ path: string; action: 'created' | 'appended' | 'failed'; error?: string }> = [];
    for (const f of files) {
      const relPath = typeof f?.path === 'string' ? f.path.trim() : '';
      const content = typeof f?.content === 'string' ? f.content : '';
      if (!relPath) {
        results.push({ path: String(f?.path ?? ''), action: 'failed', error: 'empty path' });
        continue;
      }
      const existing = await readWorkspaceFile(folderName, relPath);
      const nextContent = existing !== null
        ? existing.replace(/\s+$/, '') + '\n\n' + content
        : content;
      const w = await writeWorkspaceFile(folderName, relPath, nextContent);
      if (!w.ok) {
        results.push({ path: relPath, action: 'failed', error: w.error || 'write failed' });
      } else {
        results.push({ path: relPath, action: existing !== null ? 'appended' : 'created' });
      }
    }
    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown error' }, { status: 500 });
  }
}
