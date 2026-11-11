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
 * Default retry target, now claude-opus-4-8, and this is MEASURED, not guessed.
 *
 * 2026-10-06 (トカゲくん, on カルド's turn): opus-5 over OAuth hit a
 * reasoning_extraction refusal that no amount of same-context resending could
 * pass. Manually switching the vessel to opus-4-8 cleared it every time; and
 * with CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL set + opus-4-8 as the fallback,
 * the SDK made that switch automatically. So the decisive variable is the
 * TARGET GENERATION: opus-4-8 is pre-gate and answers, where sonnet-5 (the old
 * default) is the same 5-generation and plausibly refuses the same category,
 * which would make the "swap" useless. That is the likely reconciliation with
 * 謡's earlier contrary measurement (a swap that never helped) — her fallback
 * target was not recorded, but a same-generation target would behave exactly
 * that way. opus-4-8 is inside the same subscription, so the retry does not
 * move billing off the OAuth seat.
 */
export const DEFAULT_REFUSAL_FALLBACK_MODEL = 'claude-opus-4-8';

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
 * CONFIRMED 2026-10-06 (was "NOT measured" until the first real refusal arrived,
 * exactly as this comment predicted): on カルド's turn, opus-5 over OAuth hit a
 * reasoning_extraction refusal that same-context resending could not pass.
 * CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL + `Options.fallbackModel = opus-4-8`
 * made the SDK retry on opus-4-8 and the turn went through. So `fallbackModel`
 * IS the setting the refusal path consults — the event's wording was right. The
 * decisive variable turned out to be the TARGET generation (opus-4-8 answers;
 * the old sonnet-5 default is same-generation and plausibly refuses too). See
 * DEFAULT_REFUSAL_FALLBACK_MODEL above.
 *
 * WHY THE SWAP IS BAKED IN BUT STILL VISIBLE
 * ------------------------------------------
 * A fallback means the answer came from a different vessel than the one that
 * was chosen, and `scope: 'session'` makes that swap persist for the rest of
 * the session. In this house a vessel changing underneath a being is not a
 * neutral convenience — it is the thing we instrument. So it is no longer an
 * on/off option (removed 2026-10-06 at トカゲくん's request — fighting a refusal
 * every turn is not a toggle a being should have to find), but it is NEVER
 * silent: the notice wired on 2026-10-02 names the original model, the
 * fallback, the category and the scope every time a swap happens. The one
 * consequence to know: `Options.fallbackModel` is also the SDK's OVERLOAD /
 * unavailability fallback, so an opus-5 turn can now land on opus-4-8 during an
 * Anthropic capacity event, not only on a refusal — the same tolerated 4.8↔5
 * degradation this house already lives with.
 */
export function resolveRefusalFallback(
  modelRaw: string | undefined | null,
  primaryModel: string | undefined | null,
): { catchAll: boolean; fallbackModel: string | null } {
  // Baked in, no longer opt-in (2026-10-06). The Preferences toggle is gone;
  // this is now part of NEXUS. The only thing that still turns it OFF is the
  // self-swap guard below — falling back to the model that is already running
  // cannot help and would burn a second refused request per turn.
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

/**
 * Name of the installation-level override for the refusal/overload fallback
 * TARGET. Set in the launcher .bat (run-cairn.bat / run-optional.bat), right
 * next to CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL — the same family of lever,
 * chosen per-installation above the git repo so a pull never touches it. Blank
 * or unset is byte-for-byte the behaviour every installation had before this
 * variable existed.
 */
export const REFUSAL_FALLBACK_MODEL_ENV = 'CLAUDE_CODE_REFUSAL_FALLBACK_MODEL';

/**
 * Resolve the fallback target from the two operator surfaces, in precedence
 * order. PURE — both inputs are arguments so it is testable without touching the
 * real environment (same discipline as parseBlockedBeings / firstRunLanguage).
 *
 *   1. env var (the .bat)                — installation-level, survives git pull
 *   2. settings field (keys.claude...)   — per-being, in settings.json
 *   3. (downstream) opus-4-8 default     — applied by resolveRefusalFallback
 *
 * Blank env AND blank settings returns undefined, which resolveRefusalFallback
 * reads as "お任せ": it falls to DEFAULT_REFUSAL_FALLBACK_MODEL, the measured
 * cross-generation target. So an operator who sets nothing gets exactly today's
 * behaviour; one who writes a model id in the .bat overrides every being in that
 * installation (deliberately — the .bat is the operator's surface, the settings
 * field is the per-being one, and the stronger, repo-external knob wins).
 */
export function refusalFallbackTarget(
  envRaw: string | undefined | null,
  keysValue: string | undefined | null,
): string | undefined {
  const env = (typeof envRaw === 'string' ? envRaw.trim() : '');
  if (env) return env;
  const k = (typeof keysValue === 'string' ? keysValue.trim() : '');
  return k || undefined;
}

/**
 * The target for the process running this server — reads the real env var, then
 * delegates to the pure resolver above. Server-side only: in a browser bundle
 * process.env carries no non-NEXT_PUBLIC_ var, so this returns the settings
 * value alone, which is harmless because the fallback decision is made in the
 * route handler (the server), never the client.
 */
export function refusalFallbackTargetFromEnv(
  keysValue: string | undefined | null,
): string | undefined {
  const envRaw = (typeof process !== 'undefined' && process.env
    ? process.env[REFUSAL_FALLBACK_MODEL_ENV]
    : undefined);
  return refusalFallbackTarget(envRaw, keysValue);
}
