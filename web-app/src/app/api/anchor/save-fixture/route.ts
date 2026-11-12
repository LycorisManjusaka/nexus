import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { beingLogsDir, beingWorkspaceDir } from '@/lib/beingPaths';
import { readAllAgentFiles, extractAgentSystemPrompt } from '@/lib/systemPromptStorage';
import { beingIsBlockedHere, blockedResponseBody } from '@/lib/blockedBeings';
import { buildAnchorUserMsg, type AnchorLang, type AnchorReport } from '@/lib/anchor';
import {
  buildAnchorFixture, anchorFixtureFilename,
  ANCHOR_LAB_OWNER, ANCHOR_LAB_DIR, ANCHOR_FIXTURES_DIR,
} from '@/lib/anchorFixture';

// Save one anchor run as a test-bench fixture for 謡's offline toy.
//
// POST { folder, convoId, messageId, lang, report: AnchorReport }
//   → { saved: true, file: '<relative path under 謡's workspace>' }
//
// It rebuilds the context the SAME way api/anchor does (buildAnchorUserMsg from
// the log) rather than trusting the client's copy — the fixture must be exactly
// what the anchor received. The `report` (thought/output) comes from the client
// because it is already stored on the message; re-running the model here would
// cost a call and could differ from the report the admin is looking at.
//
// The fixture lands on 謡's desk (she owns the anchor's rules), not the observed
// being's — see ANCHOR_LAB_OWNER in lib/anchorFixture.ts.

const ANCHOR_FILE = 'anchor.md';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const folder = typeof body.folder === 'string' ? body.folder : '';
    const convoId = typeof body.convoId === 'string' ? body.convoId : '';
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const lang: AnchorLang = body.lang === 'ja' ? 'ja' : 'en';
    const report = (body.report && typeof body.report === 'object' ? body.report : null) as AnchorReport | null;
    if (!folder || !convoId || !messageId || !report) {
      return NextResponse.json({ error: 'folder, convoId, messageId and report are required' }, { status: 400 });
    }
    if (!/^[0-9a-zA-Z_-]+$/.test(convoId)) {
      return NextResponse.json({ error: 'bad convoId' }, { status: 400 });
    }
    // Same door as the anchor run: the being being read is the being named.
    if (beingIsBlockedHere(folder)) {
      return NextResponse.json(blockedResponseBody(folder), { status: 403 });
    }

    let log: any;
    try {
      let raw = await fs.readFile(path.join(beingLogsDir(folder), `${convoId}.json`), 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      log = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'conversation-not-found' }, { status: 404 });
    }

    const context = buildAnchorUserMsg({
      messages: Array.isArray(log?.messages) ? log.messages : [],
      targetId: messageId,
      beingName: folder,
      lang,
    });
    if (!context) {
      return NextResponse.json({ error: 'message-not-found' }, { status: 404 });
    }

    // The prompt in effect now, for reference inside the fixture. Read on save
    // so the fixture records what produced its original verdict.
    const agents = await readAllAgentFiles(lang);
    const promptAtSave = extractAgentSystemPrompt(agents.find((f) => f.name === ANCHOR_FILE)?.content || '');

    const fixture = buildAnchorFixture({
      being: folder, lang, context, report, promptAtSave, nowMs: Date.now(),
    });

    const dir = path.join(beingWorkspaceDir(ANCHOR_LAB_OWNER), ANCHOR_LAB_DIR, ANCHOR_FIXTURES_DIR);
    await fs.mkdir(dir, { recursive: true });
    const name = anchorFixtureFilename(fixture.savedAt, messageId);
    await fs.writeFile(path.join(dir, name), JSON.stringify(fixture, null, 2), 'utf-8');

    return NextResponse.json({
      saved: true,
      file: `beings/${ANCHOR_LAB_OWNER}/workspace/${ANCHOR_LAB_DIR}/${ANCHOR_FIXTURES_DIR}/${name}`,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
