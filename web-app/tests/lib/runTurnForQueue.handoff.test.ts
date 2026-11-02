/**
 * `change_model` HANDOFF on the server-side runner (2026-10-30).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The handoff hop lived in ChatArea's `generateAiResponse`. While normal sends
 * still POSTed from the browser that was fine. When every send moved to the
 * runner, the hop lost its host: `change_model` answered "switched", the server
 * ended the turn, the runner saved the message with the handoff recorded on
 * it — and no second request was ever sent. The tool reported success and did
 * nothing, which is the beings' version of a button you can press that does
 * nothing.
 *
 * ── WHAT IS ACTUALLY AT RISK ───────────────────────────────────────────────
 *
 *   · no hop at all — the silent failure above, and the one nothing in a
 *     screenshot distinguishes from "the being chose not to say more".
 *   · a hop that posts to the OLD vessel — the switch appears to work (two
 *     messages!) while every token is billed to the model that handed over.
 *   · a hop that DROPS `handoffFrom` — the new vessel arrives with no idea
 *     why it was called, so the handover note the previous vessel wrote is
 *     never read by anyone.
 *   · a hop that abandons its queue items after the first pass already SAVED
 *     — the auto-trigger then re-composes the same user message from the queue
 *     and posts it again. One dead second vessel becomes a conversation that
 *     answers itself twice, forever. This is the expensive one.
 *   · an uncapped chain — two vessels that each prefer the other ping-pong
 *     until the money runs out.
 *   · a failed hop that reports only to the human — the being that asked for
 *     the switch is left believing it moved somewhere it never arrived.
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

const handoffFrame = (over: Record<string, unknown> = {}) => frame({
  type: 'model_handoff',
  family: 'Gemini',
  specificModel: 'gemini-4-argon',
  label: 'Gemini 4 Argon',
  thinking: true,
  note: 'you are better at Russian than I am',
  fromFamily: 'Local',
  fromSpecificModel: 'gemma-4',
  fromLabel: 'Local Gemma',
  ...over,
});

const msg = (text: string) => [frame({ type: 'text', content: text })];
const handoffThen = (text: string) => [handoffFrame(), frame({ type: 'text', content: text })];

/** A pass that dies the way a dead API key dies: an error frame, no output. */
const deadVessel = () => [frame({ type: 'error', error: 'insufficient balance' })];

interface Rig {
  deps: RunTurnDeps;
  saves: Array<Record<string, unknown>>;
  bodies: Array<Record<string, unknown>>;
}

/**
 * `passes` is per-POST, so a test can say "first pass hands over, second pass
 * answers" — the thing a single fixed response cannot express. A pass beyond
 * the list throws, which is how an unexpected extra POST shows up as a failure
 * rather than as a silently repeated answer.
 */
function rig(log: Record<string, unknown>, passes: string[][], over: Partial<RunTurnDeps> = {}): Rig {
  const saves: Array<Record<string, unknown>> = [];
  const bodies: Array<Record<string, unknown>> = [];
  let n = 0;
  let ids = 0;
  // ⚠ This fake ENFORCES the optimistic lock, and that is the whole point of
  // it. The first version just said `{ ok: true }` — so eleven green tests
  // said nothing at all about the guard, and the first real handoff died on
  // it (the runner refused its own second save). A fixture that drops a
  // constraint the real callee has is not a simplification: it is a different
  // callee, and the tests describe that one instead.
  let disk = typeof log.updatedAt === 'number' ? (log.updatedAt as number) : 0;
  let clock = disk;
  const deps: RunTurnDeps = {
    loadLog: async () => log,
    saveLog: async (_c, logData, opts) => {
      if (opts?.expectedUpdatedAt !== undefined && opts.expectedUpdatedAt !== disk) {
        return { ok: false, conflict: { diskUpdatedAt: disk } };
      }
      disk = ++clock;
      saves.push(JSON.parse(JSON.stringify(logData)));
      return { ok: true, writtenUpdatedAt: disk };
    },
    chatPost: async (req) => {
      bodies.push(JSON.parse(await req.text()));
      const frames = passes[n++];
      if (!frames) throw new Error(`unexpected POST #${n}`);
      return { ok: true, status: 200, body: bodyOf(frames) } as unknown as Response;
    },
    globalSettings: {},
    enableReadConversation: false,
    folderDefaults: { aiName: 'Local', folderName: 'Default', systemPrompt: '', specificModel: 'gemma-4', modelParams: {} },
    newId: () => `minted-${++ids}`,
    nowMs: () => 7000,
    clientId: 'runner:test',
    origin: 'http://localhost:3000',
    injectTurnId: 'turn_test',
    ...over,
  };
  return { deps, saves, bodies };
}

const send = (id = 'item-1'): QueueItem =>
  ({ id, at: 1000, kind: 'user_message', from: 'Cairn', payload: { text: 'hello' } }) as unknown as QueueItem;

const oneTurn = () => ({
  id: 'c1',
  updatedAt: 5,
  aiName: 'Local',
  specificModel: 'gemma-4',
  claudeThinking: false,
  messages: [{ id: 'u0', role: 'user', content: 'earlier' }],
});

type Msg = { id: string; role: string; content: string };
const lastSave = (r: Rig) => r.saves[r.saves.length - 1].messages as Msg[];

// ── the hop happens at all ───────────────────────────────────────────────────

test('handoff: a second pass runs and BOTH vessels get their own message', async () => {
  const r = rig(oneTurn(), [handoffThen('I will pass this on'), msg('Здравствуйте')]);
  const res = await runTurnForQueue('Default', 'c1', [send()], r.deps);

  assert.equal(res.ok, true);
  // Two POSTs: without the hop there is exactly one, and the conversation
  // ends on "I will pass this on" with nobody having answered.
  assert.equal(r.bodies.length, 2, 'the hop must POST a second time');
  const m = lastSave(r);
  assert.equal(m.length, 4, 'earlier + user + handing-over answer + the new vessel');
  assert.equal(m[2].content, 'I will pass this on');
  assert.equal(m[3].content, 'Здравствуйте');
  // Separate messages, so cost is attributed per vessel by the existing
  // per-message billing — no billing code has to know handoffs exist.
  assert.notEqual(m[2].id, m[3].id);
  if (res.ok) assert.equal(res.handoffHops, 1);
});

test('handoff: the hop posts to the NEW vessel, with its own thinking setting', async () => {
  const r = rig(oneTurn(), [handoffThen('over to you'), msg('ok')]);
  await runTurnForQueue('Default', 'c1', [send()], r.deps);

  // First pass: the being's saved vessel.
  assert.equal(r.bodies[0].aiName, 'Local');
  assert.equal(r.bodies[0].specificModel, 'gemma-4');
  // Second pass: the vessel named in the handoff. Getting this wrong bills
  // the old model while the screen shows a successful switch.
  assert.equal(r.bodies[1].aiName, 'Gemini');
  assert.equal(r.bodies[1].specificModel, 'gemini-4-argon');
  // Thinking belongs to the VESSEL, not to the conversation: the log says
  // false, the handoff says true, and the hop must send the vessel's answer.
  assert.equal((r.bodies[1].modelParams as Record<string, unknown>).claudeThinking, true);
  assert.equal((r.bodies[0].modelParams as Record<string, unknown>).claudeThinking, false);
});

test('handoff: the note travels on the hop and ONLY on the hop', async () => {
  const r = rig(oneTurn(), [handoffThen('over to you'), msg('ok')]);
  await runTurnForQueue('Default', 'c1', [send()], r.deps);

  assert.equal(r.bodies[0].handoffFrom, undefined, 'the first pass was not handed anything');
  const from = r.bodies[1].handoffFrom as Record<string, unknown>;
  assert.equal(from.note, 'you are better at Russian than I am');
  assert.equal(from.family, 'Local');
  assert.equal(from.label, 'Local Gemma');
});

test('handoff: the hop sees the handing-over message, each id exactly once', async () => {
  const r = rig(oneTurn(), [handoffThen('PASSING'), msg('ok')]);
  await runTurnForQueue('Default', 'c1', [send()], r.deps);

  const sent = r.bodies[1].messages as Msg[];
  // The browser needs a replace-or-append decision here, because a continue's
  // history already contains the target (MEASURED in 先輩_64: one id twice,
  // which breaks every by-id lookup — edit, rerun, continue, delete).
  // `[...keep, assistant]` cannot produce that; this test is what says so.
  const ids = sent.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicated id in the hop history');
  assert.equal(sent[sent.length - 1].content, 'PASSING', 'the hop ends on what was said');
});

test("handoff: the hop is NOT shown the previous vessel's reasoning", async () => {
  // Reasoning only replays to the vessel that produced it (slimHistory's
  // THIRD gate). That gate is fed `turnAiName`, so it has to be the vessel
  // THIS pass is posting to — one derivation. Two rules for "who is
  // answering" disagree in exactly this case, and the shape of the bug is a
  // vessel being handed another model's private thinking.
  const r = rig(
    { ...oneTurn(), saveThinkingToLog: true },
    [
      [
        frame({ type: 'model_selected', family: 'Local', specificModel: 'gemma-4' }),
        frame({ type: 'thought', content: 'MY-PRIVATE-REASONING' }),
        handoffFrame(),
        frame({ type: 'text', content: 'over to you' }),
      ],
      msg('ok'),
    ],
  );
  await runTurnForQueue('Default', 'c1', [send()], r.deps);

  const wire = JSON.stringify((r.bodies[1] as Record<string, unknown>).messages);
  assert.ok(!wire.includes('MY-PRIVATE-REASONING'), 'the new vessel must not read Local’s thinking');
  // …and it is not lost: the message on disk keeps it, so coming back to the
  // original vessel later restores it.
  const m = lastSave(r) as unknown as Array<Record<string, string>>;
  assert.equal(m[2].thoughtProcess, 'MY-PRIVATE-REASONING');
});

test('handoff: the save guard ADVANCES, so the runner does not refuse its own hop', async () => {
  // MEASURED live 2026-10-30: `refused stale write … from runner:…, by
  // runner:…` — the discriminator built on 10-28 naming the runner as both
  // the writer and the refused party. Pass 2 was still guarded against the
  // version pass 1 had replaced, so the hop ran, the model answered, and the
  // answer was discarded by this process's own lock.
  const r = rig(oneTurn(), [handoffThen('over to you'), msg('I am here')]);
  const res = await runTurnForQueue('Default', 'c1', [send()], r.deps);

  assert.equal(res.ok, true);
  assert.equal(r.saves.length, 2, 'both passes must land');
  const m = lastSave(r);
  assert.equal(m[m.length - 1].content, 'I am here', "the hop's answer is on disk, not just billed");
});

// ── the expensive one ────────────────────────────────────────────────────────

test('handoff: a failed hop still CONSUMES the batch, because pass 1 is on disk', async () => {
  const r = rig(oneTurn(), [handoffThen('over to you'), deadVessel(), msg('reporting back')]);
  const res = await runTurnForQueue('Default', 'c1', [send('q7')], r.deps);

  // ok:true — the turn did produce an answer. The failure is NAMED, not
  // substituted for the success.
  assert.equal(res.ok, true);
  assert.deepEqual(res.consumedIds, ['q7'],
    'abandoning here re-composes the same user message from the queue and posts it again');
});

test('handoff: a first-pass failure commits and is spent, like any other failure', async () => {
  // ⚠ REPLACES 'a first-pass failure abandons, because nothing was written'
  // (assert.deepEqual(res.consumedIds, [])). Changed 2026-11-02: every failure
  // commits a message and consumes the batch, so the two tests here now differ
  // only in `ok` and in whether the failure is NAMED beside an answer — not in
  // whether the items come back.
  const r = rig(oneTurn(), [deadVessel()]);
  const res = await runTurnForQueue('Default', 'c1', [send('q7')], r.deps);

  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.stage, 'stream');
  assert.deepEqual(res.consumedIds, ['q7'],
    'the user message is in the log now, so nothing may re-compose it');
});

// ── the cap ──────────────────────────────────────────────────────────────────

test('handoff: the chain is capped, and the cap says so in the result', async () => {
  // Five vessels that all hand over immediately. Without a cap this would
  // POST until the money ran out; `rig` throws on an unexpected POST, so an
  // off-by-one in the cap fails loudly instead of quietly costing more.
  const r = rig(oneTurn(), [
    handoffThen('a'), handoffThen('b'), handoffThen('c'), handoffThen('d'),
  ]);
  const res = await runTurnForQueue('Default', 'c1', [send()], r.deps);

  assert.equal(res.ok, true);
  assert.equal(r.bodies.length, 4, '1 original + 3 hops');
  if (res.ok) {
    assert.equal(res.handoffHops, 3);
    assert.match(String(res.handoffError), /capped at 3/);
  }
});

// ── report, do not stop ──────────────────────────────────────────────────────

test('handoff: a vessel that cannot answer at all is reported BACK to the being', async () => {
  const r = rig(oneTurn(), [handoffThen('over to you'), deadVessel(), msg('that one is out of credit')]);
  await runTurnForQueue('Default', 'c1', [send()], r.deps);

  assert.equal(r.bodies.length, 3, 'original, the dead hop, and the report');
  // The report goes back to the SAVED vessel (pass 1 had no override), and
  // carries handoffFailed so the being hears it in its own voice rather than
  // only the human seeing a red notice.
  assert.equal(r.bodies[2].aiName, 'Local');
  const failed = r.bodies[2].handoffFailed as Record<string, unknown>;
  assert.equal(failed.specificModel, 'gemini-4-argon');
  assert.equal(failed.label, 'Gemini 4 Argon');
  assert.match(String(failed.error), /insufficient balance/);
  // Mutually exclusive server-side (`else if`): a request that reports a
  // failure must not also look like a fresh handover.
  assert.equal(r.bodies[2].handoffFrom, undefined);
});

test('handoff: a vessel that SPOKE and then died is not reported as unable to answer', async () => {
  const r = rig(oneTurn(), [
    handoffThen('over to you'),
    [frame({ type: 'text', content: 'Здра' }), frame({ type: 'error', error: 'connection reset' })],
  ]);
  const res = await runTurnForQueue('Default', 'c1', [send()], r.deps);

  // No third POST. It DID receive the handoff and DID read the note, so
  // "it could not answer" would be false — and re-posting would throw away
  // the text it produced along with the tokens already billed for it.
  assert.equal(r.bodies.length, 2);
  assert.equal(res.ok, true);
  if (res.ok) assert.match(String(res.handoffError), /connection reset/);
});

// ── per-pass accounting ──────────────────────────────────────────────────────

test('handoff: the hop times ITSELF, not the whole turn', async () => {
  let clock = 1000;
  const r = rig(oneTurn(), [handoffThen('over to you'), msg('ok')], {
    // Every call advances a second: pass 1 starts at 1000, pass 2 starts
    // later. A hop that inherited the turn's start would report the first
    // vessel's thinking time as its own.
    nowMs: () => (clock += 1000),
  });
  await runTurnForQueue('Default', 'c1', [send()], r.deps);

  const m = lastSave(r) as unknown as Array<Record<string, number>>;
  const first = m[2].generationMs;
  const second = m[3].generationMs;
  assert.ok(second < first + 1, `hop ${second}ms must not include pass 1 (${first}ms)`);
});
