/**
 * The runner reports an interjection that never reached the entity.
 *
 * An interjection can only be handed over at a tool-call boundary. A turn that
 * calls no tool after one arrives has nowhere to put it, and the entry used to
 * be dropped in silence — `clearInjections` on the OAuth path, the 15-minute
 * prune on the others. The sender could not tell "delivered" from "lost".
 *
 * Reported here rather than enqueued before each stream close ON PURPOSE: there
 * are eleven stream exits across five provider paths in the chat route, and a
 * rule that must be re-applied at eleven sites will be three-quarters applied
 * the next time a path is added. The runner has ONE last save per turn, and
 * every provider path goes through it.
 *
 * The notice channel, not the body: `notices` is outside buildSlimHistory's
 * allowlist, so this reaches the reader and never reaches the model. Telling
 * the entity "a message you never received was lost" would be an instruction
 * about something it cannot see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';
import type { DrainedInjection } from '@/lib/injectMessage';

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

/** A reader that delivers frames and then aborts — a Stop pressed mid-reply. */
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

const handoffFrame = () => frame({
  type: 'model_handoff',
  family: 'Gemini',
  specificModel: 'gemini-4-argon',
  label: 'Gemini 4 Argon',
  thinking: true,
  note: 'over to you',
  fromFamily: 'Local',
  fromSpecificModel: 'gemma-4',
  fromLabel: 'Local Gemma',
});

function items(text: string): QueueItem[] {
  return [{
    id: 'item-1', at: 1000, kind: 'user_message', from: 'Cairn',
    payload: { text, attachments: [] },
  } as unknown as QueueItem];
}

interface Rig { deps: RunTurnDeps; saves: Array<Record<string, unknown>>; asked: string[] }

function deps(over: Partial<RunTurnDeps>, left?: DrainedInjection): Rig {
  const saves: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const base: RunTurnDeps = {
    loadLog: async () => ({ id: 'c1', messages: [], aiName: 'Local', updatedAt: 5 }),
    saveLog: async (_c, logData) => { saves.push(logData); return { ok: true }; },
    chatPost: async () => ({ ok: true, status: 200, body: bodyOf([frame({ type: 'text', content: 'hi' })]) } as unknown as Response),
    globalSettings: { language: 'ja' },
    enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: '', modelParams: {} },
    newId: () => 'new-id',
    nowMs: () => 2000,
    clientId: 'runner:test',
    origin: 'http://localhost:3000',
    injectTurnId: 'turn_test',
    takeUndelivered: (id) => {
      asked.push(id);
      // Destructive in the real store; mimic that so a second read is empty.
      const out = left ?? { texts: [], media: [] };
      left = { texts: [], media: [] };
      return out;
    },
    ...over,
  };
  return { deps: base, saves, asked };
}

function lastReply(saves: Array<Record<string, unknown>>): Record<string, unknown> {
  const msgs = (saves[saves.length - 1].messages as Array<Record<string, unknown>>);
  return msgs[msgs.length - 1];
}

test('a successful turn carries the undelivered notice on its reply', async () => {
  const rig = deps({}, { texts: ['3000のタブを閉じて'], media: [] });
  await runTurnForQueue('Default', 'c1', items('hello'), rig.deps);

  const reply = lastReply(rig.saves);
  const notices = reply.notices as string[];
  assert.ok(Array.isArray(notices), 'the reply should carry notices');
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes('3000のタブを閉じて'), notices[0]);
  // Asked once, with the turn's own id.
  assert.deepEqual(rig.asked, ['turn_test']);
});

test('a delivered (empty) set adds no notice at all', async () => {
  // The common case. A turn with nothing left over must look exactly as it did
  // before this feature existed.
  const rig = deps({});
  await runTurnForQueue('Default', 'c1', items('hello'), rig.deps);
  assert.equal(lastReply(rig.saves).notices, undefined);
});

test('a STOPPED turn reports it — the case most likely to have one', async () => {
  // The tool boundary the note would have ridden on never came, because the
  // turn was cut short.
  const rig = deps({
    chatPost: async () => ({
      ok: true, status: 200,
      body: partialThenAbort([frame({ type: 'text', content: 'half' })]),
    } as unknown as Response),
    wasStopped: () => true,
  }, { texts: ['やめて'], media: [] });

  const r = await runTurnForQueue('Default', 'c1', items('go'), rig.deps);
  if (r.ok) assert.fail('expected the stop to report a failure result');
  assert.equal(r.stage, 'stopped');

  const notices = lastReply(rig.saves).notices as string[];
  // Two notices: the stop explanation that already existed, and this one.
  assert.ok(notices.some((n) => n.includes('やめて')), JSON.stringify(notices));
  assert.ok(notices.some((n) => n.includes('停止')), JSON.stringify(notices));
});

test('a FAILED turn reports it too', async () => {
  const rig = deps({
    chatPost: async () => ({ ok: false, status: 503, body: null } as unknown as Response),
  }, { texts: ['まだ見てる？'], media: [] });

  await runTurnForQueue('Default', 'c1', items('go'), rig.deps);
  const notices = lastReply(rig.saves).notices as string[];
  assert.ok(notices.some((n) => n.includes('まだ見てる？')), JSON.stringify(notices));
});

test('a HANDOFF pass does NOT take the note — the next vessel may still deliver it', async () => {
  // THE line that keeps this from reporting a false loss. The first pass is
  // not the end of the turn; the vessel taking over has its own first tool
  // boundary, and taking the note here would report it lost moments before it
  // arrived.
  let posts = 0;
  const rig = deps({
    chatPost: async () => {
      posts += 1;
      return posts === 1
        ? ({ ok: true, status: 200, body: bodyOf([handoffFrame(), frame({ type: 'text', content: 'over' })]) } as unknown as Response)
        : ({ ok: true, status: 200, body: bodyOf([frame({ type: 'text', content: 'second vessel' })]) } as unknown as Response);
    },
  }, { texts: ['途中のメモ'], media: [] });

  await runTurnForQueue('Default', 'c1', items('switch please'), rig.deps);

  assert.equal(posts, 2, 'the handoff should have produced a second pass');
  // Asked exactly once across the whole turn, not once per pass.
  assert.deepEqual(rig.asked, ['turn_test']);

  const msgs = rig.saves[rig.saves.length - 1].messages as Array<Record<string, unknown>>;
  const handing = msgs[msgs.length - 2];
  const second = msgs[msgs.length - 1];
  assert.equal(handing.notices, undefined, 'the handing-over reply must not carry it');
  assert.ok((second.notices as string[]).some((n) => n.includes('途中のメモ')), 'the LAST reply carries it');
});

test('a reporter that throws does not cost the reply', async () => {
  // A generated answer must never be lost over a warning about a lost one.
  const rig = deps({
    takeUndelivered: () => { throw new Error('store exploded'); },
  });
  const r = await runTurnForQueue('Default', 'c1', items('hello'), rig.deps);
  assert.equal(r.ok, true);
  assert.equal(lastReply(rig.saves).content, 'hi');
});

test('no reporter at all behaves exactly as before', async () => {
  // `takeUndelivered` is optional so a test — or a caller that has not been
  // wired yet — keeps the old behaviour instead of crashing.
  const rig = deps({ takeUndelivered: undefined });
  const r = await runTurnForQueue('Default', 'c1', items('hello'), rig.deps);
  assert.equal(r.ok, true);
  assert.equal(lastReply(rig.saves).notices, undefined);
});

test('the notice is in the language of the installation', async () => {
  const rig = deps({ globalSettings: { language: 'en' } }, { texts: ['check this'], media: [] });
  await runTurnForQueue('Default', 'c1', items('hello'), rig.deps);
  const notices = lastReply(rig.saves).notices as string[];
  assert.ok(notices[0].includes('tool-call boundary'), notices[0]);
});
