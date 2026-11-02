import { NextResponse } from 'next/server';
import { beginTurn, endTurn, publishTurnText, liveTurnStatus } from '@/lib/turnBus';
import { onStop } from '@/lib/turnStop';
import { runSpuAction } from '@/lib/runSpuAction';
import { spuRelayKey, type SpuRunRecord } from '@/lib/spuRun';
import {
  readSpuRunRecord,
  writeSpuRunRecord,
  clearSpuRunRecord,
} from '@/lib/systemPromptStorage';
import { installationId } from '@/lib/runnerHost';
// The SECOND route-to-route import in this tree (/api/runner/tick is the
// first, and says why: a runner is the same process, so it does not need a key
// to get past its own admin gate). The cost is the same one line of
// untestability, which is why every rule lives in lib.
import { POST as chatPost } from '@/app/api/chat/route';

// Server-side System Prompt Updater runs (2026-10-31).
//
// POST   { folder, label, action, convoId, userMsg, agentSystemPrompt, lang,
//          resumeText, aiName, specificModel, authMode?, modelParams,
//          maxContinuations?, force? }
//          → opens the relay, answers immediately, runs in the background
// GET    ?folder=&label=        → { record, live }
// DELETE ?folder=&label=        → { cleared }
//
// This is what makes "start a soul update, close the tab, come back and it is
// finished" true. Until now the panel's loop ran in the browser: a soul update
// is minutes long across up to seven provider calls, nothing was written down
// until it ended, and closing the tab threw all of it away.
//
// ── WHY THE RUNNER HOST FLAG IS *NOT* CONSULTED ───────────────────────────
//
// /api/runner/tick honours it even for a manual tick, because a SWEEP can pick
// up a conversation nobody asked about, in whichever of the two installations
// sharing this local_data happens to be polling — and which tree answered is
// invisible from the screen.
//
// An SPU run has no sweep. It exists only because a human pressed a button in
// a panel that is showing them that being, in a specific tab, against a
// specific port. The tree is not invisible: it is the tab they are in.
// Honouring the host flag here would mean the soul updater silently stops
// working in :3001 whenever :3000 is the host — which is the arrangement
// today, and :3001 is where everyone actually lives.
//
// ── WHY THERE IS NO TTL ON THE RECORD ──────────────────────────────────────
//
// Concurrency is guarded two ways, and only the first is free: the relay
// refuses a second run in the SAME process, and the record refuses one across
// processes. The record guard needs no clock — a TTL short enough to release a
// crashed run would cut a healthy seven-round run in half, which is the same
// reasoning turnQueue gives for having no lease TTL. So a stuck record is
// broken by a human, with `force`, after being told which installation left it.

function fail(e: unknown, fallback: string) {
  const msg = e instanceof Error ? e.message : fallback;
  return NextResponse.json({ error: msg }, { status: 500 });
}

function newTurnId(): string {
  return `turn_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = str(url.searchParams.get('folder')).trim();
    const label = str(url.searchParams.get('label')).trim();
    if (!folder || !label) {
      return NextResponse.json({ error: 'folder and label are required' }, { status: 400 });
    }
    const record = await readSpuRunRecord(folder, label);
    return NextResponse.json({
      record,
      live: liveTurnStatus(spuRelayKey(folder, label)),
      relayKey: spuRelayKey(folder, label),
    });
  } catch (e) {
    return fail(e, 'reading the SPU run record failed');
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const folder = str(url.searchParams.get('folder')).trim();
    const label = str(url.searchParams.get('label')).trim();
    if (!folder || !label) {
      return NextResponse.json({ error: 'folder and label are required' }, { status: 400 });
    }
    const cleared = await clearSpuRunRecord(folder, label);
    return NextResponse.json({ ok: true, cleared });
  } catch (e) {
    return fail(e, 'clearing the SPU run record failed');
  }
}

export async function POST(req: Request) {
  try {
    const body: Record<string, unknown> = (await req.json()) || {};
    const folder = str(body.folder).trim();
    const label = str(body.label).trim();
    const userMsg = str(body.userMsg);
    const agentSystemPrompt = str(body.agentSystemPrompt);
    if (!folder || !label || !userMsg || !agentSystemPrompt) {
      return NextResponse.json(
        { error: 'folder, label, userMsg and agentSystemPrompt are all required' },
        { status: 400 },
      );
    }
    const lang = body.lang === 'en' ? 'en' : 'ja';
    const relayKey = spuRelayKey(folder, label);

    // Already streaming in THIS process: do not start a second run. Opening a
    // second relay would disconnect whoever is watching the first, and two
    // runs would overwrite each other's record.
    if (liveTurnStatus(relayKey)?.live === true) {
      return NextResponse.json({ ok: true, started: false, attached: true, relayKey });
    }

    const self = await installationId();

    // Across processes the relay cannot help — see the TTL note above.
    if (body.force !== true) {
      const prev = (await readSpuRunRecord(folder, label)) as SpuRunRecord | null;
      if (prev && prev.status === 'running') {
        return NextResponse.json({
          ok: false,
          started: false,
          reason: 'running',
          // Named, not implied: the caller has to be able to tell "my own tab
          // crashed" from "someone else is updating this soul right now", and
          // those have opposite right answers.
          host: prev.host || '(unrecorded)',
          startedAt: prev.startedAt,
          updatedAt: prev.updatedAt,
          attempts: prev.attempts,
          chars: prev.accum.length,
          relayKey,
        });
      }
    }

    const turnId = newTurnId();
    beginTurn(relayKey, turnId);

    let stopped = false;
    const offStop = onStop(relayKey, turnId, () => { stopped = true; });

    const origin = new URL(req.url).origin;
    void runSpuAction(
      {
        folder,
        label,
        action: str(body.action) || 'update',
        convoId: str(body.convoId),
        userMsg,
        agentSystemPrompt,
        lang,
        resumeText: str(body.resumeText),
        aiName: str(body.aiName),
        specificModel: str(body.specificModel),
        authMode: body.authMode === 'oauth' || body.authMode === 'api-key' ? body.authMode : undefined,
        modelParams: (body.modelParams || {}) as Record<string, unknown>,
        maxContinuations: typeof body.maxContinuations === 'number' ? body.maxContinuations : undefined,
        // So a Stop aborts the call in flight, not just the next round.
        relayKey,
        turnId,
      },
      {
        chatPost,
        writeRecord: writeSpuRunRecord,
        onRawText: (text) => publishTurnText(relayKey, text),
        isAborted: () => stopped,
        nowMs: () => Date.now(),
        newId: () => crypto.randomUUID(),
        origin,
        host: self,
      },
    )
      .then((r) => {
        offStop();
        // F46 again: a background run that says nothing is indistinguishable
        // from one that is broken, and a detached pass has no response to say
        // it in. The only reader is whoever opens the server console.
        console.log(
          r.ok
            ? `[spu] ${r.record.action} ${folder}/${label} — ${r.record.status}, ${r.record.attempts} call(s), ${r.record.accum.length} chars, sentinel=${r.record.sawSentinel}`
            : `[spu] FAILED ${folder}/${label} at ${r.stage}: ${r.reason}`,
        );
        endTurn(
          relayKey,
          r.ok
            ? r.record.status === 'stopped' ? { type: 'notice', content: 'Stopped.' } : undefined
            : { type: 'error', error: r.reason },
        );
      })
      .catch((e) => {
        offStop();
        console.error('[spu] detached run threw:', e);
        endTurn(relayKey, { type: 'error', error: String((e as Error)?.message || e) });
      });

    return NextResponse.json({ ok: true, started: true, attached: false, relayKey, turnId, host: self });
  } catch (e) {
    return fail(e, 'starting the SPU run failed');
  }
}
