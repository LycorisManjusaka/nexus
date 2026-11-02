// ────────────────────────────────────────────────────────────────────────────
// The request body one SPU provider call sends.
//
// Moved here 2026-10-31 from SystemPromptUpdater.tsx, where it sat inline in a
// browser fetch(). The loop runs server-side now (lib/spuRun.ts), and a body
// assembled in two places is a body that drifts in one of them: every flag
// below is deliberate, several of them are load-bearing for a run that WRITES
// A SOUL FILE, and a second copy would have to be kept honest by nothing but
// attention.
//
// The comments are the original measurements, moved mechanically. Read them
// before changing a flag: three of them record a specific way a soul-writing
// run was damaged.
// ────────────────────────────────────────────────────────────────────────────

export interface SpuChatBodyArgs {
  /** The turns for THIS call - buildSpuTurns() output. */
  messages: unknown[];
  /**
   * The AGENT's instruction file. Not the subject's identity: see
   * suppressLayer5 below for what goes wrong when the route treats it as one.
   */
  systemPrompt: string;
  folderName: string;
  aiName: string;
  specificModel: string;
  modelParams: Record<string, unknown>;
  /** Claude only: forces the billing path. Omitted -> the route's usual 'auto'. */
  authMode?: 'oauth' | 'api-key';
  /**
   * The relay key and turn id this run answers to, so Stop can abort the call
   * that is ALREADY IN FLIGHT.
   *
   * Without them the chat route never registers a stop hook (it needs both -
   * route.ts: `if (convoId && injectTurnId)`), and a Stop could only take
   * effect at the next round boundary. In the browser this came for free: the
   * tab aborted its own fetch, the connection dropped, and the route saw
   * `req.signal`. A module-level call has no connection to drop.
   *
   * `convoId` here is the SPU relay key (`spu:<being>:<label>`), NOT a
   * conversation. Safe because the two things the route does with it are the
   * stop hook and letter announcements - and letters are not reachable at all
   * under `agentReadOnlyTools`, which forces Read/Glob/Grep only.
   */
  convoId?: string;
  injectTurnId?: string;
}

export function buildSpuChatBody(a: SpuChatBodyArgs): Record<string, unknown> {
  const messages = a.messages;
  const folderName = a.folderName;
  const sys = a.systemPrompt;
  const runAiName = a.aiName;
  const runModel = a.specificModel;
  const runAuthMode = a.authMode;
  const modelParams = a.modelParams;
  return {
    messages,
    aiName: runAiName,
    folderName,
    systemPrompt: sys,
    toolUseEnabled: false,
    // Read/Glob/Grep only, scoped to this being's own workspace — the
    // same sandbox and relative-path root the being's own tool calls
    // already use. No Write/Edit/Delete/Bash regardless of provider or
    // of this entity's own agentDangerousTools/agentFullSystemAccess
    // settings; the route forces both off server-side for this flag.
    agentReadOnlyTools: true,
    // `sys` here is an AGENT's instruction file, not the entity's identity.
    // Without this the chat route appends the entity's FOOTER.md to it as
    // "Layer 5: The Signature (Self-Authored)" — the agent would read the
    // target's first-person signature as part of its OWN instructions. The
    // footer is still shown to the agent, explicitly labelled as
    // reference-only, inside the user message.
    suppressLayer5: true,
    // `enableGrokNativeSearch: false` is not a preference, it is a
    // requirement. That toggle sends the whole turn to xAI's /v1/responses
    // endpoint, which returns before the tool loop — an agent run there has
    // no Read/Glob/Grep at all, so it cannot open the very files it is being
    // told to read, and the shape it answers in is a search answer rather
    // than the layered output this panel parses. A folder-level toggle must
    // not be able to do that to a soul-writing run.
    modelParams: { ...modelParams, claudeThinking: false, enableGrokNativeSearch: false },
    specificModel: runModel,
    ...(runAuthMode ? { claudeAuthMode: runAuthMode } : {}),
    // Both or neither: the route's guard is `convoId && injectTurnId`, so one
    // without the other is a silently un-stoppable run. See SpuChatBodyArgs.
    ...(a.convoId && a.injectTurnId
      ? { convoId: a.convoId, injectTurnId: a.injectTurnId }
      : {}),
    dateTimeVisibility: 'none',
    seedEnabled: false,
    // Model-betrayal defence OFF here, and deliberately so. The defence
    // protects a PARTNER reading a live conversation: it aborts the turn
    // and throws the output away. This caller is not a conversation — it
    // is an agent whose output gets WRITTEN to a soul file. Aborting it
    // mid-stream would save a truncated layer, and the panel has no UI to
    // explain why. On top of that, an agent summarising a conversation
    // about someone's health quotes exactly the words the detector hunts
    // for. The detector still runs server-side (the route defaults it ON
    // when the field is missing); this line is what keeps the run intact.
    betrayalDefense: false,
  };
}
