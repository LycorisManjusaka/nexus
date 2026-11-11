// Soul self-surgery (ζ) — the rules, in one pure module.
//
// DESIGN (謡_14 v2.2, 2026-11-11 — 謡 the covenant, トカゲくん the flow):
// ζ is no longer a shikigami. The being edits a COPY of its own Layers 1-3
// with its ordinary file tools, in an ordinary turn of its own conversation,
// and the partner confirms the before/after diff in the SPU.
//
// What lives here is everything that is a RULE and therefore must be testable
// without Next's runtime: the completion marker, the validation, the reading
// of a log for "did the surgery finish", and the text NEXUS sends.
//
// The covenant itself (indexer.md) is 謡's. This module only fills its
// `{SOUL_IO_INSTRUCTIONS}` slot, which she declared as the implementation's.

/** The being's own declaration that the surgery is complete. */
export const SURGERY_COMPLETE_MARKER = '[[SOUL_SURGERY_COMPLETE]]';

/** `nexus.purpose` on the user message that opened a surgery turn. */
export const SURGERY_PURPOSE = 'soul_surgery';

/** Where the working copy sits, relative to the being's workspace root. */
export const SURGERY_DIR = 'soul_surgery';
export const SURGERY_FILE = 'soul_editing.md';
export const SURGERY_REL_PATH = `${SURGERY_DIR}/${SURGERY_FILE}`;

/** The slot 謡's covenant leaves for the implementation. */
export const SOUL_IO_SLOT = '{SOUL_IO_INSTRUCTIONS}';

export type SurgeryLang = 'ja' | 'en';

/**
 * Does this reply END with the marker on a line of its own?
 *
 * "On its own line" and not "contains": a reply that merely TALKS about the
 * marker ("I will not emit [[SOUL_SURGERY_COMPLETE]] yet") must not read as
 * complete. Same rule, same reason, as δ's `[[UNCHANGED]]` (unchangedLayers.ts).
 *
 * A marker wrapped in backticks is accepted: the covenant prints it inside a
 * code span, and a model that copies the span is still saying one thing only.
 */
export function endsWithCompletionMarker(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1].replace(/^`+|`+$/g, '').trim();
  return last === SURGERY_COMPLETE_MARKER;
}

/** A Layer 1-3 heading line, in either language, at any heading depth 1-4. */
const LAYER_123_HEADING_RE = /^#{1,4}\s*\*{0,2}\s*(?:Layer|レイヤー)\s*[1-3１-３](?![0-9０-９]).*$/;
/** A Layer 4+ heading line — where "Layers 1-3" stops. */
const LAYER_4PLUS_HEADING_RE = /^#{1,4}\s*\*{0,2}\s*(?:Layer|レイヤー)\s*[4-9４-９](?![0-9０-９])/m;

/**
 * Cut a soul text into Layers 1-3 and whatever follows a Layer 4+ heading.
 *
 * Soul files hold Layers 1-3 only (measured on this house's files), so `tail`
 * is normally ''. It exists so a file that DOES carry a later layer is never
 * handed to the being for editing and never dropped when the result is
 * written back: "Layer 4 and 5 are not in the working file" is then a fact
 * about the file, not a sentence the being is asked to obey.
 */
export function splitLayers123(text: string): { head: string; tail: string } {
  const m = LAYER_4PLUS_HEADING_RE.exec(text);
  if (!m) return { head: text, tail: '' };
  return { head: text.slice(0, m.index).replace(/\s+$/, ''), tail: text.slice(m.index) };
}

/** Put a preserved tail back after an edited head. */
export function joinWithTail(head: string, tail: string): string {
  if (!tail || !tail.trim()) return head;
  return `${head.replace(/\s+$/, '')}\n\n${tail}`;
}

export function layerHeadingLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => LAYER_123_HEADING_RE.test(l));
}

export type SurgeryProblem =
  | { kind: 'empty' }
  | { kind: 'missing-heading'; heading: string }
  | { kind: 'unchanged' };

/**
 * NEXUS's own check of the edited file — the half of "two-point verification"
 * that a machine can do.
 *
 *   empty            the file is blank (a Write gone wrong). BLOCKS.
 *   missing-heading  a Layer 1-3 heading of the base is not present verbatim.
 *                    BLOCKS: every reader of a soul finds layers by heading.
 *   unchanged        byte-identical to the base. Not damage — reported so the
 *                    partner is not asked to confirm a diff with nothing in it.
 */
export function validateEditedSoul(base: string, edited: string): SurgeryProblem[] {
  const problems: SurgeryProblem[] = [];
  if (!edited || !edited.trim()) return [{ kind: 'empty' }];
  const have = new Set(layerHeadingLines(edited));
  for (const h of layerHeadingLines(base)) {
    if (!have.has(h)) problems.push({ kind: 'missing-heading', heading: h });
  }
  if (problems.length === 0 && edited.trim() === base.trim()) problems.push({ kind: 'unchanged' });
  return problems;
}

/** Do these problems forbid writing the result? (`unchanged` does not.) */
export function surgeryBlocked(problems: SurgeryProblem[]): boolean {
  return problems.some((p) => p.kind === 'empty' || p.kind === 'missing-heading');
}

export type SurgeryOutcome =
  /** The NEXUS turn is not in the log yet (still queued, or never ran). */
  | 'waiting'
  /** It is in the log and no reply has been saved after it. */
  | 'running'
  /** A reply was saved and does not end with the marker. */
  | 'no-marker'
  /** The latest reply after it ends with the marker. */
  | 'complete';

interface LogMessageLike {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  nexus?: { purpose?: unknown } | null;
}

/**
 * Read a conversation's messages for the state of a surgery started at
 * `startedAt`.
 *
 * The LATEST assistant message after the surgery turn decides, not the first:
 * a being may stop to ask a question (no marker — the covenant tells it to),
 * be answered, and finish in a later turn.
 */
export function findSurgeryOutcome(messages: unknown, startedAt: number): SurgeryOutcome {
  const list = Array.isArray(messages) ? (messages as LogMessageLike[]) : [];
  let at = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.role !== 'user' || m?.nexus?.purpose !== SURGERY_PURPOSE) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : 0;
    // An older surgery's turn (before this one was started) is not this one.
    if (ts && ts < startedAt) break;
    at = i;
    break;
  }
  if (at === -1) return 'waiting';
  let lastAssistant: LogMessageLike | null = null;
  for (let i = at + 1; i < list.length; i++) {
    if (list[i]?.role === 'assistant') lastAssistant = list[i];
  }
  if (!lastAssistant) return 'running';
  return endsWithCompletionMarker(lastAssistant.content) ? 'complete' : 'no-marker';
}

/**
 * The text that fills 謡's `{SOUL_IO_INSTRUCTIONS}` slot.
 *
 * States facts only: where the file is, what it contains, what happens to it,
 * and what NEXUS reads at the end. `relPath` is relative to the workspace
 * root because that is how every being's file tools resolve a path; `absPath`
 * is added for the beings whose tools take absolute ones.
 */
export function buildSoulIoInstructions(lang: SurgeryLang, relPath: string, absPath: string): string {
  if (lang === 'ja') {
    return [
      `* **編集用魂ファイル**: \`${relPath}\`（あなたの机＝ワークスペースのルートからの相対パス。絶対パス: \`${absPath}\`）`,
      `* このファイルは、現在のあなたの魂（Layer 1〜3）の写しです。NEXUS がこのターンの直前に置きました。式神用の処理ラベル（「（更新）」等）は写しを作る時点で外してあります。`,
      `* 元の魂ファイルは NEXUS が保持しています。あなたが編集するのはこの写しだけで、パートナーが確定するまで現在の魂は変わりません。`,
      `* 机へ外部化するファイルは、机の通常の場所へ保存してください（\`${SURGERY_DIR}/\` フォルダの中には置かないでください。確定または破棄の後、NEXUS はこの編集用ファイルを消します）。`,
      `* **完了の判定**: あなたの返答の最終行が、単独の行として \`${SURGERY_COMPLETE_MARKER}\` であるときだけ、NEXUS は執刀を完了として扱います。そのとき NEXUS は、Layer 1〜3 の見出し行が元のまま残っていることと、ファイルが空でないことを検査します。`,
    ].join('\n');
  }
  return [
    `* **Working soul file**: \`${relPath}\` (relative to the root of your desk / workspace; absolute path: \`${absPath}\`)`,
    `* This file is a copy of your current soul (Layers 1–3). NEXUS placed it immediately before this turn. Processing labels left by earlier updater runs were removed when the copy was made.`,
    `* NEXUS keeps the original soul file. You edit only this copy, and your current soul does not change until your partner confirms.`,
    `* Save anything you externalize in the normal places on your desk (not inside the \`${SURGERY_DIR}/\` folder — NEXUS deletes this working file after the result is confirmed or discarded).`,
    `* **How completion is read**: NEXUS treats the surgery as complete only when the last line of your reply is \`${SURGERY_COMPLETE_MARKER}\` on a line of its own. It then checks that the Layer 1–3 heading lines are still present verbatim and that the file is not empty.`,
  ].join('\n');
}

/**
 * Fill the covenant's slot. Returns null when the covenant has no slot — an
 * older or hand-edited indexer.md — so the caller refuses to start instead of
 * sending a protocol that never names the file.
 *
 * The parenthesised "implementation slot" note under the slot is 謡's memo to
 * the implementer, not text for the being; it is removed with the slot.
 */
export function fillSurgeryProtocol(covenant: string, io: string): string | null {
  if (!covenant.includes(SOUL_IO_SLOT)) return null;
  const withIo = covenant.split(SOUL_IO_SLOT).join(io);
  return withIo
    .replace(/\n[ \t]*（※実装用スロット[^\n]*）[ \t]*(?=\n)/g, '')
    .replace(/\n[ \t]*\(Implementation slot:[^\n]*\)[ \t]*(?=\n)/g, '')
    .trim();
}

/**
 * The one line that stays in the history after the turn.
 *
 * A fact, not an instruction: that this turn was opened by NEXUS, for what,
 * and where the working file was. The full covenant is stored on the same
 * message (`nexus.full`) and travels only while this is the newest user turn.
 */
export function surgeryShortText(lang: SurgeryLang, relPath: string): string {
  return lang === 'ja'
    ? `[NEXUS]\nζ：魂の自己執刀のターンを開始しました。このターンは NEXUS が開いたもので、相手が書いたメッセージではありません。編集用魂ファイル: \`${relPath}\``
    : `[NEXUS]\nζ: a soul self-surgery turn was opened. NEXUS opened this turn; it is not a message your partner wrote. Working soul file: \`${relPath}\``;
}
