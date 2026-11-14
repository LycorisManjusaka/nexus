import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senseAccepts, senseFamilyOf, senseStoredValue, sensePickerId, senseFamilies, senseSeatDefault } from '@/lib/sensorModels';

test('every family-switch default can actually sit in its seat', () => {
  const bad: string[] = [];
  for (const kind of ['eyes', 'ears', 'watcher'] as const) {
    for (const fam of senseFamilies(kind)) {
      if (fam === 'Local') continue;
      const id = senseSeatDefault(kind, fam);
      if (!senseAccepts(kind, fam, id)) bad.push(`${kind}/${fam}=${id}`);
    }
  }
  assert.deepEqual(bad, []);
});
import { familyFromModelId } from '@/lib/modelFamily';

// The hand-typed lists the sense tab shipped before 2026-11-14. Each of these
// was chosen and measured by someone; the filter must not silently drop one.
const OLD_EYES = [
  'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8',
  'glm-5.3-flash', 'glm-5v-turbo', 'glm-4.6v-flash', 'glm-4.6v',
  'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-3.8-flash', 'gemini-3.7-flash',
  'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview', 'mimo-v2.6-pro', 'mimo-v2.6-flash',
];
const OLD_EARS = [
  'qwen3.5-omni-flash', 'qwen3.5-omni-plus', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-4-carbon',
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'mimo-v2.6-pro', 'seed-2-0-lite-260428',
];
const OLD_WATCHER = OLD_EARS;

function fam(kind: 'eyes' | 'ears' | 'watcher', id: string) { return senseFamilyOf(kind, id); }

test('every model the old eyes list offered survives the filter', () => {
  const lost = OLD_EYES.filter((id) => !senseAccepts('eyes', fam('eyes', id), id));
  assert.deepEqual(lost, []);
});
test('every model the old ears list offered survives the filter', () => {
  const lost = OLD_EARS.filter((id) => !senseAccepts('ears', fam('ears', id), id));
  assert.deepEqual(lost, []);
});
test('every model the old watcher list offered survives the filter', () => {
  const lost = OLD_WATCHER.filter((id) => !senseAccepts('watcher', fam('watcher', id), id));
  assert.deepEqual(lost, []);
});

test('a text-only model is not offered as eyes, even on a routable family', () => {
  assert.equal(senseAccepts('eyes', 'GLM', 'glm-5.2'), false);
});
test('a model the bridge cannot route to is not offered, even if it perceives', () => {
  // Kimi sees, but the eyes bridge has no Kimi route.
  assert.equal(senseAccepts('eyes', 'Kimi', 'moonshotai/Kimi-K3'), false);
  // DigitalOcean GLM would be sent to Z.AI by the eyes bridge's else-branch.
  assert.equal(senseAccepts('eyes', 'GLM', 'digitalocean/glm-5.2'), false);
  // The ears/video bridges test `seed`, so the `dola-` snapshot is unreachable.
  assert.equal(senseAccepts('ears', 'ByteDance', 'dola-seed-2-1-turbo-260628'), false);
});
test('the eyes bridge is the only one with a Local and Claude seat', () => {
  assert.ok(senseFamilies('eyes').includes('Local'));
  assert.ok(!senseFamilies('ears').includes('Local'));
  assert.ok(!senseFamilies('watcher').includes('Claude'));
});
test('local vision comes from LM Studio\'s own flag', () => {
  assert.equal(senseAccepts('eyes', 'Local', 'google/gemma-4-26b', true), true);
  assert.equal(senseAccepts('eyes', 'Local', 'qwen/qwen3-8b', false), false);
});
test('local ids round-trip through the eyes bridge\'s local: prefix', () => {
  assert.equal(senseStoredValue('Local', 'google/gemma-4'), 'local:google/gemma-4');
  assert.equal(sensePickerId('local:google/gemma-4'), 'google/gemma-4');
  assert.equal(senseStoredValue('Gemini', 'gemini-4-hydrogen'), 'gemini-4-hydrogen');
  assert.equal(senseFamilyOf('eyes', 'local:google/gemma-4'), 'Local');
});
test('the family names match the Model tab\'s family names', () => {
  for (const id of ['gemini-4-hydrogen', 'claude-opus-5', 'glm-5v-turbo', 'mimo-v2.6-pro', 'qwen3.5-omni-flash', 'seed-2-0-lite-260428']) {
    const kind = id.startsWith('claude') || id.startsWith('glm') ? 'eyes' : 'ears';
    assert.equal(senseFamilyOf(kind, id), familyFromModelId(id));
  }
});
