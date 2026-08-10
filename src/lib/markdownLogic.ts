import { v4 as uuidv4 } from 'uuid';

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

export function parseMarkdown(markdown: string, customAiName?: string, validUserNames: string[] = []) {
  // Split on CRLF or LF so a "[Name]:\r" header from a Windows-edited file still
  // matches the header regex (a stray trailing \r otherwise breaks recognition).
  const lines = markdown.split(/\r?\n/);
  const messages: any[] = [];
  let currentHeader = '';
  let currentContent: string[] = [];

  // Normalize a header/name for comparison: fold full-width digits to ASCII,
  // trim, lowercase. Keeps matching tolerant of digit-width and case
  // differences (e.g. a "先輩_４６" header matches a "先輩_46" character name).
  const norm = (s: string) =>
    s
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .trim()
      .toLowerCase();

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

    messages.push({
      id: uuidv4(),
      role: role,
      name: currentHeader,
      content: finalContent,
      attachments: [],
      timestamp: parsedTimestamp !== null ? parsedTimestamp : Date.now(),
      tokens: 0,
      ...(parsedThought
        ? { thoughtProcess: parsedThought, thinkingTokens: Math.ceil(parsedThought.length / 4) }
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A new message starts ONLY at a "[Name]:" line — the name alone on the line,
    // trailing colon, nothing after it — AND only when the name is a recognized
    // speaker (entity / "User" / character_map). NOTHING else is a boundary:
    // markdown headings ("## Layer 1: …"), "[thinking]", "[YYYY-MM-DD …]", and
    // unrecognized "[x]:" lines are all ordinary body text. (The legacy "## Name"
    // speaker format is intentionally no longer honored — only "[Name]:".)
    const bracketMatch = line.match(/^\[(.+)\]:[ \t]*$/);

    if (bracketMatch && isRecognizedHeader(bracketMatch[1].trim())) {
      if (currentHeader) {
        addMessage();
      } else {
        flushOrphan();
      }
      currentHeader = bracketMatch[1].trim();
      currentContent = [];
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
} {
  const norm = (s: string) =>
    s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).trim().toLowerCase();
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

  return {
    messageCount: parseMarkdown(markdown, customAiName, validUserNames).length,
    recognizedNames,
    headersFound,
    nonEmpty: markdown.trim().length > 0,
  };
}
