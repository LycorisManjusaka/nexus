import { NextResponse } from 'next/server';
import fs from 'fs';
import { mergeVrchatLogs } from '@/lib/vrchatLogs';
import {
  VOICECHANGER_DIR,
  kohaiPath,
  earLogPath,
  voicechangerAvailable,
} from '@/lib/voicechangerPaths';

export const dynamic = 'force-dynamic';

// Small helper for the debug view: existence + size + a short raw preview so we
// can tell, from the work PC's browser, whether the server is even seeing the
// files and whether their *content format* is what the parser expects.
function inspectFile(p: string) {
  try {
    if (!fs.existsSync(p)) return { path: p, exists: false };
    const stat = fs.statSync(p);
    const raw = fs.readFileSync(p, 'utf-8');
    return {
      path: p,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      lineCount: raw.split('\n').length,
      preview: raw.slice(0, 500),
    };
  } catch (e: any) {
    return { path: p, exists: false, error: e?.message || 'stat failed' };
  }
}

// GET /api/vrchat/logs
//   → { text }  the live, time-sorted "[Name] text" transcript merged from
//     kohai.txt + ear_log.txt. Non-destructive: the source files are left intact
//     so the transcript keeps accumulating and stays visible in the input box.
//
// GET /api/vrchat/logs?debug=1
//   → a diagnostic payload (resolved voicechanger dir, env override, per-file
//     existence/size/preview, and the merged text). Open this in a browser on
//     the machine where VRChat mode "does nothing" to see exactly what the
//     server sees — no live VRChat session required.
export async function GET(req: Request) {
  try {
    const debug = new URL(req.url).searchParams.get('debug');
    if (debug) {
      const text = mergeVrchatLogs({ consume: false });
      return NextResponse.json({
        cwd: process.cwd(),
        voicechangerDir: VOICECHANGER_DIR,
        envOverride: process.env.NEXUS_VOICECHANGER_DIR || null,
        voicechangerAvailable: voicechangerAvailable(),
        kohai: inspectFile(kohaiPath()),
        earLog: inspectFile(earLogPath()),
        mergedText: text,
        mergedLength: text.length,
      });
    }
    const text = mergeVrchatLogs({ consume: false });
    return NextResponse.json({ text });
  } catch (e: any) {
    return NextResponse.json({ text: '', error: e?.message || 'merge failed' }, { status: 500 });
  }
}

// POST /api/vrchat/logs  { clear: true }
//   → empties kohai.txt + ear_log.txt. Called right after the merged transcript
//     has been committed to a message so the same speech isn't re-read into the
//     input on the next poll.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.clear) {
      mergeVrchatLogs({ consume: true }); // read-and-discard truncates both files
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: 'no action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'clear failed' }, { status: 500 });
  }
}
