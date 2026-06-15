// ───────────────────────────────────────────────────────────────────────────
// read_conversation tool backend.
//
// Finds a past conversation BY NAME (title) within the same entity folder and
// returns a clean text transcript for one-shot injection into the model's
// context. Privacy rule: conversations marked inactive (active === false) are
// "non-public" and MUST be refused — the AI is never allowed to read them.
//
// Nothing is persisted; the caller drops the transcript after the turn.
// ───────────────────────────────────────────────────────────────────────────

import { listLogs, loadLog } from './fsStorage';

export interface ReadConversationResult {
  ok: boolean;
  error?: string;
  title?: string;
  transcript?: string;
}

// Normalize a conversation name for fuzzy matching: trim, collapse internal
// whitespace, normalize full-width digits to ASCII, and lowercase. The current
// title format is "<base>_<index>", but models often still guess the old
// "＃"/"#" separator (e.g. "先輩#46"); treat "_", "#", and "＃" as the SAME
// separator so "先輩#46" still resolves to "先輩_46".
function normalizeName(s: string): string {
  return (s || '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[#＃_]/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Strip base64 data URIs and oversized inline blobs from a message's content
// so the transcript stays text-only.
function cleanContent(content: any): string {
  if (typeof content !== 'string') {
    try { content = JSON.stringify(content); } catch { return ''; }
  }
  return (content as string)
    // Markdown image/data URIs: ![alt](data:...) → [image]
    .replace(/!\[[^\]]*\]\(data:[^)]*\)/g, '[image]')
    // Bare data URIs
    .replace(/data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[binary]');
}

export async function readConversationByName(
  folderName: string,
  name: string,
): Promise<ReadConversationResult> {
  if (!name || !name.trim()) {
    return { ok: false, error: 'A conversation name is required.' };
  }
  const target = normalizeName(name);

  const logs = (await listLogs()).filter((l: any) => l.folderName === folderName);
  if (logs.length === 0) {
    return { ok: false, error: `No conversations found in this entity.` };
  }

  // Prefer an exact normalized title match; fall back to a contains-match.
  let hit = logs.find((l: any) => normalizeName(l.title || '') === target);
  if (!hit) {
    const partial = logs.filter((l: any) => normalizeName(l.title || '').includes(target));
    if (partial.length === 1) hit = partial[0];
    else if (partial.length > 1) {
      const names = partial.map((l: any) => l.title).join('", "');
      return {
        ok: false,
        error: `Multiple conversations match "${name}": "${names}". Be more specific.`,
      };
    }
  }
  if (!hit) {
    return { ok: false, error: `No conversation named "${name}" was found in this entity.` };
  }

  // Privacy guard — inactive conversations are non-public and must be refused.
  if (hit.active === false) {
    return {
      ok: false,
      error: `The conversation "${hit.title}" is marked inactive (non-public) and cannot be read.`,
    };
  }

  const full = await loadLog(hit.id);
  if (!full || !Array.isArray(full.messages)) {
    return { ok: false, error: `Failed to load "${hit.title}".` };
  }

  // Build a clean Role: text transcript. Skip pure-system bookkeeping; strip
  // base64; drop thinking blocks (they aren't stored in `content`, but guard
  // against any inline thought markers just in case).
  const lines: string[] = [];
  for (const m of full.messages) {
    const role = m.role === 'user' ? (m.name || 'User') : (m.name || hit.title || 'Assistant');
    const text = cleanContent(m.content || '').trim();
    const atts = Array.isArray(m.attachments) && m.attachments.length > 0
      ? ` [${m.attachments.length} attachment(s)]`
      : '';
    if (!text && !atts) continue;
    lines.push(`${role}:${atts ? atts : ''}\n${text}`.trimEnd());
  }

  return {
    ok: true,
    title: hit.title,
    transcript: lines.join('\n\n'),
  };
}
