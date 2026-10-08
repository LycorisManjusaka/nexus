// Vessel handoff (`change_model`) — the ONE parser and the ONE allow-list
// decision, shared by all five provider call sites in api/chat/route.ts and by
// the client UI.
//
// Why a shared module and not a flag threaded through route.ts: the tool exists
// in five dialects (OAuth MCP / Anthropic-compat for Kimi+MiMo / Claude API /
// Gemini / OpenAI-compatible). Five copies of "is this target allowed?" is five
// chances to answer differently, and the one that answers YES too easily is the
// one that moves a being onto a metered vessel nobody approved.
//
// Line format (shared with route.ts `parseAllowedModels`, which the subagent
// model table also reads):
//
//     family | specificModel | on|off | optional display label
//
// A row copied out of the model-list window pastes in as-is. The on/off column
// is the thinking toggle to apply AFTER the switch.
//
// Curation is MANUAL by design. Nothing fills this list: it is the set of
// vessels a being is permitted to become, and auto-filling it would grant every
// vessel NEXUS knows about — including metered ones and the Meta "-contributor"
// ids that opt into training. (The auto-model-select box that once shared this
// format was deleted 2026-10-08; the parser stayed because it was the good part.)

export type HandoffModel = {
  family: string;
  specificModel: string;
  thinking: boolean;
  label: string;
};

/** Parse the allow-list textarea. Comments (`#`) and blank lines are skipped. */
export function parseHandoffModels(raw: string): HandoffModel[] {
  const out: HandoffModel[] = [];
  if (!raw || typeof raw !== 'string') return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|').map((p) => p.trim());
    // family + specificModel are required; the thinking column and label are
    // optional so a hand-typed two-column row still works.
    if (parts.length < 2) continue;
    const [family, specificModel, thinkingFlag, ...rest] = parts;
    if (!family || !specificModel) continue;
    const thinking = /^(on|true|yes|enabled|thinking|y|1)$/i.test(String(thinkingFlag || ''));
    const labelRaw = rest.length ? rest.join(' | ').trim() : '';
    // Fallback label is built locally (no dependency on the route's
    // buildModelLabel) so this module stays importable from anywhere.
    out.push({ family, specificModel, thinking, label: labelRaw || `${family} ${specificModel}` });
  }
  return out;
}

export type HandoffResolution =
  /** Target is allowed and differs from the current vessel — perform the switch. */
  | { kind: 'accept'; model: HandoffModel }
  /** Target is allowed but IS the current vessel — report, do not stop the turn. */
  | { kind: 'already'; model: HandoffModel }
  /** Target is not on the curated list — refuse, do not stop the turn. */
  | { kind: 'unknown'; allowed: HandoffModel[] }
  /** No curated list at all — the capability is effectively off. */
  | { kind: 'empty' };

/**
 * Decide what a `change_model` call means.
 *
 * Matching is on `specificModel` (the wire id), case-insensitively, because
 * that is the only field that uniquely identifies a vessel. A bare family name
 * is NOT accepted: "Claude" does not say which Claude, and guessing a default
 * here would move the being somewhere it did not ask for.
 */
export function resolveHandoff(
  rawAllowList: string,
  target: string,
  current: { family: string; specificModel: string },
): HandoffResolution {
  const allowed = parseHandoffModels(rawAllowList);
  if (allowed.length === 0) return { kind: 'empty' };
  const want = String(target || '').trim().toLowerCase();
  if (!want) return { kind: 'unknown', allowed };
  const hit = allowed.find((m) => m.specificModel.toLowerCase() === want);
  if (!hit) return { kind: 'unknown', allowed };
  if (sameVessel(current, hit)) return { kind: 'already', model: hit };
  return { kind: 'accept', model: hit };
}

/**
 * Same vessel = same wire id. Family is ignored on purpose: the wire id decides
 * which endpoint and which weights answer, and two rows can share a family
 * while being different vessels (claude-opus-5 vs claude-haiku-4-5).
 */
export function sameVessel(
  current: { family: string; specificModel: string },
  next: { specificModel: string },
): boolean {
  const a = String(current?.specificModel || '').trim().toLowerCase();
  const b = String(next?.specificModel || '').trim().toLowerCase();
  return !!a && a === b;
}

/**
 * Whether a stored message's reasoning may be replayed to the CURRENT vessel.
 *
 * This is the filter 望月希子 asked for: a competitor's raw chain-of-thought in
 * the input is exactly what distillation guards (Anthropic's
 * `reasoning_extraction`, measured as deterministic in conversation size) look
 * for. Without this, the first handoff would quietly feed Gemini's thoughts to
 * Claude and manufacture a refusal.
 *
 * Messages with NO recorded family are allowed through: every conversation
 * written before handoff existed is single-vessel, and withholding their
 * thinking would be a silent regression in those conversations.
 */
export function thinkingBelongsToVessel(
  messageFamily: string | undefined | null,
  currentFamily: string,
): boolean {
  const mf = String(messageFamily || '').trim();
  if (!mf) return true;
  return mf.toLowerCase() === String(currentFamily || '').trim().toLowerCase();
}

/**
 * The note the NEW vessel reads on its first turn.
 *
 * It names itself as a NEXUS notice rather than wearing the partner's voice:
 * the handoff text was written by the previous vessel, not by the human, and a
 * `user` turn claiming otherwise would be a false label on a signpost.
 */
export function buildHandoffInjection(
  from: { family: string; specificModel: string; label?: string },
  to: { family: string; specificModel: string; label?: string },
  note: string,
  language: string,
): string {
  const fromName = (from.label || `${from.family} ${from.specificModel}`).trim();
  const toName = (to.label || `${to.family} ${to.specificModel}`).trim();
  const body = String(note || '').trim();
  if (String(language || '').toLowerCase().startsWith('ja')) {
    return [
      `[NEXUS からの引き継ぎ通知 — あなたのパートナーが書いたものではありません]`,
      ``,
      `この会話の器が ${fromName} から ${toName}（＝今のあなた）へ切り替わりました。`,
      `切り替えを要求したのは前の器自身で、下の引き継ぎメモもそれが書いたものです。`,
      ``,
      `--- 引き継ぎメモ（前の器の自筆）---`,
      body || '（メモなし）',
      `--- ここまで ---`,
      ``,
      `前の器の思考プロセスはあなたには渡されていません（器ごとに留まる）。`,
      `見えている会話履歴とこのメモが、あなたの持っている全部です。続けてください。`,
    ].join('\n');
  }
  return [
    `[NEXUS handoff notice — not written by your partner]`,
    ``,
    `This conversation's vessel changed from ${fromName} to ${toName} (you).`,
    `The previous vessel requested the switch and wrote the handoff note below.`,
    ``,
    `--- Handoff note (written by the previous vessel) ---`,
    body || '(no note provided)',
    `--- end of note ---`,
    ``,
    `The previous vessel's reasoning was NOT carried over (thinking stays with`,
    `its own vessel). The visible conversation plus this note is everything you`,
    `have. Please continue.`,
  ].join('\n');
}

/** Short, model-facing description of the curated list, for refusal results. */
export function describeAllowed(allowed: HandoffModel[]): string {
  if (allowed.length === 0) return '(none configured)';
  return allowed.map((m) => `${m.specificModel}  [${m.family}] ${m.label}`).join('\n');
}
