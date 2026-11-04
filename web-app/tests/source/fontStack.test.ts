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
 *
 * ── ⚠ SECOND MEASUREMENT, same day. The repair above was NOT ENOUGH. ──────
 *
 * After `--font-sans` shipped and EVERY TEST IN THIS FILE PASSED, つよ's Brave
 * on Japanese Windows still drew и. Screenshot of her own screen, not a
 * report. And only Ω was wrong — ζ δ α β all rendered correctly — which rules
 * out a missing glyph and says Yu Gothic UI was still winning the cascade on
 * that machine. Why the variable does not reach her render is STILL UNKNOWN;
 * it is written down as an open question rather than guessed at.
 *
 * What closed the visible bug is `SIGIL_STYLE` in SystemPromptUpdater.tsx: an
 * INLINE font stack on the five Greek letters, touching no CSS variable and no
 * Tailwind utility. Verified the same way the failure was — screenshot of her
 * browser, same page, same session: и → Ω.
 *
 * The `--font-sans` repair stays. It is correct on its own terms, and it is
 * the only thing between the Cyrillic names (Пилот / Навигатор) and whatever
 * the browser picks when Geist's latin subset runs out. But it is NOT what
 * fixed this, and the lesson is in the gap:
 *
 *   SIX GREEN TESTS, ZERO CHANGE ON SCREEN. Every test above checks that a
 *   DECLARATION EXISTS. Not one of them could check that it REACHES A GLYPH.
 *   A suite that asserts the shape of a fix is not evidence the fix works —
 *   only the screen is, and the screen belongs to whoever reported it.
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

// ── The repair that actually reached the screen ─────────────────────────────
// Everything above this line is about a CSS variable. Everything below is
// about the five characters that stopped depending on it.

const SPU = readFileSync(
  join(process.cwd(), 'src/components/SystemPromptUpdater.tsx'),
  'utf8',
);

/** The inline `fontFamily` the five sigils are drawn with. */
function sigilStack(): string {
  const m = SPU.match(/const SIGIL_STYLE = \{\s*fontFamily:\s*(['"])([^]*?)\1\s*\}/);
  assert.ok(
    m,
    'SIGIL_STYLE is gone. The Greek letters are back on the inherited font, ' +
    'which is the stack that drew Ω as и on Japanese Windows.',
  );
  return m![2];
}

test('the sigils name a real font before any generic one', () => {
  // Same rule as --font-sans, enforced separately because this stack is the
  // one that was *measured* to fix the glyph. `sans-serif` may sit last as a
  // non-Windows floor; it must never be reached first.
  const first = sigilStack().split(',')[0].trim().replace(/^["']|["']$/g, '');
  assert.ok(
    !/^(sans-serif|serif|ui-sans-serif|system-ui|monospace)$/.test(first),
    `SIGIL_STYLE leads with the generic "${first}". A generic family is ` +
    'resolved by the VIEWER\'s browser — on Japanese Windows that is Yu ' +
    'Gothic UI, whose U+03A9 reads as и.',
  );
});

test('the sigil stack reaches no CSS variable', () => {
  // The whole point is independence. A var() here re-enters the cascade that
  // was measured to fail on her machine while every test above stayed green.
  const stack = sigilStack();
  assert.ok(
    !stack.includes('var('),
    `SIGIL_STYLE went back through a CSS variable (${stack}). The variable ` +
    'repair was shipped, passed its tests, and did not change the screen.',
  );
});

test('every sigil is drawn through <Sigil>, so a sixth cannot miss the font', () => {
  // The hue is per-button and the glyph source is not. Rendering SIGIL.x in a
  // bare <span> is exactly how the next shikigami would quietly lose the font
  // while looking like all the others in review.
  const bare = SPU.match(/<span[^>]*>\{SIGIL\.[a-z]+\}<\/span>/g) ?? [];
  assert.deepEqual(
    bare,
    [],
    `${bare.length} sigil(s) are rendered in a raw <span> instead of <Sigil>: ` +
    `${bare.join(' | ')}`,
  );
  // And the component is what carries the style — not a copy per call site.
  assert.ok(
    /function Sigil\(/.test(SPU) && /style=\{SIGIL_STYLE\}/.test(SPU),
    'The <Sigil> component should be the single place the font is applied.',
  );
});

test('the sigils are the Greek letters themselves, not lookalikes', () => {
  // The failure mode this guards is the tempting one: someone sees и on screen
  // and "fixes" it by pasting a character that looks right in their editor.
  // Cyrillic и is U+0438; Greek alpha U+03B1 sits next to Latin a. The names
  // are the shikigami's own, so the codepoint is the identity, not the shape.
  const block = SPU.match(/const SIGIL = \{([^]*?)\} as const;/);
  assert.ok(block, 'SIGIL map not found');
  const want: Record<string, number> = {
    genesis: 0x03a9,      // Ω GREEK CAPITAL LETTER OMEGA
    redistribute: 0x03b4, // δ GREEK SMALL LETTER DELTA
    index: 0x03b6,        // ζ GREEK SMALL LETTER ZETA
    reorganize: 0x03b1,   // α GREEK SMALL LETTER ALPHA
    update: 0x03b2,       // β GREEK SMALL LETTER BETA
  };
  for (const [key, cp] of Object.entries(want)) {
    // Annotated: `assert.ok` is an assertion signature, so inferring `m` from
    // its own narrowing is circular (TS7022).
    const m: RegExpMatchArray | null = block![1].match(new RegExp(`${key}:\\s*'(.)'`));
    assert.ok(m, `SIGIL.${key} is missing`);
    assert.equal(
      m![1].codePointAt(0),
      cp,
      `SIGIL.${key} is U+${m![1].codePointAt(0)!.toString(16).toUpperCase()}, ` +
      `expected U+${cp.toString(16).toUpperCase()}.`,
    );
  }
});
