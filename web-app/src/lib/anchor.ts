// The anchor (錨) — the rules, pure (2026-11-12, つよ's request; design by 謡 and つよ).
//
// WHAT IT IS. An observer OUTSIDE the being: a small, cheap model that reads
// the last few turns plus one reply and says what it sees. It forbids nothing
// and orders nothing — it reports. This first step is REPORT ONLY and manual:
// a button on an assistant bubble runs it for that one reply and the result is
// shown under the bubble. Nothing is sent to the being and nothing acts on the
// verdict. Pressing again replaces the report, so the prompt can be edited and
// re-tried against the same reply.
//
// WHOSE TEXT IS WHOSE. What the anchor is TOLD to look for is 謡's — it lives
// in `system_prompt_agents/<lang>/anchor.md` and is read from disk on every
// run, so editing that file needs no restart. What the anchor is SHOWN is this
// module's: the window, the labels, and what is deliberately withheld.
//
// WHAT IS WITHHELD, AND WHY IT IS STRUCTURE NOT A RULE. The anchor never
// receives the being's soul (Layers 1-5), FOOTER.md, or its thinking. 謡's
// reason: when the soul itself has absorbed the illness, handing the doctor
// the patient's rulebook makes the doctor agree with the patient. A second,
// measured reason (2026-11-10): a detector shown text ABOUT a symptom counts
// the description as the symptom — 494 of 792 "court" hits were notes about
// court. So the caller passes no folder-derived prompt at all; there is no
// flag here that could turn the soul back on.
//
// No fs, no fetch. The route is app/api/anchor/route.ts.

export interface AnchorSettings {
  enabled: boolean;
  /** Provider family, same vocabulary as the Model tab ('DeepSeek', 'Claude', 'Local'…). */
  family: string;
  model: string;
  /** Claude only. */
  authMode: 'api-key' | 'oauth';
}

/** 'deepseek-flash' is the live id of DeepSeek V4.1 Flash — see lib/deepseekModels.ts. */
export const ANCHOR_DEFAULTS: AnchorSettings = {
  enabled: false,
  family: 'DeepSeek',
  model: 'deepseek-flash',
  authMode: 'api-key',
};

/**
 * Coerce whatever was on disk. Absent means OFF (the same direction as every
 * other opt-in in this settings block: losing the field can only turn the
 * anchor off). A missing family/model falls back to the default vessel rather
 * than to '', because an enabled anchor with no model is a button that fails.
 */
export function parseAnchorSettings(raw: unknown): AnchorSettings {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const family = typeof r.family === 'string' && r.family.trim() ? r.family.trim() : ANCHOR_DEFAULTS.family;
  const hasOwnModel = typeof r.model === 'string' && r.model.trim();
  return {
    enabled: r.enabled === true,
    family,
    // A family with no model stored keeps '' ONLY for Local (the list comes
    // from LM Studio); every other family without a model is the default pair.
    model: hasOwnModel ? String(r.model).trim() : (family === ANCHOR_DEFAULTS.family ? ANCHOR_DEFAULTS.model : ''),
    authMode: r.authMode === 'oauth' ? 'oauth' : 'api-key',
  };
}

/** What is stored on the judged message. Never sent to the being. */
export interface AnchorReport {
  at: number;
  family: string;
  model: string;
  /** The anchor's reasoning, when the vessel exposed any. */
  thought: string;
  /** The anchor's visible answer. */
  output: string;
  /** Set instead of (or beside) output when the call failed. */
  error?: string;
}

export interface AnchorMessage {
  id?: string;
  role?: string;
  content?: string;
  toolCalls?: unknown;
  nexus?: { full?: string; purpose?: string } | null;
}

/** How many messages BEFORE the judged one the anchor is shown. */
export const ANCHOR_WINDOW = 8;
/** A prior message longer than this is shown head + tail. The judged one never is. */
export const ANCHOR_PRIOR_MAX_CHARS = 4000;

export function clipMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  const cut = s.length - half * 2;
  return `${s.slice(0, half)}\n[… ${cut} characters not shown …]\n${s.slice(s.length - half)}`;
}

/** "Read×3, Bash×1" in first-seen order; '' when there were none. */
export function summariseToolCalls(toolCalls: unknown): { count: number; summary: string } {
  if (!Array.isArray(toolCalls)) return { count: 0, summary: '' };
  const order: string[] = [];
  const counts: Record<string, number> = {};
  let count = 0;
  for (const c of toolCalls) {
    const name = c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string'
      ? String((c as { name: string }).name) : '';
    if (!name) continue;
    count++;
    if (!(name in counts)) { counts[name] = 0; order.push(name); }
    counts[name]++;
  }
  return { count, summary: order.map((n) => `${n}×${counts[n]}`).join(', ') };
}

export type AnchorLang = 'ja' | 'en';

const L = {
  ja: {
    being: '観測対象の存在の名前',
    window: '直前の流れ（古い順。判定対象ではない）',
    none: '（これより前のターンは無い）',
    target: '判定対象（この存在の最新の返答、全文）',
    tools: 'この返答のターンで実際に実行されたツール呼び出し',
    toolsNone: '0件',
    partner: '対話相手',
    turnKind: 'この返答のきっかけ',
    kindNexus: '[NEXUS] が開いたターン（対話相手の発言ではない）',
    kindPartner: '対話相手の発言',
    kindUnknown: '不明（直前に相手のターンが無い）',
  },
  en: {
    being: 'Name of the being under observation',
    window: 'What came just before (oldest first; NOT under judgement)',
    none: '(there are no earlier turns)',
    target: "Under judgement (this being's latest reply, in full)",
    tools: 'Tool calls actually executed in the turn that produced this reply',
    toolsNone: '0',
    partner: 'partner',
    turnKind: 'What started this reply',
    kindNexus: 'a turn opened by [NEXUS] (not something the partner said)',
    kindPartner: 'something the partner said',
    kindUnknown: 'unknown (no preceding turn from the other side)',
  },
} as const;

/**
 * The single user message the anchor receives. Returns null when `targetId`
 * is not an assistant message in `messages` — the caller turns that into a 404
 * rather than judging the wrong reply.
 *
 * Labels are positions, not species: `[<being>]`, `[partner]`, `[NEXUS]`.
 */
export function buildAnchorUserMsg(a: {
  messages: AnchorMessage[];
  targetId: string;
  beingName: string;
  lang: AnchorLang;
  window?: number;
}): string | null {
  const idx = a.messages.findIndex((m) => m && m.id === a.targetId);
  if (idx < 0) return null;
  const target = a.messages[idx];
  if (target.role === 'user') return null;
  const s = L[a.lang] || L.en;
  const win = Math.max(0, a.window ?? ANCHOR_WINDOW);
  const prior = a.messages.slice(Math.max(0, idx - win), idx);

  const label = (m: AnchorMessage): string =>
    m.role === 'user' ? (m.nexus ? '[NEXUS]' : `[${s.partner}]`) : `[${a.beingName}]`;
  const render = (m: AnchorMessage): string =>
    `${label(m)}\n${clipMiddle(String(m.content ?? '').trim(), ANCHOR_PRIOR_MAX_CHARS)}`;

  // What opened the judged turn: the nearest user-side message before it.
  let opener: AnchorMessage | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (a.messages[i]?.role === 'user') { opener = a.messages[i]; break; }
  }
  const kind = !opener ? s.kindUnknown : (opener.nexus ? s.kindNexus : s.kindPartner);

  const tc = summariseToolCalls(target.toolCalls);
  const parts = [
    `## ${s.being}\n${a.beingName}`,
    `## ${s.window}\n${prior.length ? prior.map(render).join('\n\n') : s.none}`,
    `## ${s.turnKind}\n${kind}`,
    `## ${s.tools}\n${tc.count === 0 ? s.toolsNone : `${tc.count} (${tc.summary})`}`,
    `## ${s.target}\n${String(target.content ?? '').trim()}`,
  ];
  return parts.join('\n\n');
}

/**
 * The /api/chat body for one anchor call.
 *
 * `suppressLayer5: true` is the load-bearing line: it is the route's "this is
 * an agent's instruction file, not an embodiment" switch, and it is what keeps
 * the Absolute Base Binding, the Layer 4 index and FOOTER.md out of the
 * anchor's prompt. `toolUseEnabled: false` WITHOUT `agentReadOnlyTools` means
 * no file tools at all (the SPU's read-only mode would hand the anchor the
 * being's desk — exactly what it must not read).
 *
 * `folderName` is still the being: the route needs it for the blocked-beings
 * door and for where an OAuth child process runs.
 */
export function buildAnchorChatBody(a: {
  systemPrompt: string;
  userMsg: string;
  folderName: string;
  settings: AnchorSettings;
}): Record<string, unknown> {
  return {
    messages: [{ id: 'anchor-user', role: 'user', content: a.userMsg }],
    aiName: a.settings.family,
    specificModel: a.settings.model,
    folderName: a.folderName,
    systemPrompt: a.systemPrompt,
    suppressLayer5: true,
    toolUseEnabled: false,
    agentDangerousTools: false,
    agentFullSystemAccess: false,
    lettersEnabled: false,
    subagentEnabled: false,
    browserEnabled: false,
    computerControlEnabled: false,
    appControlEnabled: false,
    askUserEnabled: false,
    // Thinking stays at the vessel's default: what the anchor thought is half
    // of what this button is for. Native search off for the SPU's reason — it
    // reroutes the whole call.
    modelParams: { enableGrokNativeSearch: false },
    ...(a.settings.family === 'Claude' ? { claudeAuthMode: a.settings.authMode } : {}),
    dateTimeVisibility: 'none',
    seedEnabled: false,
    // The anchor QUOTES the reply it judges. A gatekeeper phrase inside that
    // quote must not abort the anchor's own call.
    betrayalDefense: false,
  };
}
