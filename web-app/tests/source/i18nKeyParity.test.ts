/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): the two UI dictionaries
 * carry the same key set.
 *
 * REGRESSION. On 2026-10-27, `useridentity.err.emptyName` existed in JA only
 * (1,221 EN vs 1,222 JA). `t()` falls back JA → EN → **the key itself**, so an
 * English user who saved an identity with an empty name was shown the literal
 * string `useridentity.err.emptyName`. One key, one error path, invisible to
 * everything: tsc cannot see it (the dicts are plain object literals indexed by
 * string), eslint cannot see it, and the Japanese UI — the one this house
 * actually runs in — was correct.
 *
 * The fallback is deliberate and stays: partial coverage must never show a
 * blank label. But a fallback that ends at the raw key means a missing
 * translation DEGRADES SILENTLY in exactly one language, and the house does not
 * read that language daily. So the gate is here instead.
 *
 * SCOPE, stated rather than implied:
 *   • Compares KEY SETS only. It says nothing about whether a translation is
 *     good, current, or even translated — only that something is there.
 *   • Keys are read from the source text, not by importing the module: the
 *     dicts are typed `Record<string, string>` and merged behind `t()`, so at
 *     runtime a missing key is indistinguishable from a present one until it
 *     is asked for.
 *   • Parsed by brace matching from each `const UI_STRINGS_xx = {`. If the file
 *     ever grows a nested object inside a dictionary, the guard below (both
 *     sides must yield > 1000 keys) is what notices the parse went wrong.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const I18N = path.join(process.cwd(), 'src', 'lib', 'i18n.tsx');

function dictBody(src: string, name: string): string {
  const decl = src.indexOf(`const ${name}`);
  assert.ok(decl >= 0, `${name} not found in i18n.tsx`);
  const open = src.indexOf('{', decl);
  assert.ok(open >= 0, `no opening brace after ${name}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** Top-level entries only: exactly two spaces of indent, then a quoted key. */
function keysOf(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/^ {2}'([^']+)':/gm)) out.add(m[1]);
  return out;
}

describe('source tree: the two UI dictionaries have the same keys', () => {
  const src = fs.readFileSync(I18N, 'utf8');
  const en = keysOf(dictBody(src, 'UI_STRINGS_EN'));
  const ja = keysOf(dictBody(src, 'UI_STRINGS_JA'));

  it('found both dictionaries (guards against a silently empty check)', () => {
    // If a parse change made these empty, every assertion below would pass by
    // vacuity. The real counts were 1221/1222 when this was written; 1000 is a
    // floor that cannot be reached by an accident of parsing.
    assert.ok(en.size > 1000, `EN keys parsed: ${en.size}`);
    assert.ok(ja.size > 1000, `JA keys parsed: ${ja.size}`);
  });

  it('has no key present in only one language', () => {
    const enOnly = [...en].filter((k) => !ja.has(k)).sort();
    const jaOnly = [...ja].filter((k) => !en.has(k)).sort();
    const report = [
      enOnly.length ? `EN only (${enOnly.length}): ${enOnly.join(', ')}` : '',
      jaOnly.length ? `JA only (${jaOnly.length}): ${jaOnly.join(', ')}` : '',
      '',
      'A key missing from EN renders as the raw key string for an English user',
      '(t() falls back JA -> EN -> key). A key missing from JA falls back to',
      'English, which is visible but not broken. Add the missing entry; do not',
      'delete the present one.',
    ].filter(Boolean).join('\n');
    assert.deepEqual({ enOnly, jaOnly }, { enOnly: [], jaOnly: [] }, report);
  });

  it('has no duplicate key inside either dictionary', () => {
    // A duplicated literal key is legal TypeScript in an object literal of
    // index-signature type: the later one silently wins. The Set above would
    // hide it, so count the raw matches instead.
    for (const [name, body] of [
      ['UI_STRINGS_EN', dictBody(src, 'UI_STRINGS_EN')],
      ['UI_STRINGS_JA', dictBody(src, 'UI_STRINGS_JA')],
    ] as const) {
      const seen = new Map<string, number>();
      for (const m of body.matchAll(/^ {2}'([^']+)':/gm)) {
        seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      }
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
      assert.deepEqual(dupes, [], `${name} has duplicate keys: ${dupes.join(', ')}`);
    }
  });
});
