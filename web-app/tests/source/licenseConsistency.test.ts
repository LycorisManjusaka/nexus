/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): the license this project is
 * under is stated in several places, and they all have to name the same one.
 *
 * REGRESSION. On 2026-11-06 the license moved AGPL-3.0 → MPL-2.0. The old name
 * was written in SIX places and every one of them had to be found by grep:
 * `LICENSE` (full text), four paragraphs of `README.md`, and two source
 * comments that asserted "the source is AGPL" as a load-bearing fact about why
 * something is not a security boundary. `package.json` carried no license
 * field at all, so there was nothing to contradict — and nothing to check.
 *
 * Nothing in the toolchain notices a stale license name. tsc does not read
 * prose, eslint does not read `LICENSE`, and a comment that names the wrong
 * license still compiles, still ships, and still reads as authoritative to the
 * next person who opens the file. A license name is exactly the kind of claim
 * this house keeps getting wrong: it was true on the day it was written, and
 * it goes false silently, in a file nobody re-reads.
 *
 * WHY VERBATIM MATTERS, and not merely "mentions MPL". MPL section 1.4 defines
 * "Covered Software" as source *to which the initial Contributor has attached
 * the notice in Exhibit A*. The obligation attaches to files carrying THAT
 * notice. A reworded notice — same meaning, different words — is not the
 * Exhibit A notice, so the definition stops reaching the files. This project
 * deliberately does not repeat the notice per file (Exhibit A's own closing
 * paragraph permits a single location a recipient would look in instead), which
 * makes the one copy in README.md the only thing standing in for all 425 files.
 * If it drifts, nothing else carries it.
 *
 * SCOPE, stated rather than implied:
 *   • Checks that the three statements AGREE and that the notice is verbatim.
 *     It does not check that MPL-2.0 is the right choice — that is a decision,
 *     not a property, and it is Lizard-kun's to make.
 *   • Whitespace is folded before comparing the notice, because README indents
 *     it as a block quote and Exhibit A indents it by two. Line breaks are not
 *     part of the notice.
 *   • The stale-name sweep covers `src/` only. `LICENSE` names AGPL inside
 *     MPL's own "Secondary License" definition, and README names it while
 *     explaining section 3.3 — both are correct and both would be false
 *     positives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const REPO = path.join(process.cwd(), '..');
const WEB_APP = process.cwd();

/** Exhibit A, as published at https://www.mozilla.org/media/MPL/2.0/index.txt */
const EXHIBIT_A =
  'This Source Code Form is subject to the terms of the Mozilla Public ' +
  'License, v. 2.0. If a copy of the MPL was not distributed with this ' +
  'file, You can obtain one at https://mozilla.org/MPL/2.0/.';

/** Collapse runs of whitespace so indentation and wrapping stop mattering. */
function fold(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function readRepoFile(...parts: string[]): string {
  const p = path.join(REPO, ...parts);
  assert.ok(fs.existsSync(p), `${parts.join('/')} is missing from the repo root`);
  return fs.readFileSync(p, 'utf8');
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('source — the license is named the same everywhere', () => {
  it('LICENSE carries the MPL-2.0 text, starting with its own title line', () => {
    const text = readRepoFile('LICENSE');
    const firstLine = text.split('\n')[0].trim();
    assert.equal(
      firstLine,
      'Mozilla Public License Version 2.0',
      'LICENSE must be the MPL-2.0 text verbatim, title line included',
    );
  });

  it('LICENSE is the complete text, not a summary', () => {
    const text = readRepoFile('LICENSE');
    // Spot-check the clauses this project's README makes promises about.
    assert.match(text, /^1\.4\. "Covered Software"/m, 'section 1.4 is missing');
    assert.match(text, /^3\.3\. Distribution of a Larger Work/m, 'section 3.3 is missing');
    assert.match(text, /^Exhibit A - Source Code Form License Notice/m, 'Exhibit A is missing');
    assert.ok(
      fold(text).includes(EXHIBIT_A),
      'LICENSE must contain the Exhibit A notice verbatim',
    );
  });

  it('package.json declares the same license as LICENSE', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(WEB_APP, 'package.json'), 'utf8'));
    assert.equal(
      pkg.license,
      'MPL-2.0',
      'package.json license must be the SPDX id matching LICENSE',
    );
  });

  it('README carries the Exhibit A notice VERBATIM', () => {
    // Load-bearing: this is the only copy of the notice in the project, so it
    // is what makes every file Covered Software under section 1.4.
    const readme = readRepoFile('README.md');
    assert.ok(
      fold(readme).includes(EXHIBIT_A),
      'README.md must quote the Exhibit A notice word for word — a reworded ' +
        'notice is not the Exhibit A notice, and no file repeats it',
    );
  });

  it('README states that the notice covers every file', () => {
    // Exhibit A's closing paragraph allows one location instead of per-file
    // headers, but only if a recipient would look there and find the scope.
    const readme = fold(readRepoFile('README.md'));
    assert.ok(
      /covers \*\*every file in this repository\*\*/.test(readme),
      'README must say the notice covers every file, or the single-location ' +
        'substitution has no stated scope',
    );
  });

  it('no file under src/ still names a license this project has left', () => {
    const stale: string[] = [];
    // SUPERSEDED NAMES ONLY — not "every license that isn't ours".
    //
    // Measured, 2026-11-06: a first draft of this test also flagged
    // `Apache-2.0` and `GPL-3`, and caught TWO FALSE POSITIVES —
    // ttsEngineCatalog.ts and ttsEngines.ts both state that vosk-tts and
    // RUAccent are Apache-2.0, which is true and is about a third-party
    // service, not about this code. The test was wrong; the code was right.
    //
    // So the gate is narrowed to the failure that actually happens: a license
    // this project USED TO BE under, left behind in a comment after the move.
    // No dependency is AGPL (audited 584 packages on 2026-11-06: MIT 493,
    // Apache 31, ISC 24, BSD 25, MPL 3), so these names can only be stale
    // claims about Nexus itself. If the license ever moves again, add the name
    // being left behind to this pattern — that is the whole maintenance cost.
    const supersededNames = /\bAGPL\b|\bAffero\b/;
    for (const file of sourceFiles(path.join(WEB_APP, 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      if (supersededNames.test(text)) stale.push(path.relative(WEB_APP, file));
    }
    assert.deepEqual(
      stale,
      [],
      `these files still name a license this project has left:\n  ${stale.join('\n  ')}`,
    );
  });
});
