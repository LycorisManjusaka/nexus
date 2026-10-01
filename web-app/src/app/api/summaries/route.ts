import { NextResponse } from 'next/server';
import { listFolders, listLogs } from '@/lib/fsStorage';
import {
  readSummary,
  writeSummary,
  listSummaries,
  replaceManySummaries,
  summaryKey,
} from '@/lib/summaryStorage';
import { buildLayer4IndexBody } from '@/lib/layer4Index';

// `orderedConvos()` and the index assembly USED TO LIVE HERE. They moved to
// lib/layer4Index.ts on 2026-10-01, when Layer 4 was burned in and the chat
// route became the thing that actually appends it. This endpoint now calls the
// same builder, so the body shown in the Identity window and counted in the
// "Sys" total cannot drift from the body that is sent.
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
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ja';

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
      return NextResponse.json({
        body: await buildLayer4IndexBody({ folderName: folder, currentConvoId: current, lang }),
      });
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

    if (body?.action === 'addTimestamps') {
      const { folder } = body;
      if (typeof folder !== 'string' || !folder) {
        return NextResponse.json({ error: 'folder (string) required' }, { status: 400 });
      }
      const summaries = await listSummaries(folder);
      const logs = (await listLogs()).filter((l: any) => l.folderName === folder);
      const folders = await listFolders();
      const folderCfg = folders.find((f: any) => f.name === folder);
      const convoOrder: string[] = Array.isArray(folderCfg?.settings?.convoOrder)
        ? folderCfg!.settings.convoOrder
        : [];
      const byId = new Map<string, any>(logs.map((l: any) => [l.id, l]));
      const seen = new Set<string>();
      const ordered: Array<{ id: string; title: string }> = [];
      for (const id of convoOrder) {
        const l = byId.get(id);
        if (!l) continue;
        seen.add(id);
        ordered.push({ id: l.id, title: l.title || 'Untitled' });
      }
      for (const l of logs) {
        if (seen.has(l.id)) continue;
        ordered.push({ id: l.id, title: l.title || 'Untitled' });
      }

      let updated = 0;
      const fmtDate = (ts: number) => {
        const d = new Date(ts), p = (n: number) => n.toString().padStart(2, '0');
        return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}]`;
      };

      for (const convo of ordered) {
        const key = summaryKey(convo.title);
        const existing = summaries[key];
        if (!existing) continue;
        if (/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]/.test(existing.trim())) continue;
        // Read the log file to find the first ORIGINAL message's timestamp.
        // Mirrors ChatArea.tsx's isMessageOriginal(): a conversation cloned via
        // "Go to Next" / SPU carries pre-clone history forward as copied
        // context, marked by firstOriginalMessageId (and, before that marker
        // lands, firstOriginalIsNext). Timestamping from the literal first
        // message in the log would date the summary to the copied carry-over
        // instead of when this conversation's own content actually started.
        const logPath = `../local_data/logs/${folder}/${convo.id}.json`;
        try {
          const fs2 = await import('fs/promises');
          const raw = await fs2.readFile(logPath, 'utf-8');
          const logData = JSON.parse(raw);
          const msgs: any[] = logData?.messages || [];
          const markerId: string | null = logData?.firstOriginalMessageId || null;
          const markerPending: boolean = logData?.firstOriginalIsNext === true;

          let originalMsgs: any[];
          if (markerPending && !markerId) {
            // Marker is pending on the next message added — everything
            // currently in the log is copied carry-over, nothing original yet.
            originalMsgs = [];
          } else if (!markerId) {
            // No marker at all — never went through the clone workflow, so
            // every message is original (safest default).
            originalMsgs = msgs;
          } else {
            const markerIdx = msgs.findIndex((m: any) => m.id === markerId);
            // Marker id not found in the log (e.g. that message was deleted)
            // falls back to treating everything as original, same as the client.
            originalMsgs = markerIdx >= 0 ? msgs.slice(markerIdx) : msgs;
          }

          // Find first ORIGINAL message with a timestamp
          let firstTs: number | null = null;
          for (const m of originalMsgs) {
            if (m.timestamp && m.timestamp > 0) { firstTs = m.timestamp; break; }
          }
          if (!firstTs) continue;
          const tsLine = fmtDate(firstTs);
          await writeSummary(folder, convo.title, tsLine + ' ' + existing);
          updated++;
        } catch { /* skip */ }
      }

      return NextResponse.json({ ok: true, updated, total: Object.keys(summaries).length });
    }

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
    const savePath = await writeSummary(folder, title, content);
    return NextResponse.json({ ok: true, path: savePath });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
