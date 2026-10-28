// ── Reading one turn's SSE stream to completion ─────────────────────────────
//
// WHY THIS EXISTS. Everything a turn needs in order to be *read* now lives in
// lib/: sseFrames (framing), turnEvents (payload normalisation),
// turnEventReducer (what each of the 22 events does), turnAccState (what
// accumulates), finalizeTurnMessage (what gets saved). This module is the
// ~24 lines that tie them together, and it is here for one reason: the chain
// holds a RULE that is invisible until it is wrong.
//
//   try { applyTurnEvent(JSON.parse(payload), ...) }
//   catch (e) { if (e.message && !e.message.startsWith('JSON')) throw e }
//
// A malformed frame is swallowed (a producer can emit a partial frame at a
// boundary and it is not this turn's problem); anything else — including an
// API error the route forwarded — is re-thrown so the caller's handler can
// show it. A second implementation written for the runner would almost
// certainly write `catch {}` and lose the second half: API errors would then
// vanish with no trace, on the one code path where nobody is watching a tab.
//
// So this is not extracted to save lines. It is extracted so there is exactly
// one place where "which stream errors are fatal" is decided.
//
// ── Fidelity note: the ONE deliberate difference from the ChatArea original ──
// ChatArea classified the error by MESSAGE TEXT
// (`!e.message.startsWith('JSON')`) and that test has not matched a real
// SyntaxError for years — see the measurement at the catch below. So the
// swallow branch was dead and every malformed frame ended the turn as an API
// error. This module classifies by TYPE instead, which makes the swallow
// branch live again.
//
// That is a behaviour change, named here rather than buried: it is not
// observable with today's producers (NEXUS's emitter always writes valid JSON
// and the cross-chunk buffer absorbs split frames), and it restores what the
// original comment said it wanted. Every other line of the loop is verbatim.

import { createSseReader, isSseDone } from './sseFrames';
import {
  applyTurnEvent,
  type TurnEventFlags,
  type TurnEventSink,
  type TurnEventDeps,
} from './turnEventReducer';
import type { TurnAccState } from './turnAccState';

/**
 * Side-channel hooks that are NOT state. Dropping them changes what a screen
 * shows, never what reaches disk — the same split the reducer's sink makes.
 * The server-side runner passes none of them.
 */
export interface TurnStreamHooks {
  /**
   * Called once per decoded chunk, AFTER every frame in that chunk has been
   * applied. ChatArea asks for a coalesced repaint here; a runner has no
   * screen and passes nothing.
   */
  onChunk?: () => void;
}

/**
 * Drain `reader` to completion, applying every SSE payload to `acc`/`flags`.
 *
 * The decoder and the cross-chunk SSE buffer are created HERE rather than
 * taken as arguments, for the reason sseFrames gives: a call site that keeps
 * its own buffer can forget to carry it, and the loss is one frame per chunk
 * boundary — which reads as a provider that sent less text, with nothing in
 * any log.
 *
 * Returns when the stream ends. Does NOT finalize, save, or close anything:
 * what to do with the accumulated state is the caller's, and ChatArea and the
 * runner answer that differently (React state vs. a write to disk).
 */
export async function runTurnStream(
  // `Uint8Array | string` is not defensive breadth — both really arrive.
  // MEASURED 2026-10-29: all 19 `controller.enqueue` sites in the chat route
  // pass a STRING and the route has no TextEncoder. Going out over HTTP, the
  // server encodes it, so `fetch`'s Response yields Uint8Array (ChatArea).
  // Called as a module, nothing encodes it, so the Response yields the string
  // that was enqueued (the runner). TypeScript's lib types say Uint8Array for
  // both, because `Response.body` is typed for the HTTP path; that type was a
  // claim about the transport, not about this stream. The runner's first real
  // turn died here: `decode()` throws TypeError on a string.
  reader: ReadableStreamDefaultReader<Uint8Array | string>,
  acc: TurnAccState,
  flags: TurnEventFlags,
  sink: TurnEventSink,
  deps: TurnEventDeps,
  hooks?: TurnStreamHooks,
): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  const sse = createSseReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // A string chunk must NOT go through the decoder: it is already decoded,
    // and `{ stream: true }`'s job (carrying a multi-byte character split
    // across a boundary) cannot arise for text that was never bytes.
    const text = typeof value === 'string'
      ? value
      : decoder.decode(value, { stream: true });

    // `[DONE]` falls through rather than breaking. MEASURED 2026-10-28: all
    // six `data: [DONE]` enqueue sites in the chat route send it immediately
    // before controller.close(), so it is always the last frame and there is
    // nothing after it to skip.
    for (const dataStr of sse.push(text)) {
      if (!isSseDone(dataStr)) {
        try {
          const data = JSON.parse(dataStr);
          applyTurnEvent(data, acc, flags, sink, deps);
        } catch (e) {
          // Swallow ONLY a malformed frame; re-throw everything else so the
          // caller's handler can display it.
          //
          // ⚠ CORRECTED 2026-10-28. ChatArea tested this with
          // `!e.message.startsWith('JSON')`, which predates the repo
          // restructure and assumes V8's OLD SyntaxError wording
          // (`JSON.parse: ...`). MEASURED on node v24 / current V8:
          //
          //   '{not json'  Expected property name or '}' in JSON at position 1
          //   ''           Unexpected end of JSON input
          //   'xyz'        Unexpected token 'x', "xyz" is not valid JSON
          //
          // None of them start with 'JSON', so the swallow branch had not
          // fired in a long time: EVERY parse failure was re-thrown and ended
          // the turn as an API error. Not observable today — NEXUS's emitter
          // writes `data: ${JSON.stringify(...)}` and the cross-chunk buffer
          // above absorbs split frames, so a malformed payload does not occur
          // on this path. Corrected rather than preserved because this module
          // is now the ONE place the rule is written, and shipping a rule that
          // does the opposite of what it says is worse than three copies that
          // are honest about it.
          //
          // The test is `instanceof SyntaxError`, not the message, because the
          // only producer of one here is JSON.parse: the reducer's single
          // throw is `new Error(String(data.error))` (measured), so an API
          // error can never be mistaken for a parse failure.
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
    }

    hooks?.onChunk?.();
  }
}
