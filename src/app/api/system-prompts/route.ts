import { NextResponse } from 'next/server';
import {
  readSystemPromptFile,
  writeSystemPromptFile,
} from '@/lib/systemPromptStorage';

// GET /api/system-prompts?folder=<name>&index=<n>
// Returns { contents: string | null } — null when no file exists yet.
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
    const contents = await readSystemPromptFile(folder, index);
    return NextResponse.json({ contents });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/system-prompts  body={ folder, index, contents }
export async function POST(req: Request) {
  try {
    const { folder, index, contents } = await req.json();
    if (typeof folder !== 'string' || typeof index !== 'number' || typeof contents !== 'string') {
      return NextResponse.json(
        { error: 'folder (string), index (number), contents (string) required' },
        { status: 400 }
      );
    }
    const path = await writeSystemPromptFile(folder, index, contents);
    return NextResponse.json({ ok: true, path });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
