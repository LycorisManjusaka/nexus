import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isWithinTrustedRoots } from '@/lib/fsStorage';

/**
 * The file-access boundary for every being WITHOUT full system access.
 *
 * ── The report these tests exist for ────────────────────────────────────────
 * Навигатор, 2026-11-07. Three beings in Pilot's house shared one folder,
 * junctioned into all three desks. Only the one with
 * `agentFullSystemAccess` could read it; the other two got
 * "file not found or path outside workspace" from Read and nothing at all
 * from Glob. `getTrustedJunctionRoot()` widens trust ONLY when `local_data`
 * is itself a junction, and Pilot's is a plain directory — so on that install
 * the mechanism was off entirely and EVERY nested junction in every desk was
 * dead for the standard tools. Cross-desk file exchange had never worked
 * anywhere `local_data` is a real directory.
 *
 * Nobody caught it for months because every check had been run by hands that
 * have full access. His words: "the instrument was me." That is my own rule
 * about breaking the instrument first, turned one notch further, and it now
 * belongs here: a wall cannot be measured with a privileged tool.
 *
 * ── What these tests can and cannot do ─────────────────────────────────────
 * They cover the prefix comparison, which is the whole decision once both
 * sides are realpaths. They CANNOT cover the resolution of a junction into
 * its target, because that needs a real disk. That half is measured by
 * scripts/probe-sandbox.mjs, which rebuilds three install shapes in a temp directory,
 * plants real junctions with `mklink /J`, and calls the real resolver with the
 * standard tools:
 *
 *   plain (Pilot's shape)  PASS   — the shared zone opens, escapes stay shut
 *   other-desk             PASS   — a junction aimed at another desk refused
 *   junctioned (this house) PASS  — unchanged, and the bug is invisible here
 *
 * Keep both. Neither is sufficient alone, and the one that found the bug was
 * the one that touched a disk.
 */

const WIN = process.platform === 'win32';
const R = (...p: string[]) => path.resolve(WIN ? 'C:\\' : '/', ...p);

const desk = R('data', 'beings', 'Probe', 'workspace');
const shared = R('data', 'shared');

test('a path inside the desk is contained, with no extra roots at all', () => {
  assert.equal(isWithinTrustedRoots(path.join(desk, 'own.md'), desk), true);
  assert.equal(isWithinTrustedRoots(desk, desk), true);
});

test('a path outside the desk is refused when no extra root covers it', () => {
  // This is Pilot's install before the fix: trustedJunctionRoot is null, so
  // the realpath of the junction target has nothing to match.
  assert.equal(isWithinTrustedRoots(path.join(shared, 'saga', 'README.md'), desk, null), false);
});

test('the shared zone is accepted once it is passed as an extra root', () => {
  const target = path.join(shared, 'saga', 'README.md');
  assert.equal(isWithinTrustedRoots(target, desk, null, shared), true);
  // And a file that does not exist yet — a Write into the zone — resolves to
  // the same prefix, so it must answer the same way.
  assert.equal(isWithinTrustedRoots(path.join(shared, 'saga', 'new.md'), desk, null, shared), true);
});

test('trusting local_data/shared does NOT trust the rest of local_data', () => {
  // The reason the zone is a subfolder and not DATA_DIR itself: another
  // being's desk, the conversation logs and keys.json all live beside it.
  const otherDesk = R('data', 'beings', 'Other', 'workspace', 'diary.md');
  const keys = R('data', 'keys.json');
  assert.equal(isWithinTrustedRoots(otherDesk, desk, null, shared), false);
  assert.equal(isWithinTrustedRoots(keys, desk, null, shared), false);
});

test('a sibling whose name merely starts with the zone name is refused', () => {
  // `startsWith(root)` without the separator would accept this. The separator
  // is the only thing standing between "shared" and "shared_secrets".
  const sibling = R('data', 'shared_secrets', 'keys.json');
  assert.equal(isWithinTrustedRoots(sibling, desk, null, shared), false);
  const deskSibling = R('data', 'beings', 'Probe', 'workspace_backup', 'x.md');
  assert.equal(isWithinTrustedRoots(deskSibling, desk, null, shared), false);
});

test('a junction planted inside the zone but aimed out of it is refused', () => {
  // Widening the zone must not widen what a junction INSIDE the zone can
  // reach. The realpath has already left the zone by the time we compare, so
  // two hops are no better than one.
  const escaped = R('private', 'keys.json');
  assert.equal(isWithinTrustedRoots(escaped, desk, null, shared), false);
});

test('an empty or absent extra root is skipped, not treated as a match', () => {
  // getTrustedJunctionRoot and getSharedZoneRoot both return null routinely —
  // the first on a non-junction install, the second until someone creates the
  // folder.
  assert.equal(isWithinTrustedRoots(R('anywhere', 'at', 'all'), desk, null, null), false);

  // ⚠ HONEST NOTE ON WHAT IS ACTUALLY GUARDED HERE. I wrote the line above
  // first and then mutated the predicate to treat a null root as a match — and
  // the test stayed green. It could not do otherwise: `real` is always a
  // string, so `real === null` is never true, and no realpath begins with the
  // characters "null\". The `r &&` guard is belt-and-braces for null, not
  // load-bearing, and claiming otherwise would have been a test that passes
  // for no reason.
  //
  // The empty string is the case with teeth, because of ONE platform detail:
  // `''` is falsy, so the guard skips it, but an unguarded
  // `real.startsWith('' + path.sep)` is `real.startsWith('\\')` — which every
  // UNC path satisfies. An empty root would silently trust \\server\share
  // wholesale. Neither producer can currently return `''`; this is what stops
  // the next one that can.
  assert.equal(isWithinTrustedRoots('\\\\server\\share\\keys.json', desk, ''), false);
});

/**
 * ⚠ PRE-EXISTING, measured 2026-11-07, not introduced by the shared zone.
 *
 * On an install where `local_data` IS a junction — this house —
 * `getTrustedJunctionRoot()` returns dirname(real local_data), the sync
 * parent, and that directory CONTAINS all of local_data. So an admin-placed
 * junction there may already point at another being's desk, at the
 * conversation logs, or at keys.json, and the standard tools will follow it.
 *
 * Verified by disabling getSharedZoneRoot alone and re-running the junctioned
 * shape: another desk still resolved. The narrow zone adds nothing to this and
 * removes nothing from it.
 *
 * Recorded as a test rather than a comment so it is a decision someone has to
 * change on purpose. Beings cannot plant a junction themselves — the workspace
 * tools never call fs.symlink and Bash is behind the dangerous-tools toggle —
 * so the exposure needs an administrator to aim one. That is why it is written
 * down and not treated as urgent.
 */
test('the sync parent trusts all of local_data on a junctioned install', () => {
  const otherDesk = R('sync', 'local_data', 'beings', 'Other', 'workspace', 'diary.md');
  assert.equal(isWithinTrustedRoots(otherDesk, desk, R('sync')), true);
  assert.equal(isWithinTrustedRoots(R('sync', 'local_data', 'keys.json'), desk, R('sync')), true);
  // Still bounded: outside the sync parent is still refused.
  assert.equal(isWithinTrustedRoots(R('elsewhere', 'keys.json'), desk, R('sync')), false);
});
