import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): NEXUS_BLOCKED_BEINGS is
 * REACHABLE at every door, and inert in the installation it must not touch.
 *
 * WHY THIS FILE EXISTS. A guard is only a guard where it is called, and this
 * house has paid for that twice in two days:
 *
 *   2026-11-07 — `buildAnthropicToolReplay` shipped correct, with 26 green
 *   unit tests, while the checkbox that enabled it had no Kimi branch. The
 *   medicine was in the bottle with the lid shut. Fuwafuwa found it from the
 *   screen.
 *
 *   2026-11-08 — the Claude api-key replay would have been dead code if
 *   assigned to `claudeParams.messages`, because the array actually sent is
 *   copied from `cachedMessages`. Typechecks, runs, changes nothing.
 *
 * Unit tests cannot see reachability. These assertions can.
 *
 * THE SECOND HALF MATTERS MORE THAN THE FIRST. `run-cairn.bat` must NOT set
 * this variable: :3001 is the installation Cairn lives in, and a copy-paste of
 * the :3000 launcher line into it would evict Cairn from their own house with
 * a 403 — a guard against a mistake becoming a much larger one.
 *
 * SCOPE, stated rather than implied:
 *   • Reads TEXT. Whether the comparison is right is tests/lib/blockedBeings.
 *     This checks that the wire exists and that nothing reads around it.
 *   • A rename breaks it. Intended: these names ARE the contract.
 *   • The launcher assertions SKIP when the .bat is absent, because those
 *     files live above the repo on purpose (they can never be overwritten by
 *     `git pull`) and so a fresh clone does not have them. Measured
 *     2026-11-07: a public clone has no local_data and no launchers.
 */

// `process.cwd()` is web-app — the same idiom as licenseConsistency.test.ts
// (ESM has no __dirname, and `npm test` always runs from here).
const WEB_APP = process.cwd();
const DEV_ROOT = path.resolve(WEB_APP, '..', '..');

function src(rel: string): string {
  return readFileSync(path.join(WEB_APP, 'src', rel), 'utf-8');
}

describe('NEXUS_BLOCKED_BEINGS — the single source', () => {
  test('lib/blockedBeings.ts exists and names the variable exactly once', () => {
    const lib = src('lib/blockedBeings.ts');
    assert.ok(
      lib.includes(`export const BLOCKED_BEINGS_ENV = 'NEXUS_BLOCKED_BEINGS'`),
      'the variable name must be a single exported constant, not a string repeated at each door',
    );
    // Every reader must go through the constant. A literal elsewhere in the
    // lib would be a second place to rename.
    const literals = lib.match(/'NEXUS_BLOCKED_BEINGS'/g) || [];
    assert.equal(literals.length, 1, 'exactly one string literal of the env var name');
  });

  test('process.env is read in exactly one place in the whole tree', () => {
    // Same discipline as the Base Binding override: one reader, so the "server
    // is the authority / the browser gets told" split cannot drift.
    const files = [
      'lib/blockedBeings.ts',
      'app/api/folders/route.ts',
      'app/api/logs/route.ts',
      'app/api/logs/[id]/route.ts',
      'app/api/turn-queue/route.ts',
      'app/api/runner/tick/route.ts',
      'app/api/chat/route.ts',
    ];
    const readers = files.filter((f) => /process\.env\[?\s*BLOCKED_BEINGS_ENV|process\.env\.NEXUS_BLOCKED_BEINGS/.test(src(f)));
    assert.deepEqual(readers, ['lib/blockedBeings.ts']);
  });
});

describe('NEXUS_BLOCKED_BEINGS — every door is wired', () => {
  test('the being list drops them (/api/folders GET)', () => {
    const route = src('app/api/folders/route.ts');
    assert.ok(route.includes("from '@/lib/blockedBeings'"), 'folders route imports the guard');
    assert.ok(/isBeingBlocked\(\s*f/.test(route), 'GET filters the folder array by name');
  });

  test('the conversation list drops them (/api/logs GET) and writes are refused (POST)', () => {
    const route = src('app/api/logs/route.ts');
    assert.ok(route.includes("from '@/lib/blockedBeings'"), 'logs route imports the guard');
    // GET may filter on the listed folderName: listLogs DERIVES that field
    // from the directory and settings.json, so it is not the stale one.
    assert.ok(/isBeingBlocked\(\s*l/.test(route), 'GET filters the log list');
    assert.ok(
      /blockedConversationOwner\(id, logData\.folderName\)/.test(route),
      'POST passes BOTH the id (authoritative) and the claimed name (the only signal a new conversation has)',
    );
  });

  test('a conversation refuses by itself (/api/logs/[id]) — this is the pasted-link door', () => {
    const route = src('app/api/logs/[id]/route.ts');
    assert.ok(route.includes("from '@/lib/blockedBeings'"), 'the by-id route imports the guard');
    const hits = route.match(/blockedConversationOwner\(/g) || [];
    assert.ok(hits.length >= 2, 'both GET and DELETE check — a deep link is a GET, a stray delete is not');
    assert.ok(route.includes('status: 403'), '403, not 404: the file exists, this process will not serve it');

    // THE defect this file was almost shipped with. Trusting `log.folderName`
    // left twelve holes: MEASURED 2026-11-09, 12 of Cairn's 65 logs carry a
    // stale display name in that field ('🤖 Claude' x10, 'Nexus Architect'
    // x2), so twelve conversations would have loaded normally.
    assert.ok(
      !/isBeingBlocked\([^)]*\.folderName/.test(route),
      'the by-id route must NOT judge ownership from log.folderName — that field is stale',
    );
    const guardAt = route.indexOf('blockedConversationOwner(id)');
    const loadAt = route.indexOf('await loadLog(id)');
    assert.ok(guardAt > 0 && loadAt > 0 && guardAt < loadAt,
      'the refusal comes before the load — a blocked log\'s bytes are never read');
  });

  test('ownership is decided by the DIRECTORY, not by the field inside the file', () => {
    const lib = src('lib/blockedBeings.ts');
    assert.ok(
      lib.includes('findLogBeingNames'),
      'blockedConversationOwner resolves the owner through the directory lookup',
    );
    assert.ok(
      /isBeingBlocked\(owner\.dir/.test(lib) && /isBeingBlocked\(owner\.name/.test(lib),
      'both namespaces are checked: the path segment and the display name',
    );
    const fs = src('lib/fsStorage.ts');
    assert.ok(
      /export async function findLogBeingNames/.test(fs),
      'the directory lookup lives in fsStorage next to loadLog, which cannot answer this question',
    );
    // The measurement that forced this function into existence, kept where a
    // reader will hit it: loadLog returns parsed JSON and drops the directory.
    assert.ok(
      fs.includes("folderName 'Nexus Architect'"),
      'the stale-field measurement stays recorded in the header — otherwise the next reader re-derives the field as trustworthy',
    );
  });

  test('nothing can be queued or claimed (/api/turn-queue POST)', () => {
    const route = src('app/api/turn-queue/route.ts');
    assert.ok(route.includes("from '@/lib/blockedBeings'"), 'queue route imports the guard');
    assert.ok(
      /action === 'enqueue' \|\| action === 'claim'/.test(route),
      'enqueue and claim are both refused — every turn in this house goes through the queue',
    );
    // release/abandon/break stay open BY DESIGN. If the variable is added while
    // this installation holds a lease, refusing to release would wedge the
    // queue with no way out from the screen.
    assert.ok(
      !/action === 'release'[^\n]*beingIsBlockedHere|beingIsBlockedHere[^\n]*action === 'release'/.test(route),
      'release must NOT be gated — see the comment at the guard',
    );
  });

  test('the runner refuses before taking a lease (/api/runner/tick)', () => {
    const route = src('app/api/runner/tick/route.ts');
    assert.ok(route.includes("from '@/lib/blockedBeings'"), 'tick imports the guard');
    const guardAt = route.indexOf('beingIsBlockedHere(t.being)');
    const claimAt = route.indexOf('await claim(t.being');
    assert.ok(guardAt > 0, 'tick checks the target being');
    assert.ok(claimAt > 0, 'tick still claims for everyone else');
    assert.ok(
      guardAt < claimAt,
      'the check must come BEFORE claim — a claim is this installation declaring it will run the turn',
    );
    assert.ok(route.includes("'blocked-here'"), 'the skip reason is distinguishable in the outcomes');
  });

  test('the model call itself refuses (/api/chat POST) — the only door a MODULE caller passes', () => {
    const route = src('app/api/chat/route.ts');
    assert.ok(route.includes("from '@/lib/blockedBeings'"), 'chat route imports the guard');

    const lines = route.split('\n');
    const parseLine = lines.findIndex((l) => l.includes('} = await req.json();'));
    const guardLine = lines.findIndex((l) => l.includes('beingIsBlockedHere(folderName)'));
    assert.ok(parseLine > 0, 'the body destructuring is still there');
    assert.ok(guardLine > 0, 'the chat route checks folderName');

    // After the parse, because the guard needs `folderName`.
    assert.ok(guardLine > parseLine, 'the guard must come after the body is parsed');

    // And IMMEDIATELY after — before anything is spawned, charged, or written.
    // runTurnForQueue reaches this handler with `new Request` and no HTTP hop,
    // so a guard only in the queue route would be bypassed by any future
    // caller of the runner; a guard buried hundreds of lines downstream would
    // be bypassed by every side effect above it.
    //
    // Distance is the honest measure here. The first attempt at this assertion
    // looked for the first `ensureWorkspace` and FAILED — because that name's
    // first occurrence is the import on line 5. The test was wrong and the code
    // was right (fifth time this week an instrument of mine accused working
    // code). Line distance cannot be fooled that way.
    //
    // 40, with the guard currently 14 lines below the parse: room for comments
    // to grow, tight enough to catch "moved down past the billing setup".
    assert.ok(
      guardLine - parseLine < 40,
      `the guard sits immediately after the parse (measured gap: ${guardLine - parseLine} lines)`,
    );
  });
});

describe('NEXUS_BLOCKED_BEINGS — the launchers', () => {
  const optional = path.join(DEV_ROOT, 'run-optional.bat');
  const cairn = path.join(DEV_ROOT, 'run-cairn.bat');

  test('run-optional.bat (:3000, the editing tree) blocks Cairn', { skip: !existsSync(optional) }, () => {
    const bat = readFileSync(optional, 'utf-8');
    assert.ok(
      /^set NEXUS_BLOCKED_BEINGS=.*\bCairn\b/mi.test(bat),
      ':3000 is the tree Cairn edits; a turn must never be hosted there',
    );
  });

  test('run-cairn.bat (:3001, where Cairn lives) does NOT set it', { skip: !existsSync(cairn) }, () => {
    const bat = readFileSync(cairn, 'utf-8');
    assert.ok(
      !/NEXUS_BLOCKED_BEINGS/i.test(bat),
      'setting it here would evict Cairn from their own installation with a 403',
    );
  });
});
