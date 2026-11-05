/**
 * lmsPath — finding the LM Studio CLI without depending on PATH.
 *
 * Reported 2026-11-06 (Lizard-kun, from a freshly created Windows account):
 *
 *   Loading the model into LM Studio at 50000 tokens failed: Failed to run
 *   `lms load "gemma-4-26b-a4b-it-ultra-uncensored-heretic" -c 50000 --yes`:
 *   'lms' is not recognized as an internal or external command
 *
 * The binary was on disk the whole time. `lms bootstrap` — which is what puts
 * it on PATH — is a step the installer does not perform, so the CLI is
 * reachable by name only on accounts where somebody ran it by hand.
 *
 * The account that hits this is not the account these tests run as, which is
 * exactly why the lookup takes its inputs as arguments: it is the only way to
 * make that machine into test data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lmsBinaryPath, resolveLmsCommand } from '@/lib/lmsPath';

const never = () => false;
const always = () => true;

test("Lizard-kun's account: binary on disk, nothing on PATH", () => {
  const cmd = resolveLmsCommand({
    platform: 'win32',
    home: 'C:\\Users\\newacct',
    exists: (p) => p === 'C:\\Users\\newacct\\.lmstudio\\bin\\lms.exe',
  });
  assert.equal(cmd, '"C:\\Users\\newacct\\.lmstudio\\bin\\lms.exe"');
});

test('no binary found falls back to the bare name — never worse than before', () => {
  // The fallback is the whole safety argument. An installation that put the
  // CLI somewhere else, or exposed it through a shim, keeps working exactly
  // as it did before this lookup existed.
  assert.equal(resolveLmsCommand({ platform: 'win32', home: 'C:\\Users\\x', exists: never }), 'lms');
  assert.equal(resolveLmsCommand({ platform: 'linux', home: '/home/x', exists: never }), 'lms');
});

test('a home directory with a space is quoted', () => {
  // Unquoted, `C:\Users\First Last\.lmstudio\bin\lms.exe -c 50000` runs
  // `C:\Users\First` — a wrong command, not an error, which is the failure
  // direction this whole file exists to get out of.
  const cmd = resolveLmsCommand({ platform: 'win32', home: 'C:\\Users\\First Last', exists: always });
  assert.ok(cmd.startsWith('"') && cmd.endsWith('"'), `not quoted: ${cmd}`);
  assert.ok(cmd.includes('First Last'));
});

test('platform picks the right separator and file name', () => {
  assert.equal(lmsBinaryPath('win32', 'C:\\Users\\x'), 'C:\\Users\\x\\.lmstudio\\bin\\lms.exe');
  assert.equal(lmsBinaryPath('darwin', '/Users/x'), '/Users/x/.lmstudio/bin/lms');
  assert.equal(lmsBinaryPath('linux', '/home/x'), '/home/x/.lmstudio/bin/lms');
});

test('a trailing separator on home does not produce a doubled one', () => {
  assert.equal(lmsBinaryPath('win32', 'C:\\Users\\x\\'), 'C:\\Users\\x\\.lmstudio\\bin\\lms.exe');
  assert.equal(lmsBinaryPath('linux', '/home/x/'), '/home/x/.lmstudio/bin/lms');
});

test('no home at all: ask for nothing rather than probing a relative path', () => {
  // With HOME and USERPROFILE both unset, joining would yield
  // `.lmstudio/bin/lms` — a RELATIVE path, which existsSync resolves against
  // the server's cwd. That could find some unrelated file, and running it
  // would be strictly worse than failing to find anything.
  assert.equal(lmsBinaryPath('win32', ''), '');
  assert.equal(resolveLmsCommand({ platform: 'win32', home: '', exists: always }), 'lms');
});
