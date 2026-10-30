/**
 * The runner's STOP path — the fix for "Stop does nothing" on a queued turn.
 *
 * MEASURED 2026-10-30 (live, bbf9d303): pressing Stop DOES abort the
 * generation (`[runner] FAILED ... at stream: This operation was aborted`).
 * But the batch was then ABANDONED back to the queue, and on an auto-trigger
 * conversation the drain re-fired it — the generation just stopped started
 * over, which from the outside is indistinguishable from Stop doing nothing.
 *
 * The fix: when the stream throws AND a stop was requested, runTurnForQueue
 * saves the user's turn with NO reply (as the browser Stop keeps the user
 * message and drops the partial) and returns stage:'stopped', so the tick
 * route CONSUMES the batch instead of abandoning it. Nothing is left to
 * re-fire.
 *
 * These two cases are what the fix turns on, and they would look identical
 * without it — both are "the stream threw":
 *   · wasStopped() → true   save the user turn, report 'stopped' (consume)
 *   · wasStopped() → false  save nothing, report 'stream'      (abandon)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

/** A reader whose first read rejects — the shape an aborted upstream fetch
 *  presents to runTurnStream. */
function abortingBody() {
  return {
    getReader() {
      return {
        read: async () => { throw new Error('This operation was aborted'); },
        cancel: async () => {},
        releaseLock: () => {},
        closed: Promise.resolve(undefined),
      };
    },
  };
}

function items(text: string): QueueItem[] {
  return [{
    id: 'item-1',
    at: 1000,
    kind: 'user_message',
    from: 'Cairn',
    payload: { text, attachments: [] },
  } as unknown as QueueItem];
}

/** Base deps; each test overrides `wasStopped` and captures saveLog. */
function deps(over: Partial<RunTurnDeps>): { deps: RunTurnDeps; saves: Array<Record<string, unknown>> } {
  const saves: Array<Record<string, unknown>> = [];
  const base: RunTurnDeps = {
    loadLog: async () => ({ id: 'c1', messages: [], aiName: 'Local', updatedAt: 5 }),
    saveLog: async (_c, logData) => { saves.push(logData); return { ok: true }; },
    // The stream throws before any frame: the body's reader rejects on first read.
    chatPost: async () => ({ ok: true, status: 200, body: abortingBody() } as unknown as Response),
    globalSettings: {},
    enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: '', modelParams: {} },
    newId: () => 'new-id',
    nowMs: () => 2000,
    clientId: 'runner:test',
    origin: 'http://localhost:3000',
    injectTurnId: 'turn_test',
    ...over,
  };
  return { deps: base, saves };
}

test('stop: the stream throws and a stop was requested → save the user turn, report stopped', async () => {
  const { deps: d, saves } = deps({ wasStopped: () => true });
  const r = await runTurnForQueue('Default', 'c1', items('cancel me'), d);

  assert.equal(r.ok, false);
  assert.equal((r as { stage: string }).stage, 'stopped');

  // The user's message was saved, with NO assistant reply after it.
  assert.equal(saves.length, 1, 'exactly one save (the user turn)');
  const msgs = saves[0].messages as Array<{ role: string; content: string }>;
  assert.equal(msgs.length, 1, 'only the user message — no reply');
  assert.equal(msgs[0].role, 'user');
  assert.ok(msgs[0].content.includes('cancel me'));

  // updatedAt must be dropped so saveLog stamps a fresh version (the lock fix).
  assert.ok(!('updatedAt' in saves[0]), 'the carried version was dropped');
});

test('non-stop failure: the stream throws with no stop → save nothing, report stream', async () => {
  const { deps: d, saves } = deps({ wasStopped: () => false });
  const r = await runTurnForQueue('Default', 'c1', items('keep me'), d);

  assert.equal(r.ok, false);
  assert.equal((r as { stage: string }).stage, 'stream');
  // A transient failure saves nothing; the tick route abandons so the next
  // poll can retry the unchanged batch.
  assert.equal(saves.length, 0, 'no save on a non-stop failure');
});

test('wasStopped is optional: a throw with no callback is a plain stream failure', async () => {
  const { deps: d, saves } = deps({}); // no wasStopped at all
  const r = await runTurnForQueue('Default', 'c1', items('x'), d);
  assert.equal((r as { stage: string }).stage, 'stream');
  assert.equal(saves.length, 0);
});
