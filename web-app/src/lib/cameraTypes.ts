// Shared shapes for the being-camera / OBS feature — imported by both the
// server (cameraFiles.ts manifest builder, the camera-files/camera-file/
// camera-push API routes) and the client (CameraPanel.tsx). Kept in one place
// so the two sides can never quietly drift into incompatible field names.

/**
 * The coarse activity a being is in RIGHT NOW, as observed from the SSE
 * stream ChatArea already parses. Deliberately small — five states, not one
 * per tool — because the camera panel tolerates a 1-2s gap on every switch
 * (per spec) and because a state with no camera files just falls back to
 * Idle (see cameraFiles.ts resolveState). Add states by adding files, not by
 * widening this union: an unrecognized-but-plausible phase should degrade to
 * 'idle' rather than fail to compile.
 *
 *  - 'idle'     nothing in flight (no active turn, no audio playing)
 *  - 'thinking' extended-thinking text is streaming in, no visible reply yet
 *  - 'writing'  the visible reply is streaming
 *  - 'tool'     a tool call is in flight (OAuth path only — see ChatArea's
 *               liveToolName; other provider paths never populate a live
 *               tool name mid-turn, so they fall through to 'writing')
 *  - 'speaking' TTS audio is actually playing — see CameraSignal.speaking
 */
export type CameraPhase = 'idle' | 'thinking' | 'writing' | 'tool';

/**
 * What ChatArea reports on every relevant change. `speaking` is tracked
 * separately from `phase` (rather than folded into the union) because it is
 * the one signal explicitly required to override every other state — see
 * cameraFiles.ts resolveDesiredState, which checks `speaking` first and
 * ignores `phase` entirely when it is true.
 */
export interface CameraSignal {
  speaking: boolean;
  phase: CameraPhase;
  /** Raw (untranslated, stable) tool name, e.g. "web_search". Null outside phase 'tool'. */
  toolName: string | null;
}

/**
 * The resolved, ready-to-consume state->files map for one being's camera/
 * folder. Both `states` and `transitions` are ALREADY fallback-resolved on
 * the server (numbered pool if any files exist, else the single bare file,
 * else absent) — the client never has to re-implement the naming rules, it
 * just picks a random entry from whichever pool it's given.
 */
export interface CameraManifest {
  /** State name (as written in the filename, e.g. "Idle") -> pool of filenames. */
  states: Record<string, string[]>;
  /** `${from}->${to}` -> pool of transition filenames, played once. */
  transitions: Record<string, string[]>;
}

export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'] as const;
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

const VIDEO_EXT_SET = new Set<string>(VIDEO_EXTENSIONS);
const IMAGE_EXT_SET = new Set<string>(IMAGE_EXTENSIONS);

/**
 * Pure filename -> kind classification, shared by the server-side manifest
 * builder (cameraFiles.ts) and the client-side panel (CameraPanel.tsx) — the
 * panel needs this to decide <video> vs <img> for whatever file the manifest
 * handed it, and cannot import cameraFiles.ts itself (that file touches `fs`).
 */
export function cameraFileKind(filename: string): 'image' | 'video' | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filename.slice(dot).toLowerCase();
  if (VIDEO_EXT_SET.has(ext)) return 'video';
  if (IMAGE_EXT_SET.has(ext)) return 'image';
  return null;
}

/**
 * "web_search" -> "WebSearch". Turns a raw tool key into a filename-safe
 * state token with no underscores, so it can never collide with the `_N`
 * pool-numbering suffix or the `From_To` transition separator that
 * cameraFiles.ts parses on the other side.
 */
export function toolNameToStateToken(name: string): string {
  return name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Ordered candidate state names to try against a CameraManifest.states map —
 * first one with a non-empty pool wins, and the chain always ends at 'Idle'.
 * This is what makes "even a simple fallback should work" true: a being with
 * only Idle.mp4 and Writing.mp4 on disk still resolves something sensible for
 * every possible signal, and a video added for one specific tool later just
 * starts winning over the generic 'Tool' pool without any other change.
 *
 * `speaking` overrides every phase per spec ("mostly prioritized, overriding
 * any other actions") — checked first, unconditionally.
 */
export function resolveStateCandidates(signal: CameraSignal): string[] {
  if (signal.speaking) return ['Speaking', 'Idle'];
  switch (signal.phase) {
    case 'tool':
      return signal.toolName
        ? [`Tool${toolNameToStateToken(signal.toolName)}`, 'Tool', 'Thinking', 'Idle']
        : ['Tool', 'Thinking', 'Idle'];
    case 'thinking':
      return ['Thinking', 'Idle'];
    case 'writing':
      return ['Writing', 'Idle'];
    case 'idle':
    default:
      return ['Idle'];
  }
}

/** First candidate with a non-empty pool in `manifest.states`, or null if none exist. */
export function pickResolvedState(manifest: CameraManifest, signal: CameraSignal): string | null {
  for (const candidate of resolveStateCandidates(signal)) {
    if (manifest.states[candidate]?.length) return candidate;
  }
  return null;
}
