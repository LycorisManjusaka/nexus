/**
 * SOURCE-TREE PROPERTY: nothing reads the per-being `settings.aiName` any more,
 * and every place that used to now derives the vessel from the conversations.
 *
 * WHY, 2026-11-08 (Lizard-kun): the field was removed. What made it removable
 * was a measurement — of the 23 beings in this house, 23 had no `aiName` in
 * settings.json, so both of its jobs (the family a new conversation opens on,
 * and the tokenizer profile the log importer and split planner use) were
 * already deciding on a hard-coded 'Claude'. Meanwhile 320 of 320 conversation
 * logs carry a header `aiName`, so the real answer was already on disk.
 *
 * WHY A SOURCE TEST AND NOT A UNIT TEST. `beingVesselFamily` has its own unit
 * tests; all of them would stay green if a caller went back to reading
 * `settings.aiName`, because the defect would be in the call site. The same
 * failure shape as the tool-history checkbox Fuwafuwa caught on 2026-11-08: the
 * rule was built and the gate that reached it was not updated, so the rule was
 * correct and unreachable. There is no DOM fixture for these components here.
 *
 * SCOPE, stated rather than implied:
 *   • Reads TEXT. It cannot tell whether the derived value is correct, only
 *     that no caller reads the deleted field and that the derivation is called.
 *   • COMMENTS ARE EXEMPT. The files deliberately explain what was removed and
 *     why, and those paragraphs mention `settings.aiName` by name. A test that
 *     banned the string outright would force the history to be deleted to stay
 *     green — which is the opposite of what this house wants.
 *   • A rename breaks it. Intended: the names are the contract being pinned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const SRC = path.join(process.cwd(), 'src');
const F = {
  chatArea: path.join(SRC, 'components', 'ChatArea.tsx'),
  nexusApp: path.join(SRC, 'components', 'NexusApp.tsx'),
  sidebar: path.join(SRC, 'components', 'Sidebar.tsx'),
  search: path.join(SRC, 'lib', 'conversationSearch.ts'),
  tick: path.join(SRC, 'app', 'api', 'runner', 'tick', 'route.ts'),
  vessel: path.join(SRC, 'lib', 'beingVessel.ts'),
  i18n: path.join(SRC, 'lib', 'i18n.tsx'),
};
const read = (p: string) => fs.readFileSync(p, 'utf-8');

/**
 * Strip comments so the history in the headers does not count as a read.
 *
 * Blocks are removed FIRST, as blocks. The line-based version of this function
 * failed its own first run: a JSX comment's continuation lines start with
 * neither `//` nor `*`, so the second line of
 *
 *     {@literal {}/* ...sat here. Removed together with `settings.aiName`: the
 *      vessel is now read off the conversations... *}
 *
 * was counted as code and the test reported its own explanation as an
 * offender. The claim "comments are exempt" was false for JSX specifically.
 *
 * KNOWN LIMIT, stated rather than discovered later: a string literal
 * containing the two characters that open a block comment would be clipped
 * here. Accepted — no call site this file covers has one, and the alternative
 * is a parser.
 */
function codeLines(src: string): string[] {
  const noBlocks = src.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '');
  return noBlocks.split(/\r?\n/).filter((ln) => {
    const t = ln.trim();
    if (!t) return false;
    return !t.startsWith('//');
  });
}

describe('source — the deleted field has no readers left', () => {
  for (const [name, file] of Object.entries(F)) {
    it(`${name} does not read settings.aiName as a value`, () => {
      const offenders = codeLines(read(file)).filter((ln) =>
        /settings\s*(\?\.|\.)\s*aiName/.test(ln),
      );
      assert.deepEqual(
        offenders,
        [],
        `settings.aiName was removed 2026-11-08; derive the vessel with `
        + `beingVesselFamily instead. Offending line(s):\n${offenders.join('\n')}`,
      );
    });
  }

  it('createFolder does not write aiName into a new being settings.json', () => {
    const code = codeLines(read(F.sidebar)).join('\n');
    assert.doesNotMatch(
      code,
      /settings:\s*\{\s*aiName/,
      'A new being must start with no vessel field — the readers derive it. '
      + 'Writing one here is what gave every DeepSeek being a "Claude" '
      + 'self-description for the life of the folder.',
    );
  });

  it('the runner no longer defaults the family to an empty string', () => {
    assert.doesNotMatch(
      codeLines(read(F.tick)).join('\n'),
      /aiName:\s*String\(\s*t\.settings\.aiName/,
      'Routing a turn to family "" is not a smaller error than routing it to a '
      + 'named one. Use FALLBACK_FAMILY.',
    );
  });
});

describe('source — the derivation is actually called', () => {
  const callers: [string, string, number][] = [
    // file key, why it needs the vessel, how many call sites
    ['nexusApp', 'the family a new conversation opens on + the ChatArea prop', 2],
    ['sidebar', 'the import tokenizer profile + a new being first conversation', 2],
  ];

  for (const [key, why, count] of callers) {
    it(`${key} calls beingVesselFamily ${count}x — ${why}`, () => {
      const hits = codeLines(read(F[key as keyof typeof F]))
        .filter((ln) => ln.includes('beingVesselFamily(')).length;
      assert.equal(
        hits,
        count,
        `expected ${count} call site(s) in ${key}; found ${hits}. If a site was `
        + `added or removed on purpose, update this count and say which.`,
      );
    });
  }

  it('the runner imports the fallback constant from the single source', () => {
    assert.match(read(F.tick), /import \{ FALLBACK_FAMILY \} from '@\/lib\/beingVessel'/);
  });
});

describe('source — one definition of what counts as a family', () => {
  it('ChatArea imports BASE_MODEL_FAMILIES instead of defining its own', () => {
    const code = codeLines(read(F.chatArea)).join('\n');
    assert.doesNotMatch(
      code,
      /const BASE_MODEL_FAMILIES\s*=/,
      'A second copy of the list lets a family be pickable in the UI and '
      + 'rejected by the derivation (or the reverse).',
    );
    assert.match(code, /import \{ BASE_MODEL_FAMILIES \} from '@\/lib\/beingVessel'/);
  });

  it('the allowlist lives in beingVessel and is exported', () => {
    assert.match(read(F.vessel), /export const BASE_MODEL_FAMILIES\s*=/);
    assert.match(read(F.vessel), /export const FALLBACK_FAMILY\s*=/);
  });
});

describe('source — the removed control took its strings with it', () => {
  it('the id.family.* keys are gone from both languages', () => {
    const i18n = read(F.i18n);
    for (const key of ['id.family.label', 'id.family.help']) {
      assert.doesNotMatch(
        i18n,
        new RegExp(`'${key.replace('.', '\\.')}'`.replace(/\./g, '\\.')),
        `${key} is orphaned: the control it labelled was removed. An unused key `
        + `is a promise that a screen somewhere still shows this.`,
      );
    }
  });
});
