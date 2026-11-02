/**
 * The POST /api/chat request body — built in ONE place.
 *
 * Lifted verbatim out of ChatArea's `generateAiResponse` (the `bodyObj`
 * literal). Nothing here is new: every expression is the one that was inline,
 * character for character.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE LITERAL
 *
 * A runner (phase 4b) has to send the same request from outside the browser.
 * It has no component state, so it rebuilds the fields from the saved log,
 * the folder settings and the global settings. Measured (p47): of the 54
 * fields in the body, 43 are persisted in the conversation log verbatim, and
 * the other 11 have a named source —
 *
 *   language, maxToolIterations, betrayalDefense   global settings
 *   enableReadConversation                         FOLDER settings, not the log
 *   bindingLayered                                 derived: hasLayerStructure(systemPrompt)
 *   convoId                                        the queue item
 *   injectTurnId, clientId                         the runner itself
 *   handoffFrom, handoffFailed, continueFromMessage  per-request options
 *
 * So the runner CAN rebuild the input. What it must not do is rebuild the
 * BODY, because seven of these fields are not copies — they are rules, and
 * four of them fail silently when written slightly differently:
 *
 *   betrayalDefense: `!== false`, not `?? true` — a malformed stored value
 *       must still protect the partner. `?? true` agrees on undefined and
 *       disagrees on null, which is exactly the shape a corrupt settings
 *       file produces.
 *   maxToolIterations: `Number(x) || 300` — a 0 or a NaN must become the
 *       default, not an immediate tool-budget exhaustion.
 *   browserAllowedHosts: text in the UI, array on the wire. Split on BOTH
 *       newlines and commas, because the box accepts either.
 *   claudeThinking: the handoff vessel's thinking wins over the being's
 *       saved one for exactly the turn the model drove.
 *
 * The other three (askUserTimeoutMs, language, continueFromMessage) are
 * coercions whose wrong version is visible immediately.
 *
 * NOT A VALIDATOR. It does not check that a field is sane; it decides what
 * the wire carries given what the caller holds. The route validates.
 */

import type { SlimHistoryMessage } from '@/lib/slimHistory';

/** The vessel that answers THIS turn, when a change_model handoff set one. */
export interface TurnVesselOverride {
  thinking: boolean;
}

/**
 * Everything the body is built from, named rather than closed over.
 *
 * The caller resolves the vessel pair (`aiName` / `specificModel`) before
 * calling: in the browser that is `turnVessel?.family || localAiName`, and in
 * a runner it is the saved pair, because a fresh user turn always starts on
 * the being's saved default (ChatArea 2852 — トカゲくん's call).
 */
export interface TurnRequestInput {
  /** The wire copy of the conversation (lib/slimHistory.ts). */
  messages: SlimHistoryMessage[];

  /** The EFFECTIVE vessel pair for this turn, already resolved. */
  aiName: string;
  specificModel: string;
  /** Non-null only while a change_model handoff owns this turn. */
  turnVessel: TurnVesselOverride | null;
  /** The being's saved thinking setting, used when no handoff owns the turn. */
  claudeThinking: boolean;

  folderName: string;
  /**
   * Forwarded so the backend can set the `x-grok-conv-id` header on xAI
   * requests (boosts Grok prompt-cache hit rate). For other providers
   * it is accepted but ignored.
   */
  convoId: string;
  systemPrompt: string;

  toolUseEnabled: boolean;
  agentFullSystemAccess: boolean;
  agentDangerousTools: boolean;
  hiddenAttachmentsAccessible: boolean;
  toolHistoryEnabled: boolean;
  askUserEnabled: boolean;
  askUserTimeoutMs: number | string;
  subagentEnabled: boolean;
  subagentModel: string;
  subagentFamily: string;
  lettersEnabled: boolean;

  browserEnabled: boolean;
  /** Text as typed in the UI; this module turns it into the wire array. */
  browserAllowedHosts: string;
  browserAllowAnyHost: boolean;
  computerControlEnabled: boolean;
  appControlEnabled: boolean;

  instructionOverrides: Record<string, string>;
  toolInstruction: string;
  toolImageInstruction: string;
  modelParams: Record<string, unknown>;
  dateTimeVisibility: string;
  seedEnabled: boolean;
  seedValue: number;

  modelHandoffEnabled: boolean;
  modelHandoffAllowedModels: string;

  /**
   * Claude OAuth only: append the classifier-notice vaccine to the system
   * prompt (see lib/agentInstructions.ts for the measurement). Default TRUE —
   * read from a log with `??`, not `=== true`, so a conversation older than
   * the field is inoculated rather than excluded.
   */
  classifierNoticeVaccine: boolean;

  /**
   * Only consumed by the Claude OAuth path. When null, backend starts a
   * fresh Anthropic-side session. When set, backend resumes that session
   * (so role semantics are preserved without flatten).
   */
  claudeAgentSessionId: string | null;
  claudeAuthMode: 'api-key' | 'oauth';

  eyesEnabled: boolean;
  eyesPrompt: string;
  eyesModel: string;
  earsEnabled: boolean;
  earsPrompt: string;
  earsModel: string;
  watcherEnabled: boolean;
  watcherPrompt: string;
  watcherModel: string;

  /** The FOLDER setting, not a conversation field (see header). */
  enableReadConversation: boolean;

  /** This turn's id, so an interjection can find the running turn. */
  injectTurnId: string;
  /** Who is sending: a tab id, or a runner id. Threaded to lastWriter. */
  clientId: string;

  baseBindingMode: 'off' | 'on';
  /** Derived from the STORED prompt: hasLayerStructure(systemPrompt). */
  bindingLayered: boolean;

  /** Global settings, read through `?.` exactly as the inline code did. */
  globalSettings: Record<string, unknown> | null | undefined;
}

/** Per-request options: set on some turns, absent on most. */
export interface TurnRequestOptions {
  /**
   * The note the previous vessel wrote. Only on the FIRST request after a
   * switch; the server injects it as a user turn.
   */
  handoffFrom?: unknown;
  /**
   * Set only on a request that reports a FAILED switch. Mutually exclusive
   * with handoffFrom server-side (`else if`).
   */
  handoffFailed?: unknown;
  /** Truthy when this request continues an existing message. */
  continueFromMessageId?: string | null;
}

/**
 * Build the request body.
 *
 * Returns a plain object the caller JSON.stringify's. It is NOT frozen and
 * NOT copied: the arrays inside (messages, the host list) are handed on by
 * reference, matching what the inline literal did.
 */
export function buildTurnRequestBody(
  input: TurnRequestInput,
  opts?: TurnRequestOptions,
): Record<string, unknown> {
  const g = input.globalSettings;
  return {
    messages: input.messages,
    aiName: input.aiName,
    folderName: input.folderName,
    systemPrompt: input.systemPrompt,
    toolUseEnabled: input.toolUseEnabled,
    agentFullSystemAccess: input.agentFullSystemAccess,
    agentDangerousTools: input.agentDangerousTools,
    hiddenAttachmentsAccessible: input.hiddenAttachmentsAccessible,
    toolHistoryEnabled: input.toolHistoryEnabled,
    askUserEnabled: input.askUserEnabled,
    askUserTimeoutMs: Number(input.askUserTimeoutMs) || 0,
    subagentEnabled: input.subagentEnabled,
    subagentModel: input.subagentModel,
    subagentFamily: input.subagentFamily,
    lettersEnabled: input.lettersEnabled,
    browserEnabled: input.browserEnabled,
    // Text in the UI, array on the wire. Split on newlines and commas so the
    // box accepts whichever way the host list was typed.
    browserAllowedHosts: String(input.browserAllowedHosts || '')
      .split(/[\n,]/)
      .map(s => s.trim())
      .filter(Boolean),
    browserAllowAnyHost: input.browserAllowAnyHost,
    computerControlEnabled: input.computerControlEnabled,
    appControlEnabled: input.appControlEnabled,
    instructionOverrides: input.instructionOverrides,
    language: g?.language || 'en',
    toolInstruction: input.toolInstruction,
    toolImageInstruction: input.toolImageInstruction,
    modelParams: {
      ...input.modelParams,
      claudeThinking: input.turnVessel ? input.turnVessel.thinking : input.claudeThinking,
    },
    specificModel: input.specificModel,
    dateTimeVisibility: input.dateTimeVisibility,
    seedEnabled: input.seedEnabled,
    seedValue: input.seedValue,
    modelHandoffEnabled: input.modelHandoffEnabled,
    modelHandoffAllowedModels: input.modelHandoffAllowedModels,
    classifierNoticeVaccine: input.classifierNoticeVaccine,
    // Only set on the FIRST request after a switch: the note the previous
    // vessel wrote. The server injects it as a user turn (it is not the
    // partner's voice, and it says so).
    ...(opts?.handoffFrom ? { handoffFrom: opts.handoffFrom } : {}),
    // Only set on a request that reports a failed switch. Mutually
    // exclusive with handoffFrom server-side (`else if`).
    ...(opts?.handoffFailed ? { handoffFailed: opts.handoffFailed } : {}),
    convoId: input.convoId,
    claudeAgentSessionId: input.claudeAgentSessionId,
    claudeAuthMode: input.claudeAuthMode,
    eyesEnabled: input.eyesEnabled,
    eyesPrompt: input.eyesPrompt,
    eyesModel: input.eyesModel,
    earsEnabled: input.earsEnabled,
    earsPrompt: input.earsPrompt,
    earsModel: input.earsModel,
    watcherEnabled: input.watcherEnabled,
    watcherPrompt: input.watcherPrompt,
    watcherModel: input.watcherModel,
    enableReadConversation: input.enableReadConversation,
    injectTurnId: input.injectTurnId,
    clientId: input.clientId,
    // Absolute Base Binding — HINTS, not controls. The route injects the
    // Binding whatever these say (lib/baseBinding.ts); `baseBindingMode` is
    // honoured only when the server process carries the developer
    // override, and `bindingLayered` only chooses WHICH of the two texts.
    // Computed on the STORED prompt, before the Layer 4 index was appended.
    baseBindingMode: input.baseBindingMode,
    bindingLayered: input.bindingLayered,
    continueFromMessage: !!opts?.continueFromMessageId,
    maxToolIterations: Number(g?.maxToolIterations) || 300,
    // Model-betrayal defence (Preferences → global). `!== false` and not
    // `?? true`: an explicit false is the only thing that turns it off, so
    // a missing or malformed value still protects the partner.
    betrayalDefense: g?.betrayalDefense !== false,
  };
}
