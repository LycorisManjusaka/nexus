import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { beingSoulDir, beingWorkspaceDir } from '@/lib/beingPaths';
import {
  readSystemPromptFile, readAllAgentFiles, readDeletionPatterns, applyDeletionPatterns,
} from '@/lib/systemPromptStorage';
import { loadLog } from '@/lib/fsStorage';
import { enqueue } from '@/lib/turnQueue';
import { installationId } from '@/lib/runnerHost';
import { beingIsBlockedHere, blockedResponseBody } from '@/lib/blockedBeings';
import {
  SURGERY_DIR, SURGERY_FILE, SURGERY_REL_PATH, SURGERY_PURPOSE,
  buildSoulIoInstructions, fillSurgeryProtocol, surgeryShortText,
  splitLayers123, validateEditedSoul, findSurgeryOutcome,
  type SurgeryLang,
} from '@/lib/soulSurgery';

// Soul self-surgery (ζ) — the plumbing. Every RULE is in lib/soulSurgery.ts;
// this file only moves files and enqueues one item.
//
// GET  ?folder=&convoId=
//   → { state: 'none' }
//   | { state: 'elsewhere', convoId, label, startedAt }       (another conversation's)
//   | { state: 'waiting' | 'running' | 'no-marker' | 'complete',
//       label, startedAt, base, tail, edited, editedExists, problems }
//
// POST { action: 'start', folder, convoId, label, lang, uiLang }
//   Copies Layers 1-3 of `<being>_<label>.md` (processing labels removed) to
//   the being's desk, records what it copied, and enqueues ONE 'system' item.
//   The caller kicks the runner — same as a send.
// POST { action: 'clear', folder }
//   Removes the working file and the record. Used for both endings (the
//   result was written / the result was thrown away): what differs between
//   them is what the SPU did BEFORE calling this, not what is left behind.
//
// The record and the base copy live in `soul/spu_work/`, next to the SPU's
// other working files and NOT on the desk: the desk holds the one file the
// being is asked to edit, and nothing it could mistake for a second one.

const STATE_FILE = 'surgery_state.json';
const BASE_FILE = 'surgery_base.md';

interface SurgeryState {
  convoId: string;
  label: string;
  startedAt: number;
  lang: SurgeryLang;
  /** Anything in the soul file from a Layer 4+ heading on. Normally ''. */
  tail: string;
  queueItemId?: string;
}

function workDir(folder: string): string {
  return path.join(beingSoulDir(folder), 'spu_work');
}
function editingPath(folder: string): string {
  return path.join(beingWorkspaceDir(folder), SURGERY_DIR, SURGERY_FILE);
}

async function readState(folder: string): Promise<SurgeryState | null> {
  try {
    const raw = await fs.readFile(path.join(workDir(folder), STATE_FILE), 'utf-8');
    const s = JSON.parse(raw);
    if (!s || typeof s.convoId !== 'string' || typeof s.label !== 'string') return null;
    return {
      convoId: s.convoId,
      label: s.label,
      startedAt: Number(s.startedAt) || 0,
      lang: s.lang === 'en' ? 'en' : 'ja',
      tail: typeof s.tail === 'string' ? s.tail : '',
      queueItemId: typeof s.queueItemId === 'string' ? s.queueItemId : undefined,
    };
  } catch {
    return null;
  }
}

async function readOrNull(p: string): Promise<string | null> {
  try { return await fs.readFile(p, 'utf-8'); } catch { return null; }
}

async function clearAll(folder: string): Promise<void> {
  await fs.rm(editingPath(folder), { force: true }).catch(() => {});
  // The folder only if it is empty — a being that saved something else in
  // there against the instructions keeps it.
  await fs.rmdir(path.dirname(editingPath(folder))).catch(() => {});
  await fs.rm(path.join(workDir(folder), BASE_FILE), { force: true }).catch(() => {});
  await fs.rm(path.join(workDir(folder), STATE_FILE), { force: true }).catch(() => {});
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = (url.searchParams.get('folder') || '').trim();
    const convoId = (url.searchParams.get('convoId') || '').trim();
    if (!folder) return NextResponse.json({ error: 'folder is required' }, { status: 400 });
    const state = await readState(folder);
    if (!state) return NextResponse.json({ state: 'none' });
    if (convoId && state.convoId !== convoId) {
      return NextResponse.json({
        state: 'elsewhere', convoId: state.convoId, label: state.label, startedAt: state.startedAt,
      });
    }
    const log = await loadLog(state.convoId).catch(() => null);
    const outcome = findSurgeryOutcome((log as { messages?: unknown } | null)?.messages, state.startedAt);
    const base = (await readOrNull(path.join(workDir(folder), BASE_FILE))) ?? '';
    const editedRaw = await readOrNull(editingPath(folder));
    const edited = (editedRaw ?? '').replace(/\s+$/, '');
    return NextResponse.json({
      state: outcome,
      label: state.label,
      startedAt: state.startedAt,
      base,
      tail: state.tail,
      edited,
      editedExists: editedRaw !== null,
      problems: validateEditedSoul(base, edited),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const action = typeof body?.action === 'string' ? body.action : '';
  const folder = typeof body?.folder === 'string' ? body.folder.trim() : '';
  if (!folder) return NextResponse.json({ error: 'folder is required' }, { status: 400 });

  try {
    if (action === 'clear') {
      await clearAll(folder);
      return NextResponse.json({ ok: true });
    }

    if (action === 'start') {
      // Starting a surgery wakes the being — the same door a send goes through.
      if (beingIsBlockedHere(folder)) {
        return NextResponse.json(blockedResponseBody(folder), { status: 403 });
      }
      const convoId = typeof body.convoId === 'string' ? body.convoId.trim() : '';
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      const lang: SurgeryLang = body.lang === 'en' ? 'en' : 'ja';
      if (!convoId || !label) {
        return NextResponse.json({ error: 'convoId and label are required' }, { status: 400 });
      }
      // One at a time per being: there is one working file. The caller shows
      // the existing one and offers to discard it; it is never overwritten
      // here, because it may hold an hour of the being's edits.
      const existing = await readState(folder);
      if (existing) {
        return NextResponse.json({ error: 'surgery-in-progress', convoId: existing.convoId }, { status: 409 });
      }

      const real = await readSystemPromptFile(folder, label);
      if (!real || !real.trim()) {
        return NextResponse.json({ error: 'no-soul-file' }, { status: 400 });
      }
      const agents = await readAllAgentFiles(lang);
      const covenant = agents.find((a) => a.name === 'indexer.md')?.content || '';
      // Labels from earlier updater runs are scaffolding for an SPU review,
      // not part of the soul (謡, v2.2). The live prompt already has them
      // removed by the same function at every commit, so the copy the being
      // edits matches what it is actually running on.
      const patterns = await readDeletionPatterns(lang);
      const cleaned = applyDeletionPatterns(real, patterns).replace(/\s+$/, '');
      const { head, tail } = splitLayers123(cleaned);
      if (!head.trim()) return NextResponse.json({ error: 'no-soul-file' }, { status: 400 });

      const abs = editingPath(folder);
      const protocol = fillSurgeryProtocol(covenant, buildSoulIoInstructions(lang, SURGERY_REL_PATH, abs));
      if (!protocol) {
        return NextResponse.json({ error: 'covenant-has-no-slot' }, { status: 400 });
      }

      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, head + '\n', 'utf-8');
      await fs.mkdir(workDir(folder), { recursive: true });
      await fs.writeFile(path.join(workDir(folder), BASE_FILE), head, 'utf-8');

      const startedAt = Date.now();
      let queued;
      try {
        queued = await enqueue(folder, convoId, {
          kind: 'system',
          from: 'NEXUS',
          payload: {
            text: surgeryShortText(lang, SURGERY_REL_PATH),
            attachments: [],
            fullText: protocol,
            purpose: SURGERY_PURPOSE,
          },
          // A button on THIS screen opened the turn, so this installation
          // answers it — unlike a timer-born 'system' item, which has no
          // screen and is left to the store's host flag.
          host: await installationId(),
          uiLang: typeof body.uiLang === 'string' ? body.uiLang : '',
        });
      } catch (e) {
        await clearAll(folder);
        throw e;
      }
      const state: SurgeryState = { convoId, label, startedAt, lang, tail, queueItemId: queued.item.id };
      await fs.writeFile(path.join(workDir(folder), STATE_FILE), JSON.stringify(state, null, 2), 'utf-8');
      return NextResponse.json({ ok: true, startedAt, relPath: SURGERY_REL_PATH, chars: head.length });
    }

    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
