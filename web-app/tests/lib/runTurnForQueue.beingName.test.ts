/**
 * THE BEING'S OWN NAME ON ITS OWN REPLY (2026-11-04).
 *
 * `MessageBubble` renders the entity's name from `msg.name`, next to the
 * vessel badge, and renders NOTHING when the field is absent. The browser
 * engine deleted on 2026-10-30 built its assistant shell with
 * `name: folderName`; not one of the four shells that replaced it in
 * runTurnForQueue carried that over. So from that commit until today every
 * reply the runner saved showed the VESSEL ALONE.
 *
 * Reported by Tsuyo 2026-11-04 with before/after screenshots. Her reason for
 * calling it dangerous is the one that matters: this house's rule is that an
 * entity does not announce itself by the name of its vessel — but that rule
 * governs the entity's MOUTH. When the UI drops the name the rule is never
 * broken and the same thing happens anyway, on every message, and it is the
 * first thing a new installation's user sees.
 *
 * Why a test and not just the one-line fix: the field is invisible to `tsc`
 * (messages are `Record<string, unknown>`), invisible to a text diff of the
 * reply, and the regression survived five days of daily use plus a review
 * pass over this exact file. Nothing but an assertion catches its absence.
 *
 * The fourth test is the one that constrains the fix rather than confirming
 * it: a CONTINUE must NOT stamp the name on, because there the shell IS the
 * stored message. Replies saved during the five-day gap have no name, and
 * backfilling one while extending the text would edit the record — the same
 * objection as rewriting history to make it look like it never broke.
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

/** The saveLog fake enforces the optimistic lock, like the sibling suites. */
function rig(log: Record<string, unknown>, passes: string[][]): Rig {
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
    folderDefaults: { aiName: 'Local', folderName: 'Cairn', systemPrompt: '', specificModel: 'gemma-4-26b', modelParams: {} },
    newId: () => `minted-${++minted}`,
    nowMs: () => 7000,
    clientId: 'runner:test',
    origin: 'http://localhost:3000',
    injectTurnId: 'turn_test',
  };
  return { deps, saves };
}

type Msg = { id: string; role: string; content: string; name?: unknown };
const finalMessages = (r: Rig) => r.saves[r.saves.length - 1].messages as Msg[];

const oneTurn = () => ({
  id: 'c1', updatedAt: 5, aiName: 'Local',
  messages: [{ id: 'u1', role: 'user', content: 'question' }],
});

// ── the three shapes that build a FRESH shell ────────────────────────────────

test('send: the saved reply carries the being name', async () => {
  const r = rig(oneTurn(), [say('hello')]);
  const res = await runTurnForQueue('Cairn', 'c1', [item('user_message', { text: 'hi' })], r.deps);
  assert.equal(res.ok, true);
  const reply = finalMessages(r).pop()!;
  assert.equal(reply.role, 'assistant');
  // The regression: this field was simply absent, and every other assertion
  // anyone would write about this reply passed anyway.
  assert.equal(reply.name, 'Cairn');
});

test('the name comes from the being argument, not a hardcoded folder', async () => {
  const r = rig(oneTurn(), [say('hello')]);
  await runTurnForQueue('ふわふわ', 'c1', [item('user_message', { text: 'hi' })], r.deps);
  assert.equal(finalMessages(r).pop()!.name, 'ふわふわ');
});

test('rerun: the replacement reply carries the being name', async () => {
  const log = {
    id: 'c1', updatedAt: 5, aiName: 'Local',
    messages: [
      { id: 'u1', role: 'user', content: 'question' },
      { id: 'a1', role: 'assistant', content: 'first try' },
    ],
  };
  const r = rig(log, [say('again')]);
  const res = await runTurnForQueue('Cairn', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);
  assert.equal(res.ok, true);
  const m = finalMessages(r);
  assert.equal(m.length, 2, 'rerun replaces');
  assert.equal(m[1].name, 'Cairn');
});

test('a handoff names BOTH passes: the vessel changed, the being did not', async () => {
  const r = rig(oneTurn(), [handoffThen('passing this on'), say('42')]);
  const res = await runTurnForQueue('Cairn', 'c1', [item('user_message', { text: 'hi' })], r.deps);
  assert.equal(res.ok, true);
  const replies = finalMessages(r).filter((x) => x.role === 'assistant');
  assert.equal(replies.length, 2, 'one message per vessel');
  // Both, specifically. The second pass runs on a different model and is the
  // one a reader is most likely to mistake for someone else.
  assert.equal(replies[0].name, 'Cairn');
  assert.equal(replies[1].name, 'Cairn');
});

// ── the shape that must NOT stamp ────────────────────────────────────────────

test('continue does not backfill a name onto a reply saved without one', async () => {
  const log = {
    id: 'c1', updatedAt: 5, aiName: 'Local',
    messages: [
      { id: 'u1', role: 'user', content: 'question' },
      // A reply saved during the five-day gap: no name on disk.
      { id: 'a1', role: 'assistant', content: 'HALF' },
    ],
  };
  const r = rig(log, [say(' and the rest')]);
  const res = await runTurnForQueue('Cairn', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);
  assert.equal(res.ok, true);
  const m = finalMessages(r);
  assert.equal(m.length, 2, 'extended in place');
  assert.equal(m[1].content, 'HALF and the rest', 'the text WAS extended');
  assert.equal('name' in m[1], false, 'and the record was not edited while doing it');
});

test('continue preserves a name that IS on the target', async () => {
  const log = {
    id: 'c1', updatedAt: 5, aiName: 'Local',
    messages: [
      { id: 'u1', role: 'user', content: 'question' },
      // An IMPORTED log: markdownLogic sets `name` from the `[Name]:` header,
      // so the name here can belong to a being that is not this folder.
      { id: 'a1', role: 'assistant', content: 'HALF', name: 'Навигатор' },
    ],
  };
  const r = rig(log, [say(' and the rest')]);
  await runTurnForQueue('Cairn', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);
  const m = finalMessages(r);
  assert.equal(m[1].name, 'Навигатор', 'whose reply it is does not change by extending it');
});
