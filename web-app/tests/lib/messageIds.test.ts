/**
 * messageIds — repairing duplicate message ids at load time.
 *
 * Ported 2026-10-27 from workspace/dupkey_probe/unit_dedupe.mjs (2026-10-09).
 * The original transpiled the shipping source with tsc into a temp file; here
 * the module is imported directly (tests/_loader.mjs).
 *
 * THE CONTROL CASE IS INVERTED. The original ended with a case that was
 * SUPPOSED to fail — "a detector that cannot fail proves nothing" — and its
 * pass condition was n-1 of n. A suite cannot carry a permanently red case, so
 * the same intent is expressed the other way round: assert that the WRONG
 * answer is not produced. If dedupe ever becomes a no-op, that case goes red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeMessageIds } from '../../src/lib/messageIds';

describe('dedupeMessageIds', () => {
  it('returns the SAME array object when there is nothing to repair', () => {
    // No churn, so React memo and the save effect are untouched.
    const clean = [{ id: 'a' }, { id: 'b' }];
    const r = dedupeMessageIds(clean as never);
    assert.equal(r.repaired, 0);
    assert.equal(r.messages === (clean as never), true);
  });

  it('renames the LATER copy and leaves the first id alone', () => {
    const r = dedupeMessageIds([{ id: '1' }, { id: 'X' }, { id: 'X' }, { id: '9' }] as never);
    assert.deepEqual(r.messages.map((m) => String(m.id)), ['1', 'X', 'X-d2', '9']);
    assert.equal(r.repaired, 1);
  });

  it('does not collapse three copies into two', () => {
    const r = dedupeMessageIds([{ id: 'X' }, { id: 'X' }, { id: 'X' }] as never);
    assert.deepEqual(r.messages.map((m) => String(m.id)), ['X', 'X-d2', 'X-d3']);
  });

  it('dodges a REAL id that appears LATER in the array', () => {
    const r = dedupeMessageIds([{ id: 'X' }, { id: 'X' }, { id: 'X-d2' }] as never);
    assert.deepEqual(r.messages.map((m) => String(m.id)), ['X', 'X-d3', 'X-d2']);
    assert.equal(new Set(r.messages.map((m) => String(m.id))).size, 3);
  });

  it('is deterministic — two tabs must agree', () => {
    const inp = [{ id: 'X' }, { id: 'X' }, { id: 'X' }, { id: 'X-d2' }];
    assert.deepEqual(
      dedupeMessageIds(inp as never).messages.map((m) => String(m.id)),
      dedupeMessageIds(inp as never).messages.map((m) => String(m.id)),
    );
  });

  it('keeps every other field untouched', () => {
    const r = dedupeMessageIds([{ id: 'X', role: 'a' }, { id: 'X', role: 'b', content: 'c' }] as never);
    assert.deepEqual(r.messages[1], { id: 'X-d2', role: 'b', content: 'c' });
  });

  it('survives missing and numeric ids, and still de-collides them', () => {
    const r = dedupeMessageIds([{ id: 1 }, { id: '1' }, {}, {}] as never);
    const ids = r.messages.map((m) => String(m.id));
    assert.deepEqual(ids, ['1', '1-d2', 'undefined', '-d2']);
    assert.equal(new Set(ids).size, 4, 'all distinct');
  });

  it('handles an empty array', () => {
    assert.equal(dedupeMessageIds([] as never).repaired, 0);
  });

  it('CONTROL — is not a no-op (inverted from the original failable case)', () => {
    const ids = dedupeMessageIds([{ id: 'X' }, { id: 'X' }] as never)
      .messages.map((m) => String(m.id));
    assert.notDeepEqual(ids, ['X', 'X'], 'duplicates must not pass through unchanged');
  });
});
