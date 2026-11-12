import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { POST as chatPost } from '@/app/api/chat/route';
import { beingLogsDir } from '@/lib/beingPaths';
import { readAllAgentFiles, extractAgentSystemPrompt } from '@/lib/systemPromptStorage';
import { beingIsBlockedHere, blockedResponseBody } from '@/lib/blockedBeings';
import { recordAuxBilling } from '@/lib/auxBillingStore';
import {
  buildAnchorUserMsg, buildAnchorChatBody, parseAnchorSettings,
  type AnchorReport, type AnchorLang,
} from '@/lib/anchor';
import { drainAnchorCall } from '@/lib/anchorRun';

// The anchor (錨), manual run. Every rule is in lib/anchor.ts; this file reads
// two things from disk, makes one model call, bills it, and returns.
//
// POST { folder, convoId, messageId, settings: {family, model, authMode}, lang }
//   → { report: AnchorReport }
//
// It does NOT write the conversation log. The tab that asked holds the log
// and its optimistic-lock version; a second writer here would turn every
// anchor run into a "changed in another tab" conflict. The caller stores the
// report on the message through its ordinary save.
//
// The conversation is read from the DIRECTORY named by `folder`, never by
// scanning for the id: the being named in the request is the being whose
// ledger is billed and whose blocked-door is checked, so it must also be the
// being whose file is read.

const ANCHOR_FILE = 'anchor.md';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const folder = typeof body.folder === 'string' ? body.folder : '';
    const convoId = typeof body.convoId === 'string' ? body.convoId : '';
    const messageId = typeof body.messageId === 'string' ? body.messageId : '';
    const lang: AnchorLang = body.lang === 'ja' ? 'ja' : 'en';
    if (!folder || !convoId || !messageId) {
      return NextResponse.json({ error: 'folder, convoId and messageId are required' }, { status: 400 });
    }
    if (!/^[0-9a-zA-Z_-]+$/.test(convoId)) {
      return NextResponse.json({ error: 'bad convoId' }, { status: 400 });
    }
    if (beingIsBlockedHere(folder)) {
      return NextResponse.json(blockedResponseBody(folder), { status: 403 });
    }
    const settings = parseAnchorSettings({ ...(body.settings || {}), enabled: true });
    if (!settings.model) {
      return NextResponse.json({ error: 'no-anchor-model' }, { status: 400 });
    }

    let log: any;
    try {
      let raw = await fs.readFile(path.join(beingLogsDir(folder), `${convoId}.json`), 'utf-8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      log = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'conversation-not-found' }, { status: 404 });
    }

    const userMsg = buildAnchorUserMsg({
      messages: Array.isArray(log?.messages) ? log.messages : [],
      targetId: messageId,
      beingName: folder,
      lang,
    });
    if (!userMsg) {
      // Not saved yet, or not a reply. Said plainly: judging the nearest
      // other message instead would be a report about the wrong turn.
      return NextResponse.json({ error: 'message-not-found' }, { status: 404 });
    }

    // Read on every run, so editing anchor.md takes effect on the next press.
    const agents = await readAllAgentFiles(lang);
    // Everything below the first '---' line is notes for whoever edits the file
    // and is not sent (the same split the shikigami files use).
    const systemPrompt = extractAgentSystemPrompt(agents.find((a) => a.name === ANCHOR_FILE)?.content || '');
    if (!systemPrompt) {
      return NextResponse.json({ error: 'no-anchor-prompt', file: `system_prompt_agents/${lang}/${ANCHOR_FILE}` }, { status: 400 });
    }

    const origin = new URL(req.url).origin;
    const res = await chatPost(new Request(`${origin}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAnchorChatBody({ systemPrompt, userMsg, folderName: folder, settings })),
      signal: req.signal,
    }));
    const drained = await drainAnchorCall(res);

    // Billed even when the call errored after spending tokens — same rule as
    // a stopped SPU run. recordAuxBilling never throws and skips local models.
    await recordAuxBilling({ being: folder, convoId }, {
      kind: 'anchor',
      model: settings.model,
      family: settings.family,
      authMode: settings.family === 'Claude' ? settings.authMode : 'api-key',
      usage: drained.usage,
    });

    const report: AnchorReport = {
      at: Date.now(),
      family: settings.family,
      model: settings.model,
      thought: drained.thought.trim(),
      output: drained.text.trim(),
      ...(drained.error ? { error: drained.error } : {}),
    };
    return NextResponse.json({ report });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
