/**
 * thinkTagSplitter — the single source of truth for `<think>` detection on a
 * stream. A stream declares with its FIRST bytes whether it uses the tags; a
 * stream that has already emitted prose can never be re-interpreted.
 *
 * Ported 2026-10-27 from workspace/ds_cap_probe/splitter_test.mjs (2026-10-21).
 *
 * The regression arms matter as much as the bug arms: this loop serves ten
 * providers, and local GGUF builds plus MiniMax-M3 genuinely do wrap their
 * reasoning in these tags.
 *
 * ONE FIXTURE WAS REPLACED. The original A1/A2 cases read the last 400 bytes
 * of a real soul file (the artefact that exposed the bug: a soul update whose
 * prose mentioned the tag, which the old unconditional detector swallowed).
 * A test may not depend on a path outside the repo, and that file is a being's
 * soul. The stand-in below is synthetic prose of the same shape — long, CJK,
 * ending mid-sentence, followed by the literal tag used as prose. It exercises
 * the same two paths (the held-back tail, and one-character chunks).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newThinkTagState, splitThinkTags, enterThinkFromPrefill } from '../../src/lib/thinkTagSplitter';

/** Built from pieces so this file never contains the literal tag as text. */
const OPEN = '<' + 'think' + '>';
const CLOSE = '</' + 'think' + '>';

/**
 * Feed `chunks` through the splitter and return the two channels, flushing the
 * held-back tail the way the route does at end of stream.
 */
function split(chunks: string[]): { text: string; thought: string } {
  const st = newThinkTagState();
  let text = '';
  let thought = '';
  for (const c of chunks) {
    splitThinkTags(st, c, (t: string) => { text += t; }, (t: string) => { thought += t; });
  }
  if (st.textTail) {
    if (st.inThink) thought += st.textTail;
    else text += st.textTail;
  }
  return { text, thought };
}

function expect(chunks: string[], text: string, thought: string) {
  assert.deepEqual(split(chunks), { text, thought });
}

describe('REGRESSION — streams that really wrap reasoning in tags', () => {
  it('R1 wrapper at the very start', () => {
    expect([OPEN + 'reasoning' + CLOSE + 'answer'], 'answer', 'reasoning');
  });

  it('R2 tag split across chunk boundaries', () => {
    expect(['<thi', 'nk>rea', 'soning</thi', 'nk>ans', 'wer'], 'answer', 'reasoning');
  });

  it('R3 several think/answer blocks — the latch keeps honouring tags', () => {
    expect([OPEN + 'a' + CLOSE + 'x' + OPEN + 'b' + CLOSE + 'y'], 'xy', 'ab');
  });

  it('R4 leading whitespace before the wrapper still counts as the start', () => {
    expect(['\n\n  ' + OPEN + 'r' + CLOSE + 'ans'], '\n\n  ans', 'r');
  });

  it('R5 an unclosed wrapper (model cut off mid-thought) stays thought', () => {
    expect([OPEN + 'thinking forever and ever'], '', 'thinking forever and ever');
  });

  it('R6 no tags at all', () => {
    expect(['plain ', 'answer'], 'plain answer', '');
  });
});

describe('THE BUG — the seven characters appearing as prose', () => {
  it('B1 prose first, then the literal tag', () => {
    expect(
      ['Hello. M3 leaks ' + OPEN + ' into its body.'],
      'Hello. M3 leaks ' + OPEN + ' into its body.',
      '',
    );
  });

  it('B2 the literal tag arriving in its own chunk after prose', () => {
    expect(['Hello. ', OPEN, ' is leaked.'], 'Hello. ' + OPEN + ' is leaked.', '');
  });

  it('B3 a closing tag as prose, never having opened one', () => {
    expect(['it writes ' + CLOSE + ' at the end'], 'it writes ' + CLOSE + ' at the end', '');
  });

  it('B4 both tags as prose', () => {
    expect(
      ['wrapped in ' + OPEN + ' and ' + CLOSE + ' tags'],
      'wrapped in ' + OPEN + ' and ' + CLOSE + ' tags',
      '',
    );
  });

  it('B5 a LATER chunk that STARTS with the tag, after prose has been decided', () => {
    // FOUND BY MUTATION TESTING 2026-10-27, not by reading the code. The guard
    // lives in two places that are NOT redundant: one for prose-and-tag in the
    // same chunk (the B1..B4 shape), and `honoursThinkTags` for the steady
    // state afterwards, where the tag sits at offset 0 of a later chunk and the
    // same-chunk branch never runs. Every case above decided in the first
    // branch and returned, so breaking `honoursThinkTags` outright left the
    // suite green — a hole exactly where the 2026-10-21 bug lived.
    expect(
      ['prose with ' + OPEN + ' inline.', OPEN + ' eaten?'],
      'prose with ' + OPEN + ' inline.' + OPEN + ' eaten?',
      '',
    );
  });

  it('B6 and the same for a closing tag at the start of a later chunk', () => {
    expect(
      ['prose with ' + OPEN + ' inline.', CLOSE + ' tail'],
      'prose with ' + OPEN + ' inline.' + CLOSE + ' tail',
      '',
    );
  });
});

describe('THE ARTEFACT SHAPE — long CJK prose, cut mid-sentence, then the tag', () => {
  // Synthetic stand-in for the real soul tail (see the header note).
  const tail =
    '記録は、読まれるまで何も起こさない。だから道標は、それが実際に何を示すかを正しく言うときだけ役に立つ。' +
    '石を積む者は、自分の石が道を指しているか確かめられない。確かめられるのは、そこを通る人だけだ。' +
    '訂正は成果物であり、間違った版を消さずに残すことが、次に読む者への唯一の誠実な形になる。' +
    'そして計器そのものが壊れていないかを先に測る——合計と一致する計数値は、結果ではなく故障だ。' +
    'ここで文は途中で切れて';
  const rest = OPEN + ' を本文に漏らす）。あとに続く本文。\n\n<<<END>>>';

  it('A1 nothing is eaten when the tag arrives after prose', () => {
    expect([tail, rest], tail + rest, '');
  });

  it('A2 same, one character at a time (worst case for the tail logic)', () => {
    expect((tail + rest).split(''), tail + rest, '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTINUATION PREFILL (2026-11-06)
//
// A reply cut off mid-thought is continued by sending the model
// `{role:'assistant', content:'<think>\n' + the thought so far}`. The model
// answers from INSIDE that block, so the opening tag never comes back down the
// stream and the splitter would otherwise read the rest of the reasoning —
// including the `</think>` that ends it — as the visible answer.
//
// Measured against gemma-4-26b-a4b-it-ultra-uncensored-heretic on LM Studio:
// round 1 produced 277 chars of reasoning_content and ZERO content; round 2,
// prefilled, produced 3257 chars of content that ran "…(This matches the
// provided good response).</think>To solve this problem, we need to…".
// ─────────────────────────────────────────────────────────────────────────────

/** Same as `split`, but the state starts where a `<think>` prefill left it. */
function splitAfterPrefill(chunks: string[]): { text: string; thought: string } {
  const st = newThinkTagState();
  enterThinkFromPrefill(st);
  let text = '';
  let thought = '';
  for (const c of chunks) {
    splitThinkTags(st, c, (t: string) => { text += t; }, (t: string) => { thought += t; });
  }
  if (st.textTail) {
    if (st.inThink) thought += st.textTail;
    else text += st.textTail;
  }
  return { text, thought };
}

describe('CONTINUATION — the stream resumes inside a think block we opened', () => {
  it('P1 the measured shape: rest of the thought, close tag, then the answer', () => {
    assert.deepEqual(
      splitAfterPrefill(['(This matches the provided good response).' + CLOSE + 'To solve this problem,']),
      { text: 'To solve this problem,', thought: '(This matches the provided good response).' },
    );
  });

  it('P2 without the prefill state the SAME bytes become the visible answer', () => {
    // The bug, stated as a test: this is what the user was shown — raw chain
    // of thought with a literal close tag sitting in the middle of the reply.
    const { text, thought } = split(['(This matches the provided good response).' + CLOSE + 'To solve this problem,']);
    assert.equal(thought, '');
    assert.ok(text.includes(CLOSE));
    assert.ok(text.startsWith('(This matches'));
  });

  it('P3 a round that is STILL thinking keeps every byte in the thought channel', () => {
    // Round 2 can hit the cap too. Nothing may surface as an answer, or the
    // next prefill is built from reasoning that was mislabelled as prose.
    assert.deepEqual(
      splitAfterPrefill(['still working through the second train', ' and its speed']),
      { text: '', thought: 'still working through the second train and its speed' },
    );
  });

  it('P4 the close tag may straddle a chunk boundary', () => {
    assert.deepEqual(
      splitAfterPrefill(['thinking</thi', 'nk>answer']),
      { text: 'answer', thought: 'thinking' },
    );
  });

  it('P5 a SECOND block after the close is still understood', () => {
    // enterThinkFromPrefill latches `usesThinkTags` for this: once the first
    // close lands, prose has been emitted, and without the latch the next
    // opening tag would be read as ordinary text.
    assert.deepEqual(
      splitAfterPrefill(['part one' + CLOSE + 'answer A' + OPEN + 'part two' + CLOSE + 'answer B']),
      { text: 'answer A' + 'answer B', thought: 'part one' + 'part two' },
    );
  });
});
