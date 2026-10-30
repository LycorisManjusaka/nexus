/**
 * WHO NAMES THE ASSISTANT MESSAGE (2026-10-31).
 *
 * ChatArea paints a placeholder, streams the relay into it, and reloads from
 * disk when the relay closes. The list renders `key={msg.id}`. So if the id
 * the runner saves differs from the id the tab streamed into, that reload
 * unmounts the streaming bubble and mounts a new one.
 *
 * MEASURED 2026-10-31 — what actually breaks when it remounts: streaming TTS
 * keeps its processed offset, its ordered audio slots and its in-flight
 * synthesis fetches in that component's refs. A long reply therefore stops
 * being spoken partway through, and nothing reports an error anywhere. Tsuyo
 * saw it as "lines get skipped".
 *
 * So `proposedAssistantId` exists, and these are the ways it can go wrong:
 *
 *   · NOT ADOPTED — the remount is back and TTS dies again. Invisible in a
 *     screenshot; the text is correct either way.
 *   · ADOPTED WHEN IT COLLIDES with a message already in the log — two
 *     messages share one id, which breaks dedupe, rerun's "is the target
 *     last" check, and every edit-by-id path at once. Strictly worse than
 *     the remount it was meant to avoid.
 *   · ADOPTED ON THE SECOND PASS of a handoff — the new vessel's answer would
 *     overwrite the first vessel's, so a handoff would save one message where
 *     two were produced, and billing would lose a pass.
 *   · ADOPTED FOR A CONTINUE — a continue extends an existing message and
 *     must keep ITS id; taking the caller's would rename the message the tab
 *     is already looking at.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

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

const say = (text: string) => [frame({ type: 'text', content: text })];
const handoffThen = (text: string) => [
  frame({
    type: 'model_handoff',
    family: 'Local', specificModel: 'gemma-4-12b', label: 'Gemma 12B', thinking: false,
    note: 'your turn', fromFamily: 'Local', fromSpecificModel: 'gemma-4-26b', fromLabel: 'Gemma 26B',
  }),
  frame({ type: 'text', content: text }),
];

function item(kind: 'rerun' | 'continue' | 'user_message', payload: unknown): QueueItem {
  return { id: 'item-1', at: 1000, kind, from: 'Cairn', payload } as unknown as QueueItem;
}

interface Rig {
  deps: RunTurnDeps;
  saves: Array<Record<string, unknown>>;
}

/**
 * `passes` is per-POST so a handoff can be expressed. The saveLog fake
 * enforces the optimistic lock for the same reason the handoff suite's does:
 * a fixture that drops a constraint the real callee has is a different
 * callee, and the tests would describe that one instead.
 */
function rig(log: Record<string, unknown>, passes: string[][], over: Partial<RunTurnDeps> = {}): Rig {
  const saves: Array<Record<string, unknown>> = [];
  let n = 0;
  let minted = 0;
  let disk = typeof log.updatedAt === 'number' ? (log.updatedAt as number) : 0;
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c, logData, opts) => {
      const expected = opts?.expectedUpdatedAt;
      if (typeof expected === 'number' && expected !== disk) {
        return { ok: false, conflict: { from: 'runner', by: 'runner' } };
      }
      disk += 1;
      saves.push(logData);
      return { ok: true, writtenUpdatedAt: disk };
    },
    chatPost: async () => {
      const frames = passes[n++];
      if (!frames) throw new Error(`unexpected POST #${n}`);
      return { ok: true, status: 200, body: bodyOf(frames) } as unknown as Response;
    },
    globalSettings: {},
    enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: 'gemma-4-26b', modelParams: {} },
    newId: () => `minted-${++minted}`,
    nowMs: () => 7000,
    clientId: 'runner:test',
    origin: 'http://localhost:3000',
    injectTurnId: 'turn_test',
    ...over,
  };
  return { deps, saves };
}

type Msg = { id: string; role: string; content: string };
/** The LAST save is the authority: a handoff saves once per pass. */
const finalMessages = (r: Rig) => r.saves[r.saves.length - 1].messages as Msg[];

const oneTurn = () => ({
  id: 'c1', updatedAt: 5, aiName: 'Local',
  messages: [{ id: 'u1', role: 'user', content: 'question' }],
});
const twoTurn = () => ({
  id: 'c1', updatedAt: 5, aiName: 'Local',
  messages: [
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'a1', role: 'assistant', content: 'HALF' },
  ],
});

// ── adoption ─────────────────────────────────────────────────────────────────

test('send: the caller-proposed id becomes the saved reply id', async () => {
  const r = rig(oneTurn(), [say('hello')], { proposedAssistantId: 'tab-painted-this' });
  const res = await runTurnForQueue(
    'Default', 'c1',
    [item('user_message', { text: 'hi' })],
    r.deps,
  );
  assert.equal(res.ok, true);
  const m = finalMessages(r);
  const reply = m[m.length - 1];
  assert.equal(reply.role, 'assistant');
  // Without adoption this is `minted-N` — same text, same everything else,
  // and the tab's bubble remounts.
  assert.equal(reply.id, 'tab-painted-this');
});

test('rerun: the caller-proposed id becomes the saved reply id', async () => {
  const r = rig(twoTurn(), [say('again')], { proposedAssistantId: 'tab-painted-this' });
  const res = await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);
  assert.equal(res.ok, true);
  const m = finalMessages(r);
  assert.equal(m.length, 2, 'rerun replaces, so still user + one answer');
  assert.equal(m[1].id, 'tab-painted-this');
  assert.notEqual(m[1].id, 'a1', 'still a NEW message, not an edit of the old one');
});

test('no proposal: the runner mints its own id', async () => {
  const r = rig(oneTurn(), [say('hello')]);
  await runTurnForQueue('Default', 'c1', [item('user_message', { text: 'hi' })], r.deps);
  const m = finalMessages(r);
  // `minted-1` is the user turn, `minted-2` the reply — the queue path with no
  // tab behind it (auto-trigger, letters, a sweep) must still work.
  assert.equal(m[m.length - 1].id, 'minted-2');
});

test('empty proposal is treated as no proposal', async () => {
  const r = rig(oneTurn(), [say('hello')], { proposedAssistantId: '' });
  await runTurnForQueue('Default', 'c1', [item('user_message', { text: 'hi' })], r.deps);
  assert.equal(finalMessages(r).pop()!.id, 'minted-2');
});

// ── refusal ──────────────────────────────────────────────────────────────────

test('a proposal that COLLIDES with a message already in the log is refused', async () => {
  // 'u1' is in the log. Adopting it would put two messages under one id.
  const r = rig(oneTurn(), [say('hello')], { proposedAssistantId: 'u1' });
  const res = await runTurnForQueue('Default', 'c1', [item('user_message', { text: 'hi' })], r.deps);
  assert.equal(res.ok, true);
  const m = finalMessages(r);
  const ids = m.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'every id in the log is distinct');
  assert.notEqual(m[m.length - 1].id, 'u1');
});

test('continue keeps the TARGET id and ignores the proposal', async () => {
  const r = rig(twoTurn(), [say(' and the rest')], { proposedAssistantId: 'tab-painted-this' });
  const res = await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);
  assert.equal(res.ok, true);
  const m = finalMessages(r);
  assert.equal(m.length, 2, 'extended in place, not appended');
  assert.equal(m[1].id, 'a1', 'the message the tab is already looking at keeps its name');
  assert.equal(m[1].content, 'HALF and the rest');
});

test('a handoff adopts the proposal for pass ONE only', async () => {
  const r = rig(
    oneTurn(),
    [handoffThen('passing this on'), say('42')],
    { proposedAssistantId: 'tab-painted-this' },
  );
  const res = await runTurnForQueue('Default', 'c1', [item('user_message', { text: 'hi' })], r.deps);
  assert.equal(res.ok, true);

  const m = finalMessages(r);
  const replies = m.filter((x) => x.role === 'assistant');
  // TWO answers: one per vessel. If pass two also took the proposed id it
  // would overwrite pass one, and a handoff would save one message where two
  // were produced.
  assert.equal(replies.length, 2, 'one message per vessel');
  assert.equal(replies[0].id, 'tab-painted-this');
  assert.notEqual(replies[1].id, 'tab-painted-this');
  assert.equal(replies[1].content, '42');
});
