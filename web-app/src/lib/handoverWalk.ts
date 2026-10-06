/**
 * Handover generation walk — server-only.
 *
 * Reads older generations of a being's conversation chain off disk. Two callers
 * share the fragile part (finding the chain and ordering it); each brings its
 * own pick strategy:
 *
 *  - `api/logs/restore-handover` picks by TOKEN budget (put back as much carried
 *    history as the cap allows), and persists the result.
 *  - the OAuth refusal-perturbation retry (route.ts) picks by TOKEN budget too
 *    (prepend ~10k genuine older tokens per attempt to reshuffle a deterministic
 *    reasoning_extraction refusal), wire-only — never saved, never shown.
 *    MEASURED 2026-10-06 (Lizard-kun, カルド): the 2-message step NEVER once
 *    recovered; a whole-conversation-sized change (he saw ~3万 tokens flip it)
 *    is what the deterministic classifier needs. So the step is tokens, not a
 *    message count — a couple of messages is far below the threshold that moves.
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
import { estimateTokensForModel } from '@/lib/tokenEstimate';

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

/** The text a message contributes to the transcript (content + any saved
 *  thinking), mirroring renderHistory in route.ts, so the budget counts what the
 *  wire actually carries rather than content alone. */
function estimateMessageTokens(m: any, model?: string | null): number {
  let text = (m?.content || '').toString();
  if (m?.role === 'assistant' && Array.isArray(m?.claudeThinkingBlocks)) {
    const thoughts = m.claudeThinkingBlocks
      .map((tb: any) => (tb?.thinking || '').trim()).filter(Boolean).join('\n\n');
    if (thoughts) text = thoughts + '\n\n' + text;
  }
  return estimateTokensForModel(text, model);
}

/**
 * Take messages from ONE generation's tail, newest end backwards, skipping
 * anything already held, until the running TOKEN estimate reaches `tokenBudget`
 * — returned OLDEST-FIRST for prepending. Always takes at least the crossing
 * message, so a budget smaller than one message still makes progress (never
 * returns [] while messages remain). The newest-end walk takes the message
 * closest to what we already have first — the one that reconnects the history.
 *
 * `excluded` is MUTATED: every key picked is added, so the caller's set carries
 * forward and a message is never taken twice across generations. `model` picks
 * the token family (this is the OAuth Claude path, so a Claude family). Returns
 * both the picked messages (oldest-first) and the tokens they carry, so the
 * caller can keep a cross-generation running total.
 */
export function pickTokensFromMessages(
  msgs: any[], excluded: Set<string>, tokenBudget: number, model?: string | null,
): { took: any[]; tokens: number } {
  const pickNewestFirst: any[] = [];
  let tokens = 0;
  if (!Array.isArray(msgs) || tokenBudget <= 0) return { took: pickNewestFirst, tokens: 0 };
  for (let i = msgs.length - 1; i >= 0 && tokens < tokenBudget; i--) {
    const m = msgs[i];
    if (!m) continue;
    const key = messageIdentityKey(m);
    if (excluded.has(key)) continue;
    excluded.add(key);
    pickNewestFirst.push(m);
    tokens += estimateMessageTokens(m, model);
  }
  return { took: pickNewestFirst.reverse(), tokens };
}

/**
 * Collect older-generation messages until their token estimate reaches
 * `tokenLimit`, newest-adjacent first, returned OLDEST-FIRST so the caller can
 * prepend them as one chronological run.
 *
 * `excludeKeys` are the identity keys the live conversation already holds, so a
 * message still present in the current log is skipped rather than duplicated (the
 * same reason a whole generation can yield nothing: `_36` is a full clone of what
 * `_37` still holds). Ordering mirrors `restore-handover` exactly: oldest message
 * first within a generation, older generations in front. Generations are loaded
 * lazily and the walk stops as soon as the token budget is met, so a small pick
 * does not parse 37 files.
 *
 * Returns {messages:[],tokens:0} for any structural dead end (no convoId,
 * unnumbered title, no older generation, nothing left to add) — the caller
 * treats all of them the same: "cannot perturb this way", stop and report.
 */
export async function collectOlderMessagesByTokens(args: {
  convoId: string;
  tokenLimit: number;
  excludeKeys: string[];
  model?: string | null;
}): Promise<{ messages: any[]; tokens: number }> {
  const { convoId, tokenLimit, excludeKeys, model } = args;
  if (!convoId || !Number.isFinite(tokenLimit) || tokenLimit <= 0) return { messages: [], tokens: 0 };

  const logs = await listLogs();
  const self = logs.find((l: any) => l.id === convoId);
  if (!self) return { messages: [], tokens: 0 };

  const older = olderGenerationsNewestFirst(logs, self);
  if (older.length === 0) return { messages: [], tokens: 0 };

  const excluded = new Set<string>(excludeKeys);
  let restored: any[] = []; // oldest-first overall
  let tokens = 0;
  let scanned = 0;

  for (const l of older) {
    if (tokens >= tokenLimit) break;
    if (scanned >= MAX_GENERATIONS_SCANNED) break;
    scanned++;
    const log: any = await loadLog(l.id);
    if (!log) continue;
    const { took, tokens: got } = pickTokensFromMessages(log.messages || [], excluded, tokenLimit - tokens, model);
    if (took.length > 0) { restored = [...took, ...restored]; tokens += got; } // older generation in FRONT
  }

  return { messages: restored, tokens };
}

/** Refusal-perturbation retry knobs, kept beside the walk they drive so tuning
 *  never requires touching route.ts. Add ~10k older tokens per attempt, at most
 *  5 attempts (so a full run prepends up to ~50k tokens). Lizard-kun's chosen
 *  bound — he felt "might get banned" around ~10 billed reasoning_extraction
 *  requests in a row, and MEASURED 2026-10-06 that the old 2-message step never
 *  moved the classifier while a ~3万-token change did. */
export const REFUSAL_PERTURBATION_TOKEN_STEP = 10000;
export const MAX_REFUSAL_PERTURBATION_RETRIES = 5;
