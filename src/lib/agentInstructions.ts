// ─────────────────────────────────────────────────────────────────────────────
// Centralized, per-Entity-overridable "hidden instructions".
//
// These are the English strings NEXUS injects into the model's context that are
// NOT the entity's authored system prompt: the workspace tool descriptions, the
// path-scope rules, the read_conversation tool text, and the web tool text.
// Hard, terse English commands like "never use absolute paths" can break a
// character in deep interaction, so every one of them is overridable per folder
// (Entity) via the `instructionOverrides` map saved in folder settings.
//
// DEFAULTS holds the English fallback for each key. LABELS drives the settings
// UI (so the editor auto-lists every key — adding a key here surfaces it in the
// UI automatically). resolveAgentInstructions() merges an Entity's overrides
// over the defaults; an empty/whitespace override falls back to the default.
//
// NOTE: descriptions are intentionally UNIFIED across providers (Claude / Gemini
// / OpenAI-compatible) — one default per tool, used by every path — which also
// furthers the "same tools, same names, everywhere" design.
//
// NOT covered here (and why):
//   • OAuth/Claude-Code BUILT-IN tools (Read/Write/Edit/Glob/Grep/Bash): their
//     descriptions live inside Claude Code itself and cannot be overridden by
//     NEXUS. Only the read_conversation MCP tool (which NEXUS defines) is
//     customizable on that path.
//   • The model-selector and set_creativity preflights: these run as SEPARATE
//     hidden calls that never share the character's turn, so they can't break
//     character. Left as-is (can be added on request).
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_AGENT_INSTRUCTIONS: Record<string, string> = {
  // Workspace tool descriptions (base text; Read is composed with pathRule).
  toolReadDesc:
    'Read a file. Text files return as a string; image files (.png/.jpg/.jpeg/.gif/.webp/.bmp) return as inline image data you can see.',
  toolWriteDesc:
    'Create or overwrite a text file. Parent directories are created automatically. Replaces the entire file — use Edit for partial updates.',
  toolEditDesc:
    'Surgically replace one occurrence of old_string with new_string in an existing file. Fails if old_string is missing or matches multiple times — widen the match in that case.',
  toolGlobDesc:
    'List files whose path matches a glob pattern. `*` = chars within one segment, `**` = chars across segments, `?` = a single char. Examples: `*.md`, `memories/*.txt`, `**/*.json`.',
  toolGrepDesc:
    'Search file contents for a regex. Returns matching lines as path:line:text. Use file_pattern to narrow which files are searched.',
  toolDeleteDesc:
    'Permanently delete a single file. Irreversible — confirm the path first. Files only, not directories.',

  // Path-scope: the `path` parameter hint + the rule appended to Read's text.
  // Two variants each: sandboxed (Full PC access OFF) vs full (ON).
  pathParamSandbox: 'Relative path within the workspace',
  pathParamFull:
    'File path. An ABSOLUTE path (anywhere on this PC) is allowed; a relative path resolves against your private workspace.',
  pathRuleSandbox: 'Paths are relative to your workspace root; never use ".." or absolute paths.',
  pathRuleFull:
    'You have FULL SYSTEM access: use an absolute path to reach any file on this PC, or a relative path for your private workspace.',

  // read_conversation tool (all paths, including the OAuth MCP server).
  readConversationDesc:
    'Read the full transcript of one of YOUR past conversations by name. The Layer-4 index lists every conversation\'s title and summary; call this to pull a specific past conversation\'s complete contents into context for this turn only (nothing is saved). Conversations marked inactive are private and cannot be read — the tool will refuse them.',
  readConversationNameParam:
    'The exact title of a past conversation to read. Copy it verbatim from the index — the text shown right after "###" — exactly as written (including any trailing "_<number>"). Do not guess, translate, or reformat it.',

  // Universal web tools (OpenAI-compatible providers).
  webSearchDesc:
    'Search the live web for up-to-date information. Returns a numbered list of results (title, URL, snippet). Use this to discover relevant pages, then call web_fetch to read the full content of the most promising URL. Always cite the URLs you used.',
  webFetchDesc:
    'Open ONE specific URL and return its readable text content (HTML stripped). Use this to actually read a page — either a URL the user gave you, or one returned by web_search. Only http/https public URLs; internal/localhost addresses are blocked.',
};

// Human-readable labels for the settings editor (key → short label). Keys not
// listed still appear (using the key itself), but listing them keeps the UI tidy
// and ordered.
export const AGENT_INSTRUCTION_LABELS: { key: string; label: string }[] = [
  { key: 'toolReadDesc', label: 'Tool: Read — description' },
  { key: 'toolWriteDesc', label: 'Tool: Write — description' },
  { key: 'toolEditDesc', label: 'Tool: Edit — description' },
  { key: 'toolGlobDesc', label: 'Tool: Glob — description' },
  { key: 'toolGrepDesc', label: 'Tool: Grep — description' },
  { key: 'toolDeleteDesc', label: 'Tool: Delete — description' },
  { key: 'pathParamSandbox', label: 'Path hint (workspace-only)' },
  { key: 'pathParamFull', label: 'Path hint (full PC access)' },
  { key: 'pathRuleSandbox', label: 'Path rule (workspace-only)' },
  { key: 'pathRuleFull', label: 'Path rule (full PC access)' },
  { key: 'readConversationDesc', label: 'Tool: read_conversation — description' },
  { key: 'readConversationNameParam', label: 'Tool: read_conversation — name parameter' },
  { key: 'webSearchDesc', label: 'Tool: web_search — description' },
  { key: 'webFetchDesc', label: 'Tool: web_fetch — description' },
];

export type AgentInstructions = Record<string, string>;

/**
 * Merge an Entity's overrides over the English defaults. An override that is
 * missing, null, or only whitespace falls back to the default for that key.
 */
export function resolveAgentInstructions(overrides?: Record<string, any> | null): AgentInstructions {
  const out: AgentInstructions = { ...DEFAULT_AGENT_INSTRUCTIONS };
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === 'string' && v.trim()) out[k] = v;
    }
  }
  return out;
}
