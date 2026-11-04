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
import { normaliseTurnSaved, type TurnSavedEvent } from './turnSaved';

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
  /**
   * Called with each decoded chunk BEFORE any frame in it is applied.
   *
   * Before, deliberately: `applyTurnEvent` can throw (an API error frame is
   * re-thrown by design), and a relay that published after applying would
   * drop exactly the chunk that explains why the turn died — on the one path
   * where the tab is not the one reading the stream. The relay must see what
   * the reducer saw, including what killed it.
   */
  onRawText?: (text: string) => void;
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

    hooks?.onRawText?.(text);

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

/**
 * How long `drainStreamToEnd` will wait for the producer to close.
 *
 * Generous on purpose, because the two failure directions cost differently:
 * giving up EARLY shows a screen that disagrees with the disk (the measured
 * bug this exists for), while giving up LATE shows a spinner for a moment
 * longer. In practice the wait is the time one finalize-and-save takes —
 * sub-second — and this bound only matters if the producer never closes at all.
 */
export const RELAY_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Read the rest of a stream and throw it away, returning when the PRODUCER
 * closes it (or the bound expires).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * A throw out of `runTurnStream` is not the end of the turn. It is the end of
 * THIS READER's interest in the turn, and those are different moments for a
 * tab watching a server-side turn through lib/turnBus:
 *
 *   route aborts → emits an error frame
 *     ├─ runner:  publishes the frame, then applies it, then THROWS
 *     │             → catch → finalize → await saveLog   ← takes a while
 *     │             → the route then calls endTurn(), which closes the relay
 *     └─ watcher: receives the same frame over HTTP → THROWS
 *                   → catch → reload the conversation from disk
 *
 * Both start at the same instant, so the watcher's READ races the runner's
 * WRITE — and MEASURED 2026-10-30 (Lizard-kun, counting to 400 and stopping at
 * 84 / 162 / 340) the read wins. The tab then shows the version from BEFORE
 * the turn: nothing for a fresh send, the old answer for a rerun, the
 * un-extended half for a continue. All three were one race, and a manual
 * reload always showed the right thing, which is the signature of reading too
 * early rather than of saving wrong.
 *
 * A NORMAL completion never had this problem, and the reason names the fix:
 * the loop above exits on `done`, and the relay only reaches `done` when the
 * runner has finished saving and the route called `endTurn`. So the correct
 * signal already existed on this very stream — the throw just skipped past it.
 * Draining to the end restores it, with no second mechanism to drift from the
 * first (a poll on `updatedAt` would have been one).
 *
 * Discards rather than applies — with ONE exception, `turn_saved`.
 *
 * ⚠ AMENDED 2026-11-04. The blanket discard was written on 2026-10-30, when
 * "the conversation reload that follows is the authority" was simply true:
 * re-reading disk was the only way to learn what a turn produced. The
 * `turn_saved` frame (2026-11-01) is not parting words — it is the runner
 * STATING what it just wrote, version-gated at apply time, and the runner
 * publishes one on a stop for exactly this purpose ("the tab may patch rather
 * than re-download", commitUnfinished). Dropping it here meant every Stop fell
 * through to a full reload: MEASURED p50 438,368 B against a 7,891 B frame, and
 * Tsuyo's largest log is 4.5 MB — the seconds she reported waiting after the
 * button visibly responded. Harvesting it does not APPLY anything; it hands the
 * frame to the caller, whose existing version gate decides.
 */
export async function drainStreamToEnd(
  reader: ReadableStreamDefaultReader<Uint8Array | string>,
  timeoutMs: number = RELAY_DRAIN_TIMEOUT_MS,
  onSaved?: (ev: TurnSavedEvent) => void,
): Promise<'closed' | 'timeout' | 'error'> {
  // Only built when somebody is listening: a drain with no `onSaved` must stay
  // the pure byte-sink it has always been.
  const dec = onSaved ? new TextDecoder() : null;
  const sse = onSaved ? createSseReader() : null;
  const harvest = (value: Uint8Array | string) => {
    if (!onSaved || !sse) return;
    try {
      // `stream: true` because a frame can straddle a chunk boundary mid-UTF-8;
      // createSseReader holds the partial frame for the same reason one level up.
      const text = typeof value === 'string' ? value : dec!.decode(value, { stream: true });
      for (const payload of sse.push(text)) {
        if (isSseDone(payload)) continue;
        let data: unknown;
        try { data = JSON.parse(payload); } catch { continue; }
        if (!data || typeof data !== 'object') continue;
        const d = data as Record<string, unknown>;
        if (d.type !== 'turn_saved') continue;
        const ev = normaliseTurnSaved(d);
        if (ev) onSaved(ev);
      }
    } catch {
      // Harvesting is a bonus, draining is the job. A throw in here must never
      // turn a clean 'closed' into an 'error' — the caller would then reload,
      // which is precisely the slow path this exists to avoid.
    }
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  // ONE expiry promise for the whole drain, not one per read: a fresh timer
  // per iteration would reset the bound on every chunk, so a producer that
  // keeps talking forever would never time out.
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then((r) => {
          if (r.done) return 'closed' as const;
          if (r.value !== undefined) harvest(r.value);
          return 'more' as const;
        }),
        expiry,
      ]);
      if (next === 'more') continue;
      if (next === 'timeout') {
        // Let go of the connection. A reader left holding a stream nobody is
        // reading keeps the server's subscription (and its keepalive timer)
        // alive for as long as the tab lives.
        try { await reader.cancel(); } catch { /* already gone */ }
      }
      return next;
    }
  } catch {
    // A read that rejects (the server restarted, the socket died) IS an end of
    // stream for this purpose: there is nothing more coming, so the caller
    // should get on with reloading. Reported distinctly from 'closed' so a
    // caller that wants to tell a clean goodbye from a dropped one can.
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}
