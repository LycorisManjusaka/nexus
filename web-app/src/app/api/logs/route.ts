import { NextResponse } from 'next/server';
import { listLogs, saveLog } from '@/lib/fsStorage';
import { jsonMaybeGzip } from '@/lib/jsonGzip';

// `req` is taken only to read Accept-Encoding. Measured 2026-11-01: 305
// conversations => 46,383 B, and this is on the critical path of every cold
// start (the sidebar cannot render without it).
export async function GET(req: Request) {
  const logs = await listLogs();
  return jsonMaybeGzip(req, logs);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { id, logData, baseUpdatedAt, preserveUpdatedAt, clientId } = body;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  // Same class of hole as the unwrapped `saveLog` below: without this, a body
  // with no `logData` throws a TypeError on the very next line and leaves the
  // handler as a bare 500 — a client-side mistake reported as a server fault.
  if (!logData || typeof logData !== 'object') {
    return NextResponse.json({ error: 'Missing or non-object logData' }, { status: 400 });
  }

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
  // `saveLog` CAN throw, and the reason is the useful part. Measured causes:
  // EPERM on the atomic rename when a concurrent reader holds the target open
  // (10/10 with a reader present, 0/10 without — see p20/p22), ENOSPC on a
  // full disk, EACCES after a permission change. Unwrapped, the throw leaves
  // this handler and Next turns it into a bare 500: the client then shows an
  // honest banner ("nothing on screen is lost, but this turn is not on disk")
  // with no reason in it. The 409 branch below already returns a structured
  // reason — the same route knew how to do this, in the branch next door.
  let result: Awaited<ReturnType<typeof saveLog>>;
  try {
    result = await saveLog(id, logData, {
      expectedUpdatedAt: typeof baseUpdatedAt === 'number' ? baseUpdatedAt : undefined,
      // Passed straight through; lastWriter decides what is recordable.
      clientId,
    });
  } catch (e: unknown) {
    const err = e as { code?: unknown; message?: unknown };
    console.error(`[api/logs] saveLog threw for id=${id}:`, e);
    return NextResponse.json({
      error: 'write-failed',
      // The errno is what makes the banner actionable: EPERM reads as "try
      // again", ENOSPC as "free some space". Null when the thrown value has
      // none, rather than inventing one.
      code: typeof err?.code === 'string' ? err.code : null,
      message: String(err?.message ?? e),
    }, { status: 500 });
  }

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
