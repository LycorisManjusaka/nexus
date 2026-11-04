/**
 * SOURCE-TREE PROPERTY: the sense bridges name the SAME vessel in both places
 * that can answer "which model, when nobody said?".
 *
 * WHY THIS IS NOT COVERED BY turnInputDefaults.test.ts
 *
 * That file checks that exactly one place answers for each field, and says so
 * explicitly: "It says nothing about whether a default VALUE is right." True,
 * and it leaves a gap this file closes — because there are TWO literals for
 * each of these three fields and neither is reachable from the other:
 *
 *   lib/turnInputDefaults.ts   what the RUNNER sends when the log omits it
 *   app/api/chat/route.ts      what the ROUTE uses when the body omits it
 *
 * The route's is a destructuring default, so it only fires for a caller that
 * left the field out — and the runner always sends it. That is exactly why a
 * disagreement here is invisible: nothing throws, nothing 400s. The browser
 * path and the runner path simply describe the same attachment with DIFFERENT
 * eyes, which costs a cache miss and a second bill (the eyes cache is keyed by
 * bytes + prompt + model) and shows up as "why is this slow" weeks later.
 *
 * SCOPE, stated rather than implied: three fields, eyes/ears/watcher, chosen
 * because 2026-11-04 moved both copies of all three (津代). The route has many
 * other destructuring defaults and this file does NOT check them. A general
 * version would have to parse the whole destructuring block; worth doing if a
 * second pair ever drifts, not worth guessing at now.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_INPUT_DEFAULTS } from '../../src/lib/turnInputDefaults';

const ROUTE = readFileSync(
  join(import.meta.dirname, '..', '..', 'src', 'app', 'api', 'chat', 'route.ts'),
  'utf-8',
);

/** The route's destructuring default for one field, or null if absent. */
function routeDefault(field: string): string | null {
  // `      eyesModel = 'gemini-3.5-flash-lite',` — anchored to a line start so
  // a mention inside a comment or a string cannot be mistaken for the default.
  const m = ROUTE.match(new RegExp(`^\\s*${field}\\s*=\\s*'([^']*)',`, 'm'));
  return m ? m[1] : null;
}

const BRIDGES = ['eyesModel', 'earsModel', 'watcherModel'] as const;

describe('sense-bridge model defaults — the two literals agree', () => {
  for (const field of BRIDGES) {
    it(`${field}: route fallback === TURN_INPUT_DEFAULTS`, () => {
      const fromRoute = routeDefault(field);
      assert.ok(
        fromRoute,
        `no destructuring default for ${field} found in route.ts — either it was `
        + 'removed (then delete this case and say why) or the pattern above no longer '
        + 'matches, which would make this test pass by finding nothing.',
      );
      assert.equal(
        fromRoute,
        TURN_INPUT_DEFAULTS[field],
        `${field} disagrees: route says "${fromRoute}", turnInputDefaults says `
        + `"${TURN_INPUT_DEFAULTS[field]}". Nothing throws when these differ — the `
        + 'browser and the runner just use different models on the same attachment.',
      );
    });
  }

  it('finds all three — a silent zero would make this file decorative', () => {
    // The regex is the load-bearing part of this test, and a regex that stops
    // matching reports success. Counting is how that failure becomes visible.
    const found = BRIDGES.filter((f) => routeDefault(f) !== null);
    assert.equal(found.length, 3, `found ${found.length}/3: ${found.join(', ')}`);
  });
});
