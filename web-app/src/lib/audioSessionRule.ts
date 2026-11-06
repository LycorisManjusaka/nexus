/**
 * Which audio-session rule text actually goes out.
 *
 * Three places used to carry the same hardcoded Japanese VRChat persona as a
 * literal (ChatArea twice, NexusApp once), so the default could not be
 * translated and could not be changed in one place. Worse, the literal was
 * written INTO the state box, which meant the field was never empty and the
 * placeholder was never visible — a reader could not tell "I typed this" from
 * "this is just the default".
 *
 * The resolution order is the only thing this file decides:
 *   1. what is stored on the conversation  — a human typed it, it wins
 *   2. the folder default                  — set once for a being
 *   3. the built-in fallback               — translated, shown as placeholder
 *
 * Keeping the box EMPTY for case 3 is load-bearing: the placeholder is the one
 * piece of UI that says "nothing is stored here", and it only renders when the
 * value is empty. So the fallback is applied at SEND time, never written into
 * the field. A being whose conversation already stores the old VRChat text
 * keeps it — nothing migrates stored data.
 */
export function resolveAudioSessionRule(
  stored: string | null | undefined,
  folderDefault: string | null | undefined,
  fallback: string,
): string {
  const s = (stored ?? '').trim();
  if (s) return s;
  const f = (folderDefault ?? '').trim();
  if (f) return f;
  return fallback;
}
