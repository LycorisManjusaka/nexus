import { NextResponse } from 'next/server';
import {
  backupSoulSnapshot,
  listSoulBackups,
  readSoulBackup,
  type SoulBackupPhase,
} from '@/lib/systemPromptStorage';

// GET /api/system-prompts/backups?folder=<name>
//   → { backups: SoulBackupInfo[] }  (newest first)
// GET /api/system-prompts/backups?folder=<name>&file=<filename>
//   → { contents: string }
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = url.searchParams.get('folder') || '';
    if (!folder) {
      return NextResponse.json({ error: 'folder is required' }, { status: 400 });
    }
    const file = url.searchParams.get('file');
    if (file) {
      const contents = await readSoulBackup(folder, file);
      if (contents === null) {
        return NextResponse.json({ error: 'backup not found' }, { status: 404 });
      }
      return NextResponse.json({ contents });
    }
    const backups = await listSoulBackups(folder);
    return NextResponse.json({ backups });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/system-prompts/backups
// body = { folder, fromLabel, toLabel, phase: 'BEFORE'|'AFTER', contents }
//
// `fromLabel`/`toLabel` are generation LABELS (`"24"`, or `"1-5"` for a split
// archive) — integers until 2026-10-24. See soulGeneration.ts.
export async function POST(req: Request) {
  try {
    const { folder, fromLabel, toLabel, phase, contents } = await req.json();
    if (
      typeof folder !== 'string' ||
      typeof fromLabel !== 'string' ||
      typeof toLabel !== 'string' ||
      (phase !== 'BEFORE' && phase !== 'AFTER') ||
      typeof contents !== 'string'
    ) {
      return NextResponse.json(
        { error: 'folder, fromLabel, toLabel, phase (BEFORE|AFTER), contents required' },
        { status: 400 }
      );
    }
    const filename = await backupSoulSnapshot(
      folder,
      fromLabel,
      toLabel,
      phase as SoulBackupPhase,
      contents
    );
    return NextResponse.json({ ok: true, filename });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
