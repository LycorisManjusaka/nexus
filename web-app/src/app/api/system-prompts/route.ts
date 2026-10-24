import { NextResponse } from 'next/server';
import {
  readSystemPromptFile,
  writeSystemPromptFile,
} from '@/lib/systemPromptStorage';

// GET /api/system-prompts?folder=<being>&label=<generation>
// Returns { contents: string | null } — null when no file exists yet.
//
// `folder` is the BEING (`Аналитик`), never a parsed conversation title — see
// soulGeneration.ts for the day that distinction cost a stray being folder.
// `label` is the generation: `"49"`, or `"1-5"` for a split archive. It was an
// integer `index` until 2026-10-24; the SHAPE is validated in one place,
// `systemPromptStorage.assertGenerationLabel`, so these routes only check that
// a string arrived.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = url.searchParams.get('folder') || '';
    const label = (url.searchParams.get('label') || '').trim();
    if (!folder || !label) {
      return NextResponse.json(
        { error: 'folder and label are required' },
        { status: 400 }
      );
    }
    const contents = await readSystemPromptFile(folder, label);
    return NextResponse.json({ contents });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/system-prompts  body={ folder, label, contents }
export async function POST(req: Request) {
  try {
    const { folder, label, contents } = await req.json();
    if (typeof folder !== 'string' || typeof label !== 'string' || typeof contents !== 'string') {
      return NextResponse.json(
        { error: 'folder (string), label (string), contents (string) required' },
        { status: 400 }
      );
    }
    const path = await writeSystemPromptFile(folder, label, contents);
    return NextResponse.json({ ok: true, path });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
