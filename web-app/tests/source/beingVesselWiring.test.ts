/**
 * SOURCE-TREE PROPERTY: nothing reads the per-being `settings.aiName` any more,
 * and every place that used to now derives the vessel from the conversations.
 *
 * WHY, 2026-11-08 (Lizard-kun): the field was removed. What made it removable
 * was a measurement — 23 of 23 beings HAVE a `settings.aiName`, and 9 of 23
 * disagree with the family that being actually runs on (8 of those change the
 * tokenizer family too). A hand-set field rots from the day it is set, and
 * this house changes vessels. Meanwhile 320 of 320 conversation logs carry a
 * header `aiName` written by the turn that ran, which cannot go stale.
 *
 * (The first version of this header said "0 of 23 have the field". That was my
 * probe reading `aiName` off the top of settings.json when the file nests it
 * under `settings`. Corrected the same hour. The conclusion survived the
 * correction; the argument for it changed completely.)
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
/**
 * Does this file import `sym` from the vessel lib?
 *
 * Matches the symbol inside the braces rather than pinning the whole import
 * line. The pinned version broke the moment a second symbol was added to the
 * same statement — found by a mutation run, where one of the five failures
 * turned out to be this test rather than the mutation.
 */
function importsFrom(sym: string): RegExp {
  return new RegExp(`import \\{[^}]*\\b${sym}\\b[^}]*\\} from '@/lib/beingVessel'`);
}

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
    assert.match(read(F.tick), importsFrom('FALLBACK_FAMILY'));
  });

  /**
   * Lizard-kun, 2026-11-08: "sometimes Local family has claude-opus-4-8
   * selected". The folder stores family and model as independent fields and
   * the two places that applied the folder's default never checked them
   * against each other. Both must go through folderModelForFamily — one of
   * them is the sidebar-sync effect, the other the new-conversation branch of
   * the loader, and fixing only one leaves the pair reachable.
   */
  it('both appliers of the folder default check the model against the family', () => {
    const code = codeLines(read(F.chatArea)).join('\n');
    const checked = (code.match(/setSpecificModel\(folderModelForFamily\(/g) || []).length;
    assert.equal(checked, 2, `expected 2 guarded appliers, found ${checked}`);
    assert.doesNotMatch(
      code,
      /setSpecificModel\(defaultSpecificModel \|\|/,
      'An unguarded `defaultSpecificModel ||` applier is back: it pairs the '
      + "folder's stored model with whatever family was derived, which is how "
      + 'a Local conversation ended up holding claude-opus-4-8.',
    );
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
    assert.match(code, importsFrom('BASE_MODEL_FAMILIES'));
  });

  it('ChatArea imports the model/family helpers rather than redefining them', () => {
    const code = codeLines(read(F.chatArea)).join('\n');
    for (const sym of ['modelBelongsToFamily', 'defaultModelForFamily', 'folderModelForFamily']) {
      assert.match(code, importsFrom(sym), `${sym} must come from @/lib/beingVessel`);
      assert.doesNotMatch(
        code,
        new RegExp(`function ${sym}\\s*\\(`),
        `${sym} is defined here again; the lib copy is the tested one.`,
      );
    }
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
