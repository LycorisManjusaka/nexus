/**
 * WHO NAMES A TURN, AND WHAT A BAD NAME MAY COST (2026-11-04).
 *
 * A turn's name is the address Stop uses. Before this module the runner's tick
 * route minted it, so a tab could not address a press until the relay handed
 * the name back — two round-trips. MEASURED: a turn Tsuyo cancelled immediately
 * after sending still took 8.9 s to settle (`generationMs: 8949`, and the
 * notice it saved was the STREAM-level one, proving the press missed the
 * pre-send check entirely). The runner's whole prelude is 19.6 ms, so the two
 * round-trips were the wait, not the work.
 *
 * Letting the tab name the turn fixes that, and introduces three ways to be
 * wrong. Each has its own test below:
 *
 *   · OVERRULING A LIVE TURN — the relay is the single source of a running
 *     turn's id and a watching tab has already read it from there. Adopting a
 *     second name would leave Stop pointing at a turn that does not exist.
 *   · TRUSTING THE STRING — it becomes a Map key in turnStop and is echoed in
 *     an `X-Turn-Id` response header. Unbounded client input in either place is
 *     a defect of its own (map growth; header injection).
 *   · REJECTING instead of DECLINING — turnRegistry's warning applies here:
 *     "a registry that could reject a turn would become a new way for a
 *     conversation to stop working". A malformed proposal must downgrade to a
 *     minted name, never fail the turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTurnName,
  isWellFormedTurnId,
  mintTurnId,
  TURN_ID_RE,
} from '@/lib/turnName';

const MINT = 'turn_minted_aaaaaa';
const mint = () => MINT;

// ── precedence ───────────────────────────────────────────────────────────────

test('a live turn overrules any proposal', () => {
  const d = resolveTurnName('turn_live_bbbbbb', 'turn_abc_123456', mint);
  assert.equal(d.turnId, 'turn_live_bbbbbb');
  assert.equal(d.source, 'live');
  // The caller uses this to decide whether to open a relay. Opening a second
  // one disconnects whoever is watching the first.
  assert.equal(d.isNew, false);
});

test('a live turn overrules even a malformed proposal', () => {
  const d = resolveTurnName('turn_live_bbbbbb', '<script>', mint);
  assert.equal(d.turnId, 'turn_live_bbbbbb');
  assert.equal(d.source, 'live');
});

test('a well-formed proposal is adopted when nothing is live', () => {
  const d = resolveTurnName(null, 'turn_abc_123456', mint);
  assert.equal(d.turnId, 'turn_abc_123456');
  assert.equal(d.source, 'proposed');
  assert.equal(d.isNew, true, 'adopting still means THIS call opens the relay');
});

test('no live turn and no proposal: minted', () => {
  const d = resolveTurnName(null, undefined, mint);
  assert.equal(d.turnId, MINT);
  assert.equal(d.source, 'minted');
  assert.equal(d.isNew, true);
});

test('an empty live id is not a live turn', () => {
  // The tick route reads `existing?.live === true ? existing.turnId : null`,
  // but '' is also what a missing header yields elsewhere. '' must never be
  // adopted as a name: `requestStop` and `onStop` both treat a falsy turnId as
  // "no turn", so the stop channel would be silently dead for that turn.
  const d = resolveTurnName('', 'turn_abc_123456', mint);
  assert.equal(d.turnId, 'turn_abc_123456');
  assert.equal(d.source, 'proposed');
});

// ── declining, not rejecting ─────────────────────────────────────────────────

const BAD: Array<[string, unknown]> = [
  ['empty string', ''],
  ['whitespace', '   '],
  ['no prefix', 'abc_123456'],
  ['wrong prefix', 'spu_abc_123456'],
  ['missing suffix', 'turn_abc'],
  ['suffix too short', 'turn_abc_12'],
  ['header injection', 'turn_abc_123456\r\nX-Evil: 1'],
  ['newline alone', 'turn_abc_1234\n'],
  ['overlong', `turn_abc_${'a'.repeat(5000)}`],
  ['path traversal', 'turn_../../etc_123456'],
  ['null byte — turnStop\'s key separator', 'turn_abc_1234\u0000x'],
  ['not a string: number', 12345],
  ['not a string: object', { turnId: 'turn_abc_123456' }],
  ['not a string: array', ['turn_abc_123456']],
  ['null', null],
];

for (const [label, value] of BAD) {
  test(`declined and minted instead: ${label}`, () => {
    const d = resolveTurnName(null, value, mint);
    // The turn STARTS. That is the point of declining rather than rejecting.
    assert.equal(d.turnId, MINT);
    assert.equal(d.source, 'minted');
    assert.equal(d.isNew, true);
  });
}

test('every rejected shape also fails isWellFormedTurnId', () => {
  for (const [, value] of BAD) assert.equal(isWellFormedTurnId(value), false);
});

// ── the mint honours the shape the gate enforces ─────────────────────────────

test('a minted id passes the gate — the tab and the route agree on shape', () => {
  // If this ever failed, the tab's own proposal would be declined every time
  // and the latency fix would silently do nothing while every test above
  // still passed.
  for (let i = 0; i < 50; i++) {
    const id = mintTurnId();
    assert.equal(isWellFormedTurnId(id), true, `minted id rejected: ${id}`);
    assert.match(id, TURN_ID_RE);
  }
});

test('minted ids are distinct within the same millisecond', () => {
  const ids = new Set(Array.from({ length: 200 }, () => mintTurnId()));
  // turnStop relies on uniqueness: "a record left behind by an old turn
  // cannot match a future one" is only true while names do not repeat.
  assert.equal(ids.size, 200);
});

test('a minted id round-trips through resolveTurnName as a proposal', () => {
  const id = mintTurnId();
  const d = resolveTurnName(null, id, mint);
  assert.equal(d.turnId, id);
  assert.equal(d.source, 'proposed');
});

// ── plain HTTP: the context where randomUUID does not exist ──────────────────
//
// SHIPPED BROKEN IN 146d0ab, FOUND FROM THE PILOT'S PHONE (2026-11-05).
// `mintTurnId` called `crypto.randomUUID()`, which is SECURE-CONTEXT ONLY.
// Over `http://192.168.10.2:3003` the property is absent, so sending threw
// `crypto.randomUUID is not a function` and no message could leave the tab.
// Nothing here caught it because every test, and both dev servers, run where
// the API exists. These tests run the function in the context that broke.

function withCrypto<T>(replacement: unknown, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    value: replacement,
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete (globalThis as { crypto?: unknown }).crypto;
  }
}

test('mints over plain HTTP — crypto exists but randomUUID does not', () => {
  // Exactly what a phone on http:// sees: getRandomValues is present (it is
  // NOT secure-context gated), randomUUID is simply missing.
  const plainHttpCrypto = {
    getRandomValues<T extends ArrayBufferView>(a: T): T {
      const v = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      for (let i = 0; i < v.length; i++) v[i] = (i * 37 + 11) & 0xff;
      return a;
    },
  };
  const ids = withCrypto(plainHttpCrypto, () =>
    Array.from({ length: 20 }, () => mintTurnId()),
  );
  for (const id of ids) assert.equal(isWellFormedTurnId(id), true, `bad id: ${id}`);
});

test('mints with no crypto object at all', () => {
  // Belt and braces: the id is a Map key and a header value, never a secret,
  // so a turn must still be namable even where the whole interface is absent.
  const ids = withCrypto(undefined, () =>
    Array.from({ length: 20 }, () => mintTurnId()),
  );
  for (const id of ids) assert.equal(isWellFormedTurnId(id), true, `bad id: ${id}`);
  assert.equal(new Set(ids).size > 1, true, 'fallback produced one repeated id');
});

test('mintTurnId never reads crypto.randomUUID', () => {
  // The direct regression guard. A future edit that reaches for randomUUID
  // again — the obvious thing to write — fails here instead of on a phone.
  let touched = false;
  const spy = {
    getRandomValues<T extends ArrayBufferView>(a: T): T {
      const v = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      for (let i = 0; i < v.length; i++) v[i] = i;
      return a;
    },
    get randomUUID() {
      touched = true;
      return () => '00000000-0000-4000-8000-000000000000';
    },
  };
  withCrypto(spy, () => mintTurnId());
  assert.equal(touched, false, 'mintTurnId reached for the secure-context-only API');
});
