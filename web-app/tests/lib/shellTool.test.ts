/**
 * classifyShellEnd — which ending a child process had.
 *
 * NEW TEST, written for a reported bug (2026-11-01, トカゲくん): "ask Gemma to
 * run a 10-second bash command, press Stop while it runs — nothing happens
 * until bash finishes". The stop was arriving and being ignored, because the
 * tool-loop was parked on a promise with no way to end early.
 *
 * The fix passes an AbortSignal to execFile. That makes the ORDER of the
 * checks here load-bearing in a way nothing else in the file is: Node kills an
 * aborted child the same way it kills a timed-out one, so `err.killed` is true
 * for both. Testing `killed` first reports every Stop as "exceeded the 60s
 * timeout" — a sentence that blames the command for something the person did,
 * and sends that sentence to the model as the tool's result.
 *
 * `runShellCommand` itself is not called here: it spawns a real shell, and a
 * test that depends on bash being installed at a particular path would be a
 * test about this machine. The classifier is the part that holds the rule.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { classifyShellEnd, runShellCommand, killTree } from '../../src/lib/shellTool';

describe('classifyShellEnd', () => {
  it('no error and no abort is a clean finish', () => {
    assert.equal(classifyShellEnd(null, false), 'ok');
    assert.equal(classifyShellEnd(undefined, false), 'ok');
  });

  it('ABORT WINS OVER KILLED — an aborted child arrives killed too', () => {
    // THE regression this file exists for. Both flags are true at once for a
    // Stop; if `killed` were tested first the result would read 'timeout'.
    assert.equal(
      classifyShellEnd({ killed: true, name: 'AbortError' }, true),
      'stopped',
      'a stopped command must not be reported as a timeout',
    );
  });

  it('recognises an abort from the error alone', () => {
    // Belt and braces: the signal may have been consumed by the time the
    // callback runs, so the error is read as well as the flag.
    assert.equal(classifyShellEnd({ killed: true, name: 'AbortError' }, false), 'stopped');
    assert.equal(classifyShellEnd({ killed: true, code: 'ABORT_ERR' }, false), 'stopped');
  });

  it('recognises an abort from the flag alone', () => {
    // Node calls back WITHOUT spawning when the signal is already aborted —
    // a tool call that arrives after Stop. The error shape is then whatever
    // Node chose, so the flag has to be enough on its own.
    assert.equal(classifyShellEnd({ killed: true }, true), 'stopped');
  });

  it('a finished-looking callback with an aborted signal is still stopped', () => {
    // Defensive: if Node ever resolved an aborted run without an error, "ok"
    // would tell the model the command completed. It did not.
    assert.equal(classifyShellEnd(null, true), 'stopped');
  });

  it('killed without an abort is the timeout', () => {
    assert.equal(classifyShellEnd({ killed: true }, false), 'timeout');
  });

  it('a numeric code is a normal non-zero exit', () => {
    assert.equal(classifyShellEnd({ code: 1 }, false), 'exit');
    assert.equal(classifyShellEnd({ code: 0 }, false), 'exit');
  });

  it('anything else is an error', () => {
    assert.equal(classifyShellEnd({ message: 'spawn ENOENT', code: 'ENOENT' }, false), 'error');
    assert.equal(classifyShellEnd({}, false), 'error');
  });
});

describe('runShellCommand: the signal reaches the child', () => {
  it('an ALREADY-aborted signal returns at once instead of running anything', async () => {
    // This is the only machine-independent way to prove the signal is actually
    // handed to execFile: Node answers an already-aborted signal without
    // spawning, so no shell has to exist for the assertion to hold. Without
    // `signal` in execOpts this call would run `sleep 5` to completion and the
    // test would take five seconds — which is the reported bug, in miniature.
    const began = Date.now();
    const r = await runShellCommand('sleep 5', {
      cwd: os.tmpdir(),
      signal: AbortSignal.abort(),
    });
    assert.equal(r.stopped, true, 'the ending is named "stopped", not "timed out"');
    assert.equal(r.timedOut, false, 'a cancelled command must not blame a timeout');
    assert.match(r.output, /turn was stopped/);
    assert.ok(Date.now() - began < 2000, 'it did not wait the command out');
  });

  it('a signal that fires DURING the command ends it early', async () => {
    // Needs a working shell, so it is tolerant: on a machine with no bash the
    // spawn fails fast and the only claim left is "it returned quickly", which
    // is still the property under test.
    const ac = new AbortController();
    const began = Date.now();
    const p = runShellCommand('sleep 5', { cwd: os.tmpdir(), signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const r = await p;
    assert.ok(Date.now() - began < 3000, 'the await ended long before the command would have');
    assert.equal(r.timedOut, false);
  });
});

describe('killTree', () => {
  /**
   * WHY THIS IS A SEPARATE CLAIM from "the promise settles":
   *
   * MEASURED 2026-11-02 — the first version of the Stop fix handed the signal
   * to execFile. The turn stopped at once (the suite was happy) and the
   * command KEPT RUNNING: Node kills bash.exe, Windows has no process groups,
   * and everything bash started was orphaned. A test can watch a promise
   * settle; it cannot watch a survivor. So the mechanical half — `/T`, the
   * flag that makes it a tree and not a process — is pinned here, and the
   * live proof is a retained probe (plan_probe/w246) with a date on it.
   */
  it('asks taskkill for the whole TREE, by pid, forced', () => {
    if (process.platform !== 'win32') return; // the branch under test is win32-only
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fake = ((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      return { unref() {} };
    }) as unknown as typeof import('child_process').spawn;

    killTree({ pid: 4242, kill: () => true }, fake);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'taskkill');
    assert.ok(calls[0].args.includes('/T'), 'without /T only the shell dies and its children are orphaned');
    assert.ok(calls[0].args.includes('/F'), 'a graceful ask is declined by a shell mid-command');
    assert.ok(calls[0].args.includes('4242'), 'it must name THIS child');
  });

  it('does nothing at all when the child never got a pid', () => {
    const calls: unknown[] = [];
    const fake = (() => { calls.push(1); return { unref() {} }; }) as unknown as typeof import('child_process').spawn;
    let killed = false;
    killTree({ pid: undefined, kill: () => { killed = true; return true; } }, fake);
    assert.deepEqual(calls, [], 'taskkill with no pid would be an argument error, or worse a wildcard');
    assert.equal(killed, false);
  });
});

describe('runShellCommand: the answer does not depend on the kill working', () => {
  it('settles at once even when the kill does NOTHING', async () => {
    // The fallback actually falling. On this machine taskkill works, so the
    // real callback would settle the promise anyway and the line that answers
    // immediately would never be exercised — "a safety net that has never
    // caught anything is just a claim". With a killer that does nothing, the
    // command is still running when this assertion passes.
    const ac = new AbortController();
    const began = Date.now();
    const p = runShellCommand('sleep 2', {
      cwd: os.tmpdir(),
      signal: ac.signal,
      killer: () => { /* deliberately not killing anything */ },
    });
    setTimeout(() => ac.abort(), 150);
    const r = await p;
    assert.equal(r.stopped, true);
    assert.ok(Date.now() - began < 1200, 'Stop must not wait on a cleanup that failed');
  });
});
