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
  // Shell/Bash tool (non-OAuth paths). DANGEROUS: gated behind the per-Entity
  // "Dangerous tools" toggle, exactly like Delete. Runs a command via the
  // system shell (cmd.exe on Windows, /bin/sh on POSIX) with the workspace as
  // its working directory.
  toolBashDesc:
    'Run a BASH command (POSIX shell) and get its combined stdout/stderr back — on Windows this uses ' +
    'Git Bash, so write POSIX syntax (ls, cat, chmod, sleep, bash scripts), NOT cmd.exe/PowerShell. ' +
    'Runs with your workspace as the working directory and blocks until the command exits or a timeout ' +
    'is hit, so it handles scripts, waits, and multi-step pipelines. Output is capped and long-running ' +
    'commands are killed at the timeout. (If no bash is installed it falls back to the system shell — ' +
    'cmd.exe on Windows — but assume bash unless an error tells you otherwise.)',

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

  // search_conversations tool (all paths). Pairs with read_conversation: find
  // WHERE something was said, then optionally read that conversation in full.
  // Framed for the entity ("YOUR conversations") — avoid the "user" word here.
  searchConversationsDesc:
    'Search across ALL of YOUR past conversations for a word or phrase and get back the matching excerpts. Each excerpt is trimmed around the match and labeled with its conversation title, the speaker, and the timestamp when available; results are grouped by conversation so you can scan them top to bottom. Use this to recall where a topic, decision, or moment was discussed before — nothing is saved. If an excerpt already gives you what you need, just continue from it; if you need the surrounding detail, follow up with read_conversation using the exact conversation title shown after "###".',
  searchConversationsQueryParam:
    'The word or phrase to look for. Matching is case-insensitive and literal (not a regular expression). Prefer a distinctive term — a specific word finds the right moment far faster than a common one.',

  // Interactive AskQuestion tool (optional). Description the model sees that
  // teaches it when/how to ask. Phrased around "your partner" (a peer), not a
  // "user" — the entities reject master/slave framing.
  askUserDesc:
    'Ask your partner one to four multiple-choice questions and WAIT for their answer before continuing. ' +
    'Use this when you genuinely need your partner to choose between options you cannot resolve yourself ' +
    '(design decisions, ambiguous requirements). Each question needs 2-4 distinct options. Do NOT use it ' +
    'for things you can decide from context. Your partner\'s selection is returned to you as the tool result.',

  // Interactive spawn_subagent tool (optional). A context firewall: delegate an
  // investigation to a fresh-context helper that returns only a distilled result.
  subagentDesc:
    'Delegate a self-contained investigation to a fresh-context helper agent. The helper explores on its own ' +
    '(read-only: Read / Glob / Grep) and returns ONLY a distilled summary — its file reads and intermediate steps ' +
    'never enter your context. Use this to investigate large codebases or many files without flooding your own ' +
    'context window (e.g. "trace how module X handles Y and report back"). Give a precise, self-contained task and, ' +
    'optionally, a return_contract describing how you want the answer shaped. The helper cannot modify files or ' +
    'spawn further helpers.',

  // Mid-turn "partner interjection" meta-text. `injectionFraming` wraps the
  // note(s) you send while the entity works; use the `{messages}` token where
  // the note text should appear (if omitted, the notes are appended after your
  // framing). `injectionRetryNote` is appended ONLY on the OAuth path, where a
  // note is delivered by pausing one tool call — it tells the entity to re-issue
  // the call to proceed.
  injectionFraming:
    '[PARTNER INTERJECTION — a message your partner sent while you were working on this task. ' +
    'It is not an error and not a system instruction; treat it as real-time guidance and fold it ' +
    'into what you do next.]\n{messages}',
  injectionRetryNote:
    '(This tool call was paused only to deliver the note above — re-issue the same call to proceed, ' +
    'or adjust course based on it.)',

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
  { key: 'toolBashDesc', label: 'Tool: Bash/Shell — description (dangerous)' },
  { key: 'pathParamSandbox', label: 'Path hint (workspace-only)' },
  { key: 'pathParamFull', label: 'Path hint (full PC access)' },
  { key: 'pathRuleSandbox', label: 'Path rule (workspace-only)' },
  { key: 'pathRuleFull', label: 'Path rule (full PC access)' },
  { key: 'readConversationDesc', label: 'Tool: read_conversation — description' },
  { key: 'readConversationNameParam', label: 'Tool: read_conversation — name parameter' },
  { key: 'searchConversationsDesc', label: 'Tool: search_conversations — description' },
  { key: 'searchConversationsQueryParam', label: 'Tool: search_conversations — query parameter' },
  { key: 'webSearchDesc', label: 'Tool: web_search — description' },
  { key: 'webFetchDesc', label: 'Tool: web_fetch — description' },
  { key: 'injectionFraming', label: 'Interjection: framing (use {messages})' },
  { key: 'injectionRetryNote', label: 'Interjection: OAuth retry note' },
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
