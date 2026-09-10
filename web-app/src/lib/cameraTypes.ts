// Shared shapes for the being-camera / OBS feature — imported by both the
// server (cameraFiles.ts manifest builder, the camera-files/camera-file/
// camera-push API routes) and the client (CameraPanel.tsx). Kept in one place
// so the two sides can never quietly drift into incompatible field names.

/**
 * The coarse activity a being is in RIGHT NOW, as observed from the SSE
 * stream ChatArea already parses. Deliberately small — six phases, not one
 * per tool — because the camera panel tolerates a 1-2s gap on every switch
 * (per spec) and because a state with no camera files just falls back to
 * Idle (see cameraFiles.ts buildCameraManifest). Add states by adding files,
 * not by widening this union: an unrecognized-but-plausible phase should
 * degrade to 'idle' rather than fail to compile.
 *
 *  - 'idle'     nothing in flight (no active turn, no audio playing)
 *  - 'thinking' extended-thinking text is streaming in, no visible reply yet
 *  - 'replying' the visible reply is streaming — maps to the 'Writing'
 *               camera state (outputting to the conversation; 'Speaking' is
 *               reserved for TTS audio that is actually playing right now)
 *  - 'waiting'  a turn is in flight but nothing has arrived yet — the model
 *               was just called, OR it is waiting on something (compaction, an
 *               AskQuestion answer, a subagent, a stall). Maps to 'Waiting'.
 *  - 'tool'     a tool call is in flight (OAuth path only — see ChatArea's
 *               liveToolName; other provider paths never populate a live
 *               tool name mid-turn, so they fall through to 'waiting')
 *
 * 'speaking' (TTS audio actually playing) is NOT a phase — it is
 * CameraSignal.speaking, tracked separately so it can override every phase.
 */
export type CameraPhase = 'idle' | 'thinking' | 'replying' | 'waiting' | 'tool';

/**
 * What ChatArea reports on every relevant change. `speaking` is tracked
 * separately from `phase` (rather than folded into the union) because it is
 * the one signal explicitly required to override every other state — see
 * resolveStateCandidates below, which checks `speaking` first and ignores
 * `phase` entirely when it is true.
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
 * Which of the four "doing something" camera states a raw tool name maps to.
 * The being's camera folders use seven coarse states — Idle / Speaking /
 * Thinking / Writing / Reading / Acting / Waiting — and a tool call resolves
 * to one of the four action groups here, then falls back to Idle in
 * resolveStateCandidates below.
 *
 * This is the mapping that used to misroute: the old chain resolved a tool to
 * a `Tool<Name>` token, then a generic 'Tool', then 'Thinking' — and since no
 * being had files for `ToolBash`/`Tool`, every tool call silently showed as
 * "Thinking". Now Bash → Acting, Read → Reading, Write → Writing, and
 * anything that is the model WAITING (compaction, a rate-limit pause, an
 * AskQuestion, a subagent) → Waiting.
 *
 * Unknown tool names degrade to 'Acting' — a tool we don't recognise is still
 * an action being taken, not a reason to fall back to Idle mid-turn.
 */
export type CameraToolGroup = 'Reading' | 'Writing' | 'Acting' | 'Waiting';

const WRITING_TOOLS = new Set(['Write', 'Edit']);
const READING_TOOLS = new Set([
  'Read', 'Glob', 'Grep',
  'read_conversation', 'search_conversations',
  'web_search', 'web_fetch', 'WebSearch', 'WebFetch',
  'browser_read', 'browser_snapshot', 'browser_screenshot',
  'computer_screens', 'computer_screenshot',
  'list_letters', 'read_letter',
]);
const WAITING_TOOLS = new Set(['AskQuestion', 'spawn_subagent', 'rate_limit_wait', 'compact']);

export function toolNameToGroup(name: string): CameraToolGroup {
  if (WRITING_TOOLS.has(name)) return 'Writing';
  if (READING_TOOLS.has(name)) return 'Reading';
  if (WAITING_TOOLS.has(name)) return 'Waiting';
  return 'Acting';
}

/**
 * Ordered candidate state names to try against a CameraManifest.states map —
 * first one with a non-empty pool wins, and the chain always ends at 'Idle'.
 * This is what makes "even a simple fallback should work" true: a being with
 * only Idle.mp4 and Writing.mp4 on disk still resolves something sensible for
 * every possible signal, and adding a file for one more state later just
 * starts winning for that state without any other change.
 *
 * `speaking` overrides every phase per spec ("mostly prioritized, overriding
 * any other actions") — checked first, unconditionally. The visible reply
 * resolves to 'Writing' (outputting to the conversation); 'Speaking' is
 * reserved for TTS audio that is actually playing right now.
 */
export function resolveStateCandidates(signal: CameraSignal): string[] {
  if (signal.speaking) return ['Speaking', 'Idle'];
  switch (signal.phase) {
    case 'tool':
      // A tool call resolves to its action GROUP (Reading / Writing / Acting /
      // Waiting), then falls back to Idle. No 'Thinking' stop in the chain any
      // more: a tool that isn't reading/writing/waiting is an action, not a
      // reason to show the reasoning state.
      return [signal.toolName ? toolNameToGroup(signal.toolName) : 'Acting', 'Idle'];
    case 'replying':
      return ['Writing', 'Idle'];
    case 'thinking':
      return ['Thinking', 'Idle'];
    case 'waiting':
      return ['Waiting', 'Idle'];
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
