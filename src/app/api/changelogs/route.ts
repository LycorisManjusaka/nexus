import { NextResponse } from 'next/server';
import { readChangelog, writeChangelog } from '@/lib/changelogStorage';

// GET /api/changelogs?folder=X&title=Y  → { content: string | null }
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = url.searchParams.get('folder') || '';
    const title = url.searchParams.get('title') || '';
    if (!folder || !title) {
      return NextResponse.json({ error: 'folder and title are required' }, { status: 400 });
    }
    const content = await readChangelog(folder, title);
    return NextResponse.json({ content });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/changelogs  body={ folder, title, content }
export async function POST(req: Request) {
  try {
    const { folder, title, content } = await req.json();
    if (typeof folder !== 'string' || typeof title !== 'string' || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'folder (string), title (string), content (string) required' },
        { status: 400 },
      );
    }
    const path = await writeChangelog(folder, title, content);
    return NextResponse.json({ ok: true, path });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
