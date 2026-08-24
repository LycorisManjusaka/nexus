import { NextResponse } from 'next/server';
import { shiftRightToLeft } from '@/lib/systemPromptStorage';

// POST /api/system-prompts/shift
// body={ folder, index, previousLeftContents, newLeftContents }
//
// Called right before an SPU run begins writing into the right pane, when
// the right pane already holds a finished draft. Backs up the current left
// content (best-effort), writes the (old) right content into the left/
// current index, and clears the right/next index.
export async function POST(req: Request) {
  try {
    const { folder, index, previousLeftContents, newLeftContents } = await req.json();
    if (
      typeof folder !== 'string' ||
      typeof index !== 'number' ||
      typeof previousLeftContents !== 'string' ||
      typeof newLeftContents !== 'string'
    ) {
      return NextResponse.json(
        {
          error:
            'folder (string), index (number), previousLeftContents (string), newLeftContents (string) required',
        },
        { status: 400 }
      );
    }
    const result = await shiftRightToLeft(folder, index, previousLeftContents, newLeftContents);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'shift failed' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
