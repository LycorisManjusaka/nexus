import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { mergeVrchatLogs } from '@/lib/vrchatLogs';
import {
  VOICECHANGER_DIR,
  VOICECHANGER_DATA_DIR,
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
        voicechangerDataDir: VOICECHANGER_DATA_DIR,
        envOverride: process.env.NEXUS_VOICECHANGER_DIR || null,
        dataEnvOverride: process.env.NEXUS_VOICECHANGER_DATA_DIR || null,
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

// POST /api/vrchat/logs
//   { consume: true } → read-AND-clear in one atomic op; RETURNS { ok, text }.
//       Used at image-capture time so whatever is in kohai/ear right now is
//       grabbed and truncated together — closing the race where speech that
//       reached the files but hadn't yet been polled into the input box would
//       be wiped without being captured (data loss).
//   { clear: true }   → empties kohai.txt + ear_log.txt (returns no text).
//       Used on a normal manual send, where the text was already committed to
//       the message from the visible input.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.consume) {
      const text = mergeVrchatLogs({ consume: true }); // truncates + returns
      return NextResponse.json({ ok: true, text });
    }
    if (body?.clear) {
      mergeVrchatLogs({ consume: true }); // read-and-discard truncates both files
      return NextResponse.json({ ok: true });
    }
    // Clear ONE file. The `clear` above always truncates both, which is right
    // when a message has just been sent — but the manual buttons need to drop
    // only your own speech, or only what was heard, independently. Mirrors the
    // clear_kohai.bat / clear_ear.bat pair in the voicechanger folder.
    if (body?.clearKohai || body?.clearEar) {
      const target = body.clearKohai ? kohaiPath() : earLogPath();
      const label = body.clearKohai ? 'kohai.txt' : 'ear_log.txt';
      if (!voicechangerAvailable()) {
        return NextResponse.json({ ok: false, error: 'voicechanger folder not found' }, { status: 404 });
      }
      let had = 0;
      try { had = fs.statSync(target).size; } catch { /* missing = already empty */ }
      // Back up before truncating, the same discipline the capture path uses —
      // an accidental click should never be unrecoverable.
      if (had > 0) {
        try {
          const dir = path.join(VOICECHANGER_DATA_DIR, body.clearKohai ? 'kohai_backup' : 'ear_backup');
          fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          fs.copyFileSync(target, path.join(dir, `${stamp}_manual.txt`));
        } catch { /* best effort — never block the clear */ }
      }
      try { fs.writeFileSync(target, '', 'utf-8'); } catch (e: any) {
        return NextResponse.json({ ok: false, error: e?.message || `could not clear ${label}` }, { status: 500 });
      }
      return NextResponse.json({ ok: true, cleared: label, bytes: had });
    }
    return NextResponse.json({ ok: false, error: 'no action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'clear failed' }, { status: 500 });
  }
}
