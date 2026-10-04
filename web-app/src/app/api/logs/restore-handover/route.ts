import { NextResponse } from 'next/server';
import { listLogs, loadLog } from '@/lib/fsStorage';
import { numberedIdentityTitleIndex } from '@/lib/convoNaming';
import {
  pickFromGeneration,
  messageIdentityKey,
  MAX_GENERATIONS_SCANNED,
  type RestorePlanReply,
} from '@/lib/handoverRestore';
import { olderGenerationsNewestFirst } from '@/lib/handoverWalk';

/**
 * Plan a handover restore: which messages from older generations should be put
 * back at the top of this conversation, given how much room is left.
 *
 * This endpoint READS ONLY. It never writes a log. The client prepends what
 * comes back and its own save path persists the result, so one failed restore
 * cannot leave a conversation half-rewritten on disk.
 *
 * Request:  { convoId, budgetTokens, excludeKeys }
 *   excludeKeys — identity keys (see `messageIdentityKey`) for every message the
 *   client currently holds. The client's in-memory list is authoritative, not
 *   the file: a message sent seconds ago may not have reached disk yet, and
 *   handing it back as "restored" would duplicate it.
 *
 * Reply: RestorePlanReply — see lib/handoverRestore.ts.
 *
 * Generations are read newest-first and stop as soon as the budget is hit, so a
 * 50k restore does not parse 37 conversations to answer.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const convoId: string = body?.convoId;
  const budgetTokens: number = Number(body?.budgetTokens);
  const excludeKeys: string[] = Array.isArray(body?.excludeKeys) ? body.excludeKeys : [];

  if (!convoId) return NextResponse.json({ error: 'Missing convoId' }, { status: 400 });
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    return NextResponse.json({ error: 'budgetTokens must be a positive number' }, { status: 400 });
  }

  const empty = (reason?: RestorePlanReply['reason']): RestorePlanReply => ({
    messages: [], tokens: 0, generations: [], nextNeeded: null, truncated: false,
    ...(reason ? { reason } : {}),
  });

  const logs = await listLogs();
  const self = logs.find((l: any) => l.id === convoId);
  if (!self) return NextResponse.json(empty('not-found'));

  // 'not-numbered' vs 'no-older' are distinct answers here (the client renders
  // them differently), so the index check stays explicit; the generation walk
  // itself is the shared skeleton in handoverWalk.
  const index = numberedIdentityTitleIndex(self.title, self.folderName);
  if (index === null) return NextResponse.json(empty('not-numbered'));

  const olderLogs = olderGenerationsNewestFirst(logs, self);
  if (olderLogs.length === 0) return NextResponse.json(empty('no-older'));

  const excluded = new Set<string>(excludeKeys);
  let remaining = budgetTokens;
  let restored: any[] = [];
  let totalTokens = 0;
  const generations: RestorePlanReply['generations'] = [];
  let nextNeeded: number | null = null;
  let truncated = false;
  let scanned = 0;

  for (const l of olderLogs) {
    if (scanned >= MAX_GENERATIONS_SCANNED) { truncated = true; break; }
    scanned++;
    const log: any = await loadLog(l.id);
    if (!log) continue;

    const pick = pickFromGeneration(log.messages || [], excluded, remaining);
    for (const m of pick.picked) excluded.add(messageIdentityKey(m));

    if (pick.picked.length > 0) {
      // Older generation goes in FRONT — the result is one chronological run.
      restored = [...pick.picked, ...restored];
      generations.unshift({ title: l.title, count: pick.picked.length, tokens: pick.tokens });
      totalTokens += pick.tokens;
      remaining -= pick.tokens;
    }

    // Only a budget stop ends the walk. Running out of budget WITHOUT being told
    // what the next message needs is not a stopping condition: `nextNeeded: null`
    // is the client's signal that there is nothing left anywhere, and reporting
    // it on a budget stop would freeze restore for the rest of the conversation.
    // When `remaining` has reached 0, the next generation's first candidate
    // can't fit either, so the following iteration fills in `nextNeeded` and
    // breaks here — one extra file read buys an honest answer.
    if (pick.nextNeeded !== null) { nextNeeded = pick.nextNeeded; break; }
  }

  const reply: RestorePlanReply = {
    messages: restored, tokens: totalTokens, generations, nextNeeded, truncated,
  };
  return NextResponse.json(reply);
}
