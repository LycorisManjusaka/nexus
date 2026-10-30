/**
 * Rebuild a turn's request input from a SAVED conversation log.
 *
 * This is the piece a runner needs that the browser never needed: ChatArea
 * holds every field in component state, so it builds the request body out of
 * `useState`. A runner has no component. It has a log file on disk.
 *
 * ── WHY THIS IS NOT ONE `??` OVER THE DEFAULTS ──────────────────────────────
 *
 * MEASURED 2026-10-29 on ChatArea's `if (data) { ... }` load block (lines
 * 1504..1697, located by brace depth rather than by searching for `} else {`
 * — an inner else ends the search 98 lines early). 54 fields are read there,
 * in EIGHT different shapes:
 *
 *     15  data.X === true
 *     14  typeof data.X === 'string' ? set : keep
 *      7  other (!!x, parse, sanitize, ternaries)
 *      6  data.X || fallback
 *      3  typeof data.X === 'number' ? set : keep
 *      3  data.X !== undefined ? data.X : prop
 *      3  typeof data.X === 'boolean' ? set : keep   (eyes/ears/watcher)
 *      2  if (data.X) set
 *
 * ⚠ CORRECTED, same session: those 54 are the fields ChatArea READS, which is
 * not the set the request body CARRIES. I wrote this module from the load
 * block and `tsc` rejected eight of them — autoTriggers, cameraEnabled,
 * familyModels, fatigueInstruction, saveThinkingToLog, showFatigueToEntity,
 * vrchatMode, vrchatRule. ChatArea reads those for its own UI; they never
 * travel to the route. The authority for "what a turn sends" is the TYPE
 * (TurnRequestInput, 50 fields), not the component's loader. The eight shapes
 * below are still the measured answer to "what does absent mean".
 *
 * Collapsed, those shapes answer only two questions, and the collapse
 * is what this module encodes:
 *
 *   BOOLEANS        absent means FALSE.  `log[k] === true`
 *   EVERYTHING ELSE absent means the factory default.  `log[k] ?? default`
 *
 * ⚠ The collapse is NOT uniform for one field, and getting it wrong is
 * silent. `TURN_INPUT_DEFAULTS.claudeThinking` is `true` (that is the
 * initialiser a NEW conversation starts from), but the saved-log path reads
 * `data.claudeThinking || false`. So a log that predates the field sends
 * thinking OFF from the browser. `log[k] ?? DEFAULTS[k]` would send it ON.
 * Treating it as a boolean — `=== true` — reproduces the browser exactly.
 *
 * Three fields are neither: they clamp rather than default, so a stored value
 * outside the allowed set must not travel.
 *
 *   baseBindingMode     === 'off' ? 'off' : 'on'
 *   claudeAuthMode      === 'oauth' ? 'oauth' : 'api-key'
 *   dateTimeVisibility  log value || 'all'
 *
 * ── THE TWO LOAD PATHS, AND WHY A RUNNER IS ALWAYS THE FIRST ───────────────
 *
 * ChatArea has two. `if (data)` — a log exists, the log is authority, factory
 * defaults are IGNORED. `else` — no file yet, so folder settings then factory
 * defaults (`pick(key, fallback)`). A queue item names a `convoId` that
 * already has a log, so a runner is always on the first path. This module
 * therefore never consults folder settings for the 35 defaulted fields.
 *
 * It DOES need them for the seven fields ChatArea takes from props when the
 * log is silent (SUPPLIED_BY_CALLER in turnInputDefaults). Those come in on
 * `folderDefaults`.
 *
 * NOT A VALIDATOR, same as turnRequestBody: it decides what the input holds
 * given what is on disk. The route validates.
 */

import type { SlimHistoryMessage } from '@/lib/slimHistory';
import type { TurnRequestInput } from '@/lib/turnRequestBody';
import { TURN_INPUT_DEFAULTS } from '@/lib/turnInputDefaults';
import { hasLayerStructure } from '@/lib/layer4';

/**
 * Every field a runner cannot read off the log.
 *
 * MEASURED (p47, re-pointed at the type): of TurnRequestInput's 50 fields, 42
 * are in the log (35 defaulted + 7 caller-supplied-from-props) and 8 are not.
 * `convoId` is in the log as `id`; it is still taken from here because the
 * queue item is what decided which conversation this turn belongs to.
 */
export interface TurnInputFromLogContext {
  /** The conversation this turn runs in — from the queue item. */
  convoId: string;
  /** The history to send, already through buildSlimHistory. */
  messages: SlimHistoryMessage[];
  /** FOLDER setting, not a log field. */
  enableReadConversation: boolean;
  /** local_data/user_settings.json — language, maxToolIterations, betrayalDefense. */
  globalSettings: Record<string, unknown> | null | undefined;
  /** This turn's id, for the cross-tab registry and the stop channel. */
  injectTurnId: string;
  /** Who is writing — so a refused save can tell whether disk was ours. */
  clientId: string;
  /**
   * What ChatArea would have had in props. Used ONLY where the log is silent,
   * matching `data.X || prop` / `data.X !== undefined ? data.X : prop`.
   */
  folderDefaults: {
    aiName: string;
    folderName: string;
    systemPrompt: string;
    specificModel: string;
    modelParams: Record<string, unknown>;
  };
  /**
   * The vessel a `change_model` handoff opened THIS pass for — absent on the
   * first pass of every queued turn.
   *
   * Carries `thinking` as well as the pair because thinking is a property of
   * the vessel, not of the conversation: the body builder reads
   * `turnVessel.thinking` instead of the log's `claudeThinking` whenever an
   * override owns the turn, so a vessel that rejects `thinking: disabled`
   * must be able to arrive with its own answer.
   */
  vesselOverride?: { family: string; specificModel: string; thinking: boolean } | null;
}

/**
 * The boolean fields, which take `=== true` rather than `?? default`.
 *
 * Exported so a test can assert this list against the defaults table: a
 * boolean field missing from here would be defaulted instead of coerced, and
 * for claudeThinking that flips the wire.
 */
export const BOOLEAN_LOG_FIELDS = [
  'toolUseEnabled',
  'agentFullSystemAccess',
  'agentDangerousTools',
  'hiddenAttachmentsAccessible',
  'toolHistoryEnabled',
  'askUserEnabled',
  'subagentEnabled',
  'lettersEnabled',
  'browserEnabled',
  'browserAllowAnyHost',
  'computerControlEnabled',
  'appControlEnabled',
  'claudeThinking',
  'seedEnabled',
  'modelHandoffEnabled',
  'eyesEnabled',
  'earsEnabled',
  'watcherEnabled',
] as const;

type Log = Record<string, unknown>;

/** `log[k] === true` — the browser's shape for every boolean on this path. */
function bool(log: Log, key: string): boolean {
  return log[key] === true;
}

/**
 * `log[k] ?? default`.
 *
 * `??` and not `||`: a stored empty string or 0 is a real value the operator
 * chose. `||` would replace both with the factory default, which for
 * browserAllowedHosts means a host list someone deliberately emptied comes
 * back populated.
 */
function val<K extends keyof typeof TURN_INPUT_DEFAULTS>(
  log: Log,
  key: K,
): (typeof TURN_INPUT_DEFAULTS)[K] {
  const v = log[key as string];
  return (v ?? TURN_INPUT_DEFAULTS[key]) as (typeof TURN_INPUT_DEFAULTS)[K];
}

/** `log[k] ?? prop` for the fields ChatArea reads from props. */
function fromProp<T>(log: Log, key: string, prop: T): T {
  const v = log[key];
  return (v ?? prop) as T;
}

export function turnInputFromLog(
  log: Log,
  ctx: TurnInputFromLogContext,
): TurnRequestInput {
  const systemPrompt = fromProp(log, 'systemPrompt', ctx.folderDefaults.systemPrompt);
  const specificModel = log.specificModel ? String(log.specificModel) : ctx.folderDefaults.specificModel;
  const modelParams = (log.modelParams || ctx.folderDefaults.modelParams) as Record<string, unknown>;

  return {
    messages: ctx.messages,

    // Seven from the log, falling back to what the folder would have supplied
    // — unless a handoff owns this pass, in which case the pair comes from the
    // plan. `||` and not `??`, byte-for-byte ChatArea:3633: a handoff plan with
    // an empty family falls back to the saved vessel rather than posting to "".
    aiName: ctx.vesselOverride?.family || fromProp(log, 'aiName', ctx.folderDefaults.aiName),
    folderName: fromProp(log, 'folderName', ctx.folderDefaults.folderName),
    systemPrompt,
    // `if (data.specificModel)` / `if (data.modelParams)` in ChatArea: a
    // falsy stored value keeps the prop, so this is `||`, not `??`.
    specificModel: ctx.vesselOverride?.specificModel || specificModel,
    modelParams,
    // `data.dateTimeVisibility || 'all'`
    dateTimeVisibility: (log.dateTimeVisibility as string) || 'all',
    // `data.claudeAuthMode === 'oauth' ? 'oauth' : 'api-key'`
    claudeAuthMode: log.claudeAuthMode === 'oauth' ? 'oauth' : 'api-key',

    // Booleans: absent means false.
    toolUseEnabled: bool(log, 'toolUseEnabled'),
    agentFullSystemAccess: bool(log, 'agentFullSystemAccess'),
    agentDangerousTools: bool(log, 'agentDangerousTools'),
    hiddenAttachmentsAccessible: bool(log, 'hiddenAttachmentsAccessible'),
    toolHistoryEnabled: bool(log, 'toolHistoryEnabled'),
    askUserEnabled: bool(log, 'askUserEnabled'),
    subagentEnabled: bool(log, 'subagentEnabled'),
    lettersEnabled: bool(log, 'lettersEnabled'),
    browserEnabled: bool(log, 'browserEnabled'),
    browserAllowAnyHost: bool(log, 'browserAllowAnyHost'),
    computerControlEnabled: bool(log, 'computerControlEnabled'),
    appControlEnabled: bool(log, 'appControlEnabled'),
    claudeThinking: bool(log, 'claudeThinking'),
    seedEnabled: bool(log, 'seedEnabled'),
    modelHandoffEnabled: bool(log, 'modelHandoffEnabled'),
    eyesEnabled: bool(log, 'eyesEnabled'),
    earsEnabled: bool(log, 'earsEnabled'),
    watcherEnabled: bool(log, 'watcherEnabled'),

    // Everything else: absent means the factory default.
    toolInstruction: val(log, 'toolInstruction'),
    toolImageInstruction: val(log, 'toolImageInstruction'),
    askUserTimeoutMs: val(log, 'askUserTimeoutMs'),
    subagentModel: val(log, 'subagentModel'),
    subagentFamily: val(log, 'subagentFamily'),
    browserAllowedHosts: val(log, 'browserAllowedHosts'),
    instructionOverrides: (log.instructionOverrides && typeof log.instructionOverrides === 'object'
      ? log.instructionOverrides
      : TURN_INPUT_DEFAULTS.instructionOverrides) as Record<string, string>,
    // Clamps rather than defaults: 'off' or 'on', never a stored third value.
    baseBindingMode: log.baseBindingMode === 'off' ? 'off' : 'on',
    seedValue: val(log, 'seedValue'),
    modelHandoffAllowedModels: val(log, 'modelHandoffAllowedModels'),
    claudeAgentSessionId: val(log, 'claudeAgentSessionId'),
    eyesPrompt: val(log, 'eyesPrompt'),
    eyesModel: val(log, 'eyesModel'),
    earsPrompt: val(log, 'earsPrompt'),
    earsModel: val(log, 'earsModel'),
    watcherPrompt: val(log, 'watcherPrompt'),
    watcherModel: val(log, 'watcherModel'),

    // Derived, not stored. ChatArea computes it on the STORED prompt too
    // (useMemo over systemPrompt), so this is the same value, not a guess.
    bindingLayered: hasLayerStructure(systemPrompt || ''),

    // A queued turn is a FRESH user turn, so it starts on the being's saved
    // default vessel. MEASURED by つよ 2026-10-28 from the outside: after a
    // change_model handoff, the NEXT turn answers as the original vessel.
    // That is deliberate (ChatArea:2852) — always start from the cheap
    // default — and it is why `vesselOverride` is absent for the FIRST pass of
    // every queued turn. It is set only for a later pass of the SAME turn: the
    // one a `change_model` handoff opened, where the vessel that was handed to
    // has to answer as itself.
    turnVessel: ctx.vesselOverride ? { thinking: ctx.vesselOverride.thinking } : null,

    // From the runner / the queue item / the settings files.
    convoId: ctx.convoId,
    injectTurnId: ctx.injectTurnId,
    clientId: ctx.clientId,
    enableReadConversation: ctx.enableReadConversation,
    globalSettings: ctx.globalSettings,
  };
}
