// ⚠ TEMPORARY INSTRUMENT (bug 32, 2026-11-07). A second tab joining a running
// turn paints the live pair, then a full-array setMessages replaces it and the
// pair is gone. Four client callers can do that and they leave identical
// evidence (ChatArea.tsx:3131), so reading cannot name the culprit. This sink
// appends one line per full-array replace / attach event to a file Cairn reads
// from port 3000, so つよ only has to reproduce — she copies nothing.
// REMOVE this route and its client calls together once the overwrite is named.
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { DATA_DIR } from '@/lib/beingPaths';

const LOG = path.join(DATA_DIR, 'debug_probe_32.log');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const line = JSON.stringify({ at: Date.now(), ...body }) + '\n';
    await fs.appendFile(LOG, line, 'utf8');
  } catch {
    // Best-effort — a probe failure must never affect the thing being measured.
  }
  return NextResponse.json({ ok: true });
}
