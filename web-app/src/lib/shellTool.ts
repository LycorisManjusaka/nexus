import { exec, execFile, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';

// Shell execution for the non-OAuth agentic paths (the OAuth path uses Claude
// Code's own built-in Bash). DANGEROUS — the caller gates it behind the
// per-Entity "Dangerous tools" toggle, exactly like Delete. A shell can navigate
// out of the working directory, so this is NOT sandboxed — inherent to granting
// shell, and surfaced to the user in the UI (same caveat as OAuth Bash).
//
// SHELL CHOICE: the tool is named "Bash", so it must actually BE bash wherever
// possible — otherwise the entity writes POSIX syntax (chmod, bash, sleep) that
// a Windows cmd.exe rejects. We prefer bash: an explicit NEXUS_SHELL override,
// then Git Bash on Windows (the same shell Claude Code's OAuth Bash uses on this
// machine), then /bin/bash|sh on POSIX. Only if no bash is found do we fall back
// to the OS default shell (cmd.exe on Windows) — and the description tells the
// model that can happen.

export interface ShellResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
  /**
   * The TURN was stopped while this command was still running — the child was
   * killed from outside, it did not finish and it did not time out. Named
   * separately because `timedOut: false` otherwise reads as "it ran to
   * completion", and the three endings have nothing else to tell them apart.
   */
  stopped: boolean;
  shell: string; // which shell actually ran it (for transparency)
}

/** How the child process ended. One name per ending, so nothing is inferred twice. */
export type ShellEnd = 'ok' | 'stopped' | 'timeout' | 'exit' | 'error';

/**
 * Which ending this is.
 *
 * ⚠ ORDER IS THE WHOLE RULE: a child killed by an AbortSignal arrives with
 * `killed: true`, exactly like a child killed by the timeout. Testing `killed`
 * first would report every Stop as "exceeded the 60s timeout" — a sentence
 * that blames the command for something the person did. So abort is checked
 * before kill, and `aborted` is passed in as well as read off the error: a
 * shell killed by our own `taskkill` comes back with no AbortError shape at
 * all, and the flag is then the only thing that says which ending this is.
 */
export function classifyShellEnd(
  // The fields of a Node exec error that this decision reads, plus `message`,
  // which the caller prints in the 'error' case — named here so the type says
  // "an exec error" rather than "three booleans that happen to be enough".
  err: { killed?: boolean; code?: unknown; name?: string; message?: string } | null | undefined,
  aborted: boolean,
): ShellEnd {
  if (!err) return aborted ? 'stopped' : 'ok';
  if (aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') return 'stopped';
  if (err.killed) return 'timeout';
  if (typeof err.code === 'number') return 'exit';
  return 'error';
}

const MAX_OUTPUT = 10_000; // chars fed back to the model
const MAX_BUFFER = 4 * 1024 * 1024; // bytes captured from the process

// Resolve a bash executable, or null to signal "use the OS default shell".
function resolveBash(): string | null {
  const override = process.env.NEXUS_SHELL;
  if (override && existsSync(override)) return override;
  if (process.platform !== 'win32') {
    for (const p of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) if (existsSync(p)) return p;
    return null;
  }
  // Windows: prefer Git Bash so `Bash` really is bash (matches OAuth + the name).
  for (const p of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) if (existsSync(p)) return p;
  return null; // no bash → cmd.exe fallback
}

// Decode raw process bytes. Windows cmd.exe emits its built-in messages in the
// OEM code page (CP932 on Japanese systems, etc.), NOT UTF-8 — decoding those
// as UTF-8 gives mojibake. Try UTF-8 first (correct for bash/Git Bash and modern
// programs); if it produced replacement chars, fall back to Shift-JIS (Japanese
// Windows cmd). Best-effort — mixed-encoding output can't be perfect.
function decodeBytes(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf;
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('shift_jis', { fatal: false }).decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * Run a command and resolve with what it said.
 *
 * ── `signal` is what makes Stop mean Stop (REPORTED 2026-11-01, トカゲくん) ──
 * MEASURED symptom: "ask Gemma to run `sleep 10`, press Stop while it runs —
 * nothing happens until bash finishes." The stop WAS arriving: turnStop fired,
 * `turnAbort.abort()` ran, and every loop in the chat route re-reads that flag.
 * But the loop was parked on THIS promise, which had no way to end early, so
 * the whole turn waited out a command the person had already cancelled.
 *
 * So the signal is not a refinement of the stop path — it is the last link in
 * it. Without it the abort is received, believed, and then ignored for as long
 * as the child runs (up to the 600s cap).
 *
 * ── Why the signal is NOT handed to execFile ───────────────────────────────
 * That was the first version, and it half worked. MEASURED 2026-11-02 with a
 * command that appends to a file every second: Stop ended the turn at once
 * (right) and the file KEPT GROWING for as long as I watched (wrong). Node's
 * `signal` support registers its own listener inside execFile — before any
 * listener this function could add — and it kills bash.exe alone. Windows has
 * no process groups, so everything bash started is orphaned, and by the time
 * our own `taskkill /T` ran there was no tree left to walk.
 *
 * So this owns the cancellation instead: kill the TREE, and resolve the
 * promise immediately whether or not the kill worked. Both halves matter.
 *   · Resolving at once is what makes Stop mean Stop — the tool loop is parked
 *     on this promise and cannot reach its own abort check until it settles.
 *   · Not waiting for the kill means a `taskkill` that fails or is missing
 *     cannot turn Stop back into "wait out the command".
 * Partial output is dropped on that path on purpose: the loop breaks on the
 * abort flag immediately after, so nothing ever reads the tool result.
 */
export function runShellCommand(
  command: string,
  opts: {
    cwd: string; timeoutMs?: number; signal?: AbortSignal;
    /**
     * Test seam, same idea as jsonGzip's `gzipImpl`. The abort path resolves
     * the promise WITHOUT waiting for the kill, and that line only matters
     * when the kill does not work — a case no test can reach while taskkill
     * is doing its job. Passing a killer that does nothing is the only way to
     * make the fallback actually fall. Not used by the product.
     */
    killer?: (child: Pick<ChildProcess, 'pid' | 'kill'>) => void;
  },
): Promise<ShellResult> {
  const timeout = Math.max(1000, Math.min(opts.timeoutMs ?? 60_000, 600_000));
  const bash = resolveBash();
  const shellName = bash ? bash : (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  const execOpts = {
    cwd: opts.cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true,
    encoding: 'buffer' as const,
  };

  return new Promise((resolve) => {
    // One settle. The real callback still fires when the shell dies, and it
    // must not resolve a promise the abort path already answered.
    let settled = false;
    const finish = (r: ShellResult) => { if (!settled) { settled = true; resolve(r); } };
    const stoppedResult = (): ShellResult => ({
      ok: false,
      output: '[command stopped — the turn was stopped]',
      timedOut: false, stopped: true, shell: shellName,
    });

    // A tool call that arrives AFTER Stop: nothing is spawned at all.
    if (opts.signal?.aborted) { finish(stoppedResult()); return; }

    const handle = (err: any, stdoutBuf: any, stderrBuf: any) => {
      const stdout = decodeBytes(stdoutBuf);
      const stderr = decodeBytes(stderrBuf);
      const parts: string[] = [];
      if (stdout && stdout.trim()) parts.push(stdout.replace(/\s+$/, ''));
      if (stderr && stderr.trim()) parts.push(`[stderr]\n${stderr.replace(/\s+$/, '')}`);
      const end = classifyShellEnd(err, opts.signal?.aborted === true);
      if (end === 'timeout') parts.push(`[command killed — exceeded the ${Math.round(timeout / 1000)}s timeout]`);
      else if (end === 'stopped') parts.push('[command stopped — the turn was stopped]');
      else if (end === 'exit') parts.push(`[exit code ${err.code}]`);
      else if (end === 'error' && !stdout && !stderr) parts.push(`[error] ${err.message}`);
      let output = parts.join('\n').trim() || '(command produced no output)';
      if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n[...output truncated...]';
      finish({
        ok: !err, output,
        timedOut: end === 'timeout',
        stopped: end === 'stopped',
        shell: shellName,
      });
    };

    const child = bash
      // bash -c "command" — reliable across platforms (unlike overriding exec's
      // shell option, which still uses cmd-style flags on Windows).
      ? execFile(bash, ['-c', command], execOpts, handle)
      : exec(command, execOpts, handle);

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        (opts.killer ?? killTree)(child);
        // Answer NOW, before and regardless of the kill. See the header.
        finish(stoppedResult());
      }, { once: true });
    }
  });
}

/**
 * Kill what the command STARTED, not just the shell.
 *
 * ⚠ MEASURED 2026-11-02, with the AbortSignal already wired: Stop ended the
 * turn at once (the point of the signal) and `child.killed` was true — and
 * `/usr/bin/sleep`, the process bash had started, was still running two
 * minutes later. Windows has no process groups, so Node's kill terminates
 * bash.exe and nothing below it.
 *
 * That is a NEW way to be wrong, created by fixing the first one: before the
 * signal, the turn waited the command out, so nothing was ever orphaned. "The
 * turn stopped" and "what it was doing stopped" are two claims, and only the
 * second one is about the machine.
 *
 * `taskkill /T /F` walks the tree. Fire-and-forget: the promise has already
 * resolved through the AbortError, and a Stop must not wait on a cleanup.
 *
 * POSIX is deliberately UNCHANGED and left reported rather than guessed at:
 * the fix there is `detached: true` plus `process.kill(-pid)`, which alters
 * how every command is spawned, and `detached` on Windows means
 * DETACHED_PROCESS — a shape this house has measured to silently run nothing
 * at all. Changing spawn semantics for a platform I cannot test from here
 * would be trading a known limitation for an unknown one.
 */
export function killTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  // Seam, because the claim worth testing is mechanical and the measurement
  // is not: that `/T` is present. MEASURED 2026-11-02 — the first version of
  // this fix reached the shell and not its children, and the suite could not
  // see it (a test can watch the promise settle; it cannot watch a survivor).
  // The live proof is a retained probe; this is the regression guard.
  spawnFn: typeof spawn = spawn,
): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore',
      }).unref();
      return;
    } catch { /* taskkill missing — fall through to the shell-only kill */ }
  }
  try { child.kill(); } catch { /* already gone */ }
}
