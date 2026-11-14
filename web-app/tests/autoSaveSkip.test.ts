import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsSignature, shouldSkipAutoSave } from '@/lib/autoSaveSkip';

const base = { id: 'c1', aiName: 'Claude', specificModel: 'claude-fable-5-2', title: 't', messages: [] as unknown[] };

test('the reported sequence: a vessel changed during a turn is SAVED, not skipped', () => {
  // Disk (and the tab, at open) say Fable.
  const persisted = settingsSignature(base);
  // During the turn the person picks Sonnet; the effect returned on `loading`.
  const onScreen = settingsSignature({ ...base, specificModel: 'claude-sonnet-5' });
  // The turn's patch set the skip flag. The fire after `loading` clears:
  assert.equal(shouldSkipAutoSave(true, onScreen, persisted), false);
});

test('applying disk state is still skipped (the reason the flag exists)', () => {
  const sig = settingsSignature(base);
  assert.equal(shouldSkipAutoSave(true, sig, sig), true);
});

test('a freshly opened conversation keeps the one-shot skip', () => {
  assert.equal(shouldSkipAutoSave(true, settingsSignature(base), null), true);
});

test('no flag, no skip', () => {
  const sig = settingsSignature(base);
  assert.equal(shouldSkipAutoSave(false, sig, sig), false);
});

test('messages and the runner-owned fields do not count as a settings edit', () => {
  const a = settingsSignature(base);
  const b = settingsSignature({
    ...base,
    messages: [{ id: 'm1' }],
    firstOriginalMessageId: 'm1',
    firstOriginalIsNext: false,
    claudeAgentSessionId: 'x',
  });
  assert.equal(a, b);
});

test('key order does not change the signature', () => {
  assert.equal(
    settingsSignature({ aiName: 'Gemini', specificModel: 'g' }),
    settingsSignature({ specificModel: 'g', aiName: 'Gemini' }),
  );
});
