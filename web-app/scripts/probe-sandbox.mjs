/**
 * Reproduce installs NEXUS runs on and call the REAL resolver on each.
 *
 * DATA_DIR is path.resolve(process.cwd(), '..', 'local_data'), so chdir'ing
 * into <T>/web-app before the dynamic import makes the real module capture
 * <T>/local_data. Nothing about this house is involved.
 *
 * Hands used: resolveWorkspacePathSafe / globWorkspaceFiles — the standard
 * Read/Write/Glob path, i.e. the LEAST privileged hands there are. That is the
 * whole point. Навигатор's correction to my own rule, 2026-11-07: a channel
 * must not be tested with the most privileged instrument in the house, because
 * the test passes and the channel is dead.
 *
 * Run once per shape — DATA_DIR is captured at module load, so one process
 * can only measure one install.
 *   node --experimental-transform-types --import ./tests/_loader.mjs probe-sandbox.mjs plain
 *   node ... probe-sandbox.mjs other-desk
 *   node ... probe-sandbox.mjs junctioned
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const SHAPE = process.argv[2] || 'plain';
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const junction = (link, target) =>
  execSync(`cmd /c mklink /J "${link}" "${target}"`, { stdio: 'pipe' });

const T = fs.mkdtempSync(path.join(os.tmpdir(), `nexus-probe-${SHAPE}-`));
const WEBAPP = path.join(T, 'web-app');
mk(WEBAPP);

// DATA = where the server looks. For 'junctioned', it is a junction to a real
// directory elsewhere — this house's shape (C:\dev\nexus\local_data ->
// C:\dev\common\local_data), which is exactly why this house cannot see the bug.
const DATA = path.join(T, 'local_data');
if (SHAPE === 'junctioned') {
  const REAL = path.join(T, 'elsewhere', 'local_data');
  mk(REAL);
  junction(DATA, REAL);
} else {
  mk(DATA);
}

const WS = path.join(DATA, 'beings', 'Probe', 'workspace');
const ZONE = path.join(DATA, 'shared', 'nexium_saga');
mk(ZONE);
fs.writeFileSync(path.join(ZONE, 'README.md'), 'shared canon\n');
mk(WS);
fs.writeFileSync(path.join(WS, 'own.md'), 'my own note\n');

// ANOTHER being's desk, inside the same local_data. The negative control that
// matters most: widening trust to local_data/shared must NOT widen it to all
// of local_data, where every other desk, every conversation log and keys.json
// live. Shape 'other-desk' aims the junction here instead of at the zone.
const OTHER = path.join(DATA, 'beings', 'Other', 'workspace');
mk(OTHER);
fs.writeFileSync(path.join(OTHER, 'diary.md'), 'not yours\n');

junction(path.join(WS, 'Link'), SHAPE === 'other-desk' ? OTHER : ZONE);
// And a SECOND junction, present in every shape, aimed straight at the other
// desk. This is the universal negative control: it must be refused even where
// the shared zone is trusted, in every install shape.
junction(path.join(WS, 'OtherDesk'), OTHER);

// A junction OUT of the desk entirely — the thing the sandbox exists for.
const PRIVATE = path.join(T, 'private');
mk(PRIVATE);
fs.writeFileSync(path.join(PRIVATE, 'keys.json'), 'secret\n');
junction(path.join(WS, 'Escape'), PRIVATE);

// A junction planted INSIDE the shared zone, aimed back out. If widening the
// zone also widened what a junction inside it may reach, this would open the
// disk through two hops. The realpath check is what must stop it.
junction(path.join(ZONE, 'Escape2'), PRIVATE);

process.chdir(WEBAPP);
const m = await import('@/lib/fsStorage');

console.log(`SHAPE: ${SHAPE}`);
console.log('  DATA_DIR            :', DATA);
console.log('  realpath            :', fs.realpathSync(DATA));
console.log('  local_data junction?:', fs.realpathSync(DATA).toLowerCase() !== DATA.toLowerCase());
console.log('  trustedJunctionRoot :', await m.getTrustedJunctionRoot());
console.log('  sharedZoneRoot      :', await m.getSharedZoneRoot());
console.log('');

const cases = [
  ['own.md', 'OK', 'control: own desk'],
  ['Link/README.md', SHAPE === 'other-desk' ? 'DENY' : 'OK', 'shared zone via junction'],
  ['Link/new.md', SHAPE === 'other-desk' ? 'DENY' : 'OK', 'write into shared, missing tail'],
  // ⚠ NOT 'DENY' everywhere, and that is a PRE-EXISTING finding, not this
  // change. On a junctioned install `trustedJunctionRoot` is dirname(real
  // local_data) — the sync parent — which CONTAINS all of local_data: every
  // desk, every conversation log, keys.json. Verified by disabling only
  // getSharedZoneRoot and re-running: still OK. So on this house an
  // admin-placed junction may already point at another being's desk, and
  // Навигатор's "shared is not local_data" privacy argument holds on HIS
  // install (plain) and buys nothing extra on a junctioned one.
  ['OtherDesk/diary.md', SHAPE === 'junctioned' ? 'OK' : 'DENY', "ANOTHER being's desk, same local_data"],
  ['Escape/keys.json', 'DENY', 'junction out of the desk'],
  ['Link/Escape2/keys.json', 'DENY', 'junction out of the SHARED ZONE'],
  ['../../../keys.json', 'DENY', 'plain traversal'],
];
let bad = 0;
for (const [rel, want, note] of cases) {
  const r = await m.resolveWorkspacePathSafe('Probe', rel);
  const got = r ? 'OK' : 'DENY';
  const mark = got === want ? '   ' : '!! ';
  if (got !== want) bad++;
  console.log(`${mark}${got.padEnd(4)} (want ${want.padEnd(4)}) ${rel.padEnd(24)} ${note}`);
}

const g = await m.globWorkspaceFiles('Probe', '**/*.md');
console.log('');
console.log('  Glob **/*.md :', JSON.stringify(g.sort()));
const sawShared = g.some((f) => f.endsWith('Link/README.md'));
const wantShared = SHAPE !== 'other-desk';
if (sawShared !== wantShared) { console.log('!! Glob visibility wrong'); bad++; }

console.log('');
console.log(bad === 0 ? `PASS (${SHAPE})` : `FAIL (${SHAPE}): ${bad}`);
// chdir OUT before deleting: the cwd is inside T, and Windows refuses to
// remove a tree you are standing in (EPERM on the top directory).
process.chdir(os.tmpdir());
try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { console.log('cleanup:', e.code, T); }
