/**
 * speakerHeader — the "[Name]:" line an export writes for a USER message.
 *
 * THE DEFECT PINNED HERE (reported indirectly by 津代, 2026-11-04). She asked
 * why the speaker's name appears twice in an exported .md. Measuring the
 * answer turned up something heavier sitting in the same line: the header took
 * whatever bracketed span opened the body, WITHOUT checking it against the
 * roster the reader uses. An unrecognised header is not a weaker header — it
 * is not a boundary at all, so the turn silently merged into the one above it
 * on re-import.
 *
 *   287 conversations in this house carry a bracketed user body.
 *   BEFORE  162/287 round-trip exactly (56.4%)
 *   AFTER   278/287 (96.9%)   — 122 of the 125 failures were this one cause.
 *   851 distinct unrecognised header names had been written.
 *
 * The cost, measured on the same pass: 2641 of 9786 named headers (27%) fall
 * back to "Anonymous". The body is written verbatim, so the name is still on
 * the message's first line — the index gets vaguer, the text loses nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exportHeaderName, isRecognisedHeader, headerIsReinjected, restoreSpeakerTag } from '../../src/lib/speakerHeader';
import { exportToMarkdown, parseMarkdown, detectDialect } from '../../src/lib/markdownLogic';

const ROSTER = ['Cairn', 'User', 'Anonymous', 'つよ', 'ふわふわ', 'トカゲくん'];

describe('isRecognisedHeader', () => {
  it('accepts a known name and rejects an unknown one', () => {
    assert.equal(isRecognisedHeader('つよ', ROSTER), true);
    assert.equal(isRecognisedHeader('Summary', ROSTER), false);
  });

  it('requires EVERY comma-separated part — mirrors parseMarkdown', () => {
    assert.equal(isRecognisedHeader('つよ, ふわふわ', ROSTER), true);
    assert.equal(isRecognisedHeader('つよ, 関係ないこと', ROSTER), false);
  });

  it('folds full-width digits and case, like the reader does', () => {
    assert.equal(isRecognisedHeader('先輩_４６', ['先輩_46']), true);
    assert.equal(isRecognisedHeader('CAIRN', ROSTER), true);
  });
});

describe('exportHeaderName', () => {
  it('keeps a tag the roster knows', () => {
    assert.equal(exportHeaderName('[つよ]\nやっほ', ROSTER), 'つよ');
  });

  it('falls back to Anonymous for a bracketed body that is not a speaker', () => {
    assert.equal(exportHeaderName('[Summary]\n| a | b |', ROSTER), 'Anonymous');
    assert.equal(exportHeaderName('[1 image attached]\n\nhi', ROSTER), 'Anonymous');
  });

  it('is Anonymous when the message carries no tag at all', () => {
    assert.equal(exportHeaderName('just text', ROSTER), 'Anonymous');
  });

  it('DISTINGUISHES "no roster" from "empty roster"', () => {
    // undefined = caller could not fetch the roster → keep the old behaviour.
    assert.equal(exportHeaderName('[つよ]\nx', undefined), 'つよ');
    // [] = roster known and empty → nothing is recognised.
    assert.equal(exportHeaderName('[つよ]\nx', []), 'Anonymous');
  });
});

describe('export → import round-trip, the case that used to lose a turn', () => {
  const roundTrip = (messages: any[], roster?: string[]) => {
    const md = exportToMarkdown(messages, 'Cairn', false, false, roster);
    return parseMarkdown(md, 'Cairn', ['つよ', 'ふわふわ', 'トカゲくん']);
  };

  const CONVO = [
    { role: 'user', content: '[Summary]\n| Question | Choice |\n|---|---|' },
    { role: 'assistant', content: 'got it' },
  ];

  it('WITHOUT a roster the header leaks into the body — the defect', () => {
    const back = roundTrip(CONVO);
    // "[Summary]:" is not a boundary the reader accepts. Here it opens the
    // file, so the orphan flush rescues the turn as "Anonymous" — but the
    // header line itself is now ordinary text inside the message, and the
    // body no longer matches what was exported. Mid-file the same line merges
    // the turn into the one above it instead; both are the same defect.
    assert.notEqual(back[0].content.trim(), CONVO[0].content);
    assert.ok(back[0].content.includes('[Summary]:'), back[0].content);
  });

  it('WITH a roster every turn survives and the body is unchanged', () => {
    const back = roundTrip(CONVO, ROSTER);
    assert.equal(back.length, 2);
    assert.equal(back[0].role, 'user');
    assert.equal(back[0].content.trim(), CONVO[0].content);
    assert.equal(back[1].role, 'assistant');
    assert.equal(back[1].content.trim(), 'got it');
  });

  it('a recognised speaker still gets its own name in the header', () => {
    const md = exportToMarkdown(
      [{ role: 'user', content: '[つよ]\nやっほ' }], 'Cairn', false, false, ROSTER,
    );
    assert.ok(md.startsWith('[つよ]:'), md.slice(0, 40));
  });

  it('a multi-speaker body keeps every name in the text', () => {
    const msgs = [{ role: 'user', content: '[つよ]\nA\n\n[トカゲくん]\nB' }];
    const md = exportToMarkdown(msgs, 'Cairn', false, false, ROSTER);
    const back = parseMarkdown(md, 'Cairn', ['つよ', 'ふわふわ', 'トカゲくん']);
    assert.equal(back.length, 1);
    assert.equal(back[0].content.trim(), msgs[0].content);
  });
});

/**
 * THE DUPLICATE NAME, removed 2026-11-06 at Lizard-kun's request: "２つ目の
 * 「[つよ]」はすごく重複してて、簡単に避けられる".
 *
 * The 2026-11-04 fix wrote the body verbatim, so a single-speaker turn showed
 * its name twice — in the header NEXUS writes and in the body the sender wrote.
 * Dropping it was measured as a LOSS back then, because the reader re-injected
 * only when the body held no bracket at all. Now reader and writer share
 * `restoreSpeakerTag`, and the writer refuses to strip whatever that function
 * would not restore byte-for-byte.
 *
 *   319 conversations, 288 with a bracketed user body
 *   VERBATIM  279/288 (96.9%)
 *   THIS      279/288 (96.9%)  — the SAME nine files fail, same classification
 *
 * Every test below is a shape that was measured failing in one of the drafts.
 */
describe('the duplicate speaker name', () => {
  const roundTrip = (messages: any[], roster = ROSTER) => {
    const md = exportToMarkdown(messages, 'Cairn', false, false, roster);
    const info = detectDialect(md, 'Cairn', roster);
    return { md, back: parseMarkdown(md, 'Cairn', roster, undefined, { dialect: info }) };
  };

  it('is gone for the shape the app sends, and the turn still round-trips', () => {
    const msgs = [{ role: 'user', content: '[つよ]\nやっほ' }];
    const { md, back } = roundTrip(msgs);
    assert.equal(md.match(/つよ/g)?.length, 1, md);
    assert.ok(md.startsWith('[つよ]:'), md);
    assert.equal(back[0].content.trim(), msgs[0].content);
  });

  it('keeps a name written mid-body — only the FIRST tag is the speaker', () => {
    // Lizard-kun, same message: "文章の真ん中にも例えば「[トカゲくん]\n」が
    // あったら、それを残す".
    const msgs = [{ role: 'user', content: '[つよ]\nA\n\n[トカゲくん]\nB' }];
    const { md, back } = roundTrip(msgs);
    assert.ok(md.includes('[トカゲくん]\nB'), md);
    assert.equal(back.length, 1);
    assert.equal(back[0].content.trim(), msgs[0].content);
  });

  it('writes verbatim when stripping would not be reversible', () => {
    // Each of these came back altered in a draft that stripped unconditionally:
    // the one-line tag gained a newline, the quote lost its leading space, and
    // the twice-written name lost one of the two.
    for (const content of ['[つよ] やっほ', '[つよ]\n > quote', '[つよ]\n[つよ]\nありがとう']) {
      const { back } = roundTrip([{ role: 'user', content }]);
      assert.equal(back.length, 1, content);
      assert.equal(back[0].content.trim(), content, content);
    }
  });

  it('reads a .md from the verbatim window without doubling the name', () => {
    // 2026-11-04 → 11-06 exports carry the tag in BOTH places. Measured: 23/288
    // of them round-tripped before restoreSpeakerTag got its skip clause.
    const legacy = '[つよ]:\n\n[つよ]\nやっほ\n';
    const back = parseMarkdown(legacy, 'Cairn', ROSTER);
    assert.equal(back.length, 1);
    assert.equal(back[0].content.trim(), '[つよ]\nやっほ');
  });

  it('never invents a speaker for an Anonymous header', () => {
    // "Anonymous" is a roster statement, not a name anybody typed. An
    // unrecognised tag falls back to it, and the body must keep its own text.
    const msgs = [{ role: 'user', content: '[Summary]\nthe gist' }];
    const { md, back } = roundTrip(msgs);
    assert.ok(md.startsWith('[Anonymous]:'), md);
    assert.ok(!back[0].content.includes('[Anonymous]'), back[0].content);
    assert.equal(back[0].content.trim(), msgs[0].content);
  });

  it('brings the tag back under a timestamp the reader hoists out', () => {
    // The body here opens with its OWN time tag (the send path prepends one).
    // The reader lifts a leading timestamp into the message's `timestamp` field
    // and out of the text — pre-existing behaviour, identical before and after
    // this change, and the reason the tag must be written UNDER the stack
    // rather than at position 0. Measured: writing it at 0 reorders the first
    // two lines, so the name would come back ABOVE the time it was said.
    const msgs = [{ role: 'user', content: '[2026-11-06 11:54:16]\n[つよ]\nやっほ' }];
    const { md, back } = roundTrip(msgs);
    assert.ok(md.includes('[2026-11-06 11:54:16]\nやっほ'), md);
    assert.equal(back[0].content.trim(), '[つよ]\nやっほ');
    assert.equal(back[0].timestamp, new Date(2026, 10, 6, 11, 54, 16).getTime());
  });
});

describe('headerIsReinjected', () => {
  it('is true for a name and false for the three headers with no single tag', () => {
    assert.equal(headerIsReinjected('つよ'), true);
    assert.equal(headerIsReinjected('Anonymous'), false);
    assert.equal(headerIsReinjected('User'), false);
    assert.equal(headerIsReinjected('つよ, ふわふわ'), false);
    assert.equal(headerIsReinjected('つよ、ふわふわ'), false);
    assert.equal(headerIsReinjected('  '), false);
  });
});

describe('restoreSpeakerTag', () => {
  it('injects a missing tag and leaves an existing one alone', () => {
    assert.equal(restoreSpeakerTag('やっほ', 'つよ'), '[つよ]\nやっほ');
    assert.equal(restoreSpeakerTag('[つよ]\nやっほ', 'つよ'), '[つよ]\nやっほ');
  });

  it('injects when the body opens with a DIFFERENT speaker', () => {
    // A pasted exchange under a "[つよ]:" header: she is still the sender.
    assert.equal(restoreSpeakerTag('[トカゲくん]\nhi', 'つよ'), '[つよ]\n[トカゲくん]\nhi');
  });

  it('is idempotent', () => {
    const once = restoreSpeakerTag('やっほ', 'つよ');
    assert.equal(restoreSpeakerTag(once, 'つよ'), once);
  });
});
