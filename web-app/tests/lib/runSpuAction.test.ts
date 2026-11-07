/**
 * runSpuAction — one SPU action run on the server and recorded on disk
 * (2026-10-31).
 *
 * NEW TESTS. Each names a failure that is silent, and most of them are about
 * the RECORD rather than the generation — because the record is the only thing
 * a tab that was closed can come back to:
 *
 *   "a record exists before the first call" — absent, a crashed run and a run
 *       that was never started look identical on disk, so the panel cannot
 *       tell "nothing happened" from "something happened and died".
 *   "a failing run keeps its checkpointed text" — absent, a provider error on
 *       round 6 of 7 records an empty document and five rounds of a soul
 *       update are gone. Written WRONG first: the comment said the text was
 *       kept and the code defaulted it to ''.
 *   "a checkpoint that throws does not kill the run" — absent, one unlucky
 *       disk write throws away a generation that was going fine.
 *   "abort records 'stopped', not 'done'" — absent, a cancelled run reads as a
 *       finished one and the panel offers a half document as a result.
 *   "a record write failure is its own stage" — absent, "the generation
 *       succeeded but the only durable copy did not land" is reported as a
 *       generation failure, and the cheap retry looks like an expensive one.
 *   "the stream reader accepts STRING chunks" — called as a module nothing
 *       encodes the enqueued string, and TextDecoder.decode() throws TypeError
 *       on a string. MEASURED 2026-10-29: this exact bug killed the chat
 *       runner's first real turn.
 *   "an error frame mid-stream throws" — absent, a provider error arrives as
 *       a frame, is ignored, and the run records a short document as done.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSpuAction } from '@/lib/runSpuAction';
import type { SpuRunRecord } from '@/lib/spuRun';
import type { SpuBillingEntry } from '@/lib/spuBilling';
import { END_SENTINEL } from '@/lib/spuScaffold';

const ARGS = {
  folder: 'Luna',
  label: '2',
  action: 'update',
  convoId: 'c-1',
  userMsg: 'REQUEST',
  agentSystemPrompt: 'AGENT',
  lang: 'ja' as const,
  resumeText: '',
  aiName: 'Local',
  specificModel: 'gemma',
  modelParams: {},
};

/**
 * A /api/chat stand-in that streams the given frames as SSE.
 *
 * `asString` picks the transport: strings are what a module-level call really
 * receives, bytes are what an HTTP call receives. Both are exercised — a
 * fixture that only produced one of them would be testing one transport while
 * claiming to test the reader.
 */
function chatStub(rounds: string[][], asString = true) {
  let call = 0;
  return {
    get calls() { return call; },
    chatPost: async () => {
      const frames = rounds[call] ?? [];
      call++;
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        start(c) {
          for (const f of frames) {
            const line = `data: ${f}\n\n`;
            c.enqueue(asString ? (line as unknown as Uint8Array) : enc.encode(line));
          }
          c.enqueue((asString ? 'data: [DONE]\n\n' : enc.encode('data: [DONE]\n\n')) as never);
          c.close();
        },
      }) as unknown as ReadableStream<Uint8Array>, { status: 200 });
    },
  };
}

function textFrame(s: string) {
  return JSON.stringify({ type: 'text', content: s });
}

function usageFrame(u: { total?: number; cached?: number; output?: number; reportedUsd?: number }) {
  return JSON.stringify({
    type: 'cache_usage',
    totalInputTokens: u.total ?? 0,
    cachedInputTokens: u.cached ?? 0,
    uncachedInputTokens: Math.max(0, (u.total ?? 0) - (u.cached ?? 0)),
    outputTokens: u.output ?? 0,
    cacheCreationTokens: 0,
    providerHint: 'oai',
    ...(u.reportedUsd ? { reportedUsd: u.reportedUsd } : {}),
  });
}

function billRecorder() {
  const entries: SpuBillingEntry[] = [];
  return {
    entries,
    writeBilling: async (_f: string, e: SpuBillingEntry) => { entries.push(e); },
  };
}

function recorder() {
  const writes: SpuRunRecord[] = [];
  return {
    writes,
    writeRecord: async (_f: string, _l: string, r: SpuRunRecord) => { writes.push({ ...r }); },
  };
}

function baseDeps(chatPost: RunChat, rec: ReturnType<typeof recorder>) {
  let n = 1000;
  return {
    chatPost,
    writeRecord: rec.writeRecord,
    nowMs: () => n++,
    newId: () => 'run-1',
    origin: 'http://localhost:3000',
    host: 'c:\\dev\\nexus',
  };
}
type RunChat = (req: Request) => Promise<Response>;

test('a record exists before the first provider call', async () => {
  const rec = recorder();
  let sawRecordsAtFirstCall = -1;
  const stub = chatStub([[textFrame('done' + END_SENTINEL)]]);
  const chatPost: RunChat = async () => {
    sawRecordsAtFirstCall = rec.writes.length;
    return stub.chatPost();
  };
  const r = await runSpuAction(ARGS, baseDeps(chatPost, rec));
  assert.equal(r.ok, true);
  assert.equal(sawRecordsAtFirstCall, 1, 'no record on disk when the provider was first called');
  assert.equal(rec.writes[0].status, 'running');
  assert.equal(rec.writes[0].accum, '');
  assert.equal(rec.writes[0].host, 'c:\\dev\\nexus');
});

test('a finished run records the text, the sentinel and the vessel', async () => {
  const rec = recorder();
  const stub = chatStub([[textFrame('## Layer 1'), textFrame(' body' + END_SENTINEL)]]);
  const r = await runSpuAction(ARGS, baseDeps(stub.chatPost, rec));
  assert.equal(r.ok, true);
  const last = rec.writes[rec.writes.length - 1];
  assert.equal(last.status, 'done');
  assert.equal(last.accum, '## Layer 1 body' + END_SENTINEL);
  assert.equal(last.sawSentinel, true);
  assert.equal(last.endedBecause, 'sentinel');
  assert.equal(last.attempts, 1);
  assert.deepEqual(last.vessel, { aiName: 'Local', specificModel: 'gemma' });
  assert.equal(last.convoId, 'c-1');
  assert.equal(last.label, '2');
});

test('the reader accepts STRING chunks (the module-call transport)', async () => {
  const rec = recorder();
  const stub = chatStub([[textFrame('via string' + END_SENTINEL)]], true);
  const r = await runSpuAction(ARGS, baseDeps(stub.chatPost, rec));
  assert.equal(r.ok, true);
  assert.equal((r as { record: SpuRunRecord }).record.accum, 'via string' + END_SENTINEL);
});

test('the reader accepts BYTE chunks (the HTTP transport)', async () => {
  const rec = recorder();
  const stub = chatStub([[textFrame('via bytes' + END_SENTINEL)]], false);
  const r = await runSpuAction(ARGS, baseDeps(stub.chatPost, rec));
  assert.equal(r.ok, true);
  assert.equal((r as { record: SpuRunRecord }).record.accum, 'via bytes' + END_SENTINEL);
});

test('a failing run keeps the text its checkpoints had seen', async () => {
  const rec = recorder();
  let call = 0;
  const good = chatStub([[textFrame('ROUND ONE ')]]);
  const chatPost: RunChat = async () => {
    call++;
    if (call === 1) return good.chatPost();
    throw new Error('HTTP 429');
  };
  const r = await runSpuAction(ARGS, baseDeps(chatPost, rec));
  assert.equal(r.ok, false);
  assert.equal((r as { stage: string }).stage, 'stream');
  const last = rec.writes[rec.writes.length - 1];
  assert.equal(last.status, 'error');
  assert.match(String(last.error), /429/);
  // The whole point: round 1 survives the round-2 failure.
  assert.equal(last.accum, 'ROUND ONE ');
  assert.equal(last.attempts, 1);
});

test('a failing FIRST round records an empty document, honestly', async () => {
  const rec = recorder();
  const chatPost: RunChat = async () => { throw new Error('connection refused'); };
  const r = await runSpuAction(ARGS, baseDeps(chatPost, rec));
  assert.equal(r.ok, false);
  const last = rec.writes[rec.writes.length - 1];
  assert.equal(last.accum, '');
  assert.equal(last.attempts, 0);
});

test('a failing first round on a RESUMED run keeps the salvaged half', async () => {
  const rec = recorder();
  const chatPost: RunChat = async () => { throw new Error('connection refused'); };
  const r = await runSpuAction({ ...ARGS, resumeText: 'SALVAGED' }, baseDeps(chatPost, rec));
  assert.equal(r.ok, false);
  const last = rec.writes[rec.writes.length - 1];
  // Without the seed, rescuing a truncated run and then hitting one provider
  // error would destroy the part that had survived the first truncation.
  assert.equal(last.accum, 'SALVAGED\n');
});

test('a checkpoint that throws does not kill the run', async () => {
  const stub = chatStub([[textFrame('one ')], [textFrame('two' + END_SENTINEL)]]);
  let attempts = 0;
  const r = await runSpuAction(ARGS, {
    ...baseDeps(stub.chatPost, recorder()),
    writeRecord: async () => {
      attempts++;
      // Every write after the first fails: the generation must still finish.
      if (attempts > 1) throw new Error('disk full');
    },
  });
  assert.equal(r.ok, false, 'the FINAL write failed, so the result says so');
  assert.equal((r as { stage: string }).stage, 'record');
  // ...but the generation itself completed both rounds rather than stopping at
  // the first failed checkpoint.
  assert.equal((r as { record: SpuRunRecord }).record.accum, 'one two' + END_SENTINEL);
  assert.equal((r as { record: SpuRunRecord }).record.attempts, 2);
});

test('an abort records stopped, not done', async () => {
  const rec = recorder();
  const stub = chatStub([[textFrame('half ')], [textFrame('NEVER')]]);
  let rounds = 0;
  const r = await runSpuAction(ARGS, {
    ...baseDeps(async () => { rounds++; return stub.chatPost(); }, rec),
    isAborted: () => rounds >= 1,
  });
  assert.equal(r.ok, true, 'a stop is not a failure');
  const last = rec.writes[rec.writes.length - 1];
  assert.equal(last.status, 'stopped');
  assert.equal(last.endedBecause, 'aborted');
  assert.equal(last.accum, 'half ');
  assert.equal(rounds, 1);
});

test('an error frame mid-stream fails the run instead of truncating it quietly', async () => {
  const rec = recorder();
  const stub = chatStub([[
    textFrame('partial'),
    JSON.stringify({ error: 'rate limit' }),
    textFrame(' never'),
  ]]);
  const r = await runSpuAction(ARGS, baseDeps(stub.chatPost, rec));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /rate limit/);
  // The frames after the error are not in the document.
  assert.ok(!rec.writes[rec.writes.length - 1].accum.includes('never'));
});

test('an unparseable frame is skipped, not fatal', async () => {
  const rec = recorder();
  const stub = chatStub([[ '{not json', textFrame('fine' + END_SENTINEL) ]]);
  const r = await runSpuAction(ARGS, baseDeps(stub.chatPost, rec));
  assert.equal(r.ok, true);
  assert.equal((r as { record: SpuRunRecord }).record.accum, 'fine' + END_SENTINEL);
});

test('a non-ok response names the HTTP status', async () => {
  const rec = recorder();
  const r = await runSpuAction(ARGS, {
    ...baseDeps(async () => new Response('vessel exploded', { status: 503 }), rec),
  });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /vessel exploded/);
});

test('raw frames reach the relay before they are interpreted', async () => {
  const seen: string[] = [];
  const stub = chatStub([[ textFrame('a'), JSON.stringify({ error: 'boom' }) ]]);
  await runSpuAction(ARGS, {
    ...baseDeps(stub.chatPost, recorder()),
    onRawText: (t) => { seen.push(t); },
  });
  const all = seen.join('');
  assert.ok(all.includes('"content":"a"'));
  // The frame that KILLED the run must have reached the watcher too — it is
  // the only channel a detached run has to explain itself to a tab.
  assert.ok(all.includes('boom'), all);
});

test('the chat body carries the soul-writing flags, not the panel defaults', async () => {
  let body: Record<string, unknown> = {};
  const stub = chatStub([[textFrame('x' + END_SENTINEL)]]);
  await runSpuAction(ARGS, {
    ...baseDeps(async (req) => {
      body = await req.clone().json();
      return stub.chatPost();
    }, recorder()),
  });
  // Each of these has a measured justification in lib/spuChatBody.ts. They are
  // asserted here because an agent run that loses one of them damages a soul
  // file rather than erroring.
  assert.equal(body.agentReadOnlyTools, true);
  assert.equal(body.toolUseEnabled, false);
  assert.equal(body.suppressLayer5, true);
  assert.equal(body.betrayalDefense, false);
  assert.equal(body.seedEnabled, false);
  assert.equal((body.modelParams as Record<string, unknown>).enableGrokNativeSearch, false);
  assert.equal((body.modelParams as Record<string, unknown>).claudeThinking, false);
  assert.equal(body.systemPrompt, 'AGENT');
  assert.equal(body.folderName, 'Luna');
  assert.equal(body.specificModel, 'gemma');
  // authMode is omitted unless asked for — the route's own 'auto' is the
  // default, and sending a value would pin the billing path by accident.
  assert.ok(!('claudeAuthMode' in body));
});

test('authMode is forwarded when given', async () => {
  let body: Record<string, unknown> = {};
  const stub = chatStub([[textFrame('x' + END_SENTINEL)]]);
  await runSpuAction({ ...ARGS, authMode: 'oauth' as const }, {
    ...baseDeps(async (req) => {
      body = await req.clone().json();
      return stub.chatPost();
    }, recorder()),
  });
  assert.equal(body.claudeAuthMode, 'oauth');
});

// ── Billing ledger (2026-11-07) ────────────────────────────────────────────
// The SPU run's cost used to be shown live and then thrown away. These assert
// the ledger entry: summed across rounds, written once, present even on a run
// that errored (the money was spent), and absent when nothing was spent.

test('a run with usage writes ONE billing entry, summed across its rounds', async () => {
  const rec = recorder();
  const bill = billRecorder();
  const stub = chatStub([
    [textFrame('r1 '), usageFrame({ total: 100, cached: 20, output: 10 })],
    [textFrame('r2' + END_SENTINEL), usageFrame({ total: 50, output: 5 })],
  ]);
  const r = await runSpuAction(ARGS, { ...baseDeps(stub.chatPost, rec), writeBilling: bill.writeBilling });
  assert.equal(r.ok, true);
  assert.equal(bill.entries.length, 1, 'exactly one ledger entry per run');
  const e = bill.entries[0];
  assert.equal(e.usage.totalInputTokens, 150, 'input summed across both rounds');
  assert.equal(e.usage.cachedInputTokens, 20);
  assert.equal(e.usage.outputTokens, 15, 'output summed across both rounds');
  assert.equal(e.attempts, 2);
  assert.equal(e.status, 'done');
  assert.equal(e.runId, 'run-1');
  assert.equal(e.action, 'update');
  assert.equal(e.model, 'gemma');
});

test('a run that reported no usage writes no billing entry', async () => {
  const rec = recorder();
  const bill = billRecorder();
  const stub = chatStub([[textFrame('text only' + END_SENTINEL)]]);
  const r = await runSpuAction(ARGS, { ...baseDeps(stub.chatPost, rec), writeBilling: bill.writeBilling });
  assert.equal(r.ok, true);
  assert.equal(bill.entries.length, 0, 'no usage → no ledger noise');
});

test('a run that errors still bills what it spent before dying', async () => {
  const rec = recorder();
  const bill = billRecorder();
  let call = 0;
  const good = chatStub([[textFrame('r1 '), usageFrame({ total: 80, output: 8 })]]);
  const chatPost: RunChat = async () => {
    call++;
    if (call === 1) return good.chatPost();
    throw new Error('provider exploded');
  };
  const r = await runSpuAction(ARGS, { ...baseDeps(chatPost, rec), writeBilling: bill.writeBilling });
  assert.equal(r.ok, false);
  assert.equal(bill.entries.length, 1, 'the provider calls happened — the money was spent');
  assert.equal(bill.entries[0].status, 'error');
  assert.equal(bill.entries[0].usage.totalInputTokens, 80, 'round-1 usage survives the round-2 throw');
});
