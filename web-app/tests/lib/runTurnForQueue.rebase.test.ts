import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

// ── A CONFLICT THAT CHANGED NOTHING MUST NOT COST THE TURN ──────────────────
//
// REPORTED 2026-11-04 (津代): "my message and his reply both vanished the
// instant he finished writing." MEASURED: one conversation open in two
// installations sharing a store by junction — each tab mirrors the log and
// writes it back, so `updatedAt` moves under a turn that is still running.
//
// The post is failed on purpose in these tests. The save path is the subject,
// and a failed post reaches it through `commitUnfinished` without needing a
// stream — the same helper the successful path uses, so what is proved here
// holds for both.
// ───────────────────────────────────────────────────────────────────────────

function items(text: string): QueueItem[] {
  return [{
    id: 'item-1', at: 1000, kind: 'user_message', from: 'つよ',
    payload: { text, attachments: [] },
  } as unknown as QueueItem];
}

const MSG = { id: 'u0', role: 'user', content: 'earlier' };

type SaveCall = { expected?: number; messageCount: number };

function rig(over: Partial<RunTurnDeps>) {
  const calls: SaveCall[] = [];
  const base: RunTurnDeps = {
    loadLog: async () => ({ id: 'c1', messages: [MSG], aiName: 'Local', updatedAt: 5 }),
    saveLog: async (_c, logData, opts) => {
      calls.push({
        expected: opts?.expectedUpdatedAt,
        messageCount: Array.isArray(logData.messages) ? logData.messages.length : -1,
      });
      return { ok: true };
    },
    chatPost: async () => ({ ok: false, status: 503, body: null } as unknown as Response),
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
  return { deps: base, calls };
}

test('a conflicting save that changed nothing is retried against the new version', async () => {
  let loads = 0;
  let saves = 0;
  const { deps: d, calls } = rig({
    // Second read is the OTHER tab's write: same messages, new version.
    loadLog: async () => {
      loads++;
      return { id: 'c1', messages: [MSG], aiName: 'Local', updatedAt: loads === 1 ? 5 : 777 };
    },
    saveLog: async (_c, logData, opts) => {
      saves++;
      calls.push({
        expected: opts?.expectedUpdatedAt,
        messageCount: Array.isArray(logData.messages) ? logData.messages.length : -1,
      });
      return saves === 1
        ? { ok: false, conflict: { diskUpdatedAt: 777 } }
        : { ok: true, writtenUpdatedAt: 900 };
    },
  });

  const r = await runTurnForQueue('Default', 'c1', items('do not lose me'), d);

  assert.equal(calls.length, 2, 'the refused save was tried again');
  assert.equal(calls[0].expected, 5, 'first attempt guarded against the version read at turn start');
  assert.equal(calls[1].expected, 777, 'the retry is GUARDED TOO, against the version now on disk');
  assert.equal(calls[1].messageCount, 3, 'the retry carries the same turn: earlier + user + reply');
  assert.deepEqual(
    (r as { consumedIds: string[] }).consumedIds, ['item-1'],
    'the message is spent, not left in the stock for an auto-trigger to re-send',
  );
});

test('a conflicting save over a REAL change is still refused, and keeps the message', async () => {
  let loads = 0;
  const { deps: d, calls } = rig({
    loadLog: async () => {
      loads++;
      // Someone really said something while this turn ran.
      return loads === 1
        ? { id: 'c1', messages: [MSG], aiName: 'Local', updatedAt: 5 }
        : { id: 'c1', messages: [MSG, { id: 'u1', role: 'user', content: 'me too' }], aiName: 'Local', updatedAt: 777 };
    },
    saveLog: async (_c, logData, opts) => {
      calls.push({
        expected: opts?.expectedUpdatedAt,
        messageCount: Array.isArray(logData.messages) ? logData.messages.length : -1,
      });
      return { ok: false, conflict: { diskUpdatedAt: 777 } };
    },
  });

  const r = await runTurnForQueue('Default', 'c1', items('do not lose me'), d);

  assert.equal(calls.length, 1, 'no retry over a real second message');
  assert.equal((r as { stage: string }).stage, 'save');
  assert.match((r as { reason: string }).reason, /refused: the conversation changed on disk/);
  assert.deepEqual(
    (r as { consumedIds: string[] }).consumedIds, [],
    'the typed text stays in the stock — the save did not land',
  );
});

test('a conflict is rebased at most once', async () => {
  // Writes arriving faster than this turn can answer them must END the turn,
  // not spin it. A re-reading loop is unbounded by construction.
  let loads = 0;
  const { deps: d, calls } = rig({
    loadLog: async () => {
      loads++;
      return { id: 'c1', messages: [MSG], aiName: 'Local', updatedAt: loads === 1 ? 5 : 700 + loads };
    },
    saveLog: async (_c, logData, opts) => {
      calls.push({
        expected: opts?.expectedUpdatedAt,
        messageCount: Array.isArray(logData.messages) ? logData.messages.length : -1,
      });
      return { ok: false, conflict: { diskUpdatedAt: 999 } };
    },
  });

  const r = await runTurnForQueue('Default', 'c1', items('do not lose me'), d);

  assert.equal(calls.length, 2, 'one attempt, one rebase, then stop');
  assert.deepEqual((r as { consumedIds: string[] }).consumedIds, []);
});
