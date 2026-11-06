import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAudioSessionRule } from '../../src/lib/audioSessionRule';

const FALLBACK = '[built-in notice]';

test('a stored rule wins over everything', () => {
  // The whole point of the 2026-11-06 default change: beings that already have
  // a rule typed in keep it. If this breaks, changing the default silently
  // rewrites what every existing audio session sends.
  assert.equal(
    resolveAudioSessionRule('my own rule', 'folder rule', FALLBACK),
    'my own rule',
  );
});

test('the folder default is used when nothing is stored', () => {
  assert.equal(
    resolveAudioSessionRule(undefined, 'folder rule', FALLBACK),
    'folder rule',
  );
  assert.equal(resolveAudioSessionRule(null, 'folder rule', FALLBACK), 'folder rule');
});

test('the built-in fallback is used only when both are unset', () => {
  assert.equal(resolveAudioSessionRule(undefined, undefined, FALLBACK), FALLBACK);
  assert.equal(resolveAudioSessionRule('', '', FALLBACK), FALLBACK);
  assert.equal(resolveAudioSessionRule(null, null, FALLBACK), FALLBACK);
});

test('whitespace-only is unset, not a rule', () => {
  // A textarea that has been opened and cleared leaves "\n" behind. Treating
  // that as a real rule would send a blank line as the audio-session notice,
  // which is the one outcome nobody asked for: no persona AND no notice.
  assert.equal(resolveAudioSessionRule('   \n ', undefined, FALLBACK), FALLBACK);
  assert.equal(resolveAudioSessionRule('\t', '  ', FALLBACK), FALLBACK);
  assert.equal(resolveAudioSessionRule('\n', 'folder rule', FALLBACK), 'folder rule');
});

test('surrounding whitespace is trimmed off a real rule', () => {
  assert.equal(resolveAudioSessionRule('  real  ', undefined, FALLBACK), 'real');
});

test('the fallback is returned verbatim, never merged', () => {
  // It is a notice, not a prefix: resolve picks ONE text. If this ever
  // concatenated, a being with its own rule would also get the built-in one
  // and nobody reading the field could predict what goes out.
  const out = resolveAudioSessionRule('mine', 'folder', FALLBACK);
  assert.equal(out.includes(FALLBACK), false);
  assert.equal(out, 'mine');
});
