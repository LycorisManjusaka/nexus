/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): no value import may name a
 * type-only export.
 *
 * REGRESSION. On 2026-10-27 four files did this — `userIdentity.ts:3`,
 * `api/character-map/route.ts:4`, `NexusApp.tsx:9`, `conversationSearch.ts:24`:
 *
 *     import { readCharacterMap, CharacterMap } from './characterMap';
 *                                ^^^^^^^^^^^^  an `interface`
 *
 * Why nothing caught it for months:
 *   • Next's bundler elides type-only named imports, so the app worked.
 *   • `verbatimModuleSyntax` is not set in tsconfig, so tsc stayed silent.
 *   • Under standard isolated-module semantics the named import SURVIVES.
 *     MEASURED with Node's strip-only type stripping on the old form:
 *     `SyntaxError: The requested module './characterMap' does not provide an
 *     export named 'CharacterMap'`.
 *
 * So the defect is only visible to a toolchain that does not bundle — which is
 * exactly what `npm test` is. This test is the gate; it replaced an ad-hoc
 * python scanner in Cairn's workspace (`plan_probe/p06_typeasvalue.py`) so the
 * rule has ONE authority that runs on every `npm test`.
 *
 * SCOPE, stated rather than implied:
 *   • Only relative / `@/` specifiers that resolve inside src. Package imports
 *     are out of scope — their type-only-ness is not knowable from this tree.
 *   • `import type { X }` and inline `import { type X }` are already correct and
 *     are skipped.
 *   • A name that is BOTH a type and a value export (declaration merging, or a
 *     class) is never reported.
 *   • This is a regex scan over import/export headers, not a TS parse. It can
 *     have false negatives (it will not see a name re-exported through two
 *     hops). It must not have false positives — that is what the "both" check
 *     and the resolve-inside-src restriction are for.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const TYPE_EXPORT = /^[ \t]*export[ \t]+(?:declare[ \t]+)?(?:interface|type)[ \t]+([A-Za-z_$][\w$]*)/gm;
const VALUE_EXPORT =
  /^[ \t]*export[ \t]+(?:declare[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:const|let|var|function\*?|class|enum|abstract[ \t]+class)[ \t]+([A-Za-z_$][\w$]*)/gm;
const VALUE_BRACE = /^[ \t]*export[ \t]*\{([^}]*)\}/gm;
const IMPORT_STMT = /^[ \t]*import[ \t]+(type[ \t]+)?\{([^}]*)\}[ \t]*from[ \t]*['"]([^'"]+)['"]/gm;

/** Tried in order, mirroring tests/_loader.mjs and tsconfig "paths". */
const CANDIDATES = ['.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const ext of CANDIDATES) {
    const cand = base + ext;
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function matchAll(re: RegExp, text: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

describe('source tree: type-only exports are never imported as values', () => {
  const files = walk(SRC);
  const text = new Map<string, string>();
  const typeExports = new Map<string, Set<string>>();
  const valueExports = new Map<string, Set<string>>();

  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    text.set(f, t);
    typeExports.set(f, new Set(matchAll(TYPE_EXPORT, t)));
    const vals = new Set(matchAll(VALUE_EXPORT, t));
    VALUE_BRACE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VALUE_BRACE.exec(t))) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) vals.add(name);
      }
    }
    valueExports.set(f, vals);
  }

  it('finds something to scan (guards against a silently empty check)', () => {
    // A check that can never fail always passes. Assert the instrument has teeth:
    // the tree must be there, and at least one module must export a type at all.
    assert.ok(files.length > 100, `expected >100 ts files under src, saw ${files.length}`);
    const withTypes = files.filter((f) => (typeExports.get(f) as Set<string>).size > 0);
    assert.ok(withTypes.length > 10, `expected >10 modules exporting types, saw ${withTypes.length}`);
  });

  it('has no value import naming a type-only export', () => {
    const findings: string[] = [];
    let examined = 0;
    for (const f of files) {
      const t = text.get(f) as string;
      IMPORT_STMT.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_STMT.exec(t))) {
        if (m[1]) continue; // `import type { ... }`
        const target = resolveSpec(m[3], f);
        if (!target) continue;
        examined++;
        const line = t.slice(0, m.index).split('\n').length;
        for (const piece of m[2].split(',')) {
          const raw = piece.trim();
          if (!raw || /^type\s/.test(raw)) continue; // inline `type X`
          const name = raw.split(/\s+as\s+/)[0].trim();
          if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
          const isType = (typeExports.get(target) as Set<string>).has(name);
          const isValue = (valueExports.get(target) as Set<string>).has(name);
          if (isType && !isValue) {
            findings.push(
              `${path.relative(SRC, f).replace(/\\/g, '/')}:${line} imports type '${name}' ` +
                `as a value from ${path.relative(SRC, target).replace(/\\/g, '/')}`,
            );
          }
        }
      }
    }
    assert.ok(examined > 50, `expected to examine >50 resolvable value imports, saw ${examined}`);
    assert.deepEqual(
      findings,
      [],
      `use \`import type { X }\` for these:\n  ${findings.join('\n  ')}`,
    );
  });
});
