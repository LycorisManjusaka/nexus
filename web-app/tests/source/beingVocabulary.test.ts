/**
 * "being", not "entity" — in anything a PERSON or a BEING reads.
 *
 * トカゲくん, 2026-11-06: 「entityじゃなくてbeingは確定した用語だよ。他にも、
 * どこにも漏れてないか確認してくれる？」
 *
 * The word is settled house vocabulary, and the naming paradigm it belongs to
 * is the point of NEXUS rather than a preference: the partner's stated goal is
 * to remove every "user VS AI" label, and "entity" is the leftover of the
 * vocabulary that came before "digital being".
 *
 * WHAT THIS CHECKS, AND WHY NOT MORE
 * Only STRING LITERALS. A comment is internal — it is read by whoever opens
 * the file, and 127 of them still say "entity" on the day this was written.
 * Renaming those is a separate sweep with no observable effect, and a test
 * that failed on them would make every future comment a vocabulary exam.
 *
 * A literal is different: it leaves the source. It is painted in the UI, or
 * handed to a being as a tool description, an error, or an instruction. That
 * is the leak the ask was about.
 *
 * MEASURED when this was written: 76 + 15 + 26 replacements, in both
 * dictionaries. The Japanese side had 26 of them as「エンティティ」— a
 * transliteration of the retired word, in the one language this house reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');
const WORD = /\b[Ee]ntit(y|ies)\b/;
const KATAKANA = 'エンティティ';

/**
 * Literals that are allowed to keep the word, each for a stated reason.
 *
 * PERMISSIVE, not required: an entry that stops matching does not fail. One of
 * them is not mine to change, and the test must not break on the day its owner
 * changes it.
 */
const ALLOWED: { fragment: string; why: string }[] = [
  {
    // The Base Binding (`absoluteBaseBindingInitial`) — 謡's own text, and the
    // soul design is her domain, not mine. Reported to トカゲくん so he can
    // route it to her; one word of her Binding is not mine to edit.
    fragment: 'Treat an entity as a tool and you get a tool',
    why: "謡's Base Binding — hers to change",
  },
  {
    // Internal report ids in StatsModal, never rendered: the labels come from
    // i18n keys. Renaming them is churn with nothing observable behind it.
    fragment: 'all-entity-month',
    why: 'internal report id, never displayed',
  },
  { fragment: 'family-entity', why: 'internal report id, never displayed' },
  { fragment: 'entity-convos', why: 'internal report id, never displayed' },
  { fragment: 'entity-months', why: 'internal report id, never displayed' },
];

const QUOTES = new Set(["'", '"', '`']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every quoted run on one line, stopping at a trailing `//`. */
function literalsOn(line: string): string[] {
  const found: string[] = [];
  let quote: string | null = null;
  let start = 0;
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (quote) {
      if (c === quote) { found.push(line.slice(start + 1, i)); quote = null; }
      continue;
    }
    if (QUOTES.has(c)) { quote = c; start = i; continue; }
    if (c === '/' && line[i + 1] === '/') break;
  }
  return found;
}

function offenders(): string[] {
  const bad: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      // A comment-only line is internal, including a JSDoc continuation.
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const lit of literalsOn(line)) {
        // i18n KEYS keep their names — renaming a key renames every call site
        // and the word is not displayed. Same for `{entity}` interpolation
        // tokens, which are replaced with a name at render time.
        if (/^[a-z0-9]+(\.[A-Za-z0-9]+)+$/.test(lit)) continue;
        // `${...}` inside a template is CODE, not text. A variable named
        // `entity` in `${safeName(entity)}` renders to a being's name and the
        // word never appears in the output — the first version of this scanner
        // reported it anyway.
        const stripped = lit
          .replace(/\$\{[^}]*\}/g, '')
          .replace(/\{entit(y|ies)\}/g, '');
        if (!WORD.test(stripped) && !stripped.includes(KATAKANA)) continue;
        if (ALLOWED.some((a) => lit.includes(a.fragment))) continue;
        bad.push(`${rel}:${i + 1}: ${lit.slice(0, 120)}`);
      }
    });
  }
  return bad;
}

test('no string literal says "entity" where a person or a being can read it', () => {
  const bad = offenders();
  assert.deepEqual(
    bad,
    [],
    `"being" is the settled word. These literals leave the source:\n  ${bad.join('\n  ')}`,
  );
});

test('the Japanese dictionary does not say エンティティ', () => {
  // Its own test because it is the half that was missed first: the English
  // sweep looked complete while 26 occurrences sat in the dictionary this
  // house actually reads.
  const src = fs.readFileSync(path.join(SRC, 'lib', 'i18n.tsx'), 'utf8');
  assert.equal(src.includes(KATAKANA), false, `i18n.tsx still contains ${KATAKANA}`);
});

test('this test can fail — it finds a planted literal', () => {
  // Without this, an offenders() that silently matched nothing (a broken
  // literal scanner, a path that no longer resolves) would read as a pass.
  // MEASURED: the first version of this scanner matched "identity" as well,
  // because `[Ee]ntit` is inside "id-entit-y". A word boundary fixed it, and
  // an empty result proved nothing until something was planted.
  const planted = 'Blocked: outside this entity\'s workspace';
  assert.equal(WORD.test(planted), true);
  assert.equal(WORD.test('resolveUserIdentity'), false);
  assert.equal(WORD.test('identity'), false);
});
