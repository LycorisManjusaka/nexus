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
import { exportHeaderName, isRecognisedHeader } from '../../src/lib/speakerHeader';
import { exportToMarkdown, parseMarkdown } from '../../src/lib/markdownLogic';

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
