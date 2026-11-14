import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMockScenario, planMockRound, mockChunks, isMockModelId, mockNameFromId, MOCK_DEFAULTS } from '../src/lib/mockModel.ts';

test('a broken or empty scenario plays the defaults instead of failing', () => {
  assert.deepEqual(parseMockScenario(null), MOCK_DEFAULTS);
  const s = parseMockScenario({ toolRounds: 'ten', chunkChars: -5, thoughtBetween: [1, ''] });
  assert.equal(s.toolRounds, MOCK_DEFAULTS.toolRounds);
  assert.equal(s.chunkChars, 1);
  assert.deepEqual(s.thoughtBetween, MOCK_DEFAULTS.thoughtBetween);
});

test('plays exactly toolRounds Bash rounds, then answers', () => {
  const s = parseMockScenario({ toolRounds: 3 });
  const tools = ['Read', 'Bash'];
  for (let i = 0; i < 3; i++) {
    const p = planMockRound(s, i, tools, false);
    assert.equal(p.kind, 'tool');
    if (p.kind === 'tool') assert.equal(p.tool?.name, 'Bash');
  }
  assert.equal(planMockRound(s, 3, tools, false).kind, 'final');
});

test('every Bash command is unique, so the repeat guard never trips', () => {
  const s = parseMockScenario({ toolRounds: 10, toolCommand: 'sleep 10' });
  const cmds = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const p = planMockRound(s, i, ['Bash'], false);
    if (p.kind === 'tool' && p.tool?.name === 'Bash') cmds.add(p.tool.args.command);
  }
  assert.equal(cmds.size, 10);
});

test('no Bash → Glob plus a self-wait; no tools or noTools → straight answer', () => {
  const s = parseMockScenario({ toolRounds: 2, fallbackWaitSec: 7 });
  const g = planMockRound(s, 0, ['Glob'], false);
  assert.equal(g.kind, 'tool');
  if (g.kind === 'tool') { assert.equal(g.tool?.name, 'Glob'); assert.equal(g.selfWaitSec, 7); }
  assert.equal(planMockRound(s, 0, [], false).kind, 'final');
  assert.equal(planMockRound(s, 0, ['Bash'], true).kind, 'final');
});

test('ids and chunking', () => {
  assert.ok(isMockModelId('mock:a'));
  assert.ok(!isMockModelId('gemma-4'));
  assert.equal(mockNameFromId('mock:魂のない機械'), '魂のない機械');
  assert.deepEqual(mockChunks('あい😀うえ', 2), ['あい', '😀う', 'え']);
});
