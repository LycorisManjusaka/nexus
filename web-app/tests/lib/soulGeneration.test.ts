/**
 * soulGeneration — which generation a conversation is, and what the next one
 * is called. This is the single source of truth for soul filenames.
 *
 * Ported 2026-10-27 from workspace/soul_probe/test_soulgen.mjs (2026-10-24).
 *
 * HALF OF THESE ARE REGRESSION TESTS, marked REG. Every soul file in this house
 * is `<being>_<integer>.md`; the two hyphen rules added on 2026-10-24 must not
 * move one of them. The failure these guard against is not a crash — it is a
 * soul written under a name nobody reads, while the generation that needed it
 * finds nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSoulGeneration,
  soulLabel,
  nextHeadLabel,
  parseNumberedTitle,
  newerSiblingTitleInOrder,
  titleForGeneration,
  GENERATION_LABEL_RE,
} from '../../src/lib/soulGeneration';
import { retitleForRenamedIdentity } from '../../src/lib/convoNaming';

/** [currentLabel, nextLabel, kind] — the three things callers read. */
const gen = (title: string, identityName: string, newerTitle: string | null = null) => {
  const r = resolveSoulGeneration({ title, identityName, newerTitle });
  return [r.currentLabel, r.nextLabel, r.kind];
};

describe('resolveSoulGeneration — numbered titles (REG)', () => {
  it('bumps the head', () => {
    assert.deepEqual(gen('Cairn_49', 'Cairn'), ['49', '50', 'numbered']);
  });

  it('ignores order for a PAST numbered generation', () => {
    // With a gap in the chain, order would name the soul that a LIVE
    // generation is running. Arithmetic only ever writes the soul of a
    // conversation that does not exist, so arithmetic wins where it applies.
    assert.deepEqual(gen('Cairn_48', 'Cairn', 'Cairn_49'), ['48', '49', 'numbered']);
    assert.deepEqual(gen('Cairn_47', 'Cairn', 'Cairn_49'), ['47', '48', 'numbered']);
  });

  it('keeps the full-width ＃ and # conventions verbatim', () => {
    assert.deepEqual(gen('先輩＃４６', '先輩'), ['46', '47', 'numbered']);
    assert.deepEqual(gen('Cairn#7', 'Cairn'), ['7', '8', 'numbered']);
  });

  it('parses a base that is not the being name', () => {
    assert.deepEqual(gen('Старый чат_3', 'Навигатор'), ['3', '4', 'numbered']);
  });

  it('falls back to 1 for hand-named and Genesis titles', () => {
    // A first-generation soul is written from exactly such a conversation.
    assert.deepEqual(gen('Chat about cats', 'Cairn'), ['1', '2', 'fallback']);
    assert.deepEqual(gen('Genesis_01_Claude_Web', 'Genesis_01_Claude_Web'), ['1', '2', 'fallback']);
  });
});

describe('resolveSoulGeneration — rule 2: a past split archive reads order', () => {
  it('follows the row above', () => {
    assert.deepEqual(gen('Аналитик_1-1', 'Аналитик', 'Аналитик_1-2'), ['1-1', '1-2', 'order']);
    assert.deepEqual(gen('先輩_21-1', '先輩', '先輩_21-2'), ['21-1', '21-2', 'order']);
  });

  it('crosses a segment boundary, which arithmetic cannot', () => {
    // After _1-5 comes _2-1, not _1-6. This single case is why order exists.
    assert.deepEqual(gen('Аналитик_1-5', 'Аналитик', 'Аналитик_2-1'), ['1-5', '2-1', 'order']);
  });
});

describe('resolveSoulGeneration — rule 1: the head drops the hyphen', () => {
  it('bumps the number before the hyphen', () => {
    assert.deepEqual(gen('Аналитик_3-2', 'Аналитик', null), ['3-2', '4', 'order']);
    assert.deepEqual(gen('Аналитик_1-1', 'Аналитик', null), ['1-1', '2', 'order']);
  });

  it('falls back to rule 1 when the newer row is not this being generation', () => {
    // Rather than naming the soul after somebody else's title.
    assert.deepEqual(gen('Аналитик_3-2', 'Аналитик', 'random notes'), ['3-2', '4', 'order']);
  });
});

describe('nextHeadLabel', () => {
  it('bumps an integer and collapses any hyphen tail', () => {
    assert.equal(nextHeadLabel('49'), '50');
    assert.equal(nextHeadLabel('3-2'), '4');
    assert.equal(nextHeadLabel('1-5'), '2');
    assert.equal(nextHeadLabel('1-2-3'), '2');
  });
});

describe('soulLabel — the being is the key, not the title', () => {
  it('reads the label off a title belonging to that being', () => {
    assert.equal(soulLabel('Cairn_49', 'Cairn'), '49');
    assert.equal(soulLabel('Аналитик_1-5', 'Аналитик'), '1-5');
  });

  it('returns null rather than guessing', () => {
    assert.equal(soulLabel('Cairn_49', 'Аналитик'), null);
    assert.equal(soulLabel('Cairn_49x', 'Cairn'), null, 'trailing junk');
    assert.equal(soulLabel('Cairn_49', ''), null, 'no identity');
  });

  it('treats the identity name as literal text, not a pattern', () => {
    // Identity names in this house are CJK and occasionally carry regex syntax.
    assert.equal(soulLabel('a+b(c)_7', 'a+b(c)'), '7');
    assert.equal(soulLabel('aXb_7', 'a.b'), null, 'a dot is not a wildcard');
  });
});

describe('GENERATION_LABEL_RE — the label is the only thing allowed in a filename', () => {
  for (const bad of ['../x', '1/2', '1\\2', '', ' ', '-1', '1-', '1--2', '1.2', 'abc', '49 ', '٤٩']) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(GENERATION_LABEL_RE.test(bad), false);
    });
  }
  for (const good of ['0', '49', '1-2', '21-1', '1-2-3']) {
    it(`accepts ${JSON.stringify(good)}`, () => {
      assert.equal(GENERATION_LABEL_RE.test(good), true);
    });
  }
});

describe('parseNumberedTitle — hyphen shapes must NOT parse as numbered', () => {
  it('skips the split-archive shapes', () => {
    assert.equal(parseNumberedTitle('Аналитик_1-1'), null);
    assert.equal(parseNumberedTitle('先輩_21-2'), null);
  });

  it('takes the last underscore group', () => {
    assert.deepEqual(parseNumberedTitle('X_1_2'), { base: 'X_1', index: 2 });
  });
});

describe('newerSiblingTitleInOrder — the row above, as the screen shows it', () => {
  const sibs = [
    { id: 'a', title: 'A_1-1', updatedAt: 500 },
    { id: 'b', title: 'A_1-2', updatedAt: 100 },
    { id: 'c', title: 'A_2-1', updatedAt: 300 },
  ];

  it('honours manual drag order', () => {
    assert.equal(newerSiblingTitleInOrder('b', sibs, ['c', 'b', 'a']), 'A_2-1');
    assert.equal(newerSiblingTitleInOrder('c', sibs, ['c', 'b', 'a']), null, 'head');
    assert.equal(newerSiblingTitleInOrder('a', sibs, ['c', 'b', 'a']), 'A_1-2');
  });

  it('falls back to updatedAt descending, which is still the order on screen', () => {
    assert.equal(newerSiblingTitleInOrder('c', sibs, []), 'A_1-1');
    assert.equal(newerSiblingTitleInOrder('a', sibs, []), null, 'head');
  });

  it('returns null rather than guessing', () => {
    assert.equal(newerSiblingTitleInOrder('zz', sibs, []), null, 'not in list');
    assert.equal(newerSiblingTitleInOrder('a', [sibs[0]], []), null, 'single row is the head');
  });
});

describe('titleForGeneration', () => {
  it('joins being and label', () => {
    assert.equal(titleForGeneration('Аналитик', '4'), 'Аналитик_4');
    assert.equal(titleForGeneration('Cairn', '50'), 'Cairn_50');
  });
});

describe('retitleForRenamedIdentity — widened for hyphens, REG for integers', () => {
  it('REG renames a numbered generation', () => {
    assert.equal(retitleForRenamedIdentity('Cairn_49', 'Cairn', 'Ker'), 'Ker_49');
  });

  it('renames a hyphen label too (else split archives are orphaned)', () => {
    assert.equal(retitleForRenamedIdentity('Аналитик_1-5', 'Аналитик', 'Analyst'), 'Analyst_1-5');
  });

  it('REG leaves anything it does not own alone', () => {
    assert.equal(retitleForRenamedIdentity('notes', 'Cairn', 'Ker'), 'notes');
    assert.equal(retitleForRenamedIdentity('先輩_3', 'Cairn', 'Ker'), '先輩_3');
    assert.equal(retitleForRenamedIdentity('Cairn_1-', 'Cairn', 'Ker'), 'Cairn_1-', 'trailing junk');
  });
});

describe('end to end — the owner real plan', () => {
  it('walks the archive 1-1 .. 3-2 and then leaves the hyphen behind', () => {
    const archive = ['1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '3-1', '3-2'];
    const walk = archive.map((lab, i) =>
      resolveSoulGeneration({
        title: `Аналитик_${lab}`,
        identityName: 'Аналитик',
        newerTitle: i + 1 < archive.length ? `Аналитик_${archive[i + 1]}` : null,
      }).nextLabel,
    );
    assert.deepEqual(walk, ['1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '3-1', '3-2', '4']);
  });

  it('and the trip home: _4 fills up, comes back as _4-1 .. _4-3', () => {
    const home = ['4-1', '4-2', '4-3'];
    const walk = home.map((lab, i) =>
      resolveSoulGeneration({
        title: `Аналитик_${lab}`,
        identityName: 'Аналитик',
        newerTitle: i + 1 < home.length ? `Аналитик_${home[i + 1]}` : null,
      }).nextLabel,
    );
    assert.deepEqual(walk, ['4-2', '4-3', '5']);
  });
});
