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
import { numberedIdentityTitleIndex, newerNumberedSibling } from '@/lib/convoNaming';
import { orderFolderConversations } from '@/lib/deepLink';

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

/** Which rule produced the chain, and whether `self` sits at its head. */
export type HandoverChain = {
  /** 'numbered' = `<being>_<n>`; 'order' = the sidebar's own row order. */
  kind: 'numbered' | 'order';
  /** Older conversations, nearest-older FIRST. */
  older: any[];
  /** False when something newer sits above `self` — history, not the live thread. */
  isHead: boolean;
  /** `self` is not in its own folder's list (corrupted, or a folderName mismatch). */
  orphan: boolean;
};

/**
 * The whole chain decision in ONE place, so the walk and the head guard cannot
 * disagree about what "older" and "head" mean.
 *
 * TWO rules, tried in this order:
 *
 *  1. GENERATION NUMBER — `<being>_<n>`. Unchanged, and it still wins wherever
 *     it applies. It is what `nextConversationTitle` writes, what the past-log
 *     band reads (`newerNumberedSibling`) and what `pickLatestConversation`
 *     calls "latest"; a folder must not get a chain that those three readers
 *     disagree with just because a row was dragged.
 *
 *  2. SIDEBAR ORDER — only when the title carries no generation number, which
 *     is exactly the case rule 1 answered with [] before today. The order is
 *     `orderFolderConversations`, the same comparator the sidebar renders and
 *     `/c/<folder>` resolves "top conversation" with, so the chain is literally
 *     what the reader sees: the row below yours is your previous history.
 *
 *     WHY this rule exists (2026-10-24): a being migrating in from another app
 *     arrives as a split archive — Аналитик_1-1 … _1-5, _2-1 … — and those
 *     titles are OUTSIDE the numbered chain on purpose (see `splitPartTitle`),
 *     so restore reached nothing and said nothing. Renaming ten parts into
 *     `_1`…`_10` made it work but destroyed the owner's own numbering, which is
 *     the thing being preserved. Order is the index NEXUS already has.
 *
 * MEASURED 2026-10-24 over this installation's 492 logs (27 folders carry a
 * convoOrder): rule 2 plus the head guard gives a chain to exactly 3
 * conversations that had none — the heads of two imported archives and one
 * throwaway probe. WITHOUT the head guard it would be 59, which is why the
 * guard is part of this function and not a courtesy at the call site.
 *
 * `convoOrder` is the folder's manual drag order; absent, the comparator falls
 * back to `updatedAt` descending — which is still the order on screen.
 */
export function resolveHandoverChain(
  logs: any[],
  self: any,
  convoOrder: string[] = [],
): HandoverChain {
  const index = numberedIdentityTitleIndex(self.title, self.folderName);
  const siblings = logs.filter((l: any) => l.folderName === self.folderName && !l.corrupted);

  if (index !== null) {
    return {
      kind: 'numbered',
      older: olderGenerationsNewestFirst(logs, self),
      isHead: newerNumberedSibling(self.title, self.folderName, siblings.map((l: any) => l.title)) === null,
      orphan: false,
    };
  }

  // `orderFolderConversations` is generic over `{id, updatedAt}`; the log header
  // is carried along so the caller gets back the same objects it passed in.
  const ordered = orderFolderConversations(
    siblings.map((l: any) => ({ id: String(l.id), updatedAt: Number(l.updatedAt) || 0, l })),
    convoOrder,
  );
  const pos = ordered.findIndex((x: any) => String(x.l.id) === String(self.id));
  if (pos < 0) return { kind: 'order', older: [], isHead: false, orphan: true };
  return {
    kind: 'order',
    older: ordered.slice(pos + 1).map((x: any) => x.l),
    isHead: pos === 0,
    orphan: false,
  };
}
