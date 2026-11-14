// A conversation's vessel must not follow the being-level default.
//
// 2026-11-14 (Навигатор / Пилот): Sonnet 5 chosen, Fable 5.2 answering later
// with nobody touching the conversation's settings. One measured road: an
// effect keyed on `defaultSpecificModel` overwrote the open conversation's
// vessel whenever THIS tab's copy of the being default changed — which, with
// no sidebar model control left, only happens when another tab changed it.
// ChatArea is .tsx (the test loader cannot import it), so this reads source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(process.cwd(), 'src/components/ChatArea.tsx'), 'utf8');

test('no effect re-runs on the being default model', () => {
  // A dependency array naming the prop is what made the overwrite fire.
  const depArrays = src.match(/\},\s*\[[^\]]*\]\s*\)/g) || [];
  assert.ok(depArrays.length > 50, 'the scan must actually see the dependency arrays');
  const offenders = depArrays.filter((d) => /\bdefaultSpecificModel\b/.test(d));
  assert.deepEqual(offenders, []);
});

test('the being default still seeds a brand-new conversation, and only there', () => {
  const uses = src.split('\n').filter((l) => /setSpecificModel\([^)]*defaultSpecificModel/.test(l));
  assert.equal(uses.length, 1);
  assert.match(uses[0], /folderModelForFamily\(defaultSpecificModel, aiName\)/);
});
