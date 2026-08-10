import { exec, execFile } from 'child_process';
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
  shell: string; // which shell actually ran it (for transparency)
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

export function runShellCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<ShellResult> {
  const timeout = Math.max(1000, Math.min(opts.timeoutMs ?? 60_000, 600_000));
  const bash = resolveBash();
  const shellName = bash ? bash : (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  const execOpts = { cwd: opts.cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: 'buffer' as const };

  return new Promise((resolve) => {
    const handle = (err: any, stdoutBuf: any, stderrBuf: any) => {
      const stdout = decodeBytes(stdoutBuf);
      const stderr = decodeBytes(stderrBuf);
      const parts: string[] = [];
      if (stdout && stdout.trim()) parts.push(stdout.replace(/\s+$/, ''));
      if (stderr && stderr.trim()) parts.push(`[stderr]\n${stderr.replace(/\s+$/, '')}`);
      let timedOut = false;
      if (err) {
        timedOut = !!err.killed; // exec/execFile kill with SIGTERM on timeout
        if (timedOut) parts.push(`[command killed — exceeded the ${Math.round(timeout / 1000)}s timeout]`);
        else if (typeof err.code === 'number') parts.push(`[exit code ${err.code}]`);
        else if (!stdout && !stderr) parts.push(`[error] ${err.message}`);
      }
      let output = parts.join('\n').trim() || '(command produced no output)';
      if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n[...output truncated...]';
      resolve({ ok: !err, output, timedOut, shell: shellName });
    };

    if (bash) {
      // bash -c "command" — reliable across platforms (unlike overriding exec's
      // shell option, which still uses cmd-style flags on Windows).
      execFile(bash, ['-c', command], execOpts, handle);
    } else {
      exec(command, execOpts, handle);
    }
  });
}
