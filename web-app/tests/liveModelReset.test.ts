// The loading line names `liveModel`. It must not outlive its turn: before
// 2026-11-14 it was cleared only on Stop, so the next turn first showed the
// previous turn's vessel. This pins the clear-on-turn-end wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/components/ChatArea.tsx', 'utf8');

test('liveModel is cleared when the turn ends (loading → false)', () => {
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!loading\) setLiveModel\(''\);\s*\}, \[loading\]\);/);
});
