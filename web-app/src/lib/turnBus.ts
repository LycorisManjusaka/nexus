// ── The live relay for a turn that is NOT running in your tab ──────────────
//
// WHY THIS EXISTS. MEASURED 2026-10-29 (つよ): check "stocked messages", send,
// close the tab — and LM Studio stops mid-generation. The reason is not the
// queue: it is that the browser OWNED the turn. `fetch('/api/chat')` from a
// tab means the tab's connection IS the turn's lifeline, so killing the tab
// aborts `req.signal` and the route tears the generation down.
//
// Moving the turn to the server fixes that and costs the live view: a server
// that runs the turn has the stream, and the tab has nothing. This module is
// the thing that gives it back. The runner publishes every decoded chunk here
// VERBATIM, and a tab subscribes to replay-then-live.
//
// ── WHY RAW SSE TEXT AND NOT PARSED EVENTS ─────────────────────────────────
//
// What is buffered is exactly the bytes the chat route emitted, framing and
// all. So a subscriber's stream is byte-identical to what a direct POST would
// have given it, and the browser reads it with the SAME lib/turnStreamLoop —
// same framing, same 22 branches, same rule about which errors are fatal.
// Parsing here and re-serialising would create a second wire format whose
// drift from the first would be invisible until a field went missing.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
//
// Not durable. Memory only, and a server restart loses it. That is correct:
// the AUTHORITATIVE record is the log the runner writes to disk, and a tab
// that missed the relay reloads the conversation and sees the finished turn.
// Losing the relay costs a live view, never an answer.
//
// Not a broadcast bus for anything else. One live turn per conversation,
// because the queue lease already guarantees that.

/** One conversation's in-flight (or just-finished) turn. */
interface LiveTurn {
  convoId: string;
  startedAt: number;
  endedAt: number | null;
  /** Raw SSE text, in emission order. Concatenating them replays the stream. */
  frames: string[];
  chars: number;
  /** Set when the buffer hit the cap: late subscribers get a partial replay. */
  truncated: boolean;
  done: boolean;
  /** `null` is the end-of-stream signal. */
  subs: Set<(text: string | null) => void>;
}

/**
 * Buffer cap per turn. A long agentic turn with big tool outputs can emit a
 * lot; this bounds one conversation's relay rather than the process. Past the
 * cap, LIVE subscribers still receive everything — only the replay for a tab
 * that joins late is short, and `truncated` says so rather than pretending.
 */
const MAX_BUFFER_CHARS = 8_000_000;

/** How many conversations' relays to retain. Oldest finished evicted first. */
const MAX_LIVE_TURNS = 16;

const live = new Map<string, LiveTurn>();

function evictIfNeeded() {
  while (live.size > MAX_LIVE_TURNS) {
    // Prefer a finished relay: dropping a live one would blind a tab that is
    // watching right now, while dropping a finished one costs only a replay
    // that the conversation reload already supersedes.
    let victim: LiveTurn | null = null;
    for (const t of live.values()) {
      if (!t.done) continue;
      if (!victim || (t.endedAt ?? 0) < (victim.endedAt ?? 0)) victim = t;
    }
    if (!victim) {
      for (const t of live.values()) {
        if (!victim || t.startedAt < victim.startedAt) victim = t;
      }
    }
    if (!victim) return;
    for (const fn of victim.subs) { try { fn(null); } catch { /* a dead subscriber must not block eviction */ } }
    live.delete(victim.convoId);
  }
}

/**
 * Open a relay for `convoId`, replacing any previous one.
 *
 * Called SYNCHRONOUSLY by whoever is about to start the turn, before it
 * answers its caller. That ordering is the whole contract: a tab kicks the
 * runner and subscribes immediately, and if the entry did not exist yet the
 * subscribe would answer "idle" and the tab would stop watching a turn that
 * was about to start.
 */
export function beginTurn(convoId: string, nowMs: number = Date.now()): void {
  const prev = live.get(convoId);
  if (prev) {
    for (const fn of prev.subs) { try { fn(null); } catch { /* see above */ } }
  }
  live.set(convoId, {
    convoId,
    startedAt: nowMs,
    endedAt: null,
    frames: [],
    chars: 0,
    truncated: false,
    done: false,
    subs: new Set(),
  });
  evictIfNeeded();
}

/** Append one decoded chunk and hand it to every live subscriber. */
export function publishTurnText(convoId: string, text: string): void {
  if (!text) return;
  const t = live.get(convoId);
  if (!t || t.done) return;
  if (t.chars + text.length <= MAX_BUFFER_CHARS) {
    t.frames.push(text);
    t.chars += text.length;
  } else {
    t.truncated = true;
  }
  for (const fn of t.subs) { try { fn(text); } catch { /* one broken subscriber must not stop the others */ } }
}

/**
 * Close the relay.
 *
 * `note`, when given, is published as one more real SSE frame first — so a
 * watching tab learns WHY a turn ended badly from the same channel that
 * carried the turn, instead of seeing the stream stop and having to guess.
 */
export function endTurn(convoId: string, note?: { type: string; [k: string]: unknown }, nowMs: number = Date.now()): void {
  const t = live.get(convoId);
  if (!t || t.done) return;
  if (note) publishTurnText(convoId, `data: ${JSON.stringify(note)}\n\n`);
  t.done = true;
  t.endedAt = nowMs;
  const subs = [...t.subs];
  t.subs.clear();
  for (const fn of subs) { try { fn(null); } catch { /* see above */ } }
}

export interface TurnSubscription {
  /** Everything emitted before this subscriber joined, in order. */
  replay: string[];
  /** True when the turn already finished: replay is all there is. */
  done: boolean;
  truncated: boolean;
  startedAt: number;
  unsubscribe: () => void;
}

/**
 * Join a relay. Returns null when there is no relay for this conversation —
 * which is the honest answer "nothing is running here", not an error.
 *
 * The snapshot and the registration happen in ONE synchronous block, so no
 * chunk can land between them: a frame published after this returns reaches
 * the callback, and every earlier frame is in `replay`. Split across an await
 * this would drop exactly the frames emitted in the gap, which reads as a
 * model that said less.
 */
export function subscribeTurn(
  convoId: string,
  onText: (text: string | null) => void,
): TurnSubscription | null {
  const t = live.get(convoId);
  if (!t) return null;
  const replay = [...t.frames];
  if (!t.done) t.subs.add(onText);
  return {
    replay,
    done: t.done,
    truncated: t.truncated,
    startedAt: t.startedAt,
    unsubscribe: () => { t.subs.delete(onText); },
  };
}

/** What a poller can know without subscribing. */
export function liveTurnStatus(convoId: string): { live: boolean; done: boolean; startedAt: number; chars: number } | null {
  const t = live.get(convoId);
  if (!t) return null;
  return { live: !t.done, done: t.done, startedAt: t.startedAt, chars: t.chars };
}

/** Test-only. Module state is per-process and nothing else may clear it. */
export function __resetTurnBus(): void {
  live.clear();
}
