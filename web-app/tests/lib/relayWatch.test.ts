/**
 * relayWatch — giving up on a dead relay, and what to do with what is left.
 *
 * NEW TEST for a reported bug (2026-11-02, トカゲくん, from a phone on :3000):
 * he started a soul update, saw the shikigami begin thinking, closed the tab,
 * and came back to no soul in the right pane, red text at the top, and a
 * confirm claiming the soul was still being updated.
 *
 * Written from the FAILURE MODES, not from the implementation. The old shape
 * was not a wrong value anywhere — it was a wait with no end, and downstream a
 * live run's record being DELETED and its empty text reported as "the model
 * returned no text". So the assertions are about which of those two things can
 * still happen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  withIdleBound,
  decideAfterWatch,
  IDLE,
  RELAY_KEEPALIVE_MS,
  RELAY_IDLE_TIMEOUT_MS,
} from '../../src/lib/relayWatch';
import type { SpuRunRecord } from '../../src/lib/spuRun';

function rec(over: Partial<SpuRunRecord> = {}): SpuRunRecord {
  return {
    runId: 'r1',
    label: '58',
    action: 'update',
    convoId: 'c1',
    startedAt: 1_000,
    updatedAt: 2_000,
    status: 'done',
    accum: 'TEXT',
    sawSentinel: true,
    attempts: 1,
    vessel: { aiName: 'DeepSeek', specificModel: 'deepseek-v4-pro' },
    host: 'c:\\dev\\nexus',
    ...over,
  };
}

describe('the idle bound', () => {
  it('is derived from the server keepalive, not picked', () => {
    // Without this the two numbers drift apart, and the direction that breaks
    // is silent: widen the keepalive and every watcher starts declaring
    // healthy connections dead.
    assert.equal(RELAY_IDLE_TIMEOUT_MS, 3 * RELAY_KEEPALIVE_MS);
    assert.ok(RELAY_IDLE_TIMEOUT_MS > RELAY_KEEPALIVE_MS,
      'a bound at or below one keepalive period fires on normal jitter');
  });
});

describe('withIdleBound', () => {
  it('reports IDLE when the promise never settles', async () => {
    // THE regression. A read that neither resolves nor rejects is what a
    // phone's half-open socket produces, and before this there was no other
    // way out of the loop.
    const never = new Promise<string>(() => {});
    assert.equal(await withIdleBound(never, 20), IDLE);
  });

  it('passes the value through when the promise wins', async () => {
    assert.equal(await withIdleBound(Promise.resolve('chunk'), 60_000), 'chunk');
  });

  it('propagates a rejection rather than swallowing it as IDLE', async () => {
    // A socket error must stay an error: the caller's catch is what reports it
    // and settles `running`. Turning it into IDLE would make a real failure
    // look like a quiet connection.
    await assert.rejects(
      withIdleBound(Promise.reject(new Error('socket closed')), 60_000),
      /socket closed/,
    );
  });

  it('clears its timer, so a won race does not hold the process open', async () => {
    // Asserted by CONSTRUCTION rather than by a value: the 60s bound above and
    // here would keep node's event loop alive for a minute after this file
    // finished if clearTimeout were missing. A leak shows up as the suite
    // hanging, which is the only observable this has.
    const t0 = Date.now();
    await withIdleBound(Promise.resolve(1), 60_000);
    assert.ok(Date.now() - t0 < 1_000);
  });

  it('a zero bound still resolves rather than racing forever', async () => {
    assert.equal(await withIdleBound(new Promise<number>(() => {}), 0), IDLE);
  });
});

describe('decideAfterWatch', () => {
  it('says missing when there is no record', () => {
    assert.deepEqual(decideAfterWatch(null), { kind: 'missing' });
    assert.deepEqual(decideAfterWatch(undefined), { kind: 'missing' });
  });

  it('says RUNNING for a record that still says running', () => {
    // THE regression, and the branch that did not exist. Without it this fell
    // through to `result`: the caller deleted the record of a live run and
    // post-processed its empty accum, reporting "the model returned no text"
    // about a run that was still producing.
    const r = rec({ status: 'running', accum: '' });
    assert.deepEqual(decideAfterWatch(r), { kind: 'running', record: r });
  });

  it('says RUNNING even when a running record already holds checkpoint text', () => {
    // The dangerous half: with text present, `result` looks plausible — the
    // panel would accept a half-written soul as the finished one AND delete
    // the record the rest of it was going to be written into.
    const r = rec({ status: 'running', accum: 'HALF OF LAYER 3' });
    assert.equal(decideAfterWatch(r).kind, 'running');
  });

  it('returns the result for a finished run', () => {
    const r = rec({ status: 'done' });
    assert.deepEqual(decideAfterWatch(r), { kind: 'result', record: r });
  });

  it('keeps a stopped run that produced text as a result', () => {
    // The stop branch exists to preserve partial work; calling it a failure
    // here would discard exactly what it saved.
    const r = rec({ status: 'stopped', accum: 'PARTIAL', sawSentinel: false });
    assert.equal(decideAfterWatch(r).kind, 'result');
  });

  it('keeps an errored run that produced text as a result', () => {
    const r = rec({ status: 'error', accum: 'FIVE ROUNDS', error: 'provider 500' });
    assert.equal(decideAfterWatch(r).kind, 'result');
  });

  it('says FAILED, with the reason, for an error with no text', () => {
    const r = rec({ status: 'error', accum: '', error: 'DeepSeek 400' });
    assert.deepEqual(decideAfterWatch(r), { kind: 'failed', reason: 'DeepSeek 400', record: r });
  });

  it('passes an EMPTY reason through rather than inventing one', () => {
    // A run can finish having printed nothing with no error to name. The
    // caller has its own sentence for that; a reason made up here would be a
    // false explanation in the status line.
    const r = rec({ status: 'done', accum: '' });
    assert.deepEqual(decideAfterWatch(r), { kind: 'failed', reason: '', record: r });
  });

  it('checks running BEFORE finished', () => {
    // Order is the whole fix. A running record with a sentinel in its
    // checkpoint satisfies every "is this finished" test there is.
    const r = rec({ status: 'running', accum: 'DONE_SENTINEL_LOOKALIKE', sawSentinel: true });
    assert.equal(decideAfterWatch(r).kind, 'running');
  });
});
