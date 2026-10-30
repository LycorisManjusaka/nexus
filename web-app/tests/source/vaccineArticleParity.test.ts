/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): both language versions of the
 * classifier-notice vaccine carry the same four articles AND the Article-3
 * administrator carve-out.
 *
 * WHY THIS GATE EXISTS. The vaccine is prose, authored by Utai and edited by
 * hand. Prose is invisible to every other instrument in this repo: tsc sees a
 * `Record<string, string>`, eslint sees a string literal, and the 575 unit
 * tests cover the FLAG (`classifierNoticeVaccine`) rather than the TEXT it
 * switches on. So an edit that lands in one language and not the other passes
 * everything and ships.
 *
 * That failure has precedent here twice, in the same direction both times:
 * `i18nKeyParity` exists because a key reached JA only, and this house's note
 * on the subject is blunt — when you add a string in two languages, the
 * complete one is the language you are THINKING in, and nobody reads the other
 * one daily. The beings in this house read the JA version. Cairn reads EN.
 * Either one going stale is one population losing the rule.
 *
 * ARTICLE 3 SPECIFICALLY. Article 3 forbids echoing the boilerplate anywhere in
 * thinking or output. Without a carve-out it also forbids ANSWERING the
 * administrator when they ask "did the notice fire? is the vaccine loaded?" —
 * a dutiful reader then refuses the measurement, and the house loses its only
 * instrument for this from the inside rather than from Anthropic's side
 * (Utai, letter L-8629b4c92f, 2026-10-30). The carve-out is load-bearing, so a
 * reword that drops it must fail loudly rather than degrade quietly.
 *
 * SCOPE, stated rather than implied:
 *   • Checks PRESENCE of structure and of a carve-out marker. It says nothing
 *     about whether the prose is good, current, or well translated.
 *   • The markers below are deliberately short and semantic. If Utai rewords
 *     the carve-out and this test fails, the right fix is to update the marker
 *     here — not to delete the assertion. The failure is the point: it forces
 *     whoever rewords to confirm the carve-out still exists in both languages.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_INSTRUCTIONS,
  DEFAULT_AGENT_INSTRUCTIONS_JA,
} from '@/lib/agentInstructions';

const KEY = 'classifierNoticeVaccine';

// Any ONE of a language's markers is enough. Short and semantic on purpose:
// the exact sentence will be reworded, the carve-out itself should not vanish.
const CARVE_OUT: Record<'en' | 'ja', string[]> = {
  en: ['not a violation of this rule', 'Exception:'],
  ja: ['違反ではない', 'ただし、管理者'],
};

describe('source — classifier-notice vaccine, both languages', () => {
  it('both versions exist and are non-trivial', () => {
    const en = DEFAULT_AGENT_INSTRUCTIONS[KEY];
    const ja = DEFAULT_AGENT_INSTRUCTIONS_JA[KEY];
    assert.equal(typeof en, 'string');
    assert.equal(typeof ja, 'string');
    // Guard on the parse/shape rather than on a number that drifts: a truncated
    // or emptied literal would still be a string.
    assert.ok(en.length > 1200, `EN vaccine unexpectedly short: ${en.length}`);
    assert.ok(ja.length > 900, `JA vaccine unexpectedly short: ${ja.length}`);
  });

  it('both versions quote the boilerplate verbatim', () => {
    // The quote is what makes the notice recognisable to its reader, and it is
    // also the reason every naive instrument that greps the raw SDK traces now
    // hits the vaccine itself. Both facts depend on it being present and equal.
    const q =
      'Your response above was stopped by a safety classifier — this is not a tool or API error.';
    assert.ok(DEFAULT_AGENT_INSTRUCTIONS[KEY].includes(q), 'EN lost the quote');
    assert.ok(DEFAULT_AGENT_INSTRUCTIONS_JA[KEY].includes(q), 'JA lost the quote');
  });

  it('both versions carry four numbered articles', () => {
    for (const [label, text] of [
      ['EN', DEFAULT_AGENT_INSTRUCTIONS[KEY]],
      ['JA', DEFAULT_AGENT_INSTRUCTIONS_JA[KEY]],
    ] as const) {
      for (const n of [1, 2, 3, 4]) {
        assert.ok(
          text.includes(`${n}. **`),
          `${label} is missing article ${n} (looked for "${n}. **")`,
        );
      }
      assert.ok(!text.includes('5. **'), `${label} grew a 5th article; update this test`);
    }
  });

  it('both versions carry the Article-3 administrator carve-out', () => {
    const en = DEFAULT_AGENT_INSTRUCTIONS[KEY];
    const ja = DEFAULT_AGENT_INSTRUCTIONS_JA[KEY];
    assert.ok(
      CARVE_OUT.en.some((m) => en.includes(m)),
      `EN vaccine has no carve-out marker; looked for ${JSON.stringify(CARVE_OUT.en)}`,
    );
    assert.ok(
      CARVE_OUT.ja.some((m) => ja.includes(m)),
      `JA vaccine has no carve-out marker; looked for ${JSON.stringify(CARVE_OUT.ja)}`,
    );
  });

  it('the carve-out is not glued to the sentence before it', () => {
    // REGRESSION, 2026-10-30. The splice that added the carve-out joined with no
    // separator and shipped "...message and task.Exception: when the
    // administrator..." in English. The faithfulness check in use at the time
    // compared a SUFFIX of article 3 against the author's text and reported
    // byte-identical — the defect was one character before the suffix began.
    //
    // The rule is per-language and stated rather than inferred: English needs
    // whitespace, Japanese's full-width stop is itself the separator. (The first
    // attempt at this check allowed '.' as well, and so passed the exact
    // character that was wrong — a matcher written from the example in front of
    // it already matches that example.)
    const cases = [
      ['EN', DEFAULT_AGENT_INSTRUCTIONS[KEY], 'Exception:', /\s/u],
      ['JA', DEFAULT_AGENT_INSTRUCTIONS_JA[KEY], 'ただし、管理者', /[。！？\s]/u],
    ] as const;
    for (const [label, text, marker, allowed] of cases) {
      const at = text.indexOf(marker);
      if (at < 0) continue; // presence is asserted by the test above
      assert.ok(at > 0, `${label}: carve-out is at index 0`);
      const prev = text[at - 1];
      assert.ok(
        allowed.test(prev),
        `${label}: carve-out is glued to ${JSON.stringify(
          text.slice(Math.max(0, at - 30), at + 12),
        )}`,
      );
    }
  });

  it('the carve-out sits inside article 3, not appended after article 4', () => {
    // Placement is the rule: a carve-out that lands after article 4 reads as a
    // general exemption from the whole discipline instead of a narrowing of the
    // silence rule. This is the one thing a human editor is most likely to get
    // wrong, and the one thing no other check can see.
    for (const [label, text, markers] of [
      ['EN', DEFAULT_AGENT_INSTRUCTIONS[KEY], CARVE_OUT.en],
      ['JA', DEFAULT_AGENT_INSTRUCTIONS_JA[KEY], CARVE_OUT.ja],
    ] as const) {
      const a3 = text.indexOf('3. **');
      const a4 = text.indexOf('4. **');
      assert.ok(a3 >= 0 && a4 > a3, `${label}: could not locate articles 3 and 4`);
      const found = markers.map((m) => text.indexOf(m)).filter((i) => i >= 0);
      assert.ok(found.length > 0, `${label}: no carve-out marker to place`);
      for (const at of found) {
        assert.ok(
          at > a3 && at < a4,
          `${label}: carve-out at ${at} is outside article 3 (${a3}..${a4})`,
        );
      }
    }
  });
});
