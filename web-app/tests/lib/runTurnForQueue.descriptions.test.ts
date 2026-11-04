/**
 * END-TO-END: DOES A DESCRIPTION ANNOUNCED ON THE WIRE REACH THE DISK? (2026-11-04)
 *
 * `applyDescriptions` has unit tests, and every link of the chain reads
 * correctly: the route pushes `attachment_described` into `senseEvents`, every
 * provider branch flushes them at stream start, `turnStreamLoop` parses each
 * frame, `applyTurnEvent` routes this type to `sink.attachmentDescribed`, the
 * runner sink collects into the array `saveMessages` applies.
 *
 * And after shipping that chain, 津代 measured ZERO stored descriptions across
 * 79 attachments on a conversation saved by the new code. Reading the chain a
 * second time cannot distinguish "the runner never collected it" from "the
 * runner stored it and something later overwrote it" — both leave the same
 * zero. This suite answers the first half in-process, so the second half is
 * the only place left to look.
 *
 * Deliberately NOT a unit test of the pure function: the thing in doubt is the
 * wiring between four modules, which is exactly what a unit test per module
 * cannot see.
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

/** The exact shape `api/chat/route.ts` pushes for the eyes bridge. */
const described = (over: Record<string, unknown> = {}) => frame({
  type: 'attachment_described',
  messageId: 'u1',
  attachmentId: 'att-1',
  attachmentName: 'photo.jpg',
  kind: 'eyes',
  model: 'gemini-3.5-flash-lite',
  description: 'A cat girl on a rooftop at night.',
  fromCache: true,
  generatedAt: 1234,
  ...over,
});

function item(payload: unknown): QueueItem {
  return { id: 'item-1', at: 1000, kind: 'user_message', from: 'Cairn', payload } as unknown as QueueItem;
}

interface Rig { deps: RunTurnDeps; saves: Array<Record<string, unknown>> }

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

type Att = Record<string, unknown>;
type Msg = { id: string; role: string; content: string; attachments?: Att[] };
const finalMessages = (r: Rig) => r.saves[r.saves.length - 1].messages as Msg[];

/** One past message carrying one image, as a log holds it after externalisation. */
const withPastImage = () => ({
  id: 'c1', updatedAt: 5, aiName: 'Local',
  messages: [
    {
      id: 'u1', role: 'user', content: 'look at this',
      attachments: [{ id: 'att-1', name: 'photo.jpg', ref: 'ab/cd.jpg', isImage: true, type: 'image/jpeg' }],
    },
  ],
});

test('a described attachment on an EARLIER message is stored by the save', async () => {
  const r = rig(withPastImage(), [[described(), frame({ type: 'text', content: 'I see her' })]]);
  const res = await runTurnForQueue('Cairn', 'c1', [item({ text: 'hi' })], r.deps);
  assert.equal(res.ok, true);

  const m = finalMessages(r);
  const att = m.find((x) => x.id === 'u1')!.attachments![0];
  assert.equal(att.description, 'A cat girl on a rooftop at night.');
  assert.equal(att.descriptionModel, 'gemini-3.5-flash-lite');
  assert.equal(att.descriptionKind, 'eyes');
});

test('the runner reports how many it applied', async () => {
  const r = rig(withPastImage(), [[described(), frame({ type: 'text', content: 'ok' })]]);
  const res = await runTurnForQueue('Cairn', 'c1', [item({ text: 'hi' })], r.deps);
  assert.equal(res.ok, true);
  // The number is the count COLLECTED, which is what distinguishes "nothing
  // arrived" from "something arrived and matched nothing".
  assert.equal((res as { describedAttachments?: number }).describedAttachments, 1);
});

test('a frame naming an attachment that is not here changes nothing and still reports', async () => {
  const r = rig(withPastImage(), [[described({ attachmentId: 'gone' }), frame({ type: 'text', content: 'ok' })]]);
  const res = await runTurnForQueue('Cairn', 'c1', [item({ text: 'hi' })], r.deps);
  assert.equal(res.ok, true);
  const att = finalMessages(r).find((x) => x.id === 'u1')!.attachments![0];
  assert.equal(att.description, undefined, 'no cross-assignment');
  assert.equal((res as { describedAttachments?: number }).describedAttachments, 1, 'arrival is still counted');
});

test('a failed bridge stores the error and NOT the placeholder as a description', async () => {
  const r = rig(withPastImage(), [[
    described({ description: '[image — could not describe it: 429]', error: '429 rate limited' }),
    frame({ type: 'text', content: 'ok' }),
  ]]);
  const res = await runTurnForQueue('Cairn', 'c1', [item({ text: 'hi' })], r.deps);
  assert.equal(res.ok, true);
  const att = finalMessages(r).find((x) => x.id === 'u1')!.attachments![0];
  assert.equal(att.description, undefined, 'one transient 429 must not become permanent');
  assert.equal(att.descriptionError, '429 rate limited', 'but the failure stays visible');
});
