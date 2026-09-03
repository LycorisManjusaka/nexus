import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { beingTtsDictFile } from '@/lib/beingPaths';

export const dynamic = 'force-dynamic';

const dictPath = (folder: string) => beingTtsDictFile(folder);

// GET /api/tts-dict?folder=X → { content }   (raw JSON text, '' if none)
export async function GET(req: Request) {
  try {
    const folder = new URL(req.url).searchParams.get('folder') || '';
    if (!folder) return NextResponse.json({ content: '' });
    try {
      const content = await fs.readFile(dictPath(folder), 'utf-8');
      return NextResponse.json({ content });
    } catch {
      return NextResponse.json({ content: '' });
    }
  } catch (e: any) {
    return NextResponse.json({ content: '', error: e?.message }, { status: 500 });
  }
}

// POST /api/tts-dict  { folder, content }
//   Writes the per-entity dictionary. An empty/blank body removes the file.
//   The content must be a JSON object (string→string) or it's rejected.
export async function POST(req: Request) {
  try {
    const { folder, content } = await req.json();
    if (!folder || typeof folder !== 'string') {
      return NextResponse.json({ error: 'folder is required' }, { status: 400 });
    }
    const p = dictPath(folder);
    if (!content || !String(content).trim()) {
      try { await fs.unlink(p); } catch {}
      return NextResponse.json({ ok: true, removed: true });
    }
    let parsed: any;
    try { parsed = JSON.parse(content); } catch {
      return NextResponse.json({ error: 'Not valid JSON' }, { status: 400 });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Must be a JSON object of "from": "to" string pairs' }, { status: 400 });
    }
    await fs.mkdir(path.dirname(p), { recursive: true });
    // Re-serialize so the stored file is normalized/pretty.
    await fs.writeFile(p, JSON.stringify(parsed, null, 2), 'utf-8');
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'write failed' }, { status: 500 });
  }
}
