/**
 * Handover generation walk — server-only.
 *
 * Reads older generations of a being's conversation chain off disk. Two callers
 * share the fragile part (finding the chain and ordering it); each brings its
 * own pick strategy:
 *
 *  - `api/logs/restore-handover` picks by TOKEN budget (put back as much carried
 *    history as the cap allows), and persists the result.
 *  - the OAuth refusal-perturbation retry (route.ts) picks by MESSAGE COUNT (add
 *    a couple of genuine older messages to reshuffle a deterministic
 *    reasoning_extraction refusal), wire-only — never saved, never shown.
 *
 * This file imports fsStorage/convoNaming, so it is SERVER-ONLY and must never be
 * pulled into a client bundle (unlike `handoverRestore.ts`, which is pure and
 * shared with ChatArea). Keep the two apart. The two PURE functions below
 * (`olderGenerationsNewestFirst`, `pickCountFromMessages`) carry all the
 * orderable logic and depend only on pure helpers, so they can be measured from
 * shipped bytes without disk.
 */
import { listLogs, loadLog } from '@/lib/fsStorage';
import { numberedIdentityTitleIndex } from '@/lib/convoNaming';
import { messageIdentityKey, MAX_GENERATIONS_SCANNED } from '@/lib/handoverRestore';

/**
 * Older generations of the SAME being as `self`, newest generation first.
 *
 * The number in the title (`<being>_<n>`) defines the chain. A hand-picked title
 * (no number) has no predecessors → []. Archived conversations are included on
 * purpose: the archive flag only controls what the sidebar lists, while the
 * number is what defines the chain — skipping archived logs would open a hole in
 * the middle of a being's history. This is the one fragile skeleton both callers
 * share, so it lives here and is not copied in each.
 */
export function olderGenerationsNewestFirst(logs: any[], self: any): any[] {
  const index = numberedIdentityTitleIndex(self.title, self.folderName);
  if (index === null) return [];
  return logs
    .map((l: any) => ({ l, n: numberedIdentityTitleIndex(l.title, l.folderName) }))
    .filter((x: any) => x.l.folderName === self.folderName && x.n !== null && x.n < index && !x.l.corrupted)
    .sort((a: any, b: any) => b.n - a.n)
    .map((x: any) => x.l);
}

/**
 * Take up to `need` messages from ONE generation's tail, newest end backwards,
 * skipping anything already held, returned OLDEST-FIRST for prepending.
 *
 * `excluded` is MUTATED: every key picked is added, so the caller's set carries
 * forward and a message is never taken twice across generations. The newest-end
 * walk takes the message closest to what we already have first — the one that
 * reconnects the history — exactly mirroring `pickFromGeneration`.
 */
export function pickCountFromMessages(msgs: any[], excluded: Set<string>, need: number): any[] {
  const pickNewestFirst: any[] = [];
  if (!Array.isArray(msgs) || need <= 0) return pickNewestFirst;
  for (let i = msgs.length - 1; i >= 0 && pickNewestFirst.length < need; i--) {
    const m = msgs[i];
    if (!m) continue;
    const key = messageIdentityKey(m);
    if (excluded.has(key)) continue;
    excluded.add(key);
    pickNewestFirst.push(m);
  }
  return pickNewestFirst.reverse();
}

/**
 * Collect up to `limit` messages from older generations, newest-adjacent first,
 * returned OLDEST-FIRST so the caller can prepend them as one chronological run.
 *
 * `excludeKeys` are the identity keys the live conversation already holds, so a
 * message still present in the current log is skipped rather than duplicated (the
 * same reason a whole generation can yield nothing: `_36` is a full clone of what
 * `_37` still holds). Ordering mirrors `restore-handover` exactly: oldest message
 * first within a generation, older generations in front. Generations are loaded
 * lazily and the walk stops as soon as `limit` is met, so a 2-message pick does
 * not parse 37 files.
 *
 * Returns [] for any structural dead end (no convoId, unnumbered title, no older
 * generation, nothing left to add) — the caller treats all of them the same:
 * "cannot perturb this way", stop and report.
 */
export async function collectOlderMessagesByCount(args: {
  convoId: string;
  limit: number;
  excludeKeys: string[];
}): Promise<any[]> {
  const { convoId, limit, excludeKeys } = args;
  if (!convoId || !Number.isFinite(limit) || limit <= 0) return [];

  const logs = await listLogs();
  const self = logs.find((l: any) => l.id === convoId);
  if (!self) return [];

  const older = olderGenerationsNewestFirst(logs, self);
  if (older.length === 0) return [];

  const excluded = new Set<string>(excludeKeys);
  let restored: any[] = []; // oldest-first overall
  let scanned = 0;

  for (const l of older) {
    if (restored.length >= limit) break;
    if (scanned >= MAX_GENERATIONS_SCANNED) break;
    scanned++;
    const log: any = await loadLog(l.id);
    if (!log) continue;
    const pick = pickCountFromMessages(log.messages || [], excluded, limit - restored.length);
    if (pick.length > 0) restored = [...pick, ...restored]; // older generation in FRONT
  }

  return restored;
}

/** Refusal-perturbation retry knobs, kept beside the walk they drive so tuning
 *  never requires touching route.ts. Add 2 older messages (one Q+A pair) per
 *  attempt, at most 5 attempts — Lizard-kun's chosen bound (he felt "might get
 *  banned" around ~10 billed reasoning_extraction requests in a row). */
export const REFUSAL_PERTURBATION_STEP = 2;
export const MAX_REFUSAL_PERTURBATION_RETRIES = 5;
