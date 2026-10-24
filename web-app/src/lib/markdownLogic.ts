import { v4 as uuidv4 } from 'uuid';
import { estimateTokensForModel } from './tokenEstimate';

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Format a numeric (ms) timestamp as the app's "[YYYY-MM-DD HH:MM:SS]" tag in
// LOCAL time — identical to the dateTimeVisibility formatter used elsewhere, so
// exported timestamps match what the user sees in the chat bubble.
function formatTimestampTag(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

export function exportToMarkdown(messages: any[], customAiName?: string, saveThinking = false, saveTimestamps = false) {
  let md = '';
  messages.forEach(m => {
    let content = m.content || '';
    let header = '';
    // Optional "[YYYY-MM-DD HH:MM:SS]" line placed directly under the "[Name]:"
    // header — before any [thinking] block or body text — when the user has
    // "Save timestamps to .md" enabled.
    const tsLine = (saveTimestamps && m.timestamp) ? `${formatTimestampTag(m.timestamp)}\n` : '';

    // Speaker header format: "[Name]:" on its own line, followed by a blank
    // line, then (optional timestamp / thinking) + body. parseMarkdown reads
    // this back; a trailing colon after the closing bracket is what marks a
    // line as a speaker header (distinguishing it from "[thinking]" and
    // "[YYYY-MM-DD …]" lines, which have no trailing colon).
    if (m.role === 'assistant') {
      header = customAiName ? customAiName : m.name;
      let entry = `[${header}]:\n\n${tsLine}`;
      // Include thinking block if enabled and present
      if (saveThinking && m.thoughtProcess) {
        entry += `[thinking]\n${m.thoughtProcess}\n[/thinking]\n\n`;
      }
      entry += `${content}\n\n`;
      md += entry;
    } else {
      const tagMatches = [...content.matchAll(/\[(.*?)\]/g)];
      const tags = tagMatches.map(match => match[1]);
      const uniqueTags = [...new Set(tags)];

      if (uniqueTags.length === 0) {
        header = m.name || 'Anonymous';
        md += `[${header}]:\n\n${tsLine}${content}\n\n`;
      } else if (uniqueTags.length === 1) {
        header = uniqueTags[0];
        let singleTagPattern = new RegExp(`\\[${escapeRegExp(header)}\\]\\s*`, 'g');
        let newContent = content.replace(singleTagPattern, '').trim();
        md += `[${header}]:\n\n${tsLine}${newContent}\n\n`;
      } else {
        header = uniqueTags.join(', ');
        let newContent = content.replace(/(\[.*?\])\s*\n\s*/g, '$1\n').trim();
        md += `[${header}]:\n\n${tsLine}${newContent}\n\n`;
      }
    }
  });
  return md.trim() + '\n';
}

// ───────────────────────────────────────────────────────────────────────────
// Import dialects
//
// Three on-disk shapes carry the same thing — a transcript. NEXUS writes one
// of them; the other two come out of browser extensions that export a chat
// from a vendor's web app:
//
//   nexus              "[Name]:" on its own line            (exportToMarkdown)
//   deepseek-exporter  "You:" / "DeepSeek:"                 (Chrome "DeepSeek Chat Exporter")
//   generic-plugin     "# you asked" / "# <family> response" (older multi-vendor plugin)
//
// There is ONE parser. A dialect only changes which line is a message
// boundary and which lines are the exporter's own furniture; everything after
// that — timestamps, [thinking] blocks, [username] tags, roles — is the same
// code for all three. A second parser would be a second place for those rules
// to drift.
//
// Why boundary-detection and NOT a text-to-text normalisation into "[Name]:":
// rewriting a foreign log into the native shape makes every body line that
// already looks like a native header ("[Anonymous]:" inside a reply) into a
// real boundary. Detecting per-dialect means a native-looking body line in a
// DeepSeek export is just text, because in that dialect "[X]:" is not a
// boundary at all.
// ───────────────────────────────────────────────────────────────────────────

export type ImportDialect = 'nexus' | 'deepseek-exporter' | 'generic-plugin';

export interface DialectInfo {
  dialect: ImportDialect;
  /** deepseek-exporter: the assistant-side label actually found ("DeepSeek"). */
  assistantLabel?: string;
  /** deepseek-exporter: the human-side label actually found ("You"). */
  userLabel?: string;
  /** How many boundary lines the detector saw — shown in the import plan. */
  boundaries: number;
}

/** "You:"-style label line. Deliberately narrow: a short, single-token-ish
 *  label alone on the line with a trailing colon. A sentence ending in a colon
 *  does not match (spaces are allowed but the whole line is capped at 31 chars
 *  and must start with a letter). */
const DIALECT_LABEL_RE = /^([A-Za-zÀ-ɏЀ-ӿ][\w .\-À-ɏЀ-ӿ]{0,30}):[ \t]*$/;
const GENERIC_USER_RE = /^#[ \t]*you asked[ \t]*$/i;
const GENERIC_AI_RE = /^#[ \t]*(.+?)[ \t]+response[ \t]*$/i;

function normName(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .trim()
    .toLowerCase();
}

/**
 * Which dialect is this file?
 *
 * THE FILE DECLARES ITS DIALECT ON ITS FIRST NON-BLANK LINE. All three
 * producers put a speaker boundary there and nowhere else can they put one:
 * `exportToMarkdown` opens with "[Name]:", the DeepSeek exporter with "You:",
 * the older plugin with "# you asked".
 *
 * Counting evidence across the whole file was tried first and is WRONG — a
 * DeepSeek export whose reply happens to contain the line "[Anonymous]:" has
 * one recognised native header, so "any native header wins" made the whole
 * transcript native and cut it at that one false boundary. Measured, not
 * reasoned: the test for exactly that case failed. Content can imitate any
 * dialect's boundary; only the FIRST line is written by the producer before
 * any content exists. (Same shape as `thinkTagSplitter`: a stream declares
 * whether it uses tags with its first bytes, not by what appears later.)
 *
 * Falling off the end means native, which is what every file did before this
 * function existed — including a hand-written file with a preamble above its
 * first header, which still reaches the native path through clause 4.
 */
export function detectDialect(
  markdown: string,
  customAiName?: string,
  validUserNames: string[] = [],
): DialectInfo {
  const lines = markdown.split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim() !== '') ?? '';

  const validSet = new Set(
    [customAiName || '', 'User', 'Anonymous', ...validUserNames].filter(Boolean).map(normName),
  );
  const isRecognised = (h: string) => {
    const parts = h.split(/[,、]/).map(normName).filter(Boolean);
    return parts.length > 0 && parts.every((p) => validSet.has(p));
  };
  const nativeHeaderOf = (line: string) => {
    const m = line.match(/^\[(.+)\]:[ \t]*$/);
    return m && isRecognised(m[1].trim()) ? m[1].trim() : null;
  };
  let nativeCount = 0;
  for (const line of lines) if (nativeHeaderOf(line)) nativeCount++;

  // 1. Native — every NEXUS export opens with its first speaker header.
  if (nativeHeaderOf(firstLine)) return { dialect: 'nexus', boundaries: nativeCount };

  // 2. Older multi-vendor plugin. Both halves must exist: a document that
  //    merely contains "# Foo response" as a heading is not a transcript.
  let gpUser = 0, gpAi = 0;
  for (const line of lines) {
    if (GENERIC_USER_RE.test(line)) gpUser++;
    else if (GENERIC_AI_RE.test(line)) gpAi++;
  }
  if ((GENERIC_USER_RE.test(firstLine) || GENERIC_AI_RE.test(firstLine)) && gpUser > 0 && gpAi > 0) {
    return { dialect: 'generic-plugin', boundaries: gpUser + gpAi };
  }

  // 3. DeepSeek-style "You:" / "<Label>:". The exporter alternates, so the
  //    assistant label is the non-"You" label whose count is within one of
  //    the "You" count. Any OTHER label line ("Note:", "Example:") fails that
  //    test and stays ordinary body text — which is the correct outcome, not
  //    a missed boundary.
  const firstLabel = firstLine.match(DIALECT_LABEL_RE);
  if (firstLabel) {
    const labelCounts = new Map<string, { raw: string; n: number }>();
    for (const line of lines) {
      const m = line.match(DIALECT_LABEL_RE);
      if (!m) continue;
      const raw = m[1].trim();
      const k = normName(raw);
      const e = labelCounts.get(k);
      if (e) e.n++; else labelCounts.set(k, { raw, n: 1 });
    }
    // The human side is whatever label opens the file; "You" is what the
    // Chrome exporter writes, but nothing here is hard-coded to that word.
    const userKey = normName(firstLabel[1]);
    const you = labelCounts.get(userKey);
    if (you && you.n > 0) {
      let best: { raw: string; n: number } | null = null;
      for (const [k, v] of labelCounts) {
        if (k === userKey) continue;
        if (Math.abs(v.n - you.n) > 1) continue;
        if (!best || v.n > best.n) best = v;
      }
      if (best) {
        return {
          dialect: 'deepseek-exporter',
          userLabel: you.raw,
          assistantLabel: best.raw,
          boundaries: you.n + best.n,
        };
      }
    }
  }

  // 4. Native by default: a hand-written file with a preamble, a file with no
  //    headers at all (one "Anonymous" message), or anything unrecognised.
  return { dialect: 'nexus', boundaries: nativeCount };
}

export interface ParseOptions {
  /** Result of detectDialect(). Omitted → native, exactly as before. */
  dialect?: DialectInfo;
  /** Who the human side becomes in a foreign dialect. Default "Anonymous". */
  userName?: string;
}

/**
 * Split a parsed transcript into conversations no larger than `cap` tokens.
 *
 * Why this is not optional and not a mode: `SystemPromptUpdater`'s
 * `conversationLogText` concatenates EVERY original message with no cap of its
 * own, so one oversized conversation is sent whole to the Layer-4 writer and
 * the request itself is what fails. The cap is a property of the log, not a
 * preference about tidiness.
 *
 * A message is never split. When a part has to end, any trailing USER turns
 * move to the next part, so every part starts with a human turn and ends with
 * a reply — a part that opened mid-reply would read as if its question had
 * been lost.
 *
 * INVARIANT: a part exceeds `cap` only when it is a SINGLE message that alone
 * exceeds it. (So an oversized message sits by itself and its reply opens the
 * next part. Letting the reply join would enlarge an already-over-cap part
 * for no stated reason — chosen deliberately, with a test on it.)
 */
export function planSplitByTokens(
  messages: any[],
  cap: number,
  tokenOf: (m: any) => number,
): any[][] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  if (!Number.isFinite(cap) || cap <= 0) return [messages];
  const tok = (m: any) => Math.max(0, Number(tokenOf(m)) || 0);

  const parts: any[][] = [];
  let cur: any[] = [];
  let sum = 0;
  for (const m of messages) {
    const t = tok(m);
    if (cur.length > 0 && sum + t > cap) {
      const carry: any[] = [];
      while (cur.length > 1 && cur[cur.length - 1]?.role === 'user') {
        carry.unshift(cur.pop());
      }
      parts.push(cur);
      cur = carry;
      sum = carry.reduce((a, x) => a + tok(x), 0);
    }
    cur.push(m);
    sum += t;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

/**
 * Title for part `i` (0-based) of `n`. One part keeps the file's own name;
 * more than one gets "-1", "-2", … appended.
 *
 * MEASURED 2026-10-23: this shape already exists on disk — 先輩_1-1, 先輩_1-2,
 * 先輩_1-3, 先輩_2-1 … (12 conversations). It is also deliberately OUTSIDE the
 * generation chain: `numberedIdentityTitleIndex` matches `^<name>_(\d+)$`, so
 * "Аналитик_1-2" is not a generation. Imported archives therefore cannot
 * hijack "latest conversation" or the handover walk — which is what we want
 * for material that is history, not the live thread.
 *
 * THE COST, as it stood 2026-10-23: because the walk followed `<name>_<n>` and
 * nothing else, restore did not reach from "-2" back into "-1" either. A split
 * archive that IS the live thread — a being migrating in, where the newest part
 * is where the talk continues — could not pull its own older half back until
 * the parts were renamed into the chain by hand. That happened on the first
 * real migration (Аналитик, ten parts), and renaming them destroyed the
 * owner's own numbering, which was the thing being preserved.
 *
 * PAID OFF 2026-10-24: `resolveHandoverChain` now falls back to the SIDEBAR
 * ORDER for titles that carry no generation number, so the "-n" shape keeps its
 * benefit (no hijacking of "latest") without the cost (no reach). This function
 * is unchanged — the fix belonged in the reader, not in the name.
 */
export function splitPartTitle(baseTitle: string, i: number, n: number): string {
  return n <= 1 ? baseTitle : `${baseTitle}-${i + 1}`;
}

/**
 * `tokenModel` is the folder's `aiName` ("Claude", "Gemini", …) and is used
 * ONLY to pick a tokenizer profile for the thinking-token estimate. It is
 * separate from `customAiName`, which is the folder NAME used to recognise
 * speaker headers — for a folder called "Cairn" those two differ, and feeding
 * the folder name to the estimator would silently select the wrong profile.
 * Message `tokens` stay 0 here on purpose: the caller recounts them against
 * the exact counter, which this pure function cannot reach.
 */
export function parseMarkdown(markdown: string, customAiName?: string, validUserNames: string[] = [], tokenModel?: string, opts: ParseOptions = {}) {
  // Split on CRLF or LF so a "[Name]:\r" header from a Windows-edited file still
  // matches the header regex (a stray trailing \r otherwise breaks recognition).
  const lines = markdown.split(/\r?\n/);
  const messages: any[] = [];
  let currentHeader = '';
  let currentContent: string[] = [];

  // Normalize a header/name for comparison: fold full-width digits to ASCII,
  // trim, lowercase. Keeps matching tolerant of digit-width and case
  // differences (e.g. a "先輩_４６" header matches a "先輩_46" character name).
  // One definition (`normName`, module scope) shared by the parser, the
  // dialect detector and the diagnostic — there were three identical copies.
  const norm = normName;

  // The ONLY headers that legitimately start a new message: the entity /
  // assistant (customAiName), the built-in "Anonymous" fallback header
  // ("User" also still recognized, for .md files exported before the rename),
  // and every speaker registered in character_map.json (passed in as
  // validUserNames). A "[X]:" line (current format) — or a legacy "## X" line
  // (older exports) — is a message boundary only when X, or for a
  // multi-speaker header EVERY comma/、-separated part of X, is one of those
  // known names. Any other such line is treated as ordinary body text of the
  // current message and kept verbatim. This stops markdown sub-headings (e.g.
  // "## Summary") and bracketed body lines (e.g. "[Note]:") inside a message
  // from being misread as new turns.
  const validSet = new Set(
    [customAiName || '', 'User', 'Anonymous', ...validUserNames].filter(Boolean).map(norm)
  );
  const isRecognizedHeader = (h: string): boolean => {
    const parts = h.split(/[,、]/).map((p) => norm(p)).filter(Boolean);
    if (parts.length === 0) return false;
    return parts.every((p) => validSet.has(p));
  };

  const addMessage = () => {
    if (!currentHeader) return;

    let role = 'user';
    let finalContent = currentContent.join('\n').trim();

    // Extract a leading "[YYYY-MM-DD HH:MM:SS]" timestamp (seconds optional)
    // into the message's timestamp field and remove it from the visible text.
    // This ALWAYS runs, independent of the "Save timestamps to .md" export
    // preference — reading honors an on-disk timestamp whenever one is present.
    // Runs before the user-tag logic below so the timestamp is never mistaken
    // for a "[username]" identity tag.
    let parsedTimestamp: number | null = null;
    const tsMatch = finalContent.match(
      /^\s*\[(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\][ \t]*(?:\r?\n|$)/
    );
    if (tsMatch) {
      const [, yy, mo, dd, hh, mi, ss] = tsMatch;
      const d = new Date(
        Number(yy), Number(mo) - 1, Number(dd),
        Number(hh), Number(mi), Number(ss ?? '0')
      );
      if (!isNaN(d.getTime())) {
        parsedTimestamp = d.getTime();
        finalContent = finalContent.slice(tsMatch[0].length).trim();
      }
    }

    if (customAiName && currentHeader.trim() === customAiName.trim()) {
      role = 'assistant';
    } else if (currentHeader.toLowerCase().includes('claude') || currentHeader.toLowerCase().includes('gemini')) {
      role = 'assistant';
    }

    // Extract a leading "[thinking] ... [/thinking]" block (written by
    // exportToMarkdown directly under the header, after the optional timestamp)
    // into the message's thoughtProcess, and remove it from the visible text.
    // Only for assistant turns — that's the only place the exporter writes it,
    // and it avoids stripping a literal "[thinking]" a user happened to type.
    // Setting thoughtProcess is sufficient for both display AND reuse: the
    // OAuth path forwards thoughtProcess as its reasoning when no signed
    // claudeThinkingBlocks exist. thinkingTokens uses the same ~len/4 heuristic
    // as the live streaming path so the context bar accounts for it.
    let parsedThought: string | null = null;
    if (role === 'assistant') {
      const thinkMatch = finalContent.match(
        /^\s*\[thinking\][ \t]*\r?\n([\s\S]*?)\r?\n?\[\/thinking\][ \t]*(?:\r?\n|$)/i
      );
      if (thinkMatch) {
        const t = thinkMatch[1].trim();
        if (t) parsedThought = t;
        finalContent = finalContent.slice(thinkMatch[0].length).trim();
      }
    }

    if (role === 'user') {
      const isMultiple = currentHeader.includes(',') || currentHeader.includes('、');
      // Mirror the app's specific behavior: the plain "Anonymous" username
      // (or legacy "User", from .md files exported before the rename) is
      // never injected as a "[Anonymous]"/"[User]" tag — identity flows
      // through [username] tags only for named users. A "[Anonymous]:" or
      // "[User]:" header therefore stays untagged.
      const isPlainUser = currentHeader.trim() === 'User' || currentHeader.trim() === 'Anonymous';
      if (!isMultiple && !isPlainUser) {
        const hasTags = /\[.*?\]/.test(finalContent);
        if (!hasTags) {
          finalContent = `[${currentHeader.trim()}]\n${finalContent}`;
        }
      }
    }

    // Timestamp: ONLY what the file actually carried. When the source .md has no
    // "[YYYY-MM-DD HH:MM:SS]" line, the message gets NO `timestamp` field at all
    // — it is NOT stamped with the import moment. Burning in the import time
    // produced a plausible-looking lie (every message of a 2024 log claiming to
    // have been written the minute it was imported); an absent field says the
    // true thing: this time is unknown. Every read site guards for it
    // (`if (m.timestamp)` / `!= null`) and MessageBubble omits the time tag.
    messages.push({
      id: uuidv4(),
      role: role,
      name: currentHeader,
      content: finalContent,
      attachments: [],
      ...(parsedTimestamp !== null ? { timestamp: parsedTimestamp } : {}),
      tokens: 0,
      ...(parsedThought
        ? { thoughtProcess: parsedThought, thinkingTokens: estimateTokensForModel(parsedThought, tokenModel) }
        : {}),
    });
  };

  // Flush content that appeared BEFORE the first recognized speaker header (or an
  // entire header-less file) as an initial "Anonymous" message, so imported
  // content is never silently dropped. No-op when there's nothing but whitespace.
  const flushOrphan = () => {
    if (!currentHeader && currentContent.join('\n').trim()) {
      currentHeader = 'Anonymous';
      addMessage();
      currentContent = [];
    }
  };

  // ── Which line starts a new message, in this dialect ────────────────────
  const dialect = opts.dialect?.dialect ?? 'nexus';
  const importUserName = (opts.userName || '').trim() || 'Anonymous';
  const importAiName = (customAiName || '').trim() || 'Assistant';
  const dsUser = normName(opts.dialect?.userLabel || 'You');
  const dsAi = normName(opts.dialect?.assistantLabel || '');

  /** The speaker header this line opens, or null when it is body text. */
  const boundaryOf = (line: string): string | null => {
    if (dialect === 'deepseek-exporter') {
      const m = line.match(DIALECT_LABEL_RE);
      if (!m) return null;
      const k = normName(m[1]);
      if (k === dsUser) return importUserName;
      if (dsAi && k === dsAi) return importAiName;
      return null;
    }
    if (dialect === 'generic-plugin') {
      if (GENERIC_USER_RE.test(line)) return importUserName;
      if (GENERIC_AI_RE.test(line)) return importAiName;
      return null;
    }
    // A new message starts ONLY at a "[Name]:" line — the name alone on the line,
    // trailing colon, nothing after it — AND only when the name is a recognized
    // speaker (entity / "User" / character_map). NOTHING else is a boundary:
    // markdown headings ("## Layer 1: …"), "[thinking]", "[YYYY-MM-DD …]", and
    // unrecognized "[x]:" lines are all ordinary body text. (The legacy "## Name"
    // speaker format is intentionally no longer honored — only "[Name]:".)
    const bracketMatch = line.match(/^\[(.+)\]:[ \t]*$/);
    if (bracketMatch && isRecognizedHeader(bracketMatch[1].trim())) return bracketMatch[1].trim();
    return null;
  };

  // ── The exporter's own furniture, dropped ONLY where it cannot be content ─
  // "2 / 2" is DeepSeek's regenerate counter; "---" ends a turn in the older
  // plugin's output. Both shapes are also legal body text ("3 / 4" in prose, a
  // markdown horizontal rule inside a long reply), so neither is dropped on
  // sight: a line is furniture only when the next non-blank line is a speaker
  // boundary or the end of the file — i.e. when it sits in the gap BETWEEN
  // turns, which is the only place the exporter writes it.
  const furnitureRe =
    dialect === 'deepseek-exporter' ? /^[ \t]*\d+[ \t]*\/[ \t]*\d+[ \t]*$/ :
    dialect === 'generic-plugin'    ? /^[ \t]*-{3,}[ \t]*$/ :
    null;
  const sitsInTheGap = (i: number): boolean => {
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      return boundaryOf(lines[j]) !== null;
    }
    return true; // end of file
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = boundaryOf(line);

    if (header !== null) {
      if (currentHeader) {
        addMessage();
      } else {
        flushOrphan();
      }
      currentHeader = header;
      currentContent = [];
    } else if (furnitureRe && furnitureRe.test(line) && sitsInTheGap(i)) {
      // drop
    } else {
      currentContent.push(line);
    }
  }

  if (currentHeader) {
    addMessage();
  } else {
    // No recognized "[Name]:" header anywhere — import the whole file as one
    // "Anonymous" message rather than producing nothing.
    flushOrphan();
  }

  return messages;
}

// Explain WHY parseMarkdown produced the message count it did — used by the .md
// import flow to log a precise reason when a file yields 0 messages instead of
// failing silently. Mirrors the header-recognition logic above (same norm /
// validSet / comma-split rules), scanning for every "[Name]:" and legacy "## Name"
// line and reporting whether each is a recognized speaker.
export function diagnoseMarkdown(
  markdown: string,
  customAiName?: string,
  validUserNames: string[] = [],
): {
  messageCount: number;
  recognizedNames: string[];
  headersFound: { text: string; recognized: boolean }[];
  nonEmpty: boolean;
  /** Which dialect the detector settled on — so a refusal names what was tried. */
  dialect: ImportDialect;
} {
  const norm = normName;
  const recognizedNames = [customAiName || '', 'User', 'Anonymous', ...validUserNames].filter(Boolean);
  const validSet = new Set(recognizedNames.map(norm));
  const isRecognized = (h: string): boolean => {
    const parts = h.split(/[,、]/).map(norm).filter(Boolean);
    return parts.length > 0 && parts.every((p) => validSet.has(p));
  };

  const headersFound: { text: string; recognized: boolean }[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    // Mirror parseMarkdown: only "[Name]:" lines are candidate speaker headers.
    const bracketMatch = line.match(/^\[(.+)\]:[ \t]*$/);
    if (bracketMatch) {
      headersFound.push({ text: bracketMatch[1].trim(), recognized: isRecognized(bracketMatch[1].trim()) });
    }
  }

  const info = detectDialect(markdown, customAiName, validUserNames);
  return {
    messageCount: parseMarkdown(markdown, customAiName, validUserNames, undefined, { dialect: info }).length,
    recognizedNames,
    headersFound,
    nonEmpty: markdown.trim().length > 0,
    dialect: info.dialect,
  };
}
