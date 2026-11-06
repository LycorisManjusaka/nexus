import { NextResponse } from 'next/server';
import { searchConversations, searchFolders, listSearchableFolders } from '@/lib/conversationSearch';

// Human-facing full-text search. All the scanning/trimming/author-resolution
// lives in the shared lib (also used by the entity's `search_conversations`
// tool); this route just exposes it over HTTP and adds the human-only options.
//
// The human view includes inactive conversations (tagged in the UI); the entity
// tool excludes them. The advanced options below are human-only — the tool call
// path passes none of them and behaves exactly as it always has.

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { folder, query, scope, from, to } = await req.json();
    if (!String(query || '').trim()) {
      return NextResponse.json({ error: 'Empty query' }, { status: 400 });
    }

    // Dates arrive as epoch ms already widened to whole local days by the
    // client — the browser knows the user's timezone, the server does not.
    const opts = {
      from: typeof from === 'number' ? from : null,
      to: typeof to === 'number' ? to : null,
    };

    if (scope === 'all') {
      const folders = await listSearchableFolders();
      if (folders.length === 0) return NextResponse.json({ error: 'No beings to search' }, { status: 400 });
      return NextResponse.json(await searchFolders(folders, String(query), opts));
    }

    if (!folder) return NextResponse.json({ error: 'Missing folder' }, { status: 400 });
    return NextResponse.json(await searchConversations(String(folder), String(query), opts));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'search failed' }, { status: 500 });
  }
}
