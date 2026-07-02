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
    // Optional "[YYYY-MM-DD HH:MM:SS]" line placed directly under the "## Name"
    // header — before any [thinking] block or body text — when the user has
    // "Save timestamps to .md" enabled.
    const tsLine = (saveTimestamps && m.timestamp) ? `${formatTimestampTag(m.timestamp)}\n` : '';

    if (m.role === 'assistant') {
      header = customAiName ? customAiName : m.name;
      let entry = `## ${header}\n${tsLine}`;
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
        header = m.name || 'User';
        md += `## ${header}\n${tsLine}${content}\n\n`;
      } else if (uniqueTags.length === 1) {
        header = uniqueTags[0];
        let singleTagPattern = new RegExp(`\\[${escapeRegExp(header)}\\]\\s*`, 'g');
        let newContent = content.replace(singleTagPattern, '').trim();
        md += `## ${header}\n${tsLine}${newContent}\n\n`;
      } else {
        header = uniqueTags.join(', ');
        let newContent = content.replace(/(\[.*?\])\s*\n\s*/g, '$1\n').trim();
        md += `## ${header}\n${tsLine}${newContent}\n\n`;
      }
    }
  });
  return md.trim() + '\n';
}

export function parseMarkdown(markdown: string, customAiName?: string, validUserNames: string[] = []) {
  const lines = markdown.split('\n');
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
  // assistant (customAiName), the built-in "User" fallback header, and every
  // speaker registered in character_map.json (passed in as validUserNames). A
  // "## X" line is a message boundary only when X — or, for a multi-speaker
  // header, EVERY comma/、-separated part of X — is one of those known names.
  // Any other "## ..." line is treated as ordinary body text of the current
  // message and kept verbatim (the "## " prefix is NOT stripped). This stops
  // markdown sub-headings inside a message (e.g. "## Summary") from being
  // misread as new turns.
  const validSet = new Set(
    [customAiName || '', 'User', ...validUserNames].filter(Boolean).map(norm)
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

    if (role === 'user') {
      const isMultiple = currentHeader.includes(',') || currentHeader.includes('、');
      // Mirror the app's specific behavior: the plain "User" username is never
      // injected as a "[User]" tag (identity flows through [username] tags only
      // for named users). A "## User:" header therefore stays untagged.
      const isPlainUser = currentHeader.trim() === 'User';
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
      tokens: 0
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      let parsedHeader = line.substring(3).trim();
      if (parsedHeader.endsWith(':')) {
        parsedHeader = parsedHeader.substring(0, parsedHeader.length - 1).trim();
      }

      if (isRecognizedHeader(parsedHeader)) {
        if (currentHeader) {
          addMessage();
        }
        currentHeader = parsedHeader;
        currentContent = [];
      } else {
        // Not a known speaker — this "## ..." line belongs to the current
        // message body. Push it unchanged (keep the "## ").
        currentContent.push(line);
      }
    } else {
      currentContent.push(line);
    }
  }

  if (currentHeader) {
    addMessage();
  }

  return messages;
}
