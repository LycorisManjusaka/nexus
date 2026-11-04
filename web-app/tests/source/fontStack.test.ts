import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): the UI font stack names
 * real fonts, and names them in the one place the whole app reads.
 *
 * REGRESSION, 2026-11-05. つよ reported that the genesis shikigami button read
 * "и ジェネシス" instead of "Ω ジェネシス". It was not a rendering glitch and not
 * her machine being odd — `Ω` (U+03A9) really was being drawn with a glyph that
 * reads as the Cyrillic и, because the app shell (NexusApp.tsx) wears
 * `font-sans`, Tailwind's default for that utility begins `ui-sans-serif,
 * system-ui`, and on Japanese Windows `system-ui` resolves to Yu Gothic UI,
 * whose U+03A9 looks like и. Every character in the UI was going through that
 * stack.
 *
 * Two things made it survive:
 *
 *   • `globals.css` already set a font on `body` — and that rule is overridden
 *     by the shell's utility class, so the file LOOKED correct to anyone who
 *     read only the body rule. A fix applied there alone changes nothing
 *     visible, which is the worst kind of fix: it reports success.
 *   • It renders fine on a machine whose browser resolves `sans-serif` to
 *     Arial. Looking at it locally is not evidence.
 *
 * This house has paid for the same shape once before, in pixels rather than
 * CSS: the computer-control overlay used `font-family="sans-serif"` and
 * librsvg resolved it from whatever fonts that PC had installed, so the same
 * code produced different images on different machines (AUDIT_FONT in
 * computerTools.ts is the fixed list that replaced it).
 *
 * What this test holds is therefore narrow and deliberately annoying to
 * shorten: a bare `sans-serif` hands the decision to the viewer's browser
 * settings, so at least one REAL font family must be named before it.
 */

const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** The `--font-sans:` declaration inside the @theme block. */
function fontSansDecl(): string {
  const m = CSS.match(/--font-sans:\s*([^;]+);/);
  assert.ok(m, '--font-sans is not declared in globals.css at all');
  return m![1].replace(/\s+/g, ' ').trim();
}

test('--font-sans is declared, so Tailwind’s `font-sans` stops using its default', () => {
  // Tailwind's own default is the bug. Declaring the variable in @theme is what
  // replaces it for every `font-sans` element, including the app shell.
  const decl = fontSansDecl();
  assert.ok(decl.length > 0);
});

test('the stack names at least one real font before falling back to sans-serif', () => {
  const decl = fontSansDecl();
  // Strip the leading web font — the question is what catches a render where it
  // has not arrived (blocked web font, cold cache, portal outside the shell).
  const afterGeist = decl.replace(/var\(--font-geist-sans\),?/, '').trim();
  const named = afterGeist
    .split(',')
    .map(s => s.trim().replace(/^["']|["']$/g, ''))
    .filter(s => s && s !== 'sans-serif' && s !== 'serif' && s !== 'monospace');
  assert.ok(
    named.length > 0,
    `--font-sans falls straight through to a generic family (${decl}). ` +
    'A generic name is resolved by the viewer’s browser, not by this repo — ' +
    'that is how Ω became и. Name a real font (e.g. "Segoe UI", Arial).',
  );
});

test('the generic families Yu Gothic UI hides behind are not named first', () => {
  const decl = fontSansDecl();
  // `ui-sans-serif` and `system-ui` are exactly what Tailwind's default used,
  // and exactly what resolved to the font with the wrong omega. Re-introducing
  // either at the FRONT would restore the bug with the variable still declared,
  // which would look like a fix is in place.
  const first = decl.split(',')[0].trim();
  assert.ok(
    !/^(ui-sans-serif|system-ui)$/.test(first),
    `--font-sans leads with ${first}, which is the stack that drew Ω as и.`,
  );
});

test('the web font is still preferred — this is a fallback repair, not a replacement', () => {
  const decl = fontSansDecl();
  assert.ok(
    decl.startsWith('var(--font-geist-sans)'),
    'Geist should stay first: it carries Ω and it is the app’s actual typeface.',
  );
});

test('body reads the same variable instead of repeating the list', () => {
  // Two copies of a font stack is two chances to disagree, and the body copy is
  // the invisible one — it is overridden by the shell's `font-sans`, so a
  // divergence there would be silent.
  // No `s` flag: `[^}]` already matches newlines, and the flag needs es2018.
  const body = CSS.match(/body\s*\{[^}]*\}/);
  assert.ok(body, 'no body rule found in globals.css');
  const decl = body![0].match(/font-family:\s*([^;]+);/);
  assert.ok(decl, 'body sets no font-family');
  assert.equal(
    decl![1].trim(),
    'var(--font-sans)',
    'body should reference --font-sans, not restate the stack.',
  );
});

test('the measurement that justifies the stack is recorded next to it', () => {
  // The list reads like arbitrary taste. Without the measured line, the next
  // reader shortens it to `sans-serif` for tidiness and the glyph comes back.
  assert.ok(
    CSS.includes('U+03A9') && /Yu Gothic UI/.test(CSS),
    'globals.css should keep the Ω / Yu Gothic UI measurement beside --font-sans.',
  );
});
