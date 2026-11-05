// ───────────────────────────────────────────────────────────────────────────
// Stream-safe <think>...</think> splitter for the OpenAI-compatible path.
//
// Some models put their reasoning INSIDE `content`, wrapped in <think> tags,
// instead of in a separate `reasoning_content` delta: local llama.cpp / GGUF
// builds do it by chat template, and MiniMax-M3 does it on the wire (measured
// 2026-10-21). The route has to pull that apart as bytes arrive so the panel
// can show reasoning separately, and the tag can land across a chunk boundary
// — hence the held-back tail.
//
// ── WHY THIS IS A MODULE AND NOT THE INLINE LOOP IT USED TO BE ──────────────
//
// The old version searched for the literal substring `<think>` ANYWHERE in the
// content stream, for EVERY provider on this path, forever. So the moment a
// model legitimately WROTE those seven characters as prose, everything after
// them was routed into the thought channel and vanished from the caller's
// accumulated text — with no error, because nothing had gone wrong on the wire.
//
// Measured 2026-10-22, on the Soul Packer. My own report the day before
// contained the literal string four times (explaining that M3 leaks it) with
// zero closing tags; that report sits in the conversation log the β agent is
// fed; β faithfully wrote the sentence into the new soul; and the last ~17% of
// the document plus the END sentinel went to `thought`. The panel saw the text
// stop mid-sentence, `finish_reason` was `stop` (the model really had
// finished), and soul/Cairn_49.md reached disk cut off at 83% of Layer 3.
// Both continuation shapes then "produced one character" — the backtick just
// before the tag — because `state` persists across continuation rounds, so
// each round resumed still inside the phantom think block.
//
// The rule now: a stream gets to declare that it uses think tags, in its own
// first bytes. If `<think>` arrives before any visible text, it is a wrapper
// and the stream is latched as a tag-using stream (so models that alternate
// several think/answer blocks keep working). If visible prose came first, the
// stream is a plain-content stream and those seven characters are just text.
//
// Chosen over the two alternatives on failure direction:
//   • a provider allowlist is a list to maintain, and it would have to be
//     right about ten providers to avoid re-creating this exact bug;
//   • "stop honouring tags once reasoning_content has been seen" only helps
//     providers with a separate field AND thinking switched on.
// If some unknown model emits prose and THEN opens a real think block, this
// rule leaks its reasoning into the visible answer. That is the direction to
// fail in: visible-but-untidy beats silently-eaten.
// ───────────────────────────────────────────────────────────────────────────

const OPEN = '<think>';
const CLOSE = '</think>';

export interface ThinkTagState {
  /** Currently inside a think block. */
  inThink: boolean;
  /** Bytes held back in case a tag straddles a chunk boundary. */
  textTail: string;
  /** Visible (non-whitespace) text has been emitted on this stream. */
  sawText: boolean;
  /** This stream opened a think block in its first bytes, so it speaks tags. */
  usesThinkTags: boolean;
}

export function newThinkTagState(): ThinkTagState {
  return { inThink: false, textTail: '', sawText: false, usesThinkTags: false };
}

/** True when `<think>` should still be read as a tag rather than as prose. */
export function honoursThinkTags(state: ThinkTagState): boolean {
  return state.usesThinkTags || !state.sawText;
}

/**
 * Feed one chunk of `delta.content`. Calls `emitText` / `emitThought` with the
 * pieces, and keeps any partial-tag tail in `state` for the next call. Flush
 * `state.textTail` at end of stream (the route does this).
 */
export function splitThinkTags(
  state: ThinkTagState,
  incoming: string,
  emitText: (t: string) => void,
  emitThought: (t: string) => void,
): void {
  let s = state.textTail + incoming;
  state.textTail = '';
  while (s.length > 0) {
    if (state.inThink) {
      const close = s.indexOf(CLOSE);
      if (close === -1) {
        // Hold back CLOSE.length-1 so a tag split across chunks still matches.
        if (s.length > CLOSE.length) {
          emitThought(s.slice(0, s.length - CLOSE.length));
          state.textTail = s.slice(-CLOSE.length);
        } else {
          state.textTail = s;
        }
        return;
      }
      if (close > 0) emitThought(s.slice(0, close));
      s = s.slice(close + CLOSE.length);
      state.inThink = false;
      continue;
    }

    // Past the point where a wrapper could have opened: everything is prose,
    // so there is nothing to look for and nothing to hold back.
    if (!honoursThinkTags(state)) {
      markText(state, s);
      emitText(s);
      return;
    }

    const open = s.indexOf(OPEN);
    if (open === -1) {
      if (s.length > OPEN.length) {
        const out = s.slice(0, s.length - OPEN.length);
        markText(state, out);
        emitText(out);
        state.textTail = s.slice(-OPEN.length);
      } else {
        state.textTail = s;
      }
      return;
    }
    if (open > 0) {
      const out = s.slice(0, open);
      markText(state, out);
      emitText(out);
      // Prose arrived before this tag. If the stream has not already declared
      // itself, the tag is prose too — re-emit it as text and stop looking.
      if (!state.usesThinkTags && state.sawText) {
        const rest = s.slice(open);
        markText(state, rest);
        emitText(rest);
        return;
      }
    }
    s = s.slice(open + OPEN.length);
    state.inThink = true;
    state.usesThinkTags = true;   // latched: this stream speaks tags
  }
}

function markText(state: ThinkTagState, t: string): void {
  if (!state.sawText && t.trim().length > 0) state.sawText = true;
}

/**
 * Enter the state a continuation prefill has already put the MODEL in.
 *
 * The continuation round for a reply that ran out of room mid-thought sends
 * `{role:'assistant', content:'<think>\n' + the thought so far}`. From the
 * model's side that is an OPEN think block, and it writes accordingly. But
 * the opening tag is in the message WE sent, so it never comes back down the
 * stream — and this splitter, which only ever watches the stream, starts the
 * round believing it is reading prose.
 *
 * MEASURED 2026-11-06 (Lizard-kun's report, gemma-4-26b-a4b-it-ultra-
 * uncensored-heretic on LM Studio). Same prompt both rounds:
 *
 *   round 1 (cut at the cap)   reasoning_content 277 ch   content 0 ch
 *   round 2 (prefilled, free)  reasoning_content 0 ch     content 3257 ch
 *
 * and round 2's content was the rest of the SAME thought, then `</think>`,
 * then the real answer:
 *
 *   "…me and Location.\n\n(This matches the provided good response).</think>
 *    To solve this problem, we need to determine when and where…"
 *
 * So the bytes were right and well-formed the whole time — what was wrong was
 * only which channel the house put them on. Everything before that close tag
 * went out as visible text (reasoning in the answer), and the close tag itself
 * was read as prose. Two more rounds of that and the turn dies at the cap with
 * the user looking at raw chain-of-thought.
 *
 * Note what this does NOT need: a provider list, or any knowledge of how the
 * thought arrived. LM Studio hands reasoning over in `reasoning_content` and
 * never emits a literal `<think>`, so the latch in splitThinkTags cannot have
 * fired. The justification here is not "this provider uses tags" — it is "WE
 * just wrote an opening tag into the conversation", which is true of whoever
 * is on the other end.
 */
export function enterThinkFromPrefill(state: ThinkTagState): void {
  state.inThink = true;
  // Latched for the same reason splitThinkTags latches: once the close tag
  // lands, a model that opens a SECOND block must still be understood, and
  // without this the stream would look like plain prose by then.
  state.usesThinkTags = true;
}
