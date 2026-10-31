/**
 * `turn_plan` — the frame that tells a WATCHING tab where to paint (2026-10-31).
 *
 * MEASURED by ふわふわ: two tabs on one conversation, send from the left. The
 * right tab showed a cross-tab warning and no content whatsoever, and only
 * matched after a reload. It had no way to know three things a kicking tab
 * knows for free — which message the reply lands in, that a rerun just threw
 * the visible answer away, and what the person actually sent (the queue API
 * reports labels and never bodies).
 *
 * What is at risk, and therefore what these tests are for:
 *
 *   · a plan with NO assistantId reaching a painter — "which bubble" would
 *     fall back to "some bubble", and the house rule is that it must not.
 *   · the plan arriving AFTER the first text — a watcher would then paint
 *     nothing for the first chunks, and a continue would blank the half that
 *     already exists.
 *   · a continue announced with an EMPTY seed — same erasure, for the same
 *     reason the kicking tab carries a WatchTarget.
 *   · a rerun that does not announce its discarded target — the old answer
 *     sits above the new one for a whole generation.
 *   · a HANDOFF second pass that is not announced — the new vessel's answer
 *     is painted into the old vessel's message. This is why the announcement
 *     lives inside runPass and not once before the chain.
 *   · the sink method list going stale — runnerSink's own header claims "the
 *     test parses the interface rather than trusting this", and until today
 *     no such test existed. That claim is now true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normaliseTurnPlan } from '@/lib/turnEvents';
import { applyTurnEvent } from '@/lib/turnEventReducer';
import { SINK_METHODS, createRunnerSink, createTurnFlags } from '@/lib/runnerSink';
import { createTurnAccState } from '@/lib/turnAccState';
import { recordingSink } from '../_helpers/turnHarness';
import { runTurnForQueue, type RunTurnDeps } from '@/lib/runTurnForQueue';
import type { QueueItem } from '@/lib/turnQueue';

// ── the normaliser ───────────────────────────────────────────────────────────

test('no assistantId means no plan at all', () => {
  // Without this the caller gets a plan whose destination is the empty string,
  // and "paint into id ''" is indistinguishable from "paint into nothing"
  // only by luck (no message has that id). null makes the absence explicit.
  assert.equal(normaliseTurnPlan({ type: 'turn_plan' }), null);
  assert.equal(normaliseTurnPlan({ assistantId: '' }), null);
  assert.equal(normaliseTurnPlan({ assistantId: 42 }), null);
});

test('missing fields become empty, never undefined', () => {
  const p = normaliseTurnPlan({ assistantId: 'a9' });
  assert.ok(p);
  // A watcher assigns continuedSeed straight into acc.currentText. `undefined`
  // there renders as the text "undefined" in the bubble.
  assert.equal(p.continuedSeed, '');
  assert.equal(p.continuedThought, '');
  assert.deepEqual(p.continuedBlocks, []);
  assert.equal(p.dropId, null);
  assert.equal(p.user, null);
});

test('an ARRAY is not a user message', () => {
  // `typeof [] === 'object'`, so the obvious guard accepts an array and the
  // watcher spreads it into a message with numeric keys and no id.
  assert.equal(normaliseTurnPlan({ assistantId: 'a', user: [] })?.user, null);
  assert.equal(normaliseTurnPlan({ assistantId: 'a', user: 'x' })?.user, null);
  const ok = normaliseTurnPlan({ assistantId: 'a', user: { id: 'u9' } });
  assert.deepEqual(ok?.user, { id: 'u9' });
});

// ── the reducer branch ───────────────────────────────────────────────────────

const deps = { t: (k: string) => k, settings: {}, newAttachmentId: () => 'att' };
const freshAcc = () => createTurnAccState({ continuedSeed: '', continuedThought: '', continuedBlocks: [], notices: [] });

test('a turn_plan frame reaches the sink, and nothing else', () => {
  const acc = freshAcc();
  const flags = createTurnFlags();
  const { sink, calls } = recordingSink();
  applyTurnEvent(
    { type: 'turn_plan', assistantId: 'a9', dropId: 'a1' },
    acc, flags, sink, deps,
  );
  assert.deepEqual(calls.map(c => c.m), ['turnPlan']);
  assert.deepEqual(calls[0].a, {
    assistantId: 'a9', dropId: 'a1', user: null,
    continuedSeed: '', continuedThought: '', continuedBlocks: [],
  });
  // Display-only: dropping the frame must not change anything that gets saved.
  assert.equal(acc.currentText, '');
  assert.equal(acc.notices.length, 0);
});

test('a destinationless plan notifies nobody', () => {
  const { sink, calls } = recordingSink();
  applyTurnEvent({ type: 'turn_plan' }, freshAcc(), createTurnFlags(), sink, deps);
  assert.deepEqual(calls, []);
});

// ── the sink list, which runnerSink's header promised was checked ────────────

test('SINK_METHODS matches the interface text AND the runner implementation', () => {
  const src = readFileSync('src/lib/turnEventReducer.ts', 'utf-8');
  const body = src.slice(src.indexOf('export interface TurnEventSink'));
  const iface = body.slice(0, body.indexOf('\n}'));
  // Method signatures only: `name(args): void;` at one indent level. Comments
  // and prose cannot match because of the required parenthesis.
  const declared = [...iface.matchAll(/^ {2}([a-zA-Z]\w*)\(/gm)].map(m => m[1]);
  assert.ok(declared.length >= 14, `parsed ${declared.length} methods — the regex, not the interface`);
  assert.deepEqual([...declared].sort(), [...SINK_METHODS].sort(), 'interface vs SINK_METHODS');
  const impl = Object.keys(createRunnerSink()).filter(k => k !== 'report');
  assert.deepEqual(impl.sort(), [...SINK_METHODS].sort(), 'SINK_METHODS vs runnerSink');
});

// ── what the runner actually publishes ───────────────────────────────────────

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

function item(kind: string, payload: unknown): QueueItem {
  return { id: 'i1', at: 1000, kind, from: 'Cairn', payload } as unknown as QueueItem;
}

/**
 * Records the published frames AND how many posts had happened when each
 * arrived, because "the plan is published before the request" is an ORDERING
 * claim and a list of frames cannot express it.
 */
function rig(log: Record<string, unknown>, passes: string[][]) {
  const published: Array<{ text: string; postsSoFar: number }> = [];
  let posts = 0;
  let minted = 0;
  let disk = typeof log.updatedAt === 'number' ? (log.updatedAt as number) : 0;
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c, logData, opts) => {
      if (opts?.expectedUpdatedAt !== undefined && opts.expectedUpdatedAt !== disk) {
        return { ok: false, conflict: { diskUpdatedAt: disk } };
      }
      disk += 1;
      (logData as Record<string, unknown>).updatedAt = disk;
      return { ok: true, writtenUpdatedAt: disk };
    },
    chatPost: async () => {
      const frames = passes[posts];
      if (!frames) throw new Error(`unexpected pass ${posts + 1}`);
      posts += 1;
      return { ok: true, status: 200, body: bodyOf(frames) } as unknown as Response;
    },
    globalSettings: {},
    enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: '', modelParams: {} },
    newId: () => `minted-${++minted}`,
    nowMs: () => 7000,
    clientId: 'runner:test',
    origin: 'http://localhost:3000',
    injectTurnId: 'turn_test',
    onRawText: (text) => { published.push({ text, postsSoFar: posts }); },
  };
  return { deps, published };
}

/** The decoded turn_plan announcements, in order. */
const plans = (r: { published: Array<{ text: string; postsSoFar: number }> }) =>
  r.published
    .map(p => ({ ...p, obj: JSON.parse(p.text.replace(/^data: /, '').trim()) as Record<string, unknown> }))
    .filter(p => p.obj.type === 'turn_plan');

const twoTurn = () => ({
  id: 'c1', updatedAt: 5, aiName: 'Local',
  messages: [
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'a1', role: 'assistant', content: 'HALF', thoughtProcess: 'FIRST-THINKING' },
  ],
});

test('send: announced BEFORE the request, carrying the composed user message', async () => {
  const r = rig({ id: 'c1', updatedAt: 5, aiName: 'Local', messages: [] }, [[frame({ type: 'text', content: 'hi' })]]);
  await runTurnForQueue('Default', 'c1', [item('user_message', { text: 'hello' })], r.deps);

  const p = plans(r);
  assert.equal(p.length, 1);
  // THE ordering claim. A plan that arrives after the first post can arrive
  // after the first text, and then a watcher has already missed its cue.
  assert.equal(p[0].postsSoFar, 0, 'published before the provider was called');
  const user = p[0].obj.user as Record<string, unknown>;
  assert.equal(user.content, 'hello', 'the body the queue API refuses to report');
  assert.ok(user.id, 'with the id the saved message will carry');
  assert.equal(p[0].obj.dropId, null, 'a send discards nothing');
  assert.equal(p[0].obj.continuedSeed, '');
});

test('rerun: names the answer being thrown away', async () => {
  const r = rig(twoTurn(), [[frame({ type: 'text', content: 'TAIL' })]]);
  await runTurnForQueue('Default', 'c1', [item('rerun', { targetMsgId: 'a1' })], r.deps);

  const p = plans(r);
  assert.equal(p.length, 1);
  assert.equal(p[0].obj.dropId, 'a1', 'without this the old answer stays on screen');
  assert.notEqual(p[0].obj.assistantId, 'a1', 'a rerun writes a NEW message');
  assert.equal(p[0].obj.user, null, 'a rerun mints no user turn');
  assert.equal(p[0].obj.continuedSeed, '', 'and starts from nothing');
});

test('continue: the target id, with its text and its thinking', async () => {
  const r = rig(twoTurn(), [[frame({ type: 'text', content: 'TAIL' })]]);
  await runTurnForQueue('Default', 'c1', [item('continue', { targetMsgId: 'a1' })], r.deps);

  const p = plans(r);
  assert.equal(p.length, 1);
  assert.equal(p[0].obj.assistantId, 'a1', 'paint into the message already on screen');
  assert.equal(p[0].obj.dropId, null, 'a continue discards nothing');
  // Both halves of the erasure this seed prevents: every flush REPLACES
  // content and thoughtProcess, so an unseeded watcher blanks the first half
  // on the continuation's first chunk.
  assert.equal(p[0].obj.continuedSeed, 'HALF');
  assert.equal(p[0].obj.continuedThought, 'FIRST-THINKING');
});

test('a handoff announces its SECOND pass too', async () => {
  const handoff = frame({
    type: 'model_handoff', family: 'Gemini', specificModel: 'gemini-4-argon',
    label: 'Gemini 4 Argon', thinking: true, note: 'over to you',
    fromFamily: 'Local', fromSpecificModel: 'gemma-4', fromLabel: 'Local Gemma',
  });
  const r = rig({ id: 'c1', updatedAt: 5, aiName: 'Local', messages: [] }, [
    [handoff],
    [frame({ type: 'text', content: '42' })],
  ]);
  await runTurnForQueue('Default', 'c1', [item('user_message', { text: 'ask' })], r.deps);

  const p = plans(r);
  // Two announcements, because a handoff saves TWO messages. One would leave a
  // watcher painting the new vessel's answer into the old vessel's bubble.
  assert.equal(p.length, 2, 'one per pass');
  assert.notEqual(p[1].obj.assistantId, p[0].obj.assistantId, 'a different bubble');
  assert.equal(p[1].postsSoFar, 1, 'published before the SECOND request');
  // The first pass owns the user message and the discard; a later pass must
  // not re-announce either, or a watcher would append the sent text twice.
  assert.equal(p[1].obj.user, null);
  assert.equal(p[1].obj.dropId, null);
});
