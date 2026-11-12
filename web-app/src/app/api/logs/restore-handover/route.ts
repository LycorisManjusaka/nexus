import { NextResponse } from 'next/server';
import { listLogs, loadLog, listFolders } from '@/lib/fsStorage';
import {
  pickFromGeneration,
  messageIdentityKey,
  restoreGateReason,
  MAX_GENERATIONS_SCANNED,
  type RestorePlanReply,
} from '@/lib/handoverRestore';
import { resolveHandoverChain } from '@/lib/handoverWalk';

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
  // The vessel the client sized `budgetTokens` against. Both sides must measure
  // candidate messages on one scale or the restore over/undershoots the cap.
  // Absent (an older client, or a caller that cannot know) is an explicit null
  // rather than a substituted default: `tokenFamilyFor` maps it to the
  // conservative mid-range profile instead of pretending a vessel was chosen.
  const model: string | null = typeof body?.model === 'string' ? body.model : null;
  // Past generations (not the chain head) are restored ONLY when the caller
  // passes this — i.e. the user explicitly RAISED the cap on this conversation.
  // Opening a past generation must never silently grow it; see
  // `restoreGateReason` and the 'not-head' reason. Absent, or anything but
  // literal true, means head-only — the behaviour before this flag existed.
  const includePast: boolean = body?.includePast === true;

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

  // The chain — which conversations are "older", and whether this one is the
  // head — is decided in ONE place (`resolveHandoverChain`) so the walk and the
  // guard below cannot drift apart. Two rules live there: the generation number
  // `<being>_<n>`, and, for titles that carry no number, the sidebar's own row
  // order. The folder's manual drag order is an input to the second one, so it
  // has to be read here; absent, the comparator falls back to `updatedAt`
  // descending, which is still the order on screen.
  const folders = await listFolders();
  const convoOrder: string[] = (() => {
    const f = folders.find((x: any) => x.name === self.folderName);
    const o = f?.settings?.convoOrder;
    return Array.isArray(o) ? o.map((s: any) => String(s)) : [];
  })();
  const chain = resolveHandoverChain(logs, self, convoOrder);
  const olderLogs = chain.older;

  // The whole restore gate — inactive / orphan / no-older / not-head — lives in
  // ONE pure place (`restoreGateReason`) so the branch order is testable without
  // disk and cannot drift from the comment. The facts it decides on:
  //
  //  - `active`: an inactive conversation ("…" → Mark inactive, dimmed in the
  //    sidebar) never has its history put back — head or past, with or without
  //    `includePast`. It is one the user set aside. Checked FIRST.
  //
  //  - `isHead` + `includePast`: only the HEAD of a chain restores on OPEN. A
  //    conversation with a newer generation above it is history — exactly what
  //    the past-log band warns about — and this guard is what makes the marker
  //    default in ChatArea's load path safe. MEASURED 2026-10-23 over 477 logs:
  //    head-only starts auto-restore on 1 conversation; without the guard, 245,
  //    spread over 9 beings (164 of someone else's imported 177-generation
  //    archive, 37 of another inhabitant's chain, 18 of Cairn's own past
  //    generations) would each pull predecessors in and save, silently, just
  //    from being opened. `includePast` is the opt-in: a user who explicitly
  //    RAISES the cap on a past generation — to collect a complete transcript
  //    for statistics — gets the restore; opening alone never passes it.
  //    MEASURED 2026-10-24, 492 logs: head-only gives a chain to 3 previously
  //    chainless conversations; without it, 59.
  //
  // Order: 'inactive' before the chain; 'no-older' before 'not-head' (generation
  // 1 has nothing to put back whether or not newer generations exist, so that is
  // the more fundamental fact — MEASURED: reversed, Орион_1 reported 'not-head',
  // true but less informative). The walk is a filter over already-loaded headers,
  // no file reads, so the order costs nothing. `self.active` is `meta.active !==
  // false` from listLogs — undefined reads as active, so only an explicit
  // Mark-inactive blocks restore.
  const gateReason = restoreGateReason({
    active: self.active !== false,
    orphan: chain.orphan,
    olderCount: olderLogs.length,
    isHead: chain.isHead,
    includePast,
  });
  if (gateReason) return NextResponse.json(empty(gateReason));

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

    const pick = pickFromGeneration(log.messages || [], excluded, remaining, model);
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
