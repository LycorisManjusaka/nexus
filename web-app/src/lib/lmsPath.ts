// ── Locating the `lms` CLI ───────────────────────────────────────────────────
//
// Every `lms` call in localModels.ts used to be a bare `lms …`, which only
// works when LM Studio's CLI is on the PATH of the account the NEXUS server
// runs as. It gets there via `lms bootstrap`, which the LM Studio installer
// does NOT run — so a fresh Windows account has the binary on disk and no way
// to reach it by name.
//
// ── WHAT THAT COST, MEASURED 2026-11-06 ─────────────────────────────────────
//
// Lizard-kun reported three separate symptoms on a new account. They were one
// root:
//
//   `lms` not on PATH
//     -> `lms load "<model>" -c 50000 --yes` never runs
//        -> LM Studio JIT-loads the model at whatever the GUI last saved for
//           it, or 8192 by default. The context NEXUS asked for is never
//           requested by anybody.
//        -> a 9,506-token message is rejected with
//           "exceeds the available context size (8192 tokens)"
//        -> thinking-capable GGUFs run out of room mid-thought and fall into
//           the continuation path, where the reasoning leaks into `content`.
//
// He had been working around it by opening LM Studio's GUI and ticking
// "Remember settings for <model>" with a large Context Length — which looks
// like proof that `-c` does not work. It is not. Measured the same day, same
// model, GUI untouched, with the CLI reachable:
//
//     lms load zai-org/glm-4.6v-flash -c 12000  ->  context 12032
//     lms load zai-org/glm-4.6v-flash -c 30000  ->  context 30208
//
// `-c` wins outright. The remembered GUI setting only mattered while the
// load command was never reaching LM Studio at all.
//
// ── THE LOOKUP ──────────────────────────────────────────────────────────────
//
// `~/.lmstudio/bin/` is where LM Studio puts the CLI on every platform; the
// bootstrap step adds that directory to PATH rather than moving anything. So
// the file is the reliable thing and the PATH entry is the optional one — this
// checks the file FIRST and falls back to the bare name.
//
// Falling back rather than failing matters: an installation that put the CLI
// somewhere else, or exported it through a shim, still works exactly as it did
// before this function existed. The worst case is the behaviour we already had.
//
// Inputs are arguments, not `process` reads, because the environment this bug
// lives in is one nobody here can reproduce — the account that hit it is not
// the account the tests run as. Passing them in is how that machine becomes
// test data.

export interface LmsLookup {
  /** `process.platform` */
  platform: string;
  /** `process.env.USERPROFILE` on Windows, `process.env.HOME` elsewhere. */
  home: string;
  /** Existence check for an absolute path (`fs.existsSync`). */
  exists: (p: string) => boolean;
}

/** Absolute path the LM Studio installer writes the CLI to, or '' without a home. */
export function lmsBinaryPath(platform: string, home: string): string {
  if (!home) return '';
  const sep = platform === 'win32' ? '\\' : '/';
  const name = platform === 'win32' ? 'lms.exe' : 'lms';
  const base = home.endsWith(sep) ? home.slice(0, -sep.length) : home;
  return [base, '.lmstudio', 'bin', name].join(sep);
}

/**
 * The command prefix to put in front of `ls --json`, `load …`, etc.
 *
 * Quoted when it is a path, because a Windows home directory contains spaces
 * often enough that an unquoted path is a silent wrong-command rather than an
 * error ("C:\Users\First Last\…" runs `C:\Users\First`).
 */
export function resolveLmsCommand(lookup: LmsLookup): string {
  const p = lmsBinaryPath(lookup.platform, lookup.home);
  if (p && lookup.exists(p)) return `"${p}"`;
  return 'lms';
}
