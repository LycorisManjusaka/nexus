/**
 * execOrAbandon — Stop reaching a blocking child process.
 *
 * NEW TEST for a reported bug (2026-11-02, トカゲくん): "with LM Studio loading
 * a model, the Stop button does nothing until the load finishes; once loaded it
 * stops instantly."
 *
 * MEASURED: the turn was parked inside `lms load` (timeout 120_000, after
 * `lms unload --all` at 30_000). The turn's abort signal reached the provider
 * fetch, every tool loop and the shell tool — everywhere except this one await.
 * Same family as the Bash tool fixed the night before.
 *
 * What these can and cannot show. A test can watch the promise settle; it
 * cannot watch a SURVIVOR. The live proof that `/T` reaches a grandchild is a
 * retained probe (plan_probe/w259_tree_kill.mjs), measured 2026-11-02: a
 * grandchild writing one byte per second stopped at 4 bytes and was still at 4
 * six seconds later, with the call returning 6 ms after the abort. These
 * assertions are the regression guard around that.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execOrAbandon, loadLocalModel } from '../../src/lib/localModels';

// A child that outlives any test, so "did we stop waiting" is unambiguous.
const SLOW = 'node -e "setTimeout(()=>{},30000)"';

describe('execOrAbandon', () => {
  it('does not spawn at all when the signal is already aborted', async () => {
    // A turn that is already over must not start a 120-second child whose
    // only future is to be killed.
    const ctrl = new AbortController();
    ctrl.abort();
    let killed = false;
    const t0 = Date.now();
    const r = await execOrAbandon(SLOW, 120_000, ctrl.signal, () => { killed = true; });
    assert.deepEqual(r, { kind: 'aborted' });
    assert.equal(killed, false, 'nothing was spawned, so there is nothing to kill');
    assert.ok(Date.now() - t0 < 1_000, 'returned without running the command');
  });

  it('returns AT ONCE when the signal fires mid-flight', async () => {
    // THE regression. Before this the await ran to the command's own timeout,
    // so a Stop pressed during a model load did nothing a person could see.
    const ctrl = new AbortController();
    const p = execOrAbandon(SLOW, 120_000, ctrl.signal, () => {});
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    ctrl.abort();
    const r = await p;
    assert.deepEqual(r, { kind: 'aborted' });
    assert.ok(Date.now() - t0 < 2_000, `returned in ${Date.now() - t0}ms, not after the child`);
  });

  it('hands the kill seam the real child, with a pid', async () => {
    // Without a pid killTree is a no-op, and the whole fix becomes "stop
    // waiting and leave it running" — which is half of it, and the half that
    // cannot be seen from the screen.
    const ctrl = new AbortController();
    let seen: number | undefined = undefined;
    let calls = 0;
    const p = execOrAbandon(SLOW, 120_000, ctrl.signal, (c) => { calls++; seen = c.pid; });
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await p;
    assert.equal(calls, 1);
    assert.equal(typeof seen, 'number');
    assert.ok((seen as unknown as number) > 0);
  });

  it('kills exactly once even if the signal is aborted twice', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const p = execOrAbandon(SLOW, 120_000, ctrl.signal, () => { calls++; });
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    ctrl.abort();
    await p;
    assert.equal(calls, 1);
  });

  it('survives a kill function that throws', async () => {
    // taskkill can be missing. The turn must still end: a Stop that throws
    // inside the abort listener would leave the race unresolved forever,
    // which is the bug wearing a different hat.
    const ctrl = new AbortController();
    const p = execOrAbandon(SLOW, 120_000, ctrl.signal, () => { throw new Error('no taskkill'); });
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    assert.deepEqual(await p, { kind: 'aborted' });
  });

  it('reports done with the output when the command finishes', async () => {
    const r = await execOrAbandon('node -e "console.log(42)"', 10_000);
    assert.equal(r.kind, 'done');
    assert.equal((r as { stdout: string }).stdout.trim(), '42');
  });

  it('reports failed, not aborted, when the command exits non-zero', async () => {
    // A signal is present and never fires. Conflating the two would make
    // `lms load` failures look like Stops and hide a real load error.
    const ctrl = new AbortController();
    const r = await execOrAbandon('node -e "process.exit(3)"', 10_000, ctrl.signal);
    assert.equal(r.kind, 'failed');
  });

  it('works with no signal at all — the old behaviour, untouched', async () => {
    // Every other caller of loadLocalModel passes two arguments.
    const r = await execOrAbandon('node -e "console.log(7)"', 10_000);
    assert.equal(r.kind, 'done');
    assert.equal((r as { stdout: string }).stdout.trim(), '7');
  });

  it('a late abort after a finished command does not change the outcome', async () => {
    const ctrl = new AbortController();
    const r = await execOrAbandon('node -e "console.log(1)"', 10_000, ctrl.signal, () => {
      assert.fail('nothing should be killed after the command completed');
    });
    ctrl.abort();
    assert.equal(r.kind, 'done');
  });
});

// ── loadLocalModel: the signal must reach BOTH commands ────────────────────
// Mutation testing found this hole (2026-11-02): every test above drives
// execOrAbandon directly, so removing the signal from the `lms unload --all`
// call changed nothing any test could see — and that call alone is up to 30
// seconds of dead button, a quarter of the reported bug still present.
//
// Through the injected runner, never the real CLI: a test that reached `lms`
// would eject whatever model this house has resident, and it would do it on
// the failing path, where the damage is least expected.

describe('loadLocalModel', () => {
  type Call = { cmd: string; timeoutMs: number; hasSignal: boolean };

  function recorder(outcomes: Array<'done' | 'aborted' | 'failed'>) {
    const calls: Call[] = [];
    let i = 0;
    const run = (async (cmd: string, timeoutMs: number, signal?: AbortSignal) => {
      calls.push({ cmd, timeoutMs, hasSignal: !!signal });
      const o = outcomes[Math.min(i++, outcomes.length - 1)];
      if (o === 'done') return { kind: 'done', stdout: 'loaded', stderr: '' };
      if (o === 'failed') return { kind: 'failed', message: 'nope' };
      return { kind: 'aborted' };
    }) as unknown as typeof execOrAbandon;
    return { calls, run };
  }

  it('hands the signal to the unload AND the load', async () => {
    const { calls, run } = recorder(['done', 'done']);
    const ctrl = new AbortController();
    const r = await loadLocalModel('some-model', 80000, ctrl.signal, run);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[0].cmd, /lms unload --all/);
    assert.match(calls[1].cmd, /lms load "some-model" -c 80000/);
    assert.deepEqual(calls.map((c) => c.hasSignal), [true, true],
      'a command without the signal is a window where Stop does nothing');
  });

  it('stops BEFORE the load when the unload was aborted', async () => {
    // The two abort messages differ on purpose: "before" and "while loading"
    // are the only evidence of which command Stop landed in.
    const { calls, run } = recorder(['aborted']);
    const ctrl = new AbortController();
    const r = await loadLocalModel('some-model', 80000, ctrl.signal, run);
    assert.equal(r.aborted, true);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1, 'the load must not run for a turn that is over');
    assert.match(r.message, /before/i);
  });

  it('reports aborted when the LOAD is the one that was stopped', async () => {
    const { calls, run } = recorder(['done', 'aborted']);
    const ctrl = new AbortController();
    const r = await loadLocalModel('some-model', 80000, ctrl.signal, run);
    assert.equal(r.aborted, true);
    assert.equal(calls.length, 2);
    assert.match(r.message, /loading/i);
  });

  it('a FAILED unload is non-fatal — the load still runs', async () => {
    // `lms unload --all` errors when nothing is loaded. Treating that as fatal
    // would make the first turn after a restart refuse to load anything.
    const { calls, run } = recorder(['failed', 'done']);
    const r = await loadLocalModel('some-model', 80000, undefined, run);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
  });

  it('defaults the context window rather than sending an empty -c', async () => {
    const { calls, run } = recorder(['done', 'done']);
    await loadLocalModel('m', 0, undefined, run);
    assert.match(calls[1].cmd, /-c 80000/);
  });

  it('refuses an empty model key without running anything', async () => {
    const { calls, run } = recorder(['done', 'done']);
    const r = await loadLocalModel('', 80000, undefined, run);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
});
