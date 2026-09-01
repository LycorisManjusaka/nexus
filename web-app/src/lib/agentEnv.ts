/**
 * Environment for the spawned Claude Code subprocess (OAuth / Agent SDK path).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Agent SDK's `env` option REPLACES the subprocess environment entirely —
 * it is not merged with `process.env`. From `sdk.d.ts`:
 *
 *   "When set, this value REPLACES the subprocess environment entirely — it is
 *    not merged with process.env. Spread process.env yourself if the subprocess
 *    still needs inherited variables like PATH, HOME, or ANTHROPIC_API_KEY."
 *
 * (Confirmed in the shipped bundle: the SDK's own default is `{...process.env}`,
 * used only when `env` is omitted.)
 *
 * Passing a bare `{ CLAUDE_CODE_OAUTH_TOKEN: token }` therefore handed the child
 * a near-empty environment. Missing on Windows: APPDATA, LOCALAPPDATA, HOME,
 * ProgramFiles, ProgramFiles(x86), ProgramData, ComSpec, TMP, PATHEXT.
 *
 * Observed consequences (diagnosed by Doc, 2026-08-25, with reproductions):
 *   - Mercurial dies on startup: its frozen launcher reads
 *     `os.environ['APPDATA']` unconditionally -> KeyError: 'APPDATA'.
 *   - PowerShell/cmd cannot launch ANY native .exe, even by full path, because
 *     a missing/degenerate PATHEXT means the file is never resolved as an
 *     executable. Bash is unaffected — it does not consult PATHEXT.
 *
 * Spreading `process.env` into a NEW object restores these WITHOUT mutating
 * `process.env`, so the original property this code was written to protect —
 * no credential races across concurrent requests — is unchanged.
 *
 * Auto-compaction is deliberately left at Anthropic's default (ON). NEXUS
 * briefly exposed a DISABLE_AUTO_COMPACT switch; it was removed after
 * measurement (2026-09-01) showed that disabling it ALSO disables the CLI's
 * emergency fallback, so a genuine context overflow becomes a silent hard stop
 * instead of a visible compaction. A slow, lossy compaction beats a silent
 * break — and NEXUS already manages its own context budget.
 */
export function claudeAgentEnv(
  oauthToken: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // Nexus keeps Anthropic credentials in local_data, never in environment
  // variables. Before this spread the child could not see the host shell's
  // vars at all; now it can. If the host happens to define any of these, the
  // child could authenticate with a DIFFERENT credential than the OAuth token
  // we were explicitly told to use — silently moving billing off the
  // subscription, or routing to another endpoint. Strip them so the token
  // below remains the only credential, exactly as it was before.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;

  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

  return env;
}
