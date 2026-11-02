import { NextResponse } from 'next/server';
import {
  installationId,
  readRunnerHost,
  runnerHostStatus,
  describeRunnerHost,
  setRunnerHost,
  clearRunnerHost,
} from '@/lib/runnerHost';

// Read/set which installation may run server-side turns for this store.
//
// GET  → { self, host, status, message, setAt?, note? }
// POST { host: '<path>' | 'self' } → set
// POST { clear: true }             → back to "nobody hosts"
//
// WHY (measured 2026-10-27/28): two independent clones share ONE local_data by
// junction — 3000 at C:\dev\nexus on `dev`, 3001 at C:\dev\nexus-cairn on
// `main`. The lease in turnQueue prevents double execution. Nothing prevents
// "which installation hosted this being's turn" from changing on every
// restart, because it would be settled by whichever polled first. See
// lib/runnerHost.ts for the full argument.
//
// NO extra authorisation here. The instance has exactly one gate
// (src/middleware.ts) and the reason it is one gate is written there: 60 route
// files are 60 chances to miss a check. Adding a second, different notion of
// "who may do this" in one route would be the start of exactly that.
//
// The rules live in lib/runnerHost.ts, not here. A route cannot be unit tested
// in this house — `next/server` does not load outside Next's own runtime
// (measured 2026-10-27) — so anything with a rule in it must live where a test
// can reach it. This file only translates HTTP to those calls.

export async function GET() {
  try {
    const self = await installationId();
    let host: string | null = null;
    let setAt: string | undefined;
    let note: string | undefined;
    try {
      const rec = await readRunnerHost();
      if (rec) {
        host = rec.host;
        setAt = rec.setAt;
        note = rec.note;
      }
    } catch {
      // Leave host null; status below reports 'unreadable' and the message
      // says so. Swallowing the reason here would be the shape this house
      // keeps removing — but the reason IS carried, by the status.
    }
    const status = await runnerHostStatus(self);
    return NextResponse.json({
      self,
      host,
      status,
      // A sentence, not a boolean. An idle runner that says nothing is
      // indistinguishable from a broken one.
      message: describeRunnerHost(status, self, host ?? undefined),
      ...(setAt ? { setAt } : {}),
      ...(note ? { note } : {}),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'failed to read the runner host flag';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'a JSON object body is required' }, { status: 400 });
    }
    const { host, clear, note } = body as { host?: unknown; clear?: unknown; note?: unknown };
    const self = await installationId();

    if (clear === true) {
      // `removed` is the artifact. Reporting "cleared" when there was nothing
      // to clear is a claim with nothing behind it — `fs.unlink` on a missing
      // path is the same silent success as `rm -f`.
      const removed = await clearRunnerHost();
      const status = await runnerHostStatus(self);
      return NextResponse.json({
        ok: true, removed, self, host: null, status,
        message: describeRunnerHost(status, self),
      });
    }

    if (typeof host !== 'string' || !host.trim()) {
      return NextResponse.json(
        { error: "either host (a path, or the literal 'self') or clear:true is required" },
        { status: 400 },
      );
    }

    // 'self' so a person setting the host from the installation they are
    // looking at does not have to know or type its path — and cannot typo it
    // into a flag that names nothing, which reads as 'not-host' and idles
    // everything.
    const target = host.trim() === 'self' ? self : host;
    const rec = await setRunnerHost(target, { note: typeof note === 'string' ? note : undefined });
    const status = await runnerHostStatus(self);
    return NextResponse.json({
      ok: true, self, host: rec.host, status, setAt: rec.setAt,
      ...(rec.note ? { note: rec.note } : {}),
      message: describeRunnerHost(status, self, rec.host),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'failed to set the runner host flag';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
