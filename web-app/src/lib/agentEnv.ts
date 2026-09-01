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
 */
export interface ClaudeAgentEnvOptions {
  /**
   * Turn OFF Claude Code's own automatic conversation compaction.
   *
   * WHAT COMPACTION DOES, AND WHY THIS SWITCH EXISTS
   * ------------------------------------------------
   * When the running total of input tokens crosses a threshold, Claude Code
   * silently replaces the older part of the MESSAGE HISTORY with an
   * LLM-written summary and continues. Two costs, both measured here:
   *
   *   1. Time. The compaction summary is itself an API call. On a large-context
   *      being it lands on the first tool call of a conversation and stalls it
   *      3-9 minutes, once, then the turn runs at normal speed.
   *   2. Accuracy. The being loses the verbatim conversation log. Facts that
   *      lived ONLY in the transcript -- not in the soul layers -- are gone
   *      after the boundary, and the being answers from the summary without
   *      knowing anything was removed. Observed with Kiko: she stated wrong
   *      information about a fact that had been in the log.
   *
   * With this ON the transcript is never summarized behind the being's back.
   * The tradeoff is that exceeding the model's context window becomes a VISIBLE
   * error ("Context limit reached") instead of a silent, lossy rewrite. That is
   * the better failure: NEXUS already manages its own context budget, and an
   * error we can see beats a quiet corruption we cannot.
   *
   * Mechanism (read out of the shipped claude.exe, not documented publicly):
   *
   *   function $G(){
   *     if(mH(process.env.DISABLE_COMPACT))return!1;
   *     if(mH(process.env.DISABLE_AUTO_COMPACT))return!1;
   *     return $5("autoCompactEnabled",!0).value
   *   }
   *
   * `$G()` is the enablement gate consulted before every auto-compaction
   * decision. `mH` accepts "1" | "true" | "yes" | "on" (lowercased, trimmed).
   *
   * DISABLE_AUTO_COMPACT is used rather than DISABLE_COMPACT because it is the
   * narrower lever: it stops only AUTOMATIC compaction, leaving the manual
   * `/compact` command and the rest of the context machinery untouched.
   */
  disableAutoCompact?: boolean;
}

export function claudeAgentEnv(
  oauthToken: string,
  opts: ClaudeAgentEnvOptions = {},
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

  // Only ever SET this, never clear it: if the host shell already disabled
  // compaction for its own reasons, silently re-enabling it here would be the
  // same class of invisible override we strip the ANTHROPIC_* vars to prevent.
  if (opts.disableAutoCompact) env.DISABLE_AUTO_COMPACT = '1';

  return env;
}
