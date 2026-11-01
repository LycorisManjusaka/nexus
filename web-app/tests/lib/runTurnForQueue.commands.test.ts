/**
 * RERUN and CONTINUE as queue COMMANDS, run server-side (2026-10-30).
 *
 * Both used to call generateAiResponse in the browser, so the tab's
 * connection was the turn's lifeline — Lizard-kun MEASURED LM Studio dying
 * mid-token when the tab closed. They now enqueue a POINTER
 * (`{ kind, targetMsgId }`) and the runner reads the target from the log.
 *
 * What is actually at risk, and therefore what these tests are for:
 *
 *   · a rerun that APPENDS instead of replacing — the conversation grows a
 *     second answer and the old one stays. Looks fine in a screenshot.
 *   · a continue that MINTS A NEW MESSAGE instead of extending the target —
 *     the reply is split into two bubbles with the same text twice.
 *   · a continue that forgets `continueFromMessage` — the history then ends
 *     on an assistant turn with no resume instruction, which is a prefill;
 *     Claude rejects it outright under extended thinking.
 *   · a continue that drops the carried THINKING — the first half's
 *     reasoning is erased by the first chunk of the second half.
 *   · a MIXED batch — the runner answers only the leading run, so consuming
 *     every id would delete messages nobody ever answered.
 *
 * The target checks are the other half: a command whose target moved or
 * vanished must REFUSE and still consume its item. Abandoning it would leave
 * it for the auto-trigger to re-fire forever, which is the same failure shape
 * the Stop fix removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** A body that streams the given SSE frames and ends. */
function bodyOf(frames: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        read: async () =>
          i >= frames.length
            ? { done: true, value: undefined }
            : { done: false, value: enc.encode(frames[i++]) },
        cancel: async () => {},
        releaseLock: () => {},
        closed: Promise.resolve(undefined),
      };
    },
  };
}

function item(kind: 'rerun' | 'continue' | 'user_message', payload: unknown, id = 'item-1'): QueueItem {
  return { id, at: 1000, kind, from: 'Cairn', payload } as unknown as QueueItem;
}

interface Rig {
  deps: RunTurnDeps;
  saves: Array<Record<string, unknown>>;
  bodies: Array<Record<string, unknown>>;
}

function rig(
  log: Record<string, unknown>,
  said = 'TAIL',
  over: Partial<RunTurnDeps> = {},
  thought = '',
): Rig {
  const saves: Array<Record<string, unknown>> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c, logData) => { saves.push(logData); return { ok: true }; },
    chatPost: async (req) => {
      bodies.push(JSON.parse(await req.text()));
      const frames = thought
        ? [frame({ type: 'thought', content: thought }), frame({ type: 'text', content: said })]
        : [frame({ type: 'text', content: said })];
      return { ok: true, status: 200, body: bodyOf(frames) } as unknown as Response;
    },
    globalSettings: {},
    enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: '', modelParams: {} },
    newId: () => 'minted',
    nowMs: () => 7000,
    clientId: 'runner:test',
    origin: 'http://localhost:3000',
    injectTurnId: 'turn_test',
    ...over,
  };
  return { deps, saves, bodies };
}

type Msg = { id: string; role: string; content: string; thoughtProcess?: string; attachments?: unknown[] };
const saved = (r: Rig) => r.saves[0].messages as Msg[];

const twoTurn = () => ({
  id: 'c1',
  updatedAt: 5,
  aiName: 'Local',
  messages: [
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'a1', role: 'assistant', content: 'HALF', thoughtProcess: 'FIRST-THINKING' },
  ],
});

// ── rerun ────────────────────────────────────────────────────────────────────

test('rerun: the target is REPLACED, not appended, and no user message is minted', async () => {
  const r = rig(twoTurn());
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);

  assert.equal(res.ok, true);
  const m = saved(r);
  // Two, not three: an appending bug leaves the old answer in place, and a
  // send-shaped bug also mints a user turn out of an empty batch.
  assert.equal(m.length, 2, 'user + exactly one answer');
  assert.equal(m[0].id, 'u1');
  assert.equal(m[1].role, 'assistant');
  assert.notEqual(m[1].id, 'a1', 'a rerun is a NEW message, not an edit of the old one');
  assert.equal(m[1].content, 'TAIL');
});

test('rerun: the model is NOT shown the answer being replaced', async () => {
  const r = rig(twoTurn());
  await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);
  const sent = r.bodies[0].messages as Msg[];
  assert.equal(sent.length, 1, 'history stops before the target');
  assert.equal(sent[0].role, 'user');
  // Nothing marks this as a continuation.
  assert.equal(r.bodies[0].continueFromMessage, false);
});

// ── continue ─────────────────────────────────────────────────────────────────

test('continue: the target is extended IN PLACE, keeping its id', async () => {
  const r = rig(twoTurn());
  const res = await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);

  assert.equal(res.ok, true);
  const m = saved(r);
  assert.equal(m.length, 2, 'no new bubble — the reply is one message');
  assert.equal(m[1].id, 'a1', 'the continued message keeps its id');
  assert.equal(m[1].content, 'HALFTAIL', 'seeded with what was already there');
  assert.equal((res as { messageId: string }).messageId, 'a1');
});

test('continue: the first half\'s THINKING survives the second half', async () => {
  // The continuation MUST emit thinking of its own for this to
  // discriminate. MEASURED 2026-10-30: the first version streamed only
  // text, so acc.currentThought stayed empty, finalizeTurnMessage skipped
  // its thoughtProcess override entirely, and the value arrived on `base`
  // (the spread target) no matter what the seed was. The test passed with
  // the seed deleted. A mutation run is what said so.
  const r = rig(twoTurn(), 'TAIL', {}, 'SECOND-THINKING');
  await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);
  // Every flush REPLACES thoughtProcess, so an unseeded accumulator erases
  // this on the continuation's first chunk — silently, and only on disk.
  assert.equal(saved(r)[1].thoughtProcess, 'FIRST-THINKINGSECOND-THINKING');
});

test('continue: the request says continueFromMessage, so the server adds the resume turn', async () => {
  const r = rig(twoTurn());
  await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);
  const sent = r.bodies[0].messages as Msg[];
  assert.equal(sent.length, 2, 'history INCLUDES the message being continued');
  assert.equal(sent[1].role, 'assistant');
  // Without this the tail is a prefill: Anthropic rejects it under extended
  // thinking, and Gemini 3.6+ rejects it outright.
  assert.equal(r.bodies[0].continueFromMessage, true);
});

test('continue: files the first half produced are kept, not replaced', async () => {
  const log = twoTurn();
  (log.messages[1] as Msg).attachments = [{ id: 'att-from-first-half' }];
  const r = rig(log);
  await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);
  const atts = saved(r)[1].attachments as Array<{ id: string }>;
  assert.deepEqual(atts.map(a => a.id), ['att-from-first-half']);
});

// ── the target checks ────────────────────────────────────────────────────────

test('target gone: refuse, and CONSUME the item so it cannot re-fire forever', async () => {
  const r = rig(twoTurn());
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'nope' })], r.deps);
  assert.equal(res.ok, false);
  assert.equal((res as { stage: string }).stage, 'target');
  assert.deepEqual(res.consumedIds, ['item-1'], 'permanent failure → consume');
  assert.equal(r.saves.length, 0, 'nothing written');
  assert.equal(r.bodies.length, 0, 'the provider was never called');
});

test('target is no longer last: refuse rather than delete what landed after it', async () => {
  const log = twoTurn();
  log.messages.push({ id: 'u2', role: 'user', content: 'raced in' } as never);
  const r = rig(log);
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);
  assert.equal((res as { stage: string }).stage, 'target');
  // The buttons are only offered on the LAST message, so this can only happen
  // in a race — and a rerun that proceeded would silently delete 'u2'.
  assert.match((res as { reason: string }).reason, /no longer the last/);
  assert.equal(r.saves.length, 0);
});

test('continue pointed at a user message: refuse', async () => {
  const r = rig({ id: 'c1', updatedAt: 5, messages: [{ id: 'u1', role: 'user', content: 'hi' }] });
  const res = await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'u1' })], r.deps);
  assert.equal((res as { stage: string }).stage, 'target');
  assert.equal(r.bodies.length, 0);
});

test('a command with no targetMsgId is refused, not run as an empty send', async () => {
  const r = rig(twoTurn());
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', {})], r.deps);
  assert.equal((res as { stage: string }).stage, 'target');
  assert.equal(r.bodies.length, 0);
});

// ── mixed batches ────────────────────────────────────────────────────────────

test('mixed batch: only the leading run runs, and only ITS ids are consumed', async () => {
  const r = rig(twoTurn());
  const batch = [
    item('user_message', { text: 'first', attachments: [] }, 'i-a'),
    item('user_message', { text: 'second', attachments: [] }, 'i-b'),
    item('rerun', { targetMsgId: 'a1' }, 'i-c'),
  ];
  const res = await runTurnForQueue('Default', 'c1', batch, r.deps);

  assert.equal(res.ok, true);
  // The two user messages merged into one turn; the rerun did not join them.
  const sent = r.bodies[0].messages as Msg[];
  assert.match(sent[sent.length - 1].content, /first/);
  assert.match(sent[sent.length - 1].content, /second/);
  // The rerun's id is NOT consumed. Releasing it here is the bug this guards:
  // composeBatch would have skipped it (no payload.text) and the caller used
  // to release every id it handed over, so the rerun would vanish silently.
  assert.deepEqual(res.consumedIds, ['i-a', 'i-b']);
});

test('mixed batch led by a command: the command runs ALONE', async () => {
  const r = rig(twoTurn());
  const batch = [
    item('rerun', { targetMsgId: 'a1' }, 'i-a'),
    item('user_message', { text: 'behind it', attachments: [] }, 'i-b'),
  ];
  const res = await runTurnForQueue('Default', 'c1', batch, r.deps);

  assert.equal(res.ok, true);
  assert.deepEqual(res.consumedIds, ['i-a']);
  // The waiting message was not swept into the rerun's history.
  const sent = r.bodies[0].messages as Msg[];
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'question');
});

// ── stop, on a command ───────────────────────────────────────────────────────

test('stop during a continue leaves the half-finished message exactly as it was', async () => {
  const r = rig(twoTurn(), 'TAIL', {
    wasStopped: () => true,
    chatPost: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => { throw new Error('This operation was aborted'); },
          cancel: async () => {}, releaseLock: () => {}, closed: Promise.resolve(undefined),
        }),
      },
    } as unknown as Response),
  });
  const res = await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);

  assert.equal((res as { stage: string }).stage, 'stopped');
  const m = saved(r);
  assert.equal(m.length, 2);
  assert.equal(m[1].id, 'a1');
  // NOT truncated and NOT extended: a cancelled continue must not consume the
  // message it was going to extend.
  //
  // This still holds after the 2026-10-30 partial-commit fix, and the reason is
  // THIS fixture: the reader rejects on its FIRST read, so nothing was
  // delivered and the committed partial is the target unchanged. A continue
  // stopped AFTER some text arrives keeps that text — see
  // runTurnForQueue.stop.test.ts, which drives the same path with a reader that
  // delivers first.
  assert.equal(m[1].content, 'HALF');
});

test('stop during a rerun keeps the rewind and commits a marked, empty reply', async () => {
  const r = rig(twoTurn(), 'TAIL', {
    wasStopped: () => true,
    chatPost: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => { throw new Error('This operation was aborted'); },
          cancel: async () => {}, releaseLock: () => {}, closed: Promise.resolve(undefined),
        }),
      },
    } as unknown as Response),
  });
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);

  assert.equal((res as { stage: string }).stage, 'stopped');
  const m = saved(r);
  // ⚠ CORRECTED 2026-10-30. This asserted `m.length === 1` — "the rewind
  // stands; no answer was produced" — which encoded the bug Lizard-kun then
  // measured: a stopped rerun lost the old reply AND saved nothing in its
  // place, so a reload came back one message short. Every shape now commits
  // its partial, and when nothing was delivered the partial is an empty reply
  // carrying the stop marker, so the log says what happened.
  assert.equal(m.length, 2, 'the user turn and the (empty) stopped reply');
  assert.equal(m[0].id, 'u1');
  assert.equal(m[1].role, 'assistant');
  assert.equal(m[1].content, '', 'nothing was delivered before the stop');
  assert.notEqual(m[1].id, 'a1', 'the rewind stands: the old reply is not resurrected');
});

// ── the clone boundary: a SEND resolves it, a COMMAND must not ───────────────
//
// REGRESSION 2026-10-31, reported by ふわふわ: "Next = First Original" stopped
// working. `NexusApp` sets `firstOriginalIsNext` when it clones a conversation
// forward; the consumer was three lines in ChatArea.handleSend, which minted
// the user message. The runner mints it now, and nothing took over — so the
// flag stayed pending, and pending-with-no-marker makes makeIsOriginalIndex
// answer "nothing is original". Every message in every cloned conversation
// read as carry-over, permanently, with no error anywhere.
//
// The runner is the only place that CAN resolve it: the marker has to name the
// id of the user message, and that id is minted here, after the tab's send has
// already returned.

/** A log mid-clone: the whole history is carry-over, nothing is original yet. */
const pendingLog = () => ({
  id: 'c1',
  updatedAt: 5,
  aiName: 'Local',
  firstOriginalMessageId: null,
  firstOriginalIsNext: true,
  messages: [
    { id: 'u1', role: 'user', content: 'carried question' },
    { id: 'a1', role: 'assistant', content: 'carried answer' },
  ],
});

/** Distinct ids, so "the marker names the USER message" can be told apart. */
const counting = () => {
  let n = 0;
  return () => `n${++n}`;
};

const lastSave = (r: Rig) => r.saves[r.saves.length - 1];

test('send: the pending boundary lands on the user message the RUNNER minted', async () => {
  const r = rig(pendingLog(), 'ANSWER', { newId: counting() });
  const res = await runTurnForQueue(
    'Default', 'c1', [item('user_message', { text: 'first original' })], r.deps,
  );

  assert.equal(res.ok, true);
  const log = lastSave(r);
  const m = log.messages as Msg[];
  assert.equal(m.length, 4, 'carried pair, the new user turn, the answer');
  const newUser = m[2];
  assert.equal(newUser.role, 'user', 'carried pair first, then the new user turn');
  assert.equal(m[3].role, 'assistant', 'and the answer last');
  // The id, not just "some id": a marker naming the ASSISTANT would make the
  // user's own message read as carry-over.
  assert.equal(log.firstOriginalMessageId, newUser.id);
  assert.equal(log.firstOriginalIsNext, false, 'the flag is consumed, so a later send cannot move it');
});

test('send: a log that was never cloned keeps its boundary untouched', async () => {
  // Without the pending gate, EVERY send would set the marker to itself and
  // the history above it would flip to copied — the inverse defect.
  const r = rig({ ...twoTurn(), firstOriginalMessageId: 'u1', firstOriginalIsNext: false }, 'ANSWER', { newId: counting() });
  await runTurnForQueue('Default', 'c1', [item('user_message', { text: 'later message' })], r.deps);

  const log = lastSave(r);
  assert.equal(log.firstOriginalMessageId, 'u1', 'an already-resolved boundary does not move');
  assert.equal(log.firstOriginalIsNext, false);
});

test('rerun: a command does NOT resolve the boundary (it adds no user message)', async () => {
  const r = rig(pendingLog(), 'AGAIN', { newId: counting() });
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);

  assert.equal(res.ok, true);
  const log = lastSave(r);
  // A rerun that promoted would pin the boundary to the message it is
  // REPLACING, so the clone's carry-over would start reading as original.
  assert.equal(log.firstOriginalMessageId, null, 'still pending');
  assert.equal(log.firstOriginalIsNext, true, 'the flag survives for the next real send');
});

test('continue: a command does NOT resolve the boundary', async () => {
  const r = rig(pendingLog(), 'MORE', { newId: counting() });
  const res = await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);

  assert.equal(res.ok, true);
  const log = lastSave(r);
  assert.equal(log.firstOriginalMessageId, null, 'still pending');
  assert.equal(log.firstOriginalIsNext, true);
});

// ── never POST a blank turn (REPORTED 2026-11-01, トカゲくん) ─────────────────
//
// "Pressing Run now sends an empty message to the model." Two separate ways
// this file could do that, and neither had a test:
//
//   · a rerun whose target is a USER message. `slice(0, idx)` means
//     "everything in front of the target", which for a user message is a
//     history with nothing in it — AND it drops that message from the save.
//   · a send batch where no item carried text. composeBatch answers
//     `text: ''`, which used to be wrapped in a user message and posted.
//
// An empty user turn is a real request: billed, answered, and stored as a
// blank bubble nobody typed.

test('rerun: REFUSES a user target instead of posting an empty history', async () => {
  const log = {
    id: 'c1', updatedAt: 5, aiName: 'Local',
    // The shape a STOPPED turn leaves behind: the user message saved with no
    // reply, so it is both last and a user message.
    messages: [{ id: 'u1', role: 'user', content: 'question' }],
  };
  const r = rig(log);
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'u1' })], r.deps);

  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /cannot rerun a user message/);
  assert.deepEqual(r.bodies, [], 'nothing was sent to a model');
  assert.deepEqual(r.saves, [], 'and the sender’s own message was not deleted');
  // Consumed: the target cannot stop being a user message, so abandoning it
  // would let the auto-trigger re-fire it forever.
  assert.deepEqual(res.consumedIds, ['item-1']);
});

test('send: REFUSES a batch that carried no text and no attachments', async () => {
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', messages: [] };
  const r = rig(log);
  // `letter` is a declared-but-unproduced kind: its payload has no `text`, so
  // composeBatch skips it and answers with the empty string.
  const res = await runTurnForQueue(
    'Default', 'c1',
    [item('user_message', { ref: 'x.md' }, 'item-9')],
    r.deps,
  );

  assert.equal(res.ok, false);
  assert.match((res as { reason: string }).reason, /nothing to send/);
  assert.deepEqual(r.bodies, [], 'no model call');
  assert.deepEqual(r.saves, [], 'no blank bubble on disk');
  assert.deepEqual(res.consumedIds, ['item-9'], 'nothing here will ever become runnable');
});

test('send: an ATTACHMENT with no caption is still a message', async () => {
  // The guard must not be "text is empty" alone. An image someone sent with
  // nothing typed is a turn, and refusing it would lose it.
  const log = { id: 'c1', updatedAt: 5, aiName: 'Local', messages: [] };
  const r = rig(log, 'I see it');
  const res = await runTurnForQueue(
    'Default', 'c1',
    [item('user_message', { text: '   ', attachments: [{ name: 'a.png' }] })],
    r.deps,
  );

  assert.equal(res.ok, true);
  assert.equal(r.bodies.length, 1, 'it was sent');
  const msgs = saved(r);
  assert.equal(msgs[0].role, 'user');
  assert.deepEqual(msgs[0].attachments, [{ name: 'a.png' }]);
});
