// ── Server-Sent Events: splitting a byte stream into data payloads ──────────
//
// WHY THIS EXISTS (measured 2026-10-28). The same parse was derived in SIX
// places, with FOUR different behaviours:
//
//   site                          data line found by            prefix  [DONE]
//   ────────────────────────────  ────────────────────────────  ──────  ──────
//   ChatArea.tsx:3720             whole frame startsWith('data: ')   6   break
//   SystemPromptUpdater.tsx:1289  whole frame startsWith('data: ')   6   continue
//   stream-test/page.tsx:303      whole frame startsWith('data: ')   6   continue
//   chat/route.ts:9226            frame.split('\n').find('data: ')   6   continue
//   chat/route.ts:3611            frame.split('\n').find('data:')    5   continue
//   chat/route.ts:467             line-oriented, no blank-line frames  5  continue
//
// The three client sites test the WHOLE frame, so a spec-legal frame that
// carries a field before its data line — `event: ping\ndata: {...}` — is
// silently dropped there and parsed on the route side. The prefix length
// differs by one, so `data:{"a":1}` (the space after the colon is OPTIONAL in
// the spec) parses at one site and is dropped at three.
//
// None of that is observable today: NEXUS's own emitter writes exactly
// `data: ${JSON.stringify(...)}\n\n` (measured — 6 enqueue sites, chat route),
// and every upstream provider in use frames with LF. So this module is not a
// bug fix. It is ONE definition, in a place a test can reach, because the
// server-side runner (Phase 4b) needs the same parse and a second copy written
// for it would be the seventh derivation.
//
// ── Why the spec, and not "what the current code does" ──────────────────────
// Two choices here are unobservable with today's producers, so neither can be
// settled by measuring them. They are settled by the written standard instead,
// which is checkable by someone other than me:
//
//   * MULTIPLE `data:` lines in one frame are JOINED with '\n' (spec). All six
//     existing sites take only the FIRST, which silently truncates a payload
//     to invalid JSON -> throws -> frame dropped with no trace. Of the two
//     possible wrong answers, silent truncation is the worse one.
//   * CRLF is accepted. All six sites split on '\n\n' only, so a CRLF producer
//     would yield no frames at all and streaming would be visibly dead — which
//     is how we know every current producer uses LF. Accepting '\r\n\r\n' too
//     costs nothing and cannot change LF input.
//
// ⚠ NOT handled, deliberately: `id:`, `event:`, `retry:` and the reconnection
// protocol. Nothing in this house reads them, and a parser that returned
// fields nobody consumes would invite a second meaning for "frame".
// ───────────────────────────────────────────────────────────────────────────

/** The sentinel NEXUS's chat route sends as its last frame. */
export const SSE_DONE = '[DONE]';

export type SseSplit = {
  /** Complete frames, in arrival order. May be empty. */
  frames: string[];
  /**
   * The trailing partial frame. The caller MUST keep this and prepend it to
   * the next chunk; dropping it loses the frame that straddled the boundary.
   */
  rest: string;
};

/**
 * Split a buffer into complete SSE frames plus the unfinished tail.
 *
 * A frame ends at a blank line. The LAST element is never returned as a frame
 * even when the buffer happens to end exactly on a separator — in that case it
 * is the empty string, and returning it as `rest` keeps one rule instead of
 * two (callers do not have to ask whether their chunk ended on a boundary).
 */
export function splitSseFrames(buffer: string): SseSplit {
  // A blank line, with either line ending. See the header for why CRLF is
  // accepted even though no current producer sends it.
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

/**
 * Extract the data payload of one frame, or `null` when the frame carries no
 * `data:` field at all (a comment line, a bare `event:`, an empty frame).
 *
 * `null` and `''` are different answers and both are real: `null` means there
 * was no data field, `''` means there was one and it was empty. The chat route
 * already treats the second as "nothing to parse" (`if (!payload || ...)`), so
 * collapsing them here would take a distinction the callers use.
 *
 * Per the spec a single leading space after the colon is removed, and no more:
 * whitespace inside a payload belongs to the payload. `[DONE]` comparisons
 * should go through `isSseDone`, which is the one place that is lenient.
 */
export function sseDataPayload(frame: string): string | null {
  const lines = frame.split('\n');
  const data: string[] = [];
  for (const raw of lines) {
    // A frame may arrive with CRLF line endings inside it even when the
    // separator was LF; the '\r' belongs to the framing, not the payload.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:')) continue;
    const after = line.slice(5);
    data.push(after.startsWith(' ') ? after.slice(1) : after);
  }
  if (data.length === 0) return null;
  return data.join('\n');
}

/**
 * Is this payload the end-of-stream sentinel?
 *
 * Trims, because the route side has always compared with `.trim()` and the
 * client side has always compared exactly — one of the two had to win, and the
 * lenient one cannot reject a sentinel the strict one would accept.
 */
export function isSseDone(payload: string | null): boolean {
  return payload !== null && payload.trim() === SSE_DONE;
}

/**
 * A stateful reader for the common loop: feed decoded chunks, get payloads.
 *
 * Exists because the buffer-carrying is where the one real bug lives — every
 * site that forgets to keep `rest` loses a frame per chunk boundary, and the
 * loss is invisible (a dropped delta looks like a provider that sent less
 * text). Holding the buffer here means a caller cannot forget.
 *
 * Returns payload strings, INCLUDING `[DONE]` and including `''`. What to do
 * about those stays with the caller: ChatArea stops reading at `[DONE]` and
 * the route keeps draining, and that difference is a real one about who owns
 * the connection, not an accident to be normalised away here.
 */
export function createSseReader() {
  let buffer = '';
  return {
    /** Feed one decoded chunk. Returns the payloads that completed with it. */
    push(chunk: string): string[] {
      buffer += chunk;
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      const out: string[] = [];
      for (const f of frames) {
        const p = sseDataPayload(f);
        if (p !== null) out.push(p);
      }
      return out;
    },
    /**
     * Payloads from a final unterminated frame, if the stream ended without a
     * blank line. Returns nothing in the normal case — our emitter always ends
     * with `data: [DONE]\n\n` — but a truncated stream otherwise discards its
     * last frame in silence.
     */
    flush(): string[] {
      const tail = buffer;
      buffer = '';
      const p = sseDataPayload(tail);
      return p === null ? [] : [p];
    },
    /** Bytes held back waiting for a frame boundary. For diagnostics. */
    pending(): string {
      return buffer;
    },
  };
}
