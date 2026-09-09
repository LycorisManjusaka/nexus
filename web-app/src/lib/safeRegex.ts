// ───────────────────────────────────────────────────────────────────────────
// Heuristic ReDoS guard for model-supplied regex patterns.
//
// Shared by every tool that lets the model provide a regular expression against
// NEXUS-controlled text: search_conversations' optional regex mode,
// read_attachment's optional pattern, and search_attachments.
//
// HONEST LIMITS: this is NOT a hard, time-boxed sandbox. JavaScript regex
// execution is synchronous and cannot be preempted from the same thread once
// it starts — a genuinely adversarial pattern+input pair could still hang the
// process, and only a separate worker thread (killed from outside) would truly
// close that door. What this guard actually stops is the common, non-malicious
// case this codebase is exposed to: patterns are MODEL-authored (not submitted
// by a hostile third party) and inputs are individual conversation messages or
// attachments — already small, not the whole ~GB corpus in one match. Rejecting
// the classic catastrophic-backtracking shapes (nested quantifiers) plus
// capping pattern/input size covers that threat model without the complexity
// of a worker-thread sandbox. If NEXUS ever exposes regex search to untrusted
// input, this needs to be revisited.
// ───────────────────────────────────────────────────────────────────────────

const MAX_PATTERN_LENGTH = 300;
const MAX_INPUT_LENGTH = 5_000_000; // 5MB — far above any real attachment/message
const MAX_MATCHES = 500;

// Catches the classic nested-quantifier shapes that cause catastrophic
// backtracking in practice: (x+)+, (x*)*, (x+)*, (x*)+, and the same with a
// `{n,}` repetition instead of +/*. Not a formal proof of linear-time safety —
// a heuristic that rejects the patterns actually responsible for real-world
// ReDoS incidents.
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)[+*]|\([^()]*\{\d+,?\d*\}[^()]*\)[+*]/;

export type SafeRegexResult = { ok: true; regex: RegExp } | { ok: false; error: string };

export function compileSafeRegex(pattern: string, flags = 'im'): SafeRegexResult {
  if (!pattern || !pattern.trim()) return { ok: false, error: 'empty pattern' };
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, error: `pattern too long (max ${MAX_PATTERN_LENGTH} characters)` };
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return {
      ok: false,
      error: 'pattern rejected: nested quantifiers like "(a+)+" or "(a*)*" can cause catastrophic backtracking — rewrite without them',
    };
  }
  try {
    return { ok: true, regex: new RegExp(pattern, flags) };
  } catch (e: any) {
    return { ok: false, error: `invalid regular expression: ${e?.message || e}` };
  }
}

export interface LineMatch {
  line: number;
  text: string;
}

/**
 * Line-oriented grep of `text` with an already-compiled safe regex. Bounded on
 * both ends: input is truncated at MAX_INPUT_LENGTH, and collection stops at
 * MAX_MATCHES, so even a legal-but-pathological pattern can't produce an
 * unbounded result or scan an unbounded amount of text.
 */
export function grepLines(text: string, regex: RegExp): LineMatch[] {
  const capped = text.length > MAX_INPUT_LENGTH ? text.slice(0, MAX_INPUT_LENGTH) : text;
  const lines = capped.split('\n');
  const out: LineMatch[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
    regex.lastIndex = 0;
    if (regex.test(lines[i])) out.push({ line: i + 1, text: lines[i] });
  }
  return out;
}

export { MAX_PATTERN_LENGTH, MAX_INPUT_LENGTH, MAX_MATCHES };
