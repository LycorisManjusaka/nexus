import { NextResponse } from 'next/server';
import { appendFile } from 'fs/promises';
import path from 'path';

// TEMPORARY instrument — delete once task 32 is closed.
//
// Appends one JSON line per client event to `local_data/ui_probe.log`, so the
// question "which setMessages path erased the live turn in the second tab?"
// can be answered by reading a file instead of by asking つよ to open devtools
// while she is reproducing the bug. See lib/uiProbe.ts.
//
// Writes to the SHARED store (the same `..\local_data` every other route
// resolves), which is the point: her tab talks to 3001, I read from 3000.
//
// No gate of its own — the instance has exactly one gate (middleware).
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const file = path.resolve(process.cwd(), '..', 'local_data', 'ui_probe.log');
    await appendFile(file, JSON.stringify(body) + '\n', 'utf8');
  } catch {
    // A probe that can fail a request is worse than a probe that misses a line.
  }
  return NextResponse.json({ ok: true });
}
