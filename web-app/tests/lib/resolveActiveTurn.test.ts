/**
 * resolveActiveTurn — "is a turn running for this conversation, and is it
 * mine", answered from BOTH the registry and the relay (2026-10-31).
 *
 * WHY IT EXISTS. The registry drops an entry TURN_TTL_MS (25s) after its last
 * heartbeat, and NOTHING BEATS: the only sender of POST { event: 'beat' } was
 * beginTurnRegistration in the browser turn engine, deleted 2026-10-30 with
 * the other 764 lines. For a turn the SERVER runs, the TTL therefore is not a
 * backstop — it is the normal path, and the entry disappears 25 seconds into
 * a turn that may run for minutes.
 *
 * MEASURED 2026-10-31 (Lizard-kun, phone + airplane mode): send, kill the
 * network, restore it. The watch dies with the connection and the tab's probe
 * is what would rejoin — but by the time a human has toggled the switch back,
 * the registry has aged out, the probe is told "nothing is running here", and
 * the view never comes back. The answer lands on disk; only the screen is
 * lost, which is the exact failure the server-side runner was built to remove.
 *
 * The decision lives in lib/ and not in the route because routes in this repo
 * cannot be unit-tested at all: importing next/server outside the Next runtime
 * fails (measured 2026-10-27). A rule inside a handler is a rule no test and
 * no mutation can reach.
 *
 * Each case names what would look different without the rule it fixes:
 *
 *   "relay answers when the registry has aged out" — absent, this is the
 *       airplane-mode bug itself: a live turn reported as nothing.
 *   "a DONE relay does not keep a turn alive" — absent, a tab would attach
 *       forever to a conversation whose relay record is only being retained
 *       for replay, and every attempt ends in a reload.
 *   "a missing relay does NOT subtract" — absent, an SPU run (which POSTs
 *       /api/chat but keys its relay by being+generation, so the conversation
 *       map is empty) would be reported as "nothing running" mid soul-update.
 *   "the registry wins while it is fresh" — absent, the label disappears from
 *       the cross-tab warning, because only a registry entry carries one.
 *   "relay-derived answers are never mine" — absent, the tab that kicked the
 *       turn would be told it owns a turn the RUNNER owns, and would skip the
 *       probe that is supposed to rejoin it.
 *   "mine needs a non-empty clientId" — absent, a caller that sent no
 *       clientId matches an entry whose clientId is also empty, and every
 *       anonymous probe is told the turn is its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveTurn } from '@/lib/turnRegistry';

const entry = (over: Partial<{ clientId: string; label?: string; startedAt: number }> = {}) => ({
  clientId: 'tab-abc',
  label: 'gemma-4-26b',
  startedAt: 1000,
  ...over,
});

test('resolveActiveTurn: the registry wins while it is fresh, and carries the label', () => {
  const a = resolveActiveTurn(entry(), { live: true, startedAt: 2000 }, 'tab-abc');
  assert.equal(a.active, true);
  assert.equal(a.source, 'registry');
  assert.equal(a.label, 'gemma-4-26b');
  assert.equal(a.startedAt, 1000, 'registry startedAt, not the relay one');
});

test('resolveActiveTurn: mine is true only for the owning clientId', () => {
  assert.equal(resolveActiveTurn(entry(), null, 'tab-abc').mine, true);
  assert.equal(resolveActiveTurn(entry(), null, 'tab-xyz').mine, false);
});

test('resolveActiveTurn: an empty clientId is never mine, even against an empty entry', () => {
  // Both empty strings are equal. Without the !!clientId guard every
  // anonymous probe would be told the running turn belongs to it.
  assert.equal(resolveActiveTurn(entry({ clientId: '' }), null, '').mine, false);
});

test('resolveActiveTurn: the relay answers when the registry has aged out', () => {
  // THE BUG. 25s into a server-run turn there is no entry, and this is the
  // only thing left that knows a turn is in flight.
  const a = resolveActiveTurn(null, { live: true, startedAt: 2000 }, 'tab-abc');
  assert.equal(a.active, true);
  assert.equal(a.source, 'relay');
  assert.equal(a.startedAt, 2000);
  assert.equal(a.label, undefined, 'only a registry entry carries a label');
});

test('resolveActiveTurn: a relay-derived answer is never mine', () => {
  // Conversation relays are opened in exactly one place, the runner's tick
  // route — so such an answer always describes a turn no tab owns.
  for (const id of ['tab-abc', 'runner:c:\\dev\\nexus', '']) {
    assert.equal(resolveActiveTurn(null, { live: true, startedAt: 2000 }, id).mine, false, id);
  }
});

test('resolveActiveTurn: a FINISHED relay does not keep a turn alive', () => {
  // The record is retained after the turn for replay. live === !done, and
  // only live counts.
  const a = resolveActiveTurn(null, { live: false, startedAt: 2000 }, 'tab-abc');
  assert.equal(a.active, false);
  assert.equal(a.source, 'none');
});

test('resolveActiveTurn: a missing relay does NOT subtract from the registry', () => {
  // An SPU run POSTs /api/chat and keys its relay by being+generation, so the
  // conversation map is empty for it while its registry entry is real.
  const a = resolveActiveTurn(entry(), null, 'other');
  assert.equal(a.active, true);
  assert.equal(a.source, 'registry');
});

test('resolveActiveTurn: nothing anywhere is inactive, and says which source said so', () => {
  const a = resolveActiveTurn(null, null, 'tab-abc');
  assert.deepEqual(a, { active: false, mine: false, source: 'none' });
});

test('resolveActiveTurn: an entry with no label stays label-free rather than inventing one', () => {
  const a = resolveActiveTurn(entry({ label: undefined }), { live: true, startedAt: 2000 }, 'x');
  assert.equal(a.label, undefined);
  assert.equal(a.source, 'registry');
});
