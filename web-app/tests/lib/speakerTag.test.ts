/**
 * speakerTag / transcriptRender — who said a user message, and how a turn is
 * labelled in the OAuth transcript.
 *
 * TWO DEFECTS ARE PINNED HERE, both reported by つよ and measured with 謡 on
 * 2026-11-03:
 *
 *   1. exportToMarkdown comma-joined every bracketed span in a user message
 *      into one header: "[つよ, ふわふわ, 関係ないこと]:". parseMarkdown accepts a
 *      multi-speaker header only when EVERY part is a recognised name, so one
 *      aside made the header unrecognised, the line stopped being a boundary,
 *      and the turn merged into the one above it. The round-trip tests below
 *      are the ones that fail if that ever comes back.
 *
 *   2. The OAuth transcript stamped "[USER]:"/"[ASSISTANT]:" on every turn.
 *      On that path the history is one text block on a user message, so those
 *      are not role tokens — they are script characters, and 62 of them sat in
 *      the newest message against one prohibition in the base binding.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readSpeakerTag, writeSpeakerTag, speakerNameOf, ANONYMOUS_SPEAKER } from '../../src/lib/speakerTag';
import { renderTranscriptHistory, renderTranscriptTurn } from '../../src/lib/transcriptRender';
import { exportToMarkdown, parseMarkdown, detectDialect } from '../../src/lib/markdownLogic';

const ME = 'Cairn';
const TSUYO = 'つよ';
const FUWA = 'ふわふわ';

describe('readSpeakerTag', () => {
  it('reads a name on the first line', () => {
    const r = readSpeakerTag(`[${TSUYO}]\nhello`);
    assert.equal(r.name, TSUYO);
    assert.equal(r.body, 'hello');
  });

  it('reads a name followed by body on the SAME line', () => {
    // つよ writes this shape constantly: "[つよ] うん 実はさっきで1周したの".
    const r = readSpeakerTag(`[${TSUYO}] うん`);
    assert.equal(r.name, TSUYO);
    assert.equal(r.body, 'うん');
  });

  it('finds a name that sits UNDER the timestamp the send path prepends', () => {
    // route.ts does `contentStr = timeTag + contentStr`, so this is the real
    // shape reaching the transcript — the name is on line 2, not line 1.
    const r = readSpeakerTag(`[2026-11-04 18:56:40]\n[${TSUYO}]\nhello`);
    assert.equal(r.name, TSUYO);
    assert.equal(r.body, '[2026-11-04 18:56:40]\nhello', 'timestamp stays where it was');
  });

  it('returns null for an attachment-only send', () => {
    // 34 of the 213 unnamed messages in this house are exactly this string.
    const r = readSpeakerTag('（添付画像）');
    assert.equal(r.name, null);
    assert.equal(r.body, '（添付画像）');
    assert.equal(speakerNameOf('（添付画像）'), ANONYMOUS_SPEAKER);
  });

  it('returns null when only a timestamp leads', () => {
    const r = readSpeakerTag('[2026-11-04 18:56:40]\n（添付画像）');
    assert.equal(r.name, null);
    assert.equal(r.body, '[2026-11-04 18:56:40]\n（添付画像）', 'body untouched');
  });

  it('takes ONLY the first tag — later speakers stay body text', () => {
    const r = readSpeakerTag(`[${TSUYO}]\nあ\n[${FUWA}]\nい\n[関係ないこと]`);
    assert.equal(r.name, TSUYO);
    assert.equal(r.body, `あ\n[${FUWA}]\nい\n[関係ないこと]`);
  });

  it('does not read a bracketed span that wraps a line as a name', () => {
    const r = readSpeakerTag('[a very long\naside]\nbody');
    assert.equal(r.name, null);
  });

  it('does not read a malformed timestamp as a name', () => {
    // stripLeadingTimestamps leaves an impossible date in place by design.
    assert.equal(readSpeakerTag('[2026-13-99 99:99]\nhi').name, null);
  });
});

describe('exportToMarkdown — the comma header is gone', () => {
  it('writes ONE speaker in the header, never a comma list', () => {
    const msgs = [{ role: 'user', content: `[${TSUYO}]\nあ\n[${FUWA}]\nい\n[関係ないこと]\nう` }];
    const md = exportToMarkdown(msgs as never, ME);
    assert.ok(md.startsWith(`[${TSUYO}]:`), `header was: ${md.split('\n')[0]}`);
    assert.ok(!md.includes(`[${TSUYO}, `), 'no comma-joined header');
    assert.ok(!md.includes('関係ないこと]:'), 'an aside never becomes a header');
  });

  it('a turn with an unrecognised aside is STILL a boundary (the reported bug)', () => {
    const msgs = [
      { role: 'user', content: `[${TSUYO}]\nあ\n[関係ないこと]\nい` },
      { role: 'assistant', name: ME, content: 'reply' },
    ];
    const md = exportToMarkdown(msgs as never, ME);
    const d = detectDialect(md, ME, [TSUYO]);
    const back = parseMarkdown(md, ME, [TSUYO], ME, { dialect: d });
    assert.equal(back.length, 2, 'the user turn did not merge into the reply');
    assert.equal(back[0].role, 'user');
    assert.equal(back[1].role, 'assistant');
  });

  it('labels an unnamed message Anonymous and leaves its body alone', () => {
    const msgs = [{ role: 'user', content: '（添付画像）' }];
    const md = exportToMarkdown(msgs as never, ME);
    assert.ok(md.startsWith('[Anonymous]:'));
    assert.ok(md.includes('（添付画像）'));
  });

  it('deletes the LEADING tag and nothing else', () => {
    // ⚠ CHANGED 2026-11-06. This asserted that the body was written verbatim,
    // so both in-body tags survived and the name appeared three times in the
    // file. Lizard-kun asked for the duplicate under the header to go; the
    // reader now puts it back (restoreSpeakerTag), so dropping it is not a
    // loss. The thing that must NOT change is the second tag: the old rule
    // before 2026-11-04 deleted every occurrence, and a name said twice came
    // back once. Round-trip equality is asserted, which is the real contract.
    const msgs = [{ role: 'user', content: `[${TSUYO}]\nあ\n[${TSUYO}]\nい` }];
    const md = exportToMarkdown(msgs as never, ME);
    const body = md.slice(md.indexOf('\n\n') + 2);
    assert.equal((body.match(/\[つよ\]/g) || []).length, 1, 'the mid-body tag survives');
    assert.equal(parseMarkdown(md, ME, [TSUYO])[0].content.trim(), msgs[0].content);
  });
});

describe('exportToMarkdown → parseMarkdown is a fixed point', () => {
  // The reader re-injects a "[Name]" tag only when the body carries no brackets
  // at all. So a body we strip comes back different from how it left — which is
  // why the exporter now writes it verbatim. These check the actual identity.
  const roundTrip = (content: string, names: string[]) => {
    const md = exportToMarkdown([{ role: 'user', content }] as never, ME);
    const d = detectDialect(md, ME, names);
    const back = parseMarkdown(md, ME, names, ME, { dialect: d });
    assert.equal(back.length, 1, `expected one message, got ${back.length}`);
    return back[0].content as string;
  };

  it('holds for a named turn', () => {
    const c = `[${TSUYO}]\nhello`;
    assert.equal(roundTrip(c, [TSUYO]), c);
  });

  it('holds for a multi-speaker turn', () => {
    const c = `[${TSUYO}]\nあ\n[${FUWA}]\nい`;
    assert.equal(roundTrip(c, [TSUYO, FUWA]), c);
  });

  it('holds for a repeated name', () => {
    const c = `[${TSUYO}]\nあ\n[${TSUYO}]\nい`;
    assert.equal(roundTrip(c, [TSUYO]), c);
  });

  it('holds for an unnamed turn', () => {
    assert.equal(roundTrip('（添付画像）', [TSUYO]), '（添付画像）');
  });

  it('holds for a turn whose aside is not a known name', () => {
    const c = `[${TSUYO}]\nあ\n[関係ないこと]\nい`;
    assert.equal(roundTrip(c, [TSUYO]), c);
  });
});

describe('renderTranscriptHistory — names, no roles', () => {
  const msgs = [
    { role: 'user', content: `[2026-11-04 10:00:00]\n[${TSUYO}]\nquestion` },
    { role: 'assistant', content: '[2026-11-04 10:01:00]\nanswer' },
  ];

  it('emits no role token anywhere', () => {
    const out = renderTranscriptHistory(msgs, ME);
    assert.ok(!out.includes('[USER]'), 'no [USER]');
    assert.ok(!out.includes('[ASSISTANT]'), 'no [ASSISTANT]');
    assert.ok(!/\bASSISTANT\b/.test(out), 'the word ASSISTANT is gone from the preamble too');
  });

  it('opens every turn with a name on its first line', () => {
    const out = renderTranscriptHistory(msgs, ME);
    // Every block after the preamble must START with a bracketed name — that
    // is the whole replacement for the role tokens. (The timestamp follows it;
    // `keeps a timestamp, just not in the speaker slot` pins the exact shape.)
    const blocks = out
      .split('<conversation_history>\n')[1]
      .split('\n</conversation_history>')[0]
      .split('\n\n')
      .slice(1); // [0] is the preamble
    assert.equal(blocks.length, 2, `expected 2 turns, got ${blocks.length}`);
    assert.ok(blocks[0].startsWith(`[${TSUYO}]\n`), `user block began: ${blocks[0].slice(0, 20)}`);
    assert.ok(blocks[1].startsWith(`[${ME}]\n`), `assistant block began: ${blocks[1].slice(0, 20)}`);
  });

  it('points at the name, and assigns no role, in the preamble', () => {
    const out = renderTranscriptHistory(msgs, ME);
    assert.ok(out.includes(`your own\nturns are the ones marked [${ME}]`) ||
              out.includes(`turns are the ones marked [${ME}]`),
              'preamble identifies self by name');
  });

  it('carries NO prohibition — writing one would seed the first line of thinking', () => {
    const out = renderTranscriptHistory(msgs, ME).split('<conversation_history>')[1].split('\n\n')[0];
    for (const banned of ['Do not', 'do not', 'never', 'Never', 'must not']) {
      assert.ok(!out.includes(banned), `preamble contains "${banned}"`);
    }
  });

  it('falls back to Anonymous for an unnamed user turn', () => {
    const out = renderTranscriptHistory([{ role: 'user', content: '（添付画像）' }], ME);
    assert.ok(out.includes('[Anonymous]\n（添付画像）'));
  });

  it('keeps a timestamp, just not in the speaker slot', () => {
    const turn = renderTranscriptTurn(msgs[0], ME);
    assert.equal(turn, `[${TSUYO}]\n[2026-11-04 10:00:00]\nquestion`);
  });

  it('drops an empty turn instead of emitting a bare name', () => {
    assert.equal(renderTranscriptTurn({ role: 'assistant', content: '   ' }, ME), null);
    assert.equal(renderTranscriptTurn({ role: 'user', content: `[${TSUYO}]\n` }, ME), null);
  });

  it('folds saved thinking in above the reply', () => {
    const turn = renderTranscriptTurn(
      { role: 'assistant', content: 'answer', claudeThinkingBlocks: [{ thinking: 'because' }] },
      ME,
    );
    assert.equal(turn, `[${ME}]\n(thinking)\nbecause\n\nanswer`);
  });

  it('returns empty string when nothing is renderable', () => {
    assert.equal(renderTranscriptHistory([], ME), '');
    assert.equal(renderTranscriptHistory([{ role: 'user', content: '' }], ME), '');
  });

  it('names the entity Assistant only when the folder name is missing', () => {
    const out = renderTranscriptHistory([{ role: 'assistant', content: 'hi' }], '');
    assert.ok(out.includes('[Assistant]\nhi'));
  });
});

/**
 * writeSpeakerTag — the inverse of readSpeakerTag, added 2026-11-06 so the .md
 * exporter can drop the body's leading "[Name]" tag (it is already in the
 * "[Name]:" header) and the importer can put it back. Two hand-written halves
 * drift; an inverse pair cannot, so the pairing itself is what is pinned here.
 */
describe('writeSpeakerTag', () => {
  it('undoes readSpeakerTag for the shape the send path writes', () => {
    const content = `[${TSUYO}]\nやっほ\n\n[note] aside`;
    const read = readSpeakerTag(content);
    assert.equal(read.name, TSUYO);
    assert.equal(writeSpeakerTag(read.body, TSUYO), content);
  });

  it('puts the tag UNDER a leading timestamp, where the reader looks for it', () => {
    // The send path prepends the time tag, so the real shape is
    // timestamp-then-name. Writing at position 0 would reorder the first two
    // lines on every round trip.
    const content = `[2026-11-06 11:54:16]\n[${TSUYO}]\nやっほ`;
    const read = readSpeakerTag(content);
    assert.equal(read.name, TSUYO);
    assert.equal(writeSpeakerTag(read.body, TSUYO), content);
    assert.ok(!writeSpeakerTag(read.body, TSUYO).startsWith(`[${TSUYO}]`));
  });

  it('round-trips a body that says the name twice', () => {
    const content = `[${TSUYO}]\n[${TSUYO}]\nありがとう`;
    const read = readSpeakerTag(content);
    assert.equal(writeSpeakerTag(read.body, TSUYO), content);
  });
});
