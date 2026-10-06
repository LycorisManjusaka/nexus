/**
 * Handover generation walk — server-only.
 *
 * Reads older generations of a being's conversation chain off disk. The caller
 * `api/logs/restore-handover` picks by TOKEN budget (put back as much carried
 * history as the cap allows) and persists the result; this file supplies the one
 * fragile part it shares with any future caller — finding the chain and ordering
 * it. (A second caller, the OAuth refusal-perturbation retry, was removed
 * 2026-10-06: MEASURED over ~30 runs on カルド that prepending older tokens never
 * once flipped a deterministic reasoning_extraction refusal — it only burned the
 * 5-hour OAuth window. The two levers that DO move it — a model swap and a
 * context-size change — are now surfaced as user-facing hints instead. See
 * refusal-reasoning-extraction.md.)
 *
 * This file imports convoNaming, so it is SERVER-ONLY and must never be pulled
 * into a client bundle (unlike `handoverRestore.ts`, which is pure and shared
 * with ChatArea). Keep the two apart. `olderGenerationsNewestFirst` is PURE and
 * depends only on pure helpers, so it can be measured from shipped bytes without
 * disk.
 */
import { numberedIdentityTitleIndex } from '@/lib/convoNaming';

/**
 * Older generations of the SAME being as `self`, newest generation first.
 *
 * The number in the title (`<being>_<n>`) defines the chain. A hand-picked title
 * (no number) has no predecessors → []. Archived conversations are included on
 * purpose: the archive flag only controls what the sidebar lists, while the
 * number is what defines the chain — skipping archived logs would open a hole in
 * the middle of a being's history. This is the one fragile skeleton the caller
 * shares, so it lives here and is not copied in.
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
