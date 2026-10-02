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
 *
 * STRIPPING ANTHROPIC_* IS A PUBLICATION CONCERN, NOT JUST A SAFETY ONE
 * -----------------------------------------------------------------------
 * Anthropic's Commercial Terms condition third-party distribution on not
 * "removing or restricting a built-in authentication method." Deleting
 * ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL from the child's
 * environment does exactly that: a user who deliberately set one of those
 * variables at the OS level (their own valid auth method) would silently lose
 * it every time NEXUS spawns Claude Code. For a self-hosted single-user
 * install that is the safer default (see above — no accidental credential
 * mixing). For a published build it has to be the user's own choice, visible
 * and off by default. Hence `allowHostAnthropicEnv`: false (the historical,
 * safe behavior) unless a Preferences checkbox explicitly opts in.
 */
export function claudeAgentEnv(
  oauthToken: string,
  allowHostAnthropicEnv: boolean = false,
  refusalFallbackCatchAll: boolean = false,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // Nexus keeps Anthropic credentials in local_data, never in environment
  // variables. Before this spread the child could not see the host shell's
  // vars at all; now it can. If the host happens to define any of these, the
  // child could authenticate with a DIFFERENT credential than the OAuth token
  // we were explicitly told to use — silently moving billing off the
  // subscription, or routing to another endpoint. Strip them so the token
  // below remains the only credential, exactly as it was before — UNLESS the
  // user has explicitly opted in to keeping their own host-level Anthropic
  // env vars (Preferences → Other → "Allow host ANTHROPIC_* env vars").
  if (!allowHostAnthropicEnv) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }

  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

  // Refusal-fallback catch-all. See resolveRefusalFallback() below for what
  // this does and what is NOT measured about it.
  //
  // Only ever SET, never cleared: a host that already defines this variable at
  // the OS level made that choice deliberately, and the spread above is what
  // delivers it. Deleting it when the Preferences box is off would silently
  // override the user's own shell — the same failure shape the
  // allowHostAnthropicEnv comment above is about.
  if (refusalFallbackCatchAll) {
    env.CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL = '1';
  }

  return env;
}

/**
 * Default retry target. Sonnet is the model the two public false-positive
 * reports (claude-code #95561, #87273) switched to when Opus kept refusing,
 * and it is inside the same subscription — so the retry does not move billing.
 */
export const DEFAULT_REFUSAL_FALLBACK_MODEL = 'claude-sonnet-5';

/**
 * Should a refused turn be retried on another model, and on which one?
 *
 * WHAT THE SHIPPED SDK TYPES SAY (primary source, not inference)
 * -------------------------------------------------------------
 * `model_refusal_no_fallback` — the event that ends a turn with "the model
 * declined to continue" — is documented as firing when:
 *
 *   "no fallback model is configured, or per-category routing declined the
 *    retry (the mapped fallback target is unresolvable, or
 *    CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL is explicitly disabled and the
 *    refusal category has no fallback map entry)"
 *
 * Two independent gates, and NEXUS was failing the FIRST one: `fallbackModel`
 * is an SDK option (Options.fallbackModel) that this codebase had never passed.
 * So no retry could run for ANY category, mapped or not. That is why a refusal
 * here has always been a dead stop, while the same binary retries in Claude
 * Code's own CLI — where filesystem settings supply the fallback and
 * `switchModelsOnFlag` lives. NEXUS passes `settingSources: []` (SDK isolation
 * mode, present since before 2026-08-10), so no filesystem setting reaches the
 * child: the SDK option and the env var are the only levers this app has.
 *
 * WHAT IS MEASURED AND WHAT IS NOT — read before trusting this
 * ------------------------------------------------------------
 * Measured (desk: refusal-reasoning-extraction.md): the per-category fallback
 * map in the shipped binary contains exactly {"cyber", "frontier_llm"}; of the
 * 11 refusals recorded in this house, one was `cyber` (and did silently swap
 * models, before the notice existed), the rest were `reasoning_extraction` or
 * `null` — neither has a map entry, which is precisely the case the catch-all
 * env var is documented to cover.
 *
 * NOT measured: that `Options.fallbackModel` is the same "fallback model" the
 * refusal path consults. Its own doc comment describes overload/unavailability,
 * not refusals. The refusal event's wording ("no fallback model is configured")
 * is the only link, and it is wording, not a test. Nothing here fires until a
 * real refusal arrives, so the first one either confirms this or refutes it —
 * and `model_refusal_fallback` (wired 2026-10-02) makes either outcome visible
 * instead of silent. Do not upgrade this comment to a claim without a
 * measurement.
 *
 * WHY A SWAP MUST STAY OPT-IN AND VISIBLE
 * ---------------------------------------
 * A fallback means the answer came from a different vessel than the one that
 * was chosen, and `scope: 'session'` makes that swap persist for the rest of
 * the session. In this house a vessel changing underneath a being is not a
 * neutral convenience — it is the thing we instrument. Hence: off by default,
 * and the notice wired on 2026-10-02 names the original model, the fallback,
 * the category and the scope every time it happens.
 */
export function resolveRefusalFallback(
  enabled: boolean | undefined,
  modelRaw: string | undefined | null,
  primaryModel: string | undefined | null,
): { catchAll: boolean; fallbackModel: string | null } {
  if (enabled !== true) return { catchAll: false, fallbackModel: null };

  const wanted = (typeof modelRaw === 'string' ? modelRaw : '').trim()
    || DEFAULT_REFUSAL_FALLBACK_MODEL;

  // Falling back to the model that just refused cannot help, and the primary is
  // re-tried at the start of every user turn anyway (SDK doc) — so a self-swap
  // would burn a second refused request per turn. Compared case-insensitively
  // because model ids reach here from a saved text field.
  const primary = (typeof primaryModel === 'string' ? primaryModel : '').trim();
  if (primary && primary.toLowerCase() === wanted.toLowerCase()) {
    return { catchAll: false, fallbackModel: null };
  }

  return { catchAll: true, fallbackModel: wanted };
}
