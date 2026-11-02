// Per-Entity capability folding — ONE definition, read by both sides.
//
// Why this file exists: "Dangerous tools ON + Full PC access OFF" was a label
// that did not describe the system. Measured, not assumed:
//
//   • runShellCommand(cmd, { cwd, timeoutMs }) never receives
//     agentFullSystemAccess, and never inspects the command. It runs
//     `bash -c "<whatever the model wrote>"` with cwd = the entity's
//     workspace. cwd is a starting directory, not a fence — `cat D:\x.txt`
//     works from it (verified by running exactly that).
//   • The shell is NOT OAuth-only. route.ts hands Bash to the Claude-API,
//     Gemini and OpenAI-compatible paths too, all four calling the same
//     unsandboxed runShellCommand.
//   • So the shell reaches everything this Windows process's token reaches,
//     whatever the Full-PC-access checkbox says. The checkbox was lying.
//
// The honest fix is to stop the UI from claiming a confinement that the
// shell already walks through — NOT to pretend the file tools are narrower
// than the shell sitting next to them.
//
// SAVED vs EFFECTIVE — the reason this is a function and not a mutation:
// the stored setting keeps recording what the OPERATOR chose. If we instead
// wrote `true` into settings.json, turning the shell back off would leave
// full access silently ON — a permission the operator never granted, made
// permanent by a fix meant to stop lying. Fold at the point of use; never
// at the point of storage.
export function effectiveFullAccess(
  savedFullAccess: boolean,
  dangerousTools: boolean,
): boolean {
  return !!savedFullAccess || !!dangerousTools;
}

// True when the Full-PC-access control must render as ON-and-locked because
// the shell is what is actually setting it. Separate from the value above so
// the UI can say WHY rather than just showing a checkbox the user can't move.
export function fullAccessForcedByShell(
  savedFullAccess: boolean,
  dangerousTools: boolean,
): boolean {
  return !!dangerousTools && !savedFullAccess;
}

/**
 * May this being read and search its own past conversations?
 * (`read_conversation`, `search_conversations`, `search_attachments`.)
 *
 * MEASURED 2026-11-02 (トカゲくん, on the work PC): the flag was ticked and
 * the tools were not there. Two names for one setting:
 *
 *   the UI writes            settings.enableConversationTools
 *   the runner was reading   settings.enableReadConversation   ← 0 beings have it
 *
 * `enableReadConversation` is the name of the API-request field, not of the
 * stored setting. The line that translated between them lived in the browser
 * turn engine and went with it when that was deleted (`524e1c3`, 764 lines) —
 * the same shape as F76 (the first-original marker) and the audio autoPlay
 * regression, and the third of that family.
 *
 * A field path that is absent everywhere reports a clean, reassuring answer:
 * `undefined === true` is `false`, so every runner turn said "no conversation
 * tools" and nothing failed, errored, or looked wrong.
 *
 * ── Why the fallback, and why it is not a default ──────────────────────────
 * Before this setting existed, these tools came with "use summaries for Layer
 * 4". A being whose settings predate the split has NEVER written the new key,
 * and reading it as `false` would silently take tools away from beings that
 * have them today. So an absent key means "whatever the old coupling gave
 * you" — resolved at read time, never written back (same SAVED vs EFFECTIVE
 * reasoning as `effectiveFullAccess` above).
 *
 * 8 of 23 beings carry the explicit key as of 2026-11-02; the other 15 are
 * answered by the fallback.
 */
export function conversationToolsEnabled(settings: {
  enableConversationTools?: unknown;
  useSummariesForLayer4?: unknown;
} | null | undefined): boolean {
  if (typeof settings?.enableConversationTools === 'boolean') {
    return settings.enableConversationTools;
  }
  return settings?.useSummariesForLayer4 === true;
}
