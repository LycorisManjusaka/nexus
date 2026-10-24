import { NextResponse } from 'next/server';
import { shiftRightToLeft } from '@/lib/systemPromptStorage';

// POST /api/system-prompts/shift
// body={ folder, currentLabel, nextLabel, previousLeftContents, newLeftContents }
//
// Called right before an SPU run begins writing into the right pane, when
// the right pane already holds a finished draft. Backs up the current left
// content (best-effort), writes the (old) right content into the left/
// current generation, and clears the right/next generation.
//
// BOTH labels are sent. They were one integer `index` plus `index + 1` until
// 2026-10-24, and the successor of `1-5` is `2-1` — arithmetic has no opinion
// worth having there. See soulGeneration.ts.
export async function POST(req: Request) {
  try {
    const { folder, currentLabel, nextLabel, previousLeftContents, newLeftContents } = await req.json();
    if (
      typeof folder !== 'string' ||
      typeof currentLabel !== 'string' ||
      typeof nextLabel !== 'string' ||
      typeof previousLeftContents !== 'string' ||
      typeof newLeftContents !== 'string'
    ) {
      return NextResponse.json(
        {
          error:
            'folder (string), currentLabel (string), nextLabel (string), previousLeftContents (string), newLeftContents (string) required',
        },
        { status: 400 }
      );
    }
    const result = await shiftRightToLeft(folder, currentLabel, nextLabel, previousLeftContents, newLeftContents);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'shift failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
