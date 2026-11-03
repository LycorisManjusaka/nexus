/**
 * The runner's UNFINISHED endings — a stop, and (since 2026-11-02) a failure.
 *
 * The file is still named for the stop because the stop is where the shape was
 * worked out: commit what the pass produced, mark it, consume the batch. A
 * failure now takes the same road, so the two live together — and the two
 * tests at the bottom that used to assert the OPPOSITE for a failure are
 * rewritten in place, with their old contract quoted, because a test that
 * encodes a decision keeps the whole suite silent about it when the decision
 * changes.
 *
 * THREE fixes live here, and each one CORRECTS the one before — so every
 * reason is kept rather than overwritten:
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
 * 3. 2026-11-02 — a FAILURE (not a stop) still abandoned its batch and saved
 *    nothing, and this file's own comment defended it: "committing a partial
 *    here AND abandoning would compose the same user message a second time on
 *    the retry". True, but it only ruled out ONE of the two pairs. Lizard-kun
 *    named the pair the browser always used: commit, and let a PERSON retry.
 *    "In the pre-server version the USER message stays as it is, the ASSISTANT
 *    message stays empty, and 'retry' is easy to press — if the assistant
 *    message is not kept, 'retry' cannot be pressed either."
 *
 *    Committing and CONSUMING has neither failure mode: no duplicate (nothing
 *    re-composes a spent batch) and no lost text (it is in the log).
 *
 * What would look different without each rule:
 *   · no partial commit      → a stopped turn loses the text, the thinking,
 *                              the tool report and the billing record
 *   · no stop marker         → a truncated reply is indistinguishable from a
 *                              terse one to anyone opening the log later
 *   · no commit on a failure  → the typed text exists only in the queue item
 *                              and an optimistic bubble (InputArea clears its
 *                              draft on send), there is no assistant message
 *                              to press "retry" on, and the item sits in the
 *                              stock panel asking a question nobody wanted
 *   · commit WITHOUT consume  → the next poll composes the same user message
 *                              again: one request, two copies
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

/**
 * `wasStopped` with the SHAPE THE SYSTEM ACTUALLY PRODUCES: false while the
 * body is being built, true once the request is on the wire.
 *
 * ⚠ WHY THIS REPLACED `wasStopped: () => true` (2026-11-03). Every stop test
 * here used that constant to mean "someone pressed Stop during the reply". It
 * was a fixture simplification, and the moment runTurnForQueue learned to
 * check the flag BEFORE posting (津代's ~10s dead button) the simplification
 * started lying in two different directions at once:
 *
 *   · four tests FAILED — the turn now returns before the stream they were
 *     about even exists;
 *   · two tests still PASSED, by the new path, asserting on a notice that
 *     happened to also contain the word they grep for. A test that passes for
 *     a different reason than it names has stopped checking anything.
 *
 * The second kind is why this is a helper and not six edited lines: the flag
 * flipping at the POST is one fact about the system, and it belongs in one
 * place that every stop test shares.
 */
function stopOnceSent(post?: RunTurnDeps['chatPost']): Pick<RunTurnDeps, 'wasStopped' | 'chatPost'> {
  let sent = false;
  const inner: RunTurnDeps['chatPost'] =
    post ?? (async () => ({ ok: true, status: 200, body: abortingBody() } as unknown as Response));
  return {
    chatPost: async (req) => { sent = true; return inner(req); },
    wasStopped: () => sent,
  };
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
    ...stopOnceSent(async () => ({
      ok: true, status: 200,
      body: partialThenAbort([
        frame({ type: 'thought', content: 'weighing it' }),
        frame({ type: 'text', content: 'The answer so f' }),
        frame({ type: 'tool_call', call: { name: 'Bash', input: { command: 'ls' } } }),
        frame({ type: 'cache_usage', cachedInputTokens: 10, outputTokens: 4 }),
      ]),
    } as unknown as Response)),
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
    ...stopOnceSent(async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'half a sent' })]),
    } as unknown as Response)),
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
    globalSettings: { language: 'ja' },
    ...stopOnceSent(async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'とちゅう' })]),
    } as unknown as Response)),
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
  const { deps: d, saves } = deps({ ...stopOnceSent() });
  await runTurnForQueue('Default', 'c1', items('instant stop'), d);

  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, '', 'empty, not absent');
  assert.ok((msgs[1].notices || []).length >= 1, 'and it says why it is empty');
});

// ── A FAILURE commits too (2026-11-02) ──────────────────────────────────────
//
// ⚠ The two tests immediately below REPLACE two that asserted the opposite:
//   'non-stop failure: nothing is saved, because the batch is abandoned for
//    retry'  → assert.equal(saves.length, 0)
//   'wasStopped is optional: a throw with no callback is a plain stream
//    failure' → assert.equal(saves.length, 0)
// They were green for three days and they were the reason nobody could see
// that a failed send left no message to retry from. Quoted rather than
// deleted: the next reader needs to know the suite once promised this.

test('non-stop stream failure: the partial IS saved and the batch is spent', async () => {
  const { deps: d, saves } = deps({
    wasStopped: () => false,
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'arrived before the break' })]),
    } as unknown as Response),
  });
  const r = await runTurnForQueue('Default', 'c1', items('keep me'), d);

  assert.equal((r as { stage: string }).stage, 'stream');
  assert.deepEqual((r as { consumedIds: string[] }).consumedIds, ['item-1'], 'consumed, not abandoned');
  assert.equal(saves.length, 1);
  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2, 'the user turn and the reply it got');
  assert.ok(msgs[0].content.includes('keep me'), 'the typed text is in the log');
  assert.equal(msgs[1].content, 'arrived before the break', 'text that was generated is kept');
  // A failure is not a decision, so it gets no stop marker — otherwise the log
  // would claim somebody cancelled this.
  assert.ok(!(msgs[1].notices || []).some((n) => /stopped|停止/i.test(n)), 'no stop notice');
});

test('wasStopped is optional: a throw with no callback still commits', async () => {
  const { deps: d, saves } = deps({}); // no wasStopped at all
  const r = await runTurnForQueue('Default', 'c1', items('x'), d);
  assert.equal((r as { stage: string }).stage, 'stream');
  assert.equal(saves.length, 1);
  assert.equal(savedMessages(saves[0]).length, 2);
});

test('the LM Studio shape: a 400 from the route leaves the user turn and an EMPTY reply', async () => {
  // REPORTED 2026-11-01: 'LM Studio: 400 { "error": ... Failed to load model
  // ... Engine protocol startup was aborted }'. The post never got through, so
  // there is no partial — which is exactly the case that has to produce an
  // assistant message anyway, because "Rerun from here" only renders on one.
  const { deps: d, saves } = deps({
    chatPost: async () => ({ ok: false, status: 400, body: null } as unknown as Response),
  });
  const r = await runTurnForQueue('Default', 'c1', items('load the model please'), d);

  assert.equal(r.ok, false);
  assert.equal((r as { stage: string }).stage, 'post');
  assert.deepEqual((r as { consumedIds: string[] }).consumedIds, ['item-1'], 'nothing waits in the stock');
  assert.equal(saves.length, 1, 'a post failure saves too');
  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
  assert.ok(msgs[0].content.includes('load the model please'));
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content, '', 'empty, not absent — this is what retry hangs on');
});

test('a post that THROWS commits the same way', async () => {
  const { deps: d, saves } = deps({
    chatPost: async () => { throw new Error('fetch failed'); },
  });
  const r = await runTurnForQueue('Default', 'c1', items('network down'), d);
  assert.equal((r as { stage: string }).stage, 'post');
  assert.ok((r as { reason: string }).reason.includes('fetch failed'), 'the reason survives');
  assert.deepEqual((r as { consumedIds: string[] }).consumedIds, ['item-1']);
  assert.equal(savedMessages(saves[0]).length, 2);
});

test('continue + post failure: the half it was extending is kept, with its id', async () => {
  // Without this, a continue whose post dies replaces the target with a blank —
  // the one shape where committing could DESTROY text instead of keeping it.
  const log = {
    id: 'c1', aiName: 'Local', updatedAt: 5,
    messages: [
      { id: 'u1', role: 'user', content: 'Q' },
      { id: 'a1', role: 'assistant', content: 'HALF' },
    ],
  };
  const { deps: d, saves } = deps({
    loadLog: async () => log,
    chatPost: async () => ({ ok: false, status: 503, body: null } as unknown as Response),
  });
  await runTurnForQueue('Default', 'c1', command('continue', 'a1'), d);

  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2, 'no second bubble');
  assert.equal(msgs[1].id, 'a1');
  assert.equal(msgs[1].content, 'HALF', 'the existing half was not blanked');
});

test('a failure whose SAVE fails is abandoned, because there is nothing to retry from', async () => {
  // The one remaining abandon on this road. Consuming here would delete the
  // only copy of the typed text: the log write did not land.
  const { deps: d } = deps({
    saveLog: async () => ({ ok: false, error: 'disk full' }),
  });
  const r = await runTurnForQueue('Default', 'c1', items('do not lose me'), d);
  assert.equal((r as { stage: string }).stage, 'save');
  assert.deepEqual((r as { consumedIds: string[] }).consumedIds, [], 'the items stay');
});

test('rerun + post failure: the old reply is replaced by the empty one', async () => {
  // Stated as a test because it LOSES text and that has to be deliberate: the
  // rewind is what the person asked for, and this is what the browser did too
  // (its optimistic state drops the target before the request goes out). The
  // alternative — put the old answer back on a failure — would make a rerun
  // that half-succeeded ambiguous.
  const log = {
    id: 'c1', aiName: 'Local', updatedAt: 5,
    messages: [
      { id: 'u1', role: 'user', content: 'Q' },
      { id: 'a1', role: 'assistant', content: 'OLD ANSWER' },
    ],
  };
  const { deps: d, saves } = deps({
    loadLog: async () => log,
    chatPost: async () => ({ ok: false, status: 400, body: null } as unknown as Response),
  });
  await runTurnForQueue('Default', 'c1', command('rerun', 'a1'), d);

  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, '', 'the rerun stands even though it failed');
  assert.notEqual(msgs[1].content, 'OLD ANSWER');
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
    ...stopOnceSent(async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'NEW PAR' })]),
    } as unknown as Response)),
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
    ...stopOnceSent(async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: '-MORE' })]),
    } as unknown as Response)),
  });

  await runTurnForQueue('Default', 'c1', command('continue', 'a1'), d);
  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2, 'no second bubble was minted');
  assert.equal(msgs[1].id, 'a1', 'the target kept its id');
  assert.equal(msgs[1].content, 'HALF-MORE', 'the stopped continuation was kept');
});

// ── A stop that lands BEFORE the post ───────────────────────────────────────
//
// REPORTED 2026-11-03 (津代): "you press the button and nothing happens for
// about ten seconds — and it is not exactly ten. My guess is it is however
// long the prompt takes to reach Anthropic. You will not reproduce it on
// Default; the context is short, so the reaction is fast."
//
// She had the mechanism right. The stop channel was live and the press WAS
// recorded — the tick route registers its listener before the turn starts —
// but the only reader of that flag was the catch around the STREAM. So on a
// large conversation the press sat through loadLog, turnInputFromLog,
// buildSlimHistory and buildTurnRequestBody, and the earliest the turn could
// die was after the request had already gone out.
//
// These two tests pin the part a person can check: nothing is sent.

test('a stop requested before the post never calls the model', async () => {
  let posts = 0;
  const { deps: d, saves } = deps({
    wasStopped: () => true,         // already pressed, as it is on a big context
    chatPost: async () => {
      posts += 1;
      return { ok: true, status: 200, body: abortingBody() } as unknown as Response;
    },
  });

  const r = await runTurnForQueue('Default', 'c1', items('never mind'), d);

  // THE assertion. Everything else here is about not losing anything.
  assert.equal(posts, 0, 'no request was made');

  assert.equal(r.ok, false);
  assert.equal((r as { stage: string }).stage, 'stopped', 'reported as a decision, not a failure');
  assert.deepEqual((r as { consumedIds: string[] }).consumedIds, ['item-1'],
    'the batch is consumed, so an auto-trigger cannot re-fire what was cancelled');

  const msgs = savedMessages(saves[0]);
  assert.equal(msgs.length, 2, 'the user turn and an empty reply, same as every other stop');
  assert.equal(msgs[1].content, '', 'empty, not absent — so "retry" has something to sit on');
  assert.ok((msgs[1].notices || []).length >= 1, 'and it says why it is empty');
});

test('the pre-post notice says the model was never called, not how far it got', async () => {
  // A DIFFERENT sentence from the stream-level stop, in both languages: there
  // the reader wants to know the text is truncated; here the fact is that the
  // turn cost nothing. One notice for both would make the log unable to tell
  // a cancelled send from a very short answer.
  const en = deps({ wasStopped: () => true });
  await runTurnForQueue('Default', 'c1', items('x'), en.deps);
  const enNotice = (savedMessages(en.saves[0])[1].notices || []).join(' ');
  assert.match(enNotice, /never called/i, `got ${JSON.stringify(enNotice)}`);

  const ja = deps({ wasStopped: () => true, globalSettings: { language: 'ja' } });
  await runTurnForQueue('Default', 'c1', items('x'), ja.deps);
  const jaNotice = (savedMessages(ja.saves[0])[1].notices || []).join(' ');
  assert.ok(jaNotice.includes('呼ばれていません'), `got ${JSON.stringify(jaNotice)}`);
});
