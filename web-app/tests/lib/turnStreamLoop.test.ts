/**
 * turnStreamLoop — draining one turn's SSE stream (phase 4b-5, 2026-10-28).
 *
 * NEW TEST. No probe existed; the module was extracted from ChatArea tonight.
 *
 * Written by naming, for each property, what would look different if it were
 * absent — BEFORE checking whether the code achieves it. The honest split:
 *
 *   NOT written from the implementation (these are the ones worth having):
 *     "a non-JSON error propagates" — this is the reason the module exists.
 *         The route forwards provider errors as `{error: ...}` frames and the
 *         reducer throws on them; if the loop swallowed that, a rate-limited
 *         or refused turn would end looking like a clean one. Nothing on
 *         screen would say otherwise: the message would simply stop.
 *     "a malformed frame does NOT propagate" — the other half of the same
 *         rule. Absent, one truncated frame at a chunk boundary kills a turn
 *         that was otherwise fine.
 *     "a frame split across two chunks still arrives" — the loop owns the
 *         cross-chunk buffer (sseFrames says why). Absent, exactly one frame
 *         per boundary is lost, and the loss reads as a provider that sent
 *         less text, with nothing in any log.
 *     "onChunk runs AFTER the frames in that chunk" — absent (or called
 *         before), the last repaint of a chunk shows the state from before it,
 *         so the final delta of a stream can stay invisible until the next
 *         chunk arrives — and on the last chunk, until finalize.
 *
 *   Written from the implementation (these only restate it):
 *     the `done` exit, and that `acc` is the object mutated.
 *
 *   DELIBERATELY NOT ASSERTED: that `[DONE]` is skipped rather than parsed.
 *         Removing the `isSseDone` guard makes `JSON.parse('[DONE]')` throw a
 *         SyntaxError, which this loop swallows by design — so the guard's
 *         presence is NOT observable through behaviour here. Claiming a test
 *         for it would be claiming a tooth the suite does not have.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnStream, drainStreamToEnd } from '@/lib/turnStreamLoop';
import { recordingSink, freshFlags, freshAcc, deps } from '../_helpers/turnHarness';

/**
 * A reader that hands back exactly the byte chunks it was given.
 *
 * Takes STRINGS and encodes them here, so a test can split a frame at any
 * character — which is the point: the interesting input is a frame cut in
 * half, and writing that as Uint8Array literals would hide what is being cut.
 */
function readerOf(chunks: (string | Uint8Array)[]): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined };
      const c = chunks[i++];
      // Uint8Array chunks pass through UNENCODED: a byte-level cut is the
      // whole point of the multi-byte test, and re-encoding a decoded string
      // would heal the cut before the loop ever sees it.
      return { done: false, value: typeof c === 'string' ? enc.encode(c) : c };
    },
    releaseLock() {},
    async cancel() {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function harness() {
  const acc = freshAcc();
  const flags = freshFlags();
  const rec = recordingSink();
  return { acc, flags, ...rec };
}

describe('runTurnStream — which stream errors are fatal', () => {
  it('re-throws an API error frame', async () => {
    // The route forwards provider failures as `{error}` and the reducer throws.
    // If this were swallowed, a refused turn would look like a finished one.
    const h = harness();
    await assert.rejects(
      () => runTurnStream(readerOf([frame({ error: 'rate limited' })]), h.acc, h.flags, h.sink, deps),
      /rate limited/,
    );
  });

  it('swallows a malformed frame and keeps reading', async () => {
    const h = harness();
    await runTurnStream(
      readerOf(['data: {not json\n\n', frame({ type: 'text', content: 'after' })]),
      h.acc, h.flags, h.sink, deps,
    );
    assert.equal(h.acc.currentText, 'after');
  });

  it('stops at done without needing a [DONE] frame', async () => {
    // RESTATES THE IMPLEMENTATION. Kept because the failure mode is a hang,
    // which in a runner means a turn that never finishes and never reports.
    const h = harness();
    await runTurnStream(readerOf([frame({ type: 'text', content: 'x' })]), h.acc, h.flags, h.sink, deps);
    assert.equal(h.acc.currentText, 'x');
  });
});

describe('runTurnStream — the cross-chunk buffer', () => {
  it('reassembles a frame split mid-JSON', async () => {
    const h = harness();
    const f = frame({ type: 'text', content: 'hello' });
    const cut = Math.floor(f.length / 2);
    await runTurnStream(readerOf([f.slice(0, cut), f.slice(cut)]), h.acc, h.flags, h.sink, deps);
    assert.equal(h.acc.currentText, 'hello');
  });

  it('reassembles a frame split inside its terminator', async () => {
    // The nastier cut: the first chunk ends with ONE newline, so a site that
    // splits per-chunk sees an incomplete frame and (without a buffer) drops it.
    const h = harness();
    const f = frame({ type: 'text', content: 'split' });
    await runTurnStream(readerOf([f.slice(0, -1), f.slice(-1)]), h.acc, h.flags, h.sink, deps);
    assert.equal(h.acc.currentText, 'split');
  });

  it('applies several frames arriving in one chunk, in order', async () => {
    const h = harness();
    await runTurnStream(
      readerOf([frame({ type: 'text', content: 'a' }) + frame({ type: 'text', content: 'b' })]),
      h.acc, h.flags, h.sink, deps,
    );
    assert.equal(h.acc.currentText, 'ab');
  });

  it('does not corrupt a multi-byte character split across chunks', async () => {
    // The decoder is created with {stream: true} for this. Absent, a UTF-8
    // sequence cut by a chunk boundary decodes to U+FFFD and the replacement
    // character lands in the SAVED message — a corruption that no log reports
    // and that only shows up in non-ASCII text, i.e. in this entire house.
    const h = harness();
    const bytes = new TextEncoder().encode(frame({ type: 'text', content: 'ケルン' }));
    // MEASURED: the frame's prefix is ASCII, so the first byte >= 0x80 is at
    // index 32 and cutting at 33 lands INSIDE that 3-byte sequence.
    const cut = 33;
    assert.ok(bytes[32] >= 0x80, 'fixture assumption: byte 32 starts a multi-byte char');
    await runTurnStream(
      readerOf([bytes.slice(0, cut), bytes.slice(cut)]),
      h.acc, h.flags, h.sink, deps,
    );
    assert.equal(h.acc.currentText, 'ケルン');
  });

  it('does not emit a frame that never completed', async () => {
    // A stream cut off mid-frame must not invent one. Absent, a truncated
    // turn would end with a half payload parsed as whatever it happens to be.
    const h = harness();
    await runTurnStream(readerOf([frame({ type: 'text', content: 'ok' }) + 'data: {"type":"te']),
      h.acc, h.flags, h.sink, deps);
    assert.equal(h.acc.currentText, 'ok');
  });
});

describe('runTurnStream — onChunk', () => {
  it('runs once per chunk, AFTER that chunk is applied', async () => {
    const h = harness();
    const seen: string[] = [];
    await runTurnStream(
      readerOf([frame({ type: 'text', content: 'a' }), frame({ type: 'text', content: 'b' })]),
      h.acc, h.flags, h.sink, deps,
      { onChunk: () => { seen.push(h.acc.currentText); } },
    );
    // 'a' then 'ab' — each hook sees the chunk it follows already applied.
    assert.deepEqual(seen, ['a', 'ab']);
  });

  it('is optional', async () => {
    // The runner passes no hooks at all; a missing hook must not be a crash.
    const h = harness();
    await runTurnStream(readerOf([frame({ type: 'text', content: 'q' })]), h.acc, h.flags, h.sink, deps);
    assert.equal(h.acc.currentText, 'q');
  });

  it('does not run for a chunk that completed no frame', async () => {
    // RESTATES: the hook is per-chunk, not per-frame. Named so the next reader
    // does not assume a repaint only happens when something changed.
    const h = harness();
    let calls = 0;
    const f = frame({ type: 'text', content: 'z' });
    await runTurnStream(readerOf([f.slice(0, 5), f.slice(5)]), h.acc, h.flags, h.sink, deps,
      { onChunk: () => { calls++; } });
    assert.equal(calls, 2);
    assert.equal(h.acc.currentText, 'z');
  });
});

describe('runTurnStream — the sink is passed straight through', () => {
  it('notifies the sink for a non-state event', async () => {
    const h = harness();
    await runTurnStream(readerOf([frame({ type: 'model_selected', specificModel: 'm' })]),
      h.acc, h.flags, h.sink, deps);
    assert.ok(h.names().includes('modelSelected'));
  });
});


/**
 * A reader that hands back STRING chunks, unencoded.
 *
 * This is not a convenience over `readerOf` -- it is a different transport.
 * MEASURED 2026-10-29: the chat route's 19 enqueue sites all pass a string and
 * the route has no TextEncoder. Over HTTP the server encodes it, so ChatArea's
 * `fetch` Response yields Uint8Array. Called as a module -- which is what the
 * server-side runner does -- nothing encodes it, so the Response yields the
 * string that was enqueued.
 *
 * `readerOf` encodes its string input, so every test above it exercises only
 * the byte path. That is why the runner's first real turn died in a suite that
 * was fully green: the fixture healed the difference before the loop saw it.
 */
function stringReaderOf(chunks: string[]): ReadableStreamDefaultReader<Uint8Array | string> {
  let i = 0;
  return {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[i++] };
    },
    releaseLock() {},
    async cancel() {},
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array | string>;
}

describe('runTurnStream -- the runner transport: string chunks', () => {
  it('WHAT-BREAKS: a string chunk is applied, not passed to the decoder', async () => {
    // Absent the typeof check, TextDecoder.decode() throws
    //   The "input" argument must be an instance of ArrayBuffer or
    //   ArrayBufferView. Received type string
    // which is where the runner's FIRST REAL TURN died (2026-10-29, reported
    // by Tsuyo from the one-shot button). The turn had already been POSTed and
    // the provider had already answered -- so the cost was paid and the reply
    // was lost. The byte path above cannot discriminate this.
    const h = harness();
    await runTurnStream(
      stringReaderOf([frame({ type: 'text', content: 'from a string chunk' })]),
      h.acc, h.flags, h.sink, deps,
    );
    assert.equal(h.acc.currentText, 'from a string chunk');
  });

  it('the cross-chunk buffer works on strings too', async () => {
    // The buffer lives in sseFrames and joins text, so it should not care --
    // but "should not care" is a claim about code I changed tonight.
    const h = harness();
    const f = frame({ type: 'text', content: 'split' });
    const cut = Math.floor(f.length / 2);
    await runTurnStream(
      stringReaderOf([f.slice(0, cut), f.slice(cut)]),
      h.acc, h.flags, h.sink, deps,
    );
    assert.equal(h.acc.currentText, 'split');
  });

  it('a string chunk carrying several frames applies them in order', async () => {
    const h = harness();
    await runTurnStream(
      stringReaderOf([
        frame({ type: 'text', content: 'a' }) + frame({ type: 'text', content: 'b' }),
      ]),
      h.acc, h.flags, h.sink, deps,
    );
    assert.equal(h.acc.currentText, 'ab');
  });

  it('an error frame still propagates on the string path', async () => {
    // The fatal/non-fatal rule is the reason this module exists; it must not
    // be reachable only on one transport.
    const h = harness();
    await assert.rejects(
      () => runTurnStream(stringReaderOf([frame({ error: 'rate limited' })]),
        h.acc, h.flags, h.sink, deps),
      /rate limited/,
    );
  });

  it('multi-byte text survives, with no decoder involved', async () => {
    // On the byte path this is the split-boundary test. Here it is the
    // opposite assertion: nothing re-encodes, so nothing can be cut.
    const h = harness();
    await runTurnStream(
      stringReaderOf([frame({ type: 'text', content: 'A B C' })]),
      h.acc, h.flags, h.sink, deps,
    );
    assert.equal(h.acc.currentText, 'A B C');
  });
});

/**
 * drainStreamToEnd — "a throw is not the end of the stream" (2026-10-30).
 *
 * What would look different without each rule:
 *
 *   the LOOP (read until `done`, not once): absent, the drain returns while
 *       the producer is still mid-sentence, which is exactly the bug it was
 *       written for — the caller reloads from disk before the writer wrote.
 *   ONE expiry promise for the whole drain: absent (a fresh timer per read),
 *       a producer that keeps emitting resets the bound on every chunk and the
 *       drain never ends. This is the only test here that can tell the two
 *       designs apart, because a producer that simply HANGS times out under
 *       both.
 *   `reader.cancel()` on timeout: absent, a stream nobody reads keeps the
 *       server's subscription and its keepalive timer alive for the tab's
 *       whole life.
 *   the `catch`: absent, a read that rejects throws out of the drain — and
 *       the one caller is already inside a catch handling a different error,
 *       so the real one would be replaced by this one.
 *
 * NOT COVERED, named rather than implied: a producer whose chunks resolve
 * SYNCHRONOUSLY forever would starve the macrotask queue and the timer would
 * never fire. The infinite reader below yields through a timer precisely so it
 * does not test that, and the real producer is an HTTP body, where every chunk
 * costs I/O. If a synchronous in-process producer is ever given to this, the
 * bound is not a bound.
 */
describe('drainStreamToEnd', () => {
  it('reads to the producer\'s close, not to the first chunk', async () => {
    let reads = 0;
    const reader = {
      async read() {
        reads += 1;
        if (reads <= 2) return { done: false, value: 'data: {}\n\n' };
        return { done: true, value: undefined };
      },
      async cancel() {},
      releaseLock() {},
      closed: Promise.resolve(undefined),
    } as unknown as ReadableStreamDefaultReader<Uint8Array | string>;

    assert.equal(await drainStreamToEnd(reader, 2_000), 'closed');
    // 3 = two chunks plus the one that reported `done`. A single-read drain
    // would leave this at 1 and still have claimed success.
    assert.equal(reads, 3);
  });

  it('returns at once for a stream that is already finished', async () => {
    const reader = {
      async read() { return { done: true, value: undefined }; },
      async cancel() {},
      releaseLock() {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array | string>;
    assert.equal(await drainStreamToEnd(reader, 2_000), 'closed');
  });

  it('times out on a producer that keeps talking and never closes', async () => {
    let cancelled = false;
    let stop = false;
    const reader = {
      async read() {
        // Through a timer, so this models an HTTP body and not a synchronous
        // generator — see the NOT COVERED note above.
        await new Promise((r) => setTimeout(r, 1));
        if (stop) return { done: true, value: undefined };
        return { done: false, value: 'data: {}\n\n' };
      },
      async cancel() { cancelled = true; },
      releaseLock() {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array | string>;

    // ⚠ The drain is raced against a bound of the test's OWN, so a drain that
    // never returns FAILS instead of HANGING. A per-read timer (the design
    // this test exists to rule out) would wait forever here, and a hang is not
    // a test result: the mutation harness would stall on it rather than
    // reporting it CAUGHT.
    const outcome = await Promise.race([
      drainStreamToEnd(reader, 40),
      new Promise<'never-returned'>((r) => { setTimeout(() => r('never-returned'), 3_000); }),
    ]);
    stop = true;
    assert.equal(outcome, 'timeout');
    // The drain let go of the stream. Without this the subscription upstream
    // stays registered with nobody reading it.
    assert.equal(cancelled, true);
  });

  it('a rejecting read ends the drain instead of throwing out of it', async () => {
    const reader = {
      async read(): Promise<never> { throw new Error('socket closed'); },
      async cancel() {},
      releaseLock() {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array | string>;

    // Distinct from 'closed': a dropped socket and a clean goodbye are not the
    // same fact, even though both mean "stop waiting".
    assert.equal(await drainStreamToEnd(reader, 2_000), 'error');
  });
});

/**
 * drainStreamToEnd — harvesting `turn_saved` out of the drain (2026-11-04).
 *
 * WHY THESE EXIST. The drain was a pure byte-sink, and that cost a full
 * conversation re-download on every Stop: the runner publishes `turn_saved`
 * AFTER the error frame that throws the reader into the catch, so the frame
 * could only ever arrive here — and here threw it away. Measured p50 438,368 B
 * of reload against a 7,891 B frame; Tsuyo reported the wait as "a few seconds"
 * on a 4.5 MB log.
 *
 * What is asserted is the HANDOVER, never the application: these tests prove
 * the frame reaches the caller, and `applyTurnSaved`'s own suite owns what
 * happens to it (including the version gate that can still refuse it).
 */
describe('drainStreamToEnd — turn_saved harvest', () => {
  const enc = new TextEncoder();
  const savedFrame = (assistantId: string) => `data: ${JSON.stringify({
    type: 'turn_saved',
    readUpdatedAt: 100,
    writtenUpdatedAt: 200,
    assistant: { id: assistantId, role: 'assistant', content: '' },
    user: { id: 'u1', role: 'user', content: 'hi' },
  })}\n\n`;

  const readerOf = (chunks: (Uint8Array | string)[]) => {
    let i = 0;
    return {
      async read() {
        if (i < chunks.length) return { done: false, value: chunks[i++] };
        return { done: true, value: undefined };
      },
      async cancel() {},
      releaseLock() {},
    } as unknown as ReadableStreamDefaultReader<Uint8Array | string>;
  };

  it('hands a turn_saved frame to the caller and still reports closed', async () => {
    const got: unknown[] = [];
    const outcome = await drainStreamToEnd(
      readerOf([enc.encode(savedFrame('a1')), enc.encode('data: [DONE]\n\n')]),
      2_000,
      (ev) => { got.push(ev); },
    );
    // Draining is still the job: harvesting must not change the outcome the
    // caller branches on.
    assert.equal(outcome, 'closed');
    assert.equal(got.length, 1);
    assert.equal((got[0] as { assistant: { id: string } }).assistant.id, 'a1');
    // Normalised, not raw: the caller feeds this straight to applyTurnSaved.
    assert.equal((got[0] as { writtenUpdatedAt: number }).writtenUpdatedAt, 200);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    // The whole reason createSseReader is used rather than a per-chunk parse.
    // A frame straddling a boundary is the normal case on a real HTTP body,
    // and a naive parser drops it in silence.
    const whole = savedFrame('a2');
    const cut = Math.floor(whole.length / 2);
    const got: unknown[] = [];
    await drainStreamToEnd(
      readerOf([enc.encode(whole.slice(0, cut)), enc.encode(whole.slice(cut))]),
      2_000,
      (ev) => { got.push(ev); },
    );
    assert.equal(got.length, 1);
    assert.equal((got[0] as { assistant: { id: string } }).assistant.id, 'a2');
  });

  it('ignores every other frame type', async () => {
    const got: unknown[] = [];
    await drainStreamToEnd(
      readerOf([
        enc.encode(`data: ${JSON.stringify({ type: 'text', content: 'late words' })}\n\n`),
        enc.encode(`data: ${JSON.stringify({ type: 'error', error: 'aborted' })}\n\n`),
        enc.encode('data: [DONE]\n\n'),
      ]),
      2_000,
      (ev) => { got.push(ev); },
    );
    // The 2026-10-30 rule is unchanged for everything but the one frame that
    // states what was written: parting words are still discarded.
    assert.equal(got.length, 0);
  });

  it('refuses a turn_saved that cannot name the message it wrote', async () => {
    const got: unknown[] = [];
    await drainStreamToEnd(
      readerOf([enc.encode(`data: ${JSON.stringify({ type: 'turn_saved', assistant: {} })}\n\n`)]),
      2_000,
      (ev) => { got.push(ev); },
    );
    // normaliseTurnSaved returns null; a null must not reach the caller as a
    // frame, because "which message" would fall back to "some message".
    assert.equal(got.length, 0);
  });

  it('survives malformed JSON without turning a clean close into an error', async () => {
    const got: unknown[] = [];
    const outcome = await drainStreamToEnd(
      readerOf([enc.encode('data: {not json\n\n'), enc.encode(savedFrame('a3'))]),
      2_000,
      (ev) => { got.push(ev); },
    );
    // If harvesting could throw, the caller would see 'error' and reload —
    // exactly the slow path this change exists to remove.
    assert.equal(outcome, 'closed');
    assert.equal(got.length, 1);
  });

  it('stays a pure byte-sink when no listener is passed', async () => {
    // The old two-argument call must behave exactly as it did: no decoder, no
    // parser, no observable difference.
    assert.equal(
      await drainStreamToEnd(readerOf([enc.encode(savedFrame('a4'))]), 2_000),
      'closed',
    );
  });
});
