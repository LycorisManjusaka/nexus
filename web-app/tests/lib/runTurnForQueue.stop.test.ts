/**
 * The runner's STOP path.
 *
 * TWO fixes live here, measured two days apart, and the second one CORRECTS
 * the first — so both reasons are kept rather than overwritten:
 *
 * 1. 2026-10-29 — "Stop does nothing". Pressing Stop DOES abort the generation
 *    (`[runner] FAILED ... at stream: This operation was aborted`), but the
 *    batch was then ABANDONED back to the queue, and on an auto-trigger
 *    conversation the drain re-fired it. The generation just stopped started
 *    over, which from the outside is Stop doing nothing. Fix: report
 *    stage:'stopped' so the tick route CONSUMES the batch.
 *
 * 2. 2026-10-30 — the same branch then wrote `plan.history`, i.e. the turn
 *    WITHOUT a reply, and justified it in a comment with "as the browser Stop
 *    drops its own partial". THAT CLAIM WAS FALSE and never checked:
 *    ChatArea:4221 says "Commit whatever the turn accumulated — partial text,
 *    tool calls, cache usage — even when the partner stopped it (AbortError),
 *    so billing and the 🔧 tool report are saved to the log instead of lost."
 *    Lizard-kun MEASURED the consequence as three separate symptoms — send,
 *    rerun, change_model — which were one bug: the partial was thrown away,
 *    so a reload left only the user's message.
 *
 *    ⚠ The test below named "save the user turn" asserted `msgs.length === 1`
 *    — it encoded the bug as the contract. A green suite therefore said
 *    nothing about the thing that was wrong. That is why these tests now check
 *    WHAT IS IN the saved reply and not only how many messages there are.
 *
 * What would look different without each rule:
 *   · no partial commit      → a stopped turn loses the text, the thinking,
 *                              the tool report and the billing record
 *   · no stop marker         → a truncated reply is indistinguishable from a
 *                              terse one to anyone opening the log later
 *   · partial on a non-stop  → the batch is also abandoned for retry, so the
 *     failure                  same user message is composed a second time
 *   · rerun without commit   → the old reply is gone AND the new one is not
 *                              saved: the conversation loses a message
 *   · continue without commit → the continuation is lost, the half stays
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** A reader whose first read rejects — an aborted upstream fetch with nothing
 *  delivered yet. */
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

/** A reader that delivers frames and THEN rejects — the real shape of a Stop
 *  pressed mid-reply, and the only one that can show a partial being kept. */
function partialThenAbort(frames: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        read: async () => {
          if (i < frames.length) return { done: false, value: enc.encode(frames[i++]) };
          throw new Error('This operation was aborted');
        },
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

function command(kind: 'rerun' | 'continue', targetMsgId: string): QueueItem[] {
  return [{ id: 'item-1', at: 1000, kind, from: 'Cairn', payload: { targetMsgId } } as unknown as QueueItem];
}

interface Rig { deps: RunTurnDeps; saves: Array<Record<string, unknown>> }

/** Base deps; each test overrides `wasStopped`, the body, and the log. */
function deps(over: Partial<RunTurnDeps>): Rig {
  const saves: Array<Record<string, unknown>> = [];
  const base: RunTurnDeps = {
    loadLog: async () => ({ id: 'c1', messages: [], aiName: 'Local', updatedAt: 5 }),
    saveLog: async (_c, logData) => { saves.push(logData); return { ok: true }; },
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

type Saved = {
  role: string;
  content: string;
  id?: string;
  thoughtProcess?: string;
  notices?: string[];
  toolCalls?: unknown[];
  cacheUsage?: unknown;
  generationMs?: number;
};
const savedMessages = (log: Record<string, unknown>) => log.messages as Saved[];

test('stop mid-reply: the partial text, thinking, tools and billing are all saved', async () => {
  const { deps: d, saves } = deps({
    wasStopped: () => true,
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([
        frame({ type: 'thought', content: 'weighing it' }),
        frame({ type: 'text', content: 'The answer so f' }),
        frame({ type: 'tool_call', call: { name: 'Bash', input: { command: 'ls' } } }),
        frame({ type: 'cache_usage', cachedInputTokens: 10, outputTokens: 4 }),
      ]),
    } as unknown as Response),
  });

  const r = await runTurnForQueue('Default', 'c1', items('cancel me'), d);
  assert.equal(r.ok, false);
  assert.equal((r as { stage: string }).stage, 'stopped');

  assert.equal(saves.length, 1, 'exactly one save');
  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2, 'the user turn AND the partial reply');
  assert.equal(msgs[0].role, 'user');
  assert.ok(msgs[0].content.includes('cancel me'));

  const reply = msgs[1];
  assert.equal(reply.role, 'assistant');
  // The four things ChatArea:4221 names as the reason to commit a partial.
  assert.equal(reply.content, 'The answer so f', 'partial text kept');
  assert.equal(reply.thoughtProcess, 'weighing it', 'partial thinking kept');
  assert.equal(reply.toolCalls?.length, 1, 'the tool report kept');
  assert.ok(reply.cacheUsage, 'the billing record kept');
  assert.ok(typeof reply.generationMs === 'number', 'generation time recorded');

  // updatedAt must be dropped so saveLog stamps a fresh version (the lock fix).
  assert.ok(!('updatedAt' in saves[0]), 'the carried version was dropped');
});

test('a stopped reply is MARKED, so a truncation cannot read as a complete answer', async () => {
  const { deps: d, saves } = deps({
    wasStopped: () => true,
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'half a sent' })]),
    } as unknown as Response),
  });
  await runTurnForQueue('Default', 'c1', items('x'), d);

  const reply = savedMessages(saves[0])[1];
  assert.ok(Array.isArray(reply.notices) && reply.notices.length >= 1, 'a notice is attached');
  assert.ok(
    reply.notices!.some((n) => /stopped/i.test(n)),
    'the notice says the turn was stopped',
  );
  // The marker must NOT be in the body: `content` is in buildSlimHistory's
  // allowlist and would be replayed to the model on every later turn.
  assert.equal(reply.content, 'half a sent', 'the marker is not in the text');
});

test('the stop marker follows the interface language', async () => {
  const { deps: d, saves } = deps({
    wasStopped: () => true,
    globalSettings: { language: 'ja' },
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'とちゅう' })]),
    } as unknown as Response),
  });
  await runTurnForQueue('Default', 'c1', items('x'), d);
  const notices = savedMessages(saves[0])[1].notices || [];
  assert.ok(notices.some((n) => n.includes('停止')), `expected a Japanese notice, got ${JSON.stringify(notices)}`);
});

test('stop before anything arrived: an empty reply is still saved, carrying the marker', async () => {
  // Lizard-kun saw this shape on change_model (an empty assistant message left
  // behind) and reported it as a third symptom. It is the correct outcome and
  // the browser's too — the streaming placeholder is created up front — so the
  // fix makes all three shapes agree rather than special-casing this one.
  const { deps: d, saves } = deps({ wasStopped: () => true });
  await runTurnForQueue('Default', 'c1', items('instant stop'), d);

  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, '', 'empty, not absent');
  assert.ok((msgs[1].notices || []).length >= 1, 'and it says why it is empty');
});

test('non-stop failure: nothing is saved, because the batch is abandoned for retry', async () => {
  const { deps: d, saves } = deps({
    wasStopped: () => false,
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'would be lost' })]),
    } as unknown as Response),
  });
  const r = await runTurnForQueue('Default', 'c1', items('keep me'), d);

  assert.equal((r as { stage: string }).stage, 'stream');
  assert.deepEqual((r as { consumedIds: string[] }).consumedIds, [], 'abandoned');
  // Committing a partial here AND abandoning would compose the same user
  // message a second time on the retry.
  assert.equal(saves.length, 0, 'no save on a non-stop failure');
});

test('wasStopped is optional: a throw with no callback is a plain stream failure', async () => {
  const { deps: d, saves } = deps({}); // no wasStopped at all
  const r = await runTurnForQueue('Default', 'c1', items('x'), d);
  assert.equal((r as { stage: string }).stage, 'stream');
  assert.equal(saves.length, 0);
});

test('rerun + stop: the partial takes the old reply\'s place, so no message is lost', async () => {
  const log = {
    id: 'c1',
    aiName: 'Local',
    updatedAt: 5,
    messages: [
      { id: 'u1', role: 'user', content: 'Q' },
      { id: 'a1', role: 'assistant', content: 'OLD ANSWER' },
    ],
  };
  const { deps: d, saves } = deps({
    loadLog: async () => log,
    wasStopped: () => true,
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'NEW PAR' })]),
    } as unknown as Response),
  });

  await runTurnForQueue('Default', 'c1', command('rerun', 'a1'), d);
  const msgs = savedMessages(saves[0]);
  // Before the fix this saved [u1] alone: the rewind stood and the partial was
  // dropped, so the conversation came back one message shorter.
  assert.equal(msgs.length, 2, 'the user turn and exactly one reply');
  assert.equal(msgs[1].content, 'NEW PAR');
  assert.notEqual(msgs[1].content, 'OLD ANSWER', 'the rerun did replace it');
});

test('continue + stop: the continuation extends the target in place, keeping its id', async () => {
  const log = {
    id: 'c1',
    aiName: 'Local',
    updatedAt: 5,
    messages: [
      { id: 'u1', role: 'user', content: 'Q' },
      { id: 'a1', role: 'assistant', content: 'HALF' },
    ],
  };
  const { deps: d, saves } = deps({
    loadLog: async () => log,
    wasStopped: () => true,
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: '-MORE' })]),
    } as unknown as Response),
  });

  await runTurnForQueue('Default', 'c1', command('continue', 'a1'), d);
  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2, 'no second bubble was minted');
  assert.equal(msgs[1].id, 'a1', 'the target kept its id');
  assert.equal(msgs[1].content, 'HALF-MORE', 'the stopped continuation was kept');
});
