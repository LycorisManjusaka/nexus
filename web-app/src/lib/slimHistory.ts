// The conversation history as it goes ON THE WIRE, built in ONE place.
//
// A stored message carries far more than the model may see: display-only
// metadata, excluded attachments, another vessel's reasoning, diagnostics that
// were once ordinary reply text. Five rules decide what survives, and four of
// them are invisible when they are missing — the request still succeeds, it
// just carries the wrong thing.
//
// Why this is a module and not a local closure: the server-side runner is a
// second caller, and it has to produce a BYTE-IDENTICAL body. The rule that
// makes this urgent is the third thinking gate. A runner that forwarded every
// stored `claudeThinkingBlocks` would feed one provider's raw chain-of-thought
// to another, which is exactly what distillation guards look for (Anthropic's
// `reasoning_extraction`, measured as deterministic in conversation size) —
// so the failure mode of getting this wrong is a refusal manufactured out of
// nothing, on a turn nobody is watching.
//
// Extracted from ChatArea.tsx's inline `slimHistory` 2026-10-28, byte-for-byte:
// same expressions, same field order, same conditional shape. `toolHistoryIds`
// is now derived inside instead of being passed in — same call with the same
// argument, so the result is identical, and the window rule stops being a
// thing the caller has to remember.

import { replayableCalls, selectToolHistoryIds } from '@/lib/toolHistory';
import { thinkingBelongsToVessel } from '@/lib/modelHandoff';

// Turn-stopped diagnostics used to be streamed as ordinary reply text, so they
// are baked into the body of every affected message already on disk. This
// removes them from the copy sent upstream. Anchored on the "]_" closing pair
// rather than a bare "]" because the notice quotes file paths, which can
// themselves contain brackets.
const TURN_NOTICE_RE = /\n*⚠️\s*_\[Turn stopped:[\s\S]*?\]_[ \t]*/g;

/**
 * Strip baked-in turn-stopped notices from an outgoing message body.
 *
 * Non-destructive: only the outgoing copy is cleaned, the stored log keeps the
 * notice (it is history, and the reader can see why a turn ended).
 */
export function stripTurnNotices(s: string): string {
  return s.includes('[Turn stopped:') ? s.replace(TURN_NOTICE_RE, '').trimEnd() : s;
}

/**
 * The fields of a stored message this builder reads.
 *
 * This interface IS the allowlist. Everything a stored message carries and is
 * not named here is display-only and must not reach the wire — two comments in
 * ChatArea depend on that property by name ("slimHistory above is an allowlist
 * that names..."), and for every version of NEXUS before tool-history replay
 * the omission was the only thing keeping `toolCalls` off the wire.
 */
export interface SlimHistoryMessage {
  id?: string;
  content?: string;
  role?: string;
  timestamp?: unknown;
  attachments?: Record<string, unknown>[];
  toolCalls?: unknown;
  thinkingExcluded?: boolean;
  modelFamily?: string;
  claudeThinkingBlocks?: { thinking: string; signature: string }[];
  thoughtProcess?: string;
  /**
   * Set on a user turn that NEXUS opened (soul self-surgery, later the 24/7
   * wake-ups). `content` is the one-line fact that stays in the history;
   * `full` is what was actually sent — see `wireContent` below.
   */
  nexus?: { full?: string; purpose?: string } | null;
}

/**
 * What a message's body is ON THE WIRE.
 *
 * A NEXUS-opened turn carries two texts (トカゲくん, 2026-11-11: "the same
 * mechanism as a thinking block, on a USER turn — it exists, but the being
 * does not see it; except that while the turn RUNS, the real one is seen").
 * The rule that implements that sentence: the full text travels only while
 * its message is the NEWEST user turn in the history being sent. That is true
 * for the turn itself, for a rerun of its answer and for a continue of it —
 * and false from the next user turn on, when the one-line `content` takes
 * its place with no deletion step to forget.
 *
 * The full text is STORED, not re-derived from the covenant file: that file
 * is rewritten over time, and a log has to say what was really sent.
 */
export function wireContent(m: SlimHistoryMessage, isNewestUserTurn: boolean): string {
  const full = m.nexus?.full;
  if (isNewestUserTurn && m.role === 'user' && typeof full === 'string' && full.trim()) return full;
  return m.content || '';
}

/** Everything outside the message list that changes what travels. */
export interface SlimHistoryOptions {
  /** Excluded attachments may travel as a `ref` the entity can open itself. */
  hiddenAttachmentsAccessible: boolean;
  /**
   * `effectiveFullAccess(...)` at the call site — with full PC access the
   * entity is handed absolute paths, so an excluded attachment's ref is still
   * worth forwarding.
   */
  attachmentPathsVisible: boolean;
  /** When off, no past turn carries its own tool calls and the body is the old one. */
  toolHistoryEnabled: boolean;
  /** The "Save & reuse thinking process" toggle. */
  saveThinkingToLog: boolean;
  /**
   * The family answering THIS turn — the effective one after a handoff
   * override, not the being's saved default. Compared against each message's
   * recorded family by the third thinking gate.
   */
  turnAiName: string;
}

/**
 * Build the `messages` array for a POST to /api/chat.
 *
 * Pure: no clock, no state, no I/O. Returns fresh objects; the arrays it
 * forwards by reference (`claudeThinkingBlocks`) are the stored ones, which is
 * what the inline version did — nothing downstream mutates them.
 */
export function buildSlimHistory(
  history: SlimHistoryMessage[],
  opts: SlimHistoryOptions,
): Record<string, unknown>[] {
  // Which past turns may carry their own tool calls onto the wire. The window
  // is applied HERE because this is the only side holding the whole
  // conversation — so the POST body grows by at most one turn's calls, and the
  // server receives exactly what it is allowed to replay. When the toggle is
  // off this is empty and the body is byte-for-byte the old one.
  const toolHistoryIds = opts.toolHistoryEnabled ? selectToolHistoryIds(history) : new Set<string>();
  let newestUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') { newestUserIdx = i; break; }
  }
  return history.map((m, idx) => {
    const slim: Record<string, unknown> = {
      // id forwarded so the backend can match `attachment_described` SSE
      // events back to the originating message. Frontend updates the
      // attachment in-place when the event arrives, so subsequent turns
      // re-use the persisted description instead of re-calling the
      // bridge model.
      id: m.id,
      // Turns that stopped BEFORE this became a separate event still carry
      // the "⚠️ _[Turn stopped: …]_" text inside their body. Strip it on the
      // way out so those old turns stop replaying a failure explanation to
      // the model every single turn. Non-destructive: only this outgoing
      // copy is cleaned, the stored log is untouched.
      content: stripTurnNotices(wireContent(m, idx === newestUserIdx)),
      role: m.role,
      timestamp: m.timestamp,
    };
    if (m.attachments?.length) {
      const kept = m.attachments
        .filter((a) => !a.excluded || ((opts.hiddenAttachmentsAccessible || opts.attachmentPathsVisible) && a.ref))
        .map((a) => {
          const { fileObj, ...rest } = a;
          if (rest.excluded) return { ...rest, textData: null, dataUrl: null };
          return rest;
        });
      if (kept.length) slim.attachments = kept;
    }
    // The entity's own tool calls from a past turn. SlimHistoryMessage is an
    // allowlist, so for every version of NEXUS before this one the field
    // simply never travelled — the server could have been written to
    // replay it and nothing would have arrived. Only the windowed ids get
    // it, and only with the toggle on.
    if (m.id && toolHistoryIds.has(m.id)) {
      const calls = replayableCalls(m);
      if (calls.length) slim.toolCalls = calls.map((c) => ({ name: c.name, input: c.input }));
    }
    // Only feed Claude its own past reasoning when the user opts in via the
    // "Save & reuse thinking process" toggle, and only for blocks the user
    // hasn't manually excluded. When off (or excluded), thinking is withheld
    // from the wire entirely — the API-key path won't resend it and the OAuth
    // transcript reconstruction won't include the "(thinking)" lines. (This
    // mirrors the .md export, which is gated by the same toggle.)
    //
    // Two sources of reusable thinking:
    //   1. claudeThinkingBlocks — signed blocks from the token-paid API-key
    //      path (carry real signatures, replayable natively).
    //   2. thoughtProcess — the OAuth/Agent-SDK path emits thinking as text
    //      only (no signatures), so it is NEVER stored as claudeThinkingBlocks.
    //      Without this fallback, OAuth Claude never receives its own past
    //      reasoning at all (the transcript builder reads claudeThinkingBlocks,
    //      which is empty). We forward it as a signature-less block: the OAuth
    //      transcript builder folds `tb.thinking` regardless of signature, and
    //      the API-key native-replay path safely skips signature-less blocks.
    //
    // THIRD gate, added with vessel handoff: only replay reasoning the CURRENT
    // vessel produced — see lib/modelHandoff.ts#thinkingBelongsToVessel for
    // why, and why messages with no recorded family pass through.
    if (opts.saveThinkingToLog && !m.thinkingExcluded && thinkingBelongsToVessel(m.modelFamily, opts.turnAiName)) {
      if (m.claudeThinkingBlocks?.length) {
        slim.claudeThinkingBlocks = m.claudeThinkingBlocks;
      } else if (m.thoughtProcess) {
        slim.claudeThinkingBlocks = [{ thinking: m.thoughtProcess, signature: '' }];
      }
    }
    return slim;
  });
}
