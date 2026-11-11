import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { placeAnnouncedUser } from '@/lib/announcedUser';

const user = { id: 'u1', role: 'user', content: 'ζ: started', nexus: { full: 'LONG COVENANT' } };

test('a kicked turn the tab did not type: the user message lands BEFORE the placeholder', () => {
  const prev = [{ id: 'a0' }, { id: 'ph' }];
  const next = placeAnnouncedUser(prev, user, 'ph', false) as any[];
  assert.deepEqual(next.map((m) => m.id), ['a0', 'u1', 'ph']);
  assert.equal(next[1].nexus.full, 'LONG COVENANT'); // the fold needs the full text
  assert.equal(next[1].autoPlay, false);
});

test('placeholder not in the list: appended', () => {
  const next = placeAnnouncedUser([{ id: 'a0' }], user, 'ph', false);
  assert.deepEqual(next.map((m) => m.id), ['a0', 'u1']);
});

test('a direct send already shows its own bubble: nothing is added (no double text)', () => {
  const prev = [{ id: 'opt' }, { id: 'ph' }];
  assert.equal(placeAnnouncedUser(prev, user, 'ph', true), prev);
});

test('already present by id, or no announced user: unchanged', () => {
  const prev = [{ id: 'u1' }, { id: 'ph' }];
  assert.equal(placeAnnouncedUser(prev, user, 'ph', false), prev);
  assert.equal(placeAnnouncedUser(prev, null, 'ph', false), prev);
  assert.equal(placeAnnouncedUser(prev, { content: 'no id' }, 'ph', false), prev);
});

test('wiring: the kicking tab no longer drops the plan before looking at its user', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/components/ChatArea.tsx'), 'utf8');
  assert.match(src, /if \(!attach\) \{[\s\S]{0,200}placeAnnouncedUser\(prev, plan\.user, watchId, hasOptimistic\)/);
  assert.doesNotMatch(src, /if \(!attach\) return;\s*\n\s*\/\/ FIRST plan only/);
});
