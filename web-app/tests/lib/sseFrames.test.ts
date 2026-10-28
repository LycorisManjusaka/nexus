/**
 * sseFrames — one definition of "split a stream into data payloads",
 * extracted 2026-10-28 from six derivations with four behaviours
 * (see the module header for the table).
 *
 * NEW TEST. No probe existed, and nothing in the repo tested this parse at
 * all: it lived inline in three components and three places in the chat route,
 * where nothing can reach it.
 *
 * ⚠ What these cases are and are not. Most of them pin the WRITTEN SPEC
 * (blank-line framing, optional space after the colon, multiple `data:` lines
 * joined with '\n'), not the behaviour any existing site had — three of those
 * choices are unobservable with today's producers, which is exactly why the
 * standard and not my guess decided them. Cases marked DIVERGENCE are the ones
 * where the single source answers differently from a site it replaces, and the
 * comment says which site and why that is the intended direction.
 *
 * Before writing them I named what would look different if each property were
 * absent. The one that matters most is the chunk boundary: without the kept
 * `rest`, one frame per boundary disappears and the loss is INVISIBLE — a
 * dropped text delta reads as a provider that sent less text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSseFrames,
  sseDataPayload,
  isSseDone,
  createSseReader,
  SSE_DONE,
} from '../../src/lib/sseFrames';

describe('splitSseFrames', () => {
  it('returns complete frames and holds the partial tail', () => {
    const r = splitSseFrames('data: a\n\ndata: b\n\ndata: par');
    assert.deepEqual(r.frames, ['data: a', 'data: b']);
    assert.equal(r.rest, 'data: par');
  });

  it('a buffer ending exactly on a separator leaves rest empty', () => {
    // Without this, a caller would need two rules: "did my chunk end on a
    // boundary" and "what do I keep". One rule, always: keep `rest`.
    const r = splitSseFrames('data: a\n\n');
    assert.deepEqual(r.frames, ['data: a']);
    assert.equal(r.rest, '');
  });

  it('a buffer with no separator yields no frames and keeps everything', () => {
    const r = splitSseFrames('data: still arriving');
    assert.deepEqual(r.frames, []);
    assert.equal(r.rest, 'data: still arriving');
  });

  it('the empty buffer yields no frames', () => {
    const r = splitSseFrames('');
    assert.deepEqual(r.frames, []);
    assert.equal(r.rest, '');
  });

  it('SPEC: CRLF framing is accepted too', () => {
    // Unobservable today: every current producer frames with LF, which is how
    // we know — a CRLF producer would yield zero frames and streaming would be
    // visibly dead. Accepting it cannot change LF input.
    const r = splitSseFrames('data: a\r\n\r\ndata: b\r\n\r\n');
    assert.deepEqual(r.frames, ['data: a', 'data: b']);
    assert.equal(r.rest, '');
  });

  it('a lone trailing CR is kept as part of the tail', () => {
    // Half a separator. Dropping it would corrupt the frame that completes on
    // the next chunk.
    const r = splitSseFrames('data: a\r\n\r\ndata: b\r');
    assert.deepEqual(r.frames, ['data: a']);
    assert.equal(r.rest, 'data: b\r');
  });
});

describe('sseDataPayload', () => {
  it('strips the prefix and exactly one leading space', () => {
    assert.equal(sseDataPayload('data: {"a":1}'), '{"a":1}');
  });

  it('SPEC: the space after the colon is optional', () => {
    // DIVERGENCE from ChatArea / SystemPromptUpdater / stream-test, which test
    // the whole frame against 'data: ' with the space and drop this frame.
    // chat/route.ts:3611 already accepted it. The permissive answer cannot
    // reject a frame the strict one would have accepted.
    assert.equal(sseDataPayload('data:{"a":1}'), '{"a":1}');
  });

  it('SPEC: only ONE leading space is removed; the rest is payload', () => {
    assert.equal(sseDataPayload('data:   x'), '  x');
  });

  it('DIVERGENCE: finds the data line when a field precedes it', () => {
    // The three client sites test the WHOLE frame with startsWith, so this
    // spec-legal frame is silently dropped there. Both route-side loops
    // already searched the lines. Nothing in this house emits it — this is the
    // union of what the six sites accepted, not a new capability.
    assert.equal(sseDataPayload('event: ping\ndata: {"a":1}'), '{"a":1}');
  });

  it('SPEC: multiple data lines are joined with a newline, not truncated', () => {
    // All six existing sites take the FIRST data line only, which turns a
    // multi-line payload into invalid JSON — it then throws and the frame is
    // dropped with no trace. Of the two possible wrong answers, silent
    // truncation is the worse one. Unobservable today: JSON.stringify never
    // emits a raw newline, so no current producer sends this.
    assert.equal(sseDataPayload('data: one\ndata: two'), 'one\ntwo');
  });

  it('no data field at all returns null', () => {
    assert.equal(sseDataPayload('event: ping'), null);
    assert.equal(sseDataPayload(':this is a comment'), null);
    assert.equal(sseDataPayload(''), null);
  });

  it('an EMPTY data field returns the empty string, not null', () => {
    // These are different answers and both are real. The chat route already
    // uses the distinction (`if (!payload || payload === '[DONE]') continue`),
    // so collapsing them here would take something a caller reads.
    assert.equal(sseDataPayload('data:'), '');
    assert.equal(sseDataPayload('data: '), '');
  });

  it('a CR at the end of a line belongs to the framing, not the payload', () => {
    assert.equal(sseDataPayload('data: {"a":1}\r'), '{"a":1}');
  });

  it('a field that merely CONTAINS "data:" is not a data line', () => {
    // SSE field names are at the start of the line; no leading whitespace is
    // allowed. A payload mentioning the word is not a second field.
    assert.equal(sseDataPayload('  data: indented'), null);
    assert.equal(sseDataPayload('data: {"note":"data: inside"}'), '{"note":"data: inside"}');
  });
});

describe('isSseDone', () => {
  it('recognises the sentinel our emitter writes', () => {
    assert.equal(isSseDone(SSE_DONE), true);
    assert.equal(isSseDone(sseDataPayload('data: [DONE]')), true);
  });

  it('is lenient about surrounding whitespace', () => {
    // The route side always compared with .trim(), the client side compared
    // exactly. One had to win; the lenient one cannot reject a sentinel the
    // strict one would have accepted.
    assert.equal(isSseDone(' [DONE] '), true);
  });

  it('null is not done', () => {
    assert.equal(isSseDone(null), false);
    assert.equal(isSseDone(''), false);
    assert.equal(isSseDone('[done]'), false);
  });
});

describe('createSseReader', () => {
  it('DISCRIMINATING: a frame split across chunks survives', () => {
    // The property this module exists for. Without the kept buffer, exactly
    // one frame per chunk boundary disappears, and nothing reports it: a lost
    // text delta is indistinguishable from a provider that sent less text.
    //
    // CORRECTED EXPECTATION. First written as:
    //
    //   assert.deepEqual(r.push('data: {"a":1}'), []);
    //   assert.deepEqual(r.push('}\n\n'), []);        // <- wrong
    //   assert.deepEqual(r.push('data: {"b":2}\n\n'), ['{"b":2}']);
    //
    // The second line DOES complete a frame — the stray '}' made the payload
    // `{"a":1}}`, so the reader was right and my expectation described a
    // stream I had not meant to write. Worth leaving visible: I was trying to
    // say "a boundary arrives late" and instead said "the payload is
    // different", and the two look alike in a one-line assertion.
    const r = createSseReader();
    assert.deepEqual(r.push('data: {"a":1}'), []);
    assert.deepEqual(r.push('\n\n'), ['{"a":1}']);
    assert.deepEqual(r.push('data: {"b":2}\n\n'), ['{"b":2}']);
  });

  it('DISCRIMINATING: a payload split mid-JSON is delivered whole', () => {
    const r = createSseReader();
    assert.deepEqual(r.push('data: {"text":"he'), []);
    assert.deepEqual(r.push('llo"}\n\n'), ['{"text":"hello"}']);
  });

  it('delivers several payloads from one chunk, in order', () => {
    const r = createSseReader();
    assert.deepEqual(
      r.push('data: 1\n\ndata: 2\n\ndata: 3\n\n'),
      ['1', '2', '3'],
    );
  });

  it('passes [DONE] through instead of deciding for the caller', () => {
    // ChatArea stops reading at [DONE]; the chat route keeps draining. That
    // difference is about who owns the connection, so it stays at the call
    // site rather than being normalised away here.
    const r = createSseReader();
    assert.deepEqual(r.push('data: x\n\ndata: [DONE]\n\n'), ['x', '[DONE]']);
  });

  it('skips frames with no data field without consuming the following one', () => {
    const r = createSseReader();
    assert.deepEqual(r.push(':keep-alive\n\ndata: real\n\n'), ['real']);
  });

  it('pending() reports what is held back', () => {
    const r = createSseReader();
    r.push('data: a\n\ndata: par');
    assert.equal(r.pending(), 'data: par');
  });

  it('flush() recovers a final frame that never got its blank line', () => {
    // Does not happen with our emitter (it always ends `data: [DONE]\n\n`).
    // It happens when a stream is cut, and without flush the last frame is
    // discarded in silence.
    const r = createSseReader();
    r.push('data: a\n\ndata: last');
    assert.deepEqual(r.flush(), ['last']);
    assert.deepEqual(r.flush(), []); // and only once
  });

  it('flush() on an empty buffer returns nothing', () => {
    const r = createSseReader();
    r.push('data: a\n\n');
    assert.deepEqual(r.flush(), []);
  });

  it('two readers do not share a buffer', () => {
    // Guards the factory shape: a module-level buffer would interleave two
    // concurrent turns' bytes, which is exactly what the runner will do.
    const a = createSseReader();
    const b = createSseReader();
    a.push('data: aaa');
    assert.deepEqual(b.push('data: bbb\n\n'), ['bbb']);
    assert.deepEqual(a.push('\n\n'), ['aaa']);
  });
});
