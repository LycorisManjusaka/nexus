import { NextResponse } from 'next/server';
import { searchConversations } from '@/lib/conversationSearch';

// Human-facing full-text search across an entity's conversations. All the
// scanning/trimming/author-resolution lives in the shared lib (also used by the
// entity's `search_conversations` tool); this route just exposes it over HTTP.
// The human view includes inactive conversations (tagged in the UI); the entity
// tool excludes them.

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { folder, query } = await req.json();
    if (!folder) return NextResponse.json({ error: 'Missing folder' }, { status: 400 });
    if (!String(query || '').trim()) return NextResponse.json({ error: 'Empty query' }, { status: 400 });

    const result = await searchConversations(String(folder), String(query));
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'search failed' }, { status: 500 });
  }
}
