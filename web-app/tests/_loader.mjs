/**
 * Module hooks so `node --test` can import the product's TypeScript directly.
 *
 * WHY THIS EXISTS
 * ---------------
 * Next/tsc resolve three things that Node's ESM loader does not:
 *
 *   1. `@/x`            -> `<web-app>/src/x`      (tsconfig.json "paths")
 *   2. `./foo`          -> `./foo.ts`             (extensionless relative imports)
 *   3. `import j from './x.json'`                 (tsconfig "resolveJsonModule";
 *                                                  Node wants `with {type:'json'}`)
 *
 * Node 24 strips types by itself, so no transpiler dependency is needed. The
 * `npm test` script adds `--experimental-transform-types` for the one construct
 * strip-only mode refuses (a constructor parameter property, in betrayalGuard.ts).
 *
 * MEASURED 2026-10-27: with these hooks, 54 of the 55 directly-dependency-free
 * modules in src/lib import successfully. The one that does not (charaResolver)
 * is a correct rejection: it reaches `fs` transitively, so it is not a unit-test
 * target anyway.
 *
 * NOT A BUNDLER. This resolves only what the three rules above cover. If a test
 * fails with "Cannot find module", the honest first question is whether the
 * import is one Next resolves by a rule that is not written down here.
 */
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** <web-app>/src — derived from this file's own location, never hard-coded. */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Tried in order. `.ts` before `.json` so a module shadows a data file. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '/index.ts', '/index.tsx'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    let spec = specifier;

    // Rule 1: tsconfig path alias.
    if (spec.startsWith('@/')) {
      spec = pathToFileURL(path.join(SRC, spec.slice(2))).href;
    }

    // Rule 2: extensionless relative/absolute file specifier.
    if (spec.startsWith('.') || spec.startsWith('file:')) {
      let filePath = null;
      try {
        filePath = spec.startsWith('file:')
          ? fileURLToPath(spec)
          : path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec);
      } catch {
        filePath = null;
      }
      if (filePath && !existsSync(filePath)) {
        for (const ext of EXTENSIONS) {
          if (existsSync(filePath + ext)) {
            spec = pathToFileURL(filePath + ext).href;
            break;
          }
        }
      }
    }

    return nextResolve(spec, context);
  },

  load(url, context, nextLoad) {
    // Rule 3: JSON without an import attribute (tsconfig resolveJsonModule).
    if (url.startsWith('file:') && url.endsWith('.json')) {
      return {
        format: 'json',
        shortCircuit: true,
        source: readFileSync(fileURLToPath(url), 'utf8'),
      };
    }
    return nextLoad(url, context);
  },
});
