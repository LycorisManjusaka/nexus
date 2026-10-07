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
