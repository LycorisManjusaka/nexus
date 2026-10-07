import { NextResponse } from 'next/server';
import { listLogs, saveLog } from '@/lib/fsStorage';

export async function GET() {
  const logs = await listLogs();
  return NextResponse.json(logs);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { id, logData, baseUpdatedAt, preserveUpdatedAt } = body;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  // ensure updatedAt is tracked
  //
  // `preserveUpdatedAt` is for saves that change METADATA, not content —
  // renaming, the active toggle, renumbering. Advancing updatedAt there has two
  // costs, both MEASURED: (1) an open ChatArea's optimistic-concurrency base
  // goes stale the instant you rename from the sidebar, so its very next save
  // 409s with nothing actually in conflict; (2) the sidebar's "latest" ordering
  // treats a rename as new activity, which is a lie about the conversation.
  // Same discipline already applied to opening a conversation (see the
  // skip-next-auto-save flag in ChatArea): updatedAt advances when the content
  // changes, not when we touch the file.
  if (preserveUpdatedAt === true && typeof logData.updatedAt === 'number') {
    // keep the caller's value — it was read from disk moments ago
  } else {
    logData.updatedAt = Date.now();
  }

  // `baseUpdatedAt` is the updatedAt this client last SAW. When present, the
  // save is refused if disk has moved since — that's how a second tab's stale
  // message array stops overwriting this one's (see saveLog for the measured
  // failure). Absent means "unguarded", which is correct for the callers that
  // write a brand-new conversation id (duplicate, import, backup restore):
  // there is no base to compare against.
  const result = await saveLog(id, logData, {
    expectedUpdatedAt: typeof baseUpdatedAt === 'number' ? baseUpdatedAt : undefined,
  });

  if (result && result.ok === false && result.conflict) {
    // 409, not 200-with-a-flag: a refused save must be impossible to mistake
    // for a successful one by a caller that only checks `res.ok`.
    return NextResponse.json({
      error: 'conflict',
      conflict: result.conflict,
    }, { status: 409 });
  }

  return NextResponse.json({ success: true, updatedAt: result?.writtenUpdatedAt ?? logData.updatedAt });
}
