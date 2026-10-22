/**
 * What does a pull's changed-file list OBLIGE the operator to do?
 *
 * Split out of `app/api/update/route.ts` so it can be measured against real
 * `git diff --name-only` output instead of a retyped copy of the same two
 * regexes. A route handler cannot be imported outside Next; this can.
 *
 * Measured 2026-10-23 against a throwaway clone (`import_probe/git_contract.sh`),
 * which is where these exact strings come from:
 *     b.txt
 *     next.config.ts
 *     web-app/package-lock.json
 */

export interface UpdateObligations {
  /** `npm ci` is needed. NEVER run automatically: it takes minutes and
   *  removes node_modules out from under the running server. */
  lockfileChanged: boolean;
  /** Next.js restarts ITSELF when this moves — say so, don't pre-empt it. */
  nextConfigChanged: boolean;
}

export function classifyChangedFiles(changed: string[]): UpdateObligations {
  const files = (changed || []).map(s => String(s).trim()).filter(Boolean);
  return {
    // Match on the BASENAME, not a hard-coded path. This repo keeps the
    // lockfile at web-app/package-lock.json; another layout may not, and a
    // flag that is silently false is worse than no flag at all.
    lockfileChanged: files.some(f => f.split('/').pop() === 'package-lock.json'),
    // .ts/.js/.mjs/.cjs, at the repo root or inside any directory.
    nextConfigChanged: files.some(f => /(^|\/)next\.config\.[cm]?[jt]s$/.test(f)),
  };
}
