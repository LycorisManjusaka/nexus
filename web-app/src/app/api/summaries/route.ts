import { NextResponse } from 'next/server';
import { listFolders, listLogs } from '@/lib/fsStorage';
import {
  readSummary,
  writeSummary,
  listSummaries,
  assembleSummaryIndex,
  replaceManySummaries,
  summaryKey,
  type SummaryIndexEntry,
} from '@/lib/summaryStorage';

// Resolve the ordered, title-paired list of conversations for one entity
// folder. Order follows folder.settings.convoOrder (the sidebar order); any
// conversation not listed there is appended by recency. Each entry carries the
// live title and the `active` flag (default true when absent).
async function orderedConvos(folderName: string): Promise<Array<{ convoId: string; title: string; active: boolean }>> {
  const folders = await listFolders();
  const folder = folders.find((f) => f.name === folderName);
  const convoOrder: string[] = Array.isArray(folder?.settings?.convoOrder)
    ? folder!.settings.convoOrder
    : [];

  const logs = (await listLogs()).filter((l: any) => l.folderName === folderName);
  const byId = new Map<string, any>(logs.map((l: any) => [l.id, l]));

  const ordered: Array<{ convoId: string; title: string; active: boolean }> = [];
  const seen = new Set<string>();
  for (const id of convoOrder) {
    const l = byId.get(id);
    if (!l) continue;
    seen.add(id);
    ordered.push({ convoId: id, title: l.title || 'Untitled', active: l.active !== false });
  }
  // Append any logs missing from convoOrder, most-recent first (listLogs is
  // already sorted by updatedAt desc).
  for (const l of logs) {
    if (seen.has(l.id)) continue;
    ordered.push({ convoId: l.id, title: l.title || 'Untitled', active: l.active !== false });
  }
  return ordered;
}

// GET /api/summaries?folder=X&title=Y            → { content: string | null }
// GET /api/summaries?folder=X&mode=index          → { body: string }
//   The assembled Layer-4 index body (titles + summaries in sidebar order;
//   inactive conversations listed by title only, their summaries never shown).
// GET /api/summaries?folder=X&mode=all            → { summaries: Record<key, string> }
//   Every summary in the folder, keyed by summaryKey(title). One request per
//   folder instead of one per conversation — this feeds the sidebar's hover
//   preview. Unlike mode=index this is a USER-facing view, so inactive
//   conversations are NOT filtered out: the filtering in mode=index exists to
//   keep them out of what gets injected into an AI's context, not to hide them
//   from the person reading their own sidebar.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = url.searchParams.get('folder') || '';
    const mode = url.searchParams.get('mode') || '';
    const title = url.searchParams.get('title') || '';

    if (!folder) {
      return NextResponse.json({ error: 'folder is required' }, { status: 400 });
    }

    if (mode === 'all') {
      return NextResponse.json({ summaries: await listSummaries(folder) });
    }

    if (mode === 'index') {
      // The conversation currently open in the chat view. Its own summary is
      // meaningless inside its own context (the AI already has the live
      // transcript), so it is excluded from both the read-only preview and the
      // injected Layer-4 index.
      const current = url.searchParams.get('current') || '';
      const ordered = await orderedConvos(folder);
      const summaries = await listSummaries(folder);
      // Per-folder editable hint override (undefined → default hint used).
      const folders = await listFolders();
      const hintOverride = folders.find((f) => f.name === folder)?.settings?.summaryIndexHint as
        | string
        | undefined;
      const entries: SummaryIndexEntry[] = ordered
        // Inactive ("non-public") conversations are fully hidden — not even a
        // title placeholder — so the AI never learns they exist.
        .filter((c) => c.active)
        // Drop the current conversation entirely.
        .filter((c) => !current || c.convoId !== current)
        .map((c) => ({
          convoId: c.convoId,
          title: c.title,
          active: c.active,
          // Summaries are filed under the (sanitized) conversation title.
          summary: summaries[summaryKey(c.title)] ?? null,
        }))
        // Present oldest → newest, matching the old baked Layer 4 ordering.
        // orderedConvos follows the sidebar order (newest-first), so reverse it.
        .reverse();
      return NextResponse.json({ body: assembleSummaryIndex(entries, hintOverride) });
    }

    if (title) {
      const content = await readSummary(folder, title);
      return NextResponse.json({ content });
    }

    return NextResponse.json({ error: 'title or mode=index required' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/summaries
//   body={ folder, title, content }                     → write one summary
//   body={ action:'replaceMany', folder, entries:[…] }  → snapshot the whole
//     folder into local_data/backups/<folder>/summaries/<date_time>/, then
//     write every entry. Used by the updater's "Redistribute Layers 1-4" mode,
//     which rewrites many summaries from one agent output. Backup + writes are
//     one request so they can never be half-applied, and titles that are on
//     disk but missing from `entries` are left alone (a truncated agent run
//     must not be able to delete a summary).
export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (body?.action === 'replaceMany') {
      const { folder, entries } = body;
      if (typeof folder !== 'string' || !folder || !Array.isArray(entries)) {
        return NextResponse.json(
          { error: 'folder (string) and entries (array) required' },
          { status: 400 },
        );
      }
      if (entries.length === 0) {
        return NextResponse.json({ error: 'entries is empty — nothing to write' }, { status: 400 });
      }
      const result = await replaceManySummaries(folder, entries);
      return NextResponse.json({ ok: true, ...result });
    }

    const { folder, title, content } = body;
    if (typeof folder !== 'string' || typeof title !== 'string' || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'folder (string), title (string), content (string) required' },
        { status: 400 },
      );
    }
    const path = await writeSummary(folder, title, content);
    return NextResponse.json({ ok: true, path });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
