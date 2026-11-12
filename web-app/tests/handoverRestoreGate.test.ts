import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { restoreGateReason, clampLogCapUnits, LOG_CAP_MIN_UNITS } from '@/lib/handoverRestore';

// つよ 2026-11-12: past generations restore only when the cap is explicitly
// raised; an inactive conversation ("…" → 非アクティブ, faint name) never does;
// the cap may be 0 ("no past log").

const base = { active: true, orphan: false, olderCount: 3, isHead: true, includePast: false };

test('head restores as before', () => {
  assert.equal(restoreGateReason(base), null);
});

test('past generation: opening alone does not restore', () => {
  assert.equal(restoreGateReason({ ...base, isHead: false }), 'not-head');
});

test('past generation: explicit cap raise restores', () => {
  assert.equal(restoreGateReason({ ...base, isHead: false, includePast: true }), null);
});

test('inactive never restores, head or past, even with includePast', () => {
  assert.equal(restoreGateReason({ ...base, active: false }), 'inactive');
  assert.equal(restoreGateReason({ ...base, active: false, isHead: false, includePast: true }), 'inactive');
});

test('cap minimum is 0 and 0 survives the clamp', () => {
  assert.equal(LOG_CAP_MIN_UNITS, 0);
  assert.equal(clampLogCapUnits(0), 0);
  assert.equal(clampLogCapUnits(-5), 0);
});

test('no `|| DEFAULT_MAX_CONVERSATION_LOG` left: a 0 cap must not become the default', () => {
  for (const f of ['src/components/ChatArea.tsx', 'src/components/Sidebar.tsx']) {
    const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
    assert.ok(!/\|\|\s*DEFAULT_MAX_CONVERSATION_LOG/.test(src), `${f} still uses || DEFAULT_MAX_CONVERSATION_LOG`);
  }
});

test('ChatArea sends includePast only from the cap-raise signal', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/components/ChatArea.tsx'), 'utf8');
  assert.ok(src.includes('includePast: capRaised'));
  assert.ok(/capRaised\s*=\s*prevCap\.convoId === convoId && cap > prevCap\.cap/.test(src));
});
