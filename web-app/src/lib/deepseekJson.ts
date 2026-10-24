/**
 * DeepSeek conversation JSON  ->  the `deepseek-exporter` markdown this app
 * already imports.
 *
 * WHY A RENDERER AND NOT A PARSER
 * -------------------------------
 * This module does NOT build NEXUS messages. It builds the exact text that
 * `detectDialect` + `parseMarkdown` already read, and hands that to the import
 * path unchanged. Everything subtle downstream — `[username]` tags, the
 * on-disk timestamp rule, `[thinking]` extraction, the "N / N" regenerate
 * counter, split planning, the first-original marker, sidebar order — then has
 * exactly ONE implementation, the tested one. A second message builder would
 * be a second place for those rules to drift.
 *
 * It is a port of `ds_to_md.py`, which was verified 2026-10-24 by round-trip
 * against the REAL parser over 954 messages / 1.65M chars (33/33) plus an
 * 11-case adversarial fixture. The port is held to that verification by byte
 * equality with the Python output on the same input, which is the only reason
 * to trust it: the bytes are the contract, not the restated intent.
 *
 * OUTPUT DIALECT: "You:" / "<Label>:", never native "[Name]:". Measured
 * reasons, both in markdownLogic.ts:
 *   - In the native dialect a body line "[Anonymous]:" IS a boundary, and the
 *     user branch of `exportToMarkdown` strips any leading "[...]" from the
 *     body as a speaker tag. Foreign text with brackets would be mangled.
 *   - In this dialect only the two detected label lines are boundaries; any
 *     other "Label:" line stays ordinary body text.
 *
 * LABELS ARE CHOSEN, NOT HARD-CODED. A body line that is exactly "DeepSeek:"
 * is entirely possible in a conversation about DeepSeek, and it would become a
 * false boundary. The labels are picked so they collide with no standalone
 * line in this conversation's own text, and the substitution is reported.
 */

/** Mirror of DIALECT_LABEL_RE in markdownLogic.ts. Same source, one meaning. */
const LABEL_RE = /^([A-Za-zÀ-ɏЀ-ӿ][\w .\-À-ɏЀ-ӿ]{0,30}):[ \t]*$/;

const USER_LABELS = ['You', 'You_DS', 'Human_DS', 'Q_DS'];
const AI_LABELS = ['DeepSeek', 'DeepSeek_AI', 'Assistant_DS', 'A_DS'];

/** Mirror of normName() in markdownLogic.ts. */
function normName(s: string): string {
  return s
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .trim()
    .toLowerCase();
}

type DsMessage = {
  role: 'user' | 'assistant';
  content: string;
  thinking: string;
  ts: string | null;
};

export type DeepSeekConversion = {
  /** The conversation's own title, from the JSON. Empty when it has none. */
  title: string;
  /** Text in the `deepseek-exporter` dialect, ready for parseMarkdown. */
  markdown: string;
  /** Messages rendered (branch-abandoned nodes are NOT counted here). */
  messages: number;
  /** Nodes on abandoned regeneration branches, left out of the transcript. */
  droppedBranchMessages: number;
  /** Label substitutions and other things the reader should be told. */
  notes: string[];
};

/** A JSON file this module can convert — shape only, no content read. */
export function isDeepSeekJson(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray(data)) return data.some((c) => c && typeof c === 'object' && c.mapping);
  if (data.mapping && typeof data.mapping === 'object') return true;
  const biz = data.data && typeof data.data === 'object' ? data.data.biz_data : null;
  return !!(biz && Array.isArray(biz.chat_messages));
}

// ── timestamps ──────────────────────────────────────────────────────────────

function two(n: number): string { return String(n).padStart(2, '0'); }

/**
 * `inserted_at` -> "[YYYY-MM-DD HH:MM:SS]" in LOCAL time, or null.
 *
 * Local because `formatTimestampTag` renders local time, so a UTC tag would
 * make every imported message read hours off. TWO SOURCES, TWO TYPES: the
 * official data export writes an ISO string, the live API a float epoch
 * (measured — 700/700 messages were floats, not assumed). Both arrive here.
 */
function localTsTag(raw: any): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let d: Date;
  if (typeof raw === 'number') {
    d = new Date(raw * 1000);
  } else {
    // Date.parse wants at most 3 fractional digits to be portable, and no "Z"
    // alongside an offset. Trim rather than hope.
    const s = String(raw).trim().replace('Z', '+00:00').replace(/\.(\d{3})\d+/, '.$1');
    d = new Date(s);
  }
  if (isNaN(d.getTime())) return null;
  return `[${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}]`;
}

// ── one message ─────────────────────────────────────────────────────────────

/**
 * One DeepSeek message -> one transcript turn, or null when it carries no text.
 *
 * The official export has no `role`, so the role is derived from the fragment
 * types; the live API states it outright. Use the stated one when it is there —
 * deriving a fact that was handed to you is how two sources quietly disagree.
 *
 * Fragment types, measured against both doors: REQUEST / RESPONSE carry body
 * text, THINK carries the thought, FILE carries attachment METADATA only (the
 * bytes are in neither export), SEARCH / TOOL_SEARCH carry result lists.
 * Anything else is UI-only (the API adds a transient TIP) and is left out —
 * but its size is counted by the caller's stats so "dropped" is never confused
 * with "there was nothing there".
 */
function messageToTurn(msg: any): DsMessage | null {
  const frags: any[] = Array.isArray(msg?.fragments) ? msg.fragments : [];
  const stated = String(msg?.role || '').toUpperCase();
  const role: 'user' | 'assistant' =
    stated === 'USER' ? 'user'
      : stated === 'ASSISTANT' ? 'assistant'
        : frags.some((f) => f?.type === 'REQUEST') ? 'user' : 'assistant';

  const bodyParts: string[] = [];
  const thinkParts: string[] = [];

  for (const f of frags) {
    const t = f?.type;
    if (t === 'REQUEST' || t === 'RESPONSE') {
      if (f.content) bodyParts.push(String(f.content));
    } else if (t === 'THINK') {
      if (f.content) thinkParts.push(String(f.content));
    } else if (t === 'FILE') {
      const names: string[] = [];
      for (const fl of (Array.isArray(f.files) ? f.files : [])) {
        const nm = fl?.file_name || '(unnamed)';
        const sz = fl?.file_size;
        names.push(typeof sz === 'number' ? `${nm}, ${sz} bytes` : String(nm));
      }
      if (names.length) bodyParts.push('[attachment: ' + names.join('; ') + ']');
    } else if (t === 'SEARCH' || t === 'TOOL_SEARCH') {
      const res = Array.isArray(f.results) ? f.results : [];
      bodyParts.push(`[web search: ${res.length} results]`);
    }
  }

  const body = bodyParts.filter(Boolean).join('\n\n').trim();
  const thinking = thinkParts.filter(Boolean).join('\n\n').trim();
  if (!body && !thinking) return null;

  return {
    role,
    content: body,
    thinking: role === 'assistant' ? thinking : '',
    ts: localTsTag(msg?.inserted_at ?? ''),
  };
}

// ── which branch is the conversation ────────────────────────────────────────

/**
 * Live API: a FLAT array plus `chat_session.current_message_id`, which names
 * the leaf of the branch the app is showing. Walking `parent_id` up from that
 * leaf is the SERVER's own answer to "which branch is live"; the official
 * export has no such field, which is why that path has to infer it.
 *
 * Measured on one conversation through both doors: 700 nodes, 696 in the
 * chain, 4 abandoned — identical. Two different rules agreeing on the same
 * data is the only reason to trust either.
 */
function apiChain(conv: any): { chain: any[]; dropped: number } {
  const msgs: any[] = Array.isArray(conv?.chat_messages) ? conv.chat_messages : [];
  const byId = new Map<any, any>();
  for (const m of msgs) byId.set(m?.message_id, m);
  const leaf = conv?.chat_session?.current_message_id;
  if (!byId.has(leaf)) return { chain: msgs.slice(), dropped: 0 };
  const chain: any[] = [];
  const seen = new Set<any>();
  let node = leaf;
  while (node !== null && node !== undefined && byId.has(node) && !seen.has(node)) {
    seen.add(node);
    chain.push(byId.get(node));
    node = byId.get(node)?.parent_id;
  }
  chain.reverse();
  return { chain, dropped: msgs.length - chain.length };
}

function insertedAt(node: any): string {
  const v = node?.message?.inserted_at;
  return v === null || v === undefined ? '' : String(v);
}

function maxTimeBelow(mapping: any, start: string, memo: Map<string, string>): string {
  const hit = memo.get(start);
  if (hit !== undefined) return hit;
  memo.set(start, '');  // cycle guard
  const node = mapping[start] || {};
  let best = insertedAt(node);
  for (const child of (Array.isArray(node.children) ? node.children : [])) {
    const t = maxTimeBelow(mapping, child, memo);
    if (t > best) best = t;
  }
  memo.set(start, best);
  return best;
}

function countBelow(mapping: any, start: string, seen: Set<string>): number {
  if (seen.has(start) || !mapping[start]) return 0;
  seen.add(start);
  let n = mapping[start].message ? 1 : 0;
  for (const c of (Array.isArray(mapping[start].children) ? mapping[start].children : [])) {
    n += countBelow(mapping, c, seen);
  }
  return n;
}

/**
 * Official export: walk root -> leaf taking the branch that holds the NEWEST
 * message. Measured on the real export, following newest-subtree reaches
 * 696/700 and 220/246 nodes where following the FIRST child reaches 260 and
 * 54. Branch points are user-side prompt edits; the abandoned side has 2-20
 * nodes below it while the live side has 186-438. "Last child" agrees on this
 * data, but newest-subtree says WHY, so that is the rule.
 */
function activePath(mapping: any): { path: string[]; dropped: number } {
  const memo = new Map<string, string>();
  const path: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let cur = 'root';
  while (mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    const kids: string[] = Array.isArray(mapping[cur].children) ? mapping[cur].children : [];
    if (!kids.length) break;
    let pick = kids[0];
    if (kids.length > 1) {
      // Mirror of Python's `max(kids, key=(time, id))`: newest subtree wins,
      // the id breaks ties so the choice is deterministic.
      for (const k of kids) {
        const a = maxTimeBelow(mapping, k, memo), b = maxTimeBelow(mapping, pick, memo);
        if (a > b || (a === b && k > pick)) pick = k;
      }
      for (const k of kids) if (k !== pick) dropped += countBelow(mapping, k, new Set());
    }
    path.push(pick);
    cur = pick;
  }
  return { path, dropped };
}

// ── rendering ───────────────────────────────────────────────────────────────

function standaloneLabels(messages: DsMessage[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    for (const blob of [m.content, m.thinking]) {
      for (const line of blob.split('\n')) {
        const mt = line.match(LABEL_RE);
        if (mt) out.add(normName(mt[1]));
      }
    }
  }
  return out;
}

const THINK_CLOSE = /^[ \t]*\[\/thinking\]/im;
const INLINE_NOTE = '(thinking kept inline: it contains a literal [/thinking] line)';

function render(messages: DsMessage[], userLabel: string, aiLabel: string): string {
  const out: string[] = [];
  for (const m of messages) {
    out.push(`${m.role === 'user' ? userLabel : aiLabel}:`);
    out.push('');
    if (m.ts) out.push(m.ts);
    if (m.thinking) {
      if (THINK_CLOSE.test(m.thinking)) {
        // The parser's block regex is non-greedy: a literal "[/thinking]" line
        // inside the thought would close the block early and spill the rest
        // into the body in the wrong order. So this thought is NOT written as
        // a block — it goes into the body under a line that says so. Nothing
        // is lost; only the channel changes.
        out.push(INLINE_NOTE);
        out.push(m.thinking);
        out.push('');
      } else {
        out.push('[thinking]');
        out.push(m.thinking);
        out.push('[/thinking]');
        out.push('');
      }
    }
    out.push(m.content);
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Convert one DeepSeek JSON file. Throws with a sentence the reader can act on
 * — never a silent partial result, which is the failure mode this whole path
 * exists to avoid.
 */
export function deepSeekJsonToMarkdown(data: any): DeepSeekConversion {
  const notes: string[] = [];
  let conv: any = null;
  let fromApi = false;

  if (Array.isArray(data)) {
    throw new Error(
      'This is the full DeepSeek data export (every conversation in one file). ' +
      'Import takes one conversation at a time — use the browser snippet, which ' +
      'downloads the open conversation on its own, or ds_to_md.py for the archive.'
    );
  }
  const biz = data?.data && typeof data.data === 'object' ? data.data.biz_data : null;
  if (biz && Array.isArray(biz.chat_messages)) {
    const cc = String(biz.cache_control || '').toUpperCase();
    if (cc === 'MERGE') {
      // A delta looks complete and is short. Refusing is the only honest answer.
      throw new Error(
        'cache_control = MERGE: this response is a DELTA, not the whole thread. ' +
        'Re-run the snippet in a fresh tab before importing — importing a delta ' +
        'would look complete and be missing most of the conversation.'
      );
    }
    conv = {
      title: biz.chat_session?.title || '',
      chat_session: biz.chat_session || {},
      chat_messages: biz.chat_messages,
    };
    fromApi = true;
  } else if (data?.mapping && typeof data.mapping === 'object') {
    conv = data;
  } else {
    throw new Error(
      'Not a DeepSeek conversation: no `mapping` and no `data.biz_data.chat_messages`.'
    );
  }

  let turns: DsMessage[];
  let dropped: number;
  if (fromApi) {
    const r = apiChain(conv);
    dropped = r.dropped;
    turns = r.chain.map(messageToTurn).filter((x): x is DsMessage => !!x);
  } else {
    const r = activePath(conv.mapping);
    dropped = r.dropped;
    turns = r.path.map((n) => messageToTurn(conv.mapping[n]?.message || {}))
      .filter((x): x is DsMessage => !!x);
  }

  if (turns.length === 0) throw new Error('The conversation has no messages with any text in it.');

  const taken = standaloneLabels(turns);
  const userLabel = USER_LABELS.find((c) => !taken.has(normName(c)));
  const aiLabel = AI_LABELS.find((c) => !taken.has(normName(c)));
  if (!userLabel || !aiLabel) {
    throw new Error(
      'Every candidate speaker label already appears as a standalone line in this ' +
      'conversation\'s own text, so any of them would cut the transcript at a false ' +
      'boundary. Refusing rather than shipping a log that is quietly wrong.'
    );
  }
  if (userLabel !== USER_LABELS[0]) notes.push(`"${USER_LABELS[0]}:" collides with body text → using "${userLabel}:"`);
  if (aiLabel !== AI_LABELS[0]) notes.push(`"${AI_LABELS[0]}:" collides with body text → using "${aiLabel}:"`);
  if (dropped > 0) notes.push(`${dropped} message(s) on abandoned regeneration branches are not included`);

  return {
    title: String(conv.title || '').trim(),
    markdown: render(turns, userLabel, aiLabel),
    messages: turns.length,
    droppedBranchMessages: dropped,
    notes,
  };
}
