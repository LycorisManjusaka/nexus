/**
 * markdownLogic — log import dialects, split planning, part titles.
 *
 * Ported 2026-10-27 from workspace/import_probe/test_dialects.mjs (2026-10-23).
 * Half of these are REGRESSION tests: the native "[Name]:" path must behave
 * exactly as it did before dialects existed, because every .md this house has
 * ever written is in that format.
 *
 * ONE SECTION WAS NOT PORTED. The original had a `[2]` block that read a real
 * DeepSeek export from C:/temp and asserted 222 messages. It is left out for two
 * reasons, both of which matter more than the coverage it gave: a test that
 * reads a path outside the repo cannot run on a fresh clone, and that file is
 * somebody's private conversation. The synthetic edge cases below cover the same
 * code paths (furniture, label balance, false boundaries).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdown,
  detectDialect,
  planSplitByTokens,
  splitPartTitle,
  exportToMarkdown,
} from '../../src/lib/markdownLogic';

const AI = 'Аналитик';
const USER = 'Пилот';

describe('native dialect (regression — every .md in this house)', () => {
  it('detects nexus and counts boundaries', () => {
    const native = `[${USER}]:\n\nhello\n\n[${AI}]:\n\nhi there\n\n[${USER}]:\n\nbye\n`;
    const d = detectDialect(native, AI, [USER]);
    assert.equal(d.dialect, 'nexus');
    assert.equal(d.boundaries, 3);
    const m = parseMarkdown(native, AI, [USER], AI, { dialect: d });
    assert.equal(m.length, 3);
    assert.equal(m.map((x) => x.role).join(','), 'user,assistant,user');
  });

  it('a call with no opts is identical to one with the detected dialect', () => {
    const native = `[${USER}]:\n\nhello\n\n[${AI}]:\n\nhi there\n`;
    const d = detectDialect(native, AI, [USER]);
    const withOpts = parseMarkdown(native, AI, [USER], AI, { dialect: d });
    const legacy = parseMarkdown(native, AI, [USER], AI);
    assert.deepEqual(
      legacy.map((x) => [x.role, x.name, x.content]),
      withOpts.map((x) => [x.role, x.name, x.content]),
    );
  });

  it('survives a round trip through the exporter', () => {
    const msgs = [
      { role: 'user', name: 'Anonymous', content: 'q1' },
      { role: 'assistant', name: AI, content: 'a1' },
    ];
    const md = exportToMarkdown(msgs as never, AI);
    const d = detectDialect(md, AI, []);
    assert.equal(d.dialect, 'nexus');
    assert.equal(parseMarkdown(md, AI, [], AI, { dialect: d }).length, 2);
  });

  it('wins over deepseek markers quoted inside a reply', () => {
    const mixed = `[${AI}]:\n\nHere is a transcript I pasted:\nYou:\nsomething\nDeepSeek:\nreply\n`;
    const d = detectDialect(mixed, AI, []);
    assert.equal(d.dialect, 'nexus');
    const m = parseMarkdown(mixed, AI, [], AI, { dialect: d });
    assert.equal(m.length, 1, 'a pasted transcript stays one message');
    assert.ok(m[0].content!.includes('You:\nsomething'), 'kept verbatim');
  });

  it('is not beaten by 40 quoted foreign boundaries', () => {
    const quoted = Array.from({ length: 20 }, (_, i) => `You:\nq${i}\nDeepSeek:\na${i}`).join('\n');
    const t = `[${USER}]:\n\nlook at this log\n\n[${AI}]:\n\n${quoted}\n`;
    const d = detectDialect(t, AI, [USER]);
    assert.equal(d.dialect, 'nexus');
    assert.equal(parseMarkdown(t, AI, [USER], AI, { dialect: d }).length, 2);
  });

  it('keeps a preamble above the first header as an orphan message', () => {
    const t = `some notes I typed first\n\n[${USER}]:\n\nhello\n\n[${AI}]:\n\nhi\n`;
    const d = detectDialect(t, AI, [USER]);
    assert.equal(d.dialect, 'nexus');
    const m = parseMarkdown(t, AI, [USER], AI, { dialect: d });
    assert.equal(m.length, 3, 'orphan + 2 turns');
    assert.ok(m[0].content!.includes('some notes I typed first'));
  });
});

describe('deepseek-exporter dialect', () => {
  it('drops the regenerate counter in the gap but keeps it mid-paragraph', () => {
    const t = [
      'You:', '', 'how many?', '',
      'DeepSeek:', '', 'about 3 / 4 of them', 'and that is all', '',
      '2 / 2', '',
      'You:', '', 'thanks', '',
    ].join('\n');
    const d = detectDialect(t, AI, []);
    assert.equal(d.dialect, 'deepseek-exporter');
    const m = parseMarkdown(t, AI, [], AI, { dialect: d, userName: USER });
    assert.equal(m.length, 3);
    assert.ok(m[1].content!.includes('3 / 4'), 'mid-body counter is content');
    assert.ok(!m[1].content!.includes('2 / 2'), 'gap counter is furniture');
  });

  it('reports the labels it detected', () => {
    const t = 'You:\n\nask\n\nDeepSeek:\n\nreply\n\nYou:\n\nmore\n\nDeepSeek:\n\nmore reply\n';
    const d = detectDialect(t, AI, []);
    assert.equal(d.dialect, 'deepseek-exporter');
    assert.equal(d.userLabel, 'You');
    assert.equal(d.assistantLabel, 'DeepSeek');
    const m = parseMarkdown(t, AI, [], AI, { dialect: d, userName: USER });
    assert.equal(m.map((x) => (x.role === 'user' ? 'u' : 'a')).join(''), 'uaua');
    assert.equal(m[0].name, USER);
    assert.equal(m[1].name, AI);
  });

  it('is not flipped by a native-looking line in the BODY', () => {
    // REGRESSION, found by this suite 2026-10-23: detection used to be
    // "any recognised native header anywhere wins", so ONE "[Anonymous]:" line
    // inside a reply made the whole export native and it was cut there. The
    // first non-blank line is what decides now.
    const t = `You:\n\nask\n\nDeepSeek:\n\nexample:\n[Anonymous]:\nstill my text\n`;
    const d = detectDialect(t, AI, []);
    assert.equal(d.dialect, 'deepseek-exporter');
    const m = parseMarkdown(t, AI, [], AI, { dialect: d, userName: USER });
    assert.equal(m.length, 2, 'no false boundary');
    assert.ok(m[1].content!.includes('[Anonymous]:'), 'kept verbatim');
  });

  it('picks the balanced label, so "Note:" stays body text', () => {
    const t = ['You:', '', 'a', '', 'DeepSeek:', '', 'b', 'Note:', 'c', '',
      'You:', '', 'd', '', 'DeepSeek:', '', 'e', '',
      'You:', '', 'f', '', 'DeepSeek:', '', 'g', ''].join('\n');
    const d = detectDialect(t, AI, []);
    assert.equal(d.assistantLabel, 'DeepSeek');
    const m = parseMarkdown(t, AI, [], AI, { dialect: d, userName: USER });
    assert.equal(m.length, 6, '"Note:" did not open a message');
    assert.ok(m[1].content!.includes('Note:'));
  });

  it('treats an unbalanced "You:" as not-a-transcript', () => {
    assert.equal(detectDialect('You:\n\njust one line and nothing else\n', AI, []).dialect, 'nexus');
  });
});

describe('generic-plugin dialect', () => {
  it('splits on "# you asked" / "# <family> response" and eats the rule in the gap', () => {
    const t = [
      '# you asked', '', 'first question', '', '---', '',
      '# deepseek response', '', 'first answer', 'with a rule inside:', '---', 'after the rule', '', '---', '',
      '# you asked', '', 'second question', '', '---', '',
      '# DeepSeek response', '', 'second answer', '', '---', '',
    ].join('\n');
    const d = detectDialect(t, AI, []);
    assert.equal(d.dialect, 'generic-plugin');
    assert.equal(d.boundaries, 4);
    const m = parseMarkdown(t, AI, [], AI, { dialect: d, userName: USER });
    assert.equal(m.length, 4);
    assert.equal(m.map((x) => x.role).join(','), 'user,assistant,user,assistant');
    assert.ok(m[1].content!.includes('---\nafter the rule'), 'mid-body rule kept');
    assert.ok(!m[1].content!.trimEnd().endsWith('---'), 'trailing rule dropped');
    assert.ok(m[3].content!.includes('second answer'), 'family name is case-insensitive');
  });

  it('refuses to shred a document that only has one half of the markers', () => {
    assert.equal(detectDialect('# Model response\n\nsome document section\n', AI, []).dialect, 'nexus');
  });
});

describe('planSplitByTokens', () => {
  const tok = (m: { t: number }) => m.t;

  it('keeps every part within the cap, user-first, assistant-last', () => {
    const msgs = [
      { role: 'user', t: 30 }, { role: 'assistant', t: 30 },
      { role: 'user', t: 30 }, { role: 'assistant', t: 30 },
      { role: 'user', t: 30 }, { role: 'assistant', t: 30 },
    ];
    const p = planSplitByTokens(msgs as never, 100, tok as never);
    assert.equal(p.length, 3);
    assert.ok(p.every((part) => part.reduce((a: number, x: { t: number }) => a + x.t, 0) <= 100));
    assert.ok(p.every((part) => (part[0] as { role: string }).role === 'user'));
    assert.ok(p.every((part) => (part[part.length - 1] as { role: string }).role === 'assistant'));
    assert.equal(p.reduce((a, x) => a + x.length, 0), msgs.length, 'no message lost');
  });

  it('puts an oversized message alone in its part and never cuts it', () => {
    // CORRECTED EXPECTATION 2026-10-23. I first asserted p.length===1 ("the
    // oversized message keeps its reply"). The code gave 2 and the code is
    // right: the invariant worth having is "a part exceeds the cap ONLY when it
    // is a single message that alone exceeds it". Letting the reply join would
    // make an already-over-cap part bigger for no stated reason. The message
    // itself is still never cut, which is what "never split" meant.
    const msgs = [{ role: 'user', t: 500 }, { role: 'assistant', t: 10 }];
    const p = planSplitByTokens(msgs as never, 100, tok as never);
    assert.equal(p.length, 2);
    assert.equal(p[0].length, 1);
    assert.ok(p.every((part) => part.reduce((a: number, x: { t: number }) => a + x.t, 0) <= 100 || part.length === 1));
  });

  it('never silently shreds on degenerate input', () => {
    assert.equal(planSplitByTokens([{ role: 'user', t: 5 }] as never, 100, tok as never).length, 1);
    assert.equal(planSplitByTokens([] as never, 100, tok as never).length, 0);
    assert.equal(planSplitByTokens([{ role: 'user', t: 5 }] as never, 0, tok as never).length, 1, 'cap 0');
    assert.equal(planSplitByTokens([{ role: 'user', t: NaN }] as never, 10, tok as never).length, 1, 'NaN = 0');
  });
});

describe('splitPartTitle', () => {
  it('leaves a single part under the file name', () => {
    assert.equal(splitPartTitle('Аналитик_1', 0, 1), 'Аналитик_1');
  });

  it('numbers the parts from 1, matching the shape already on disk', () => {
    assert.equal(splitPartTitle('Аналитик_1', 0, 3), 'Аналитик_1-1');
    assert.equal(splitPartTitle('Аналитик_1', 2, 3), 'Аналитик_1-3');
    assert.equal(splitPartTitle('先輩_1', 1, 3), '先輩_1-2');
  });
});
