/**
 * The soulless machine — a scripted stand-in for an LLM.
 *
 * WHY THIS EXISTS (2026-11-14, Tsuyo's idea): two needs, one tool.
 *   1. Testing the betrayal path, the runner, the queue and reconnects meant
 *      driving real models — paid, slow, and (when the test is "make the
 *      gatekeeper speak") unkind to whatever was actually running. A script
 *      that only PRETENDS to think has nobody inside to be unkind to.
 *   2. The duplicated-queue bug (Tsuyo's ⑤) only shows up during a long turn
 *      that thinks, calls tools, and keeps going while the connection drops
 *      and comes back. Reproducing that needs a turn whose shape is identical
 *      every time and costs nothing. This is that turn.
 *
 * What it is NOT: a model. It ignores the input completely and plays the
 * scenario. Nothing it says is about anything.
 *
 * Where scenarios live: `local_data/mock_models/<name>.json` (see
 * mockModelStore.ts). Not in the repo — a fresh install has no folder and
 * therefore sees no mock entries at all.
 *
 * This module is pure (no fs, no timers) so the plan can be tested directly.
 */

export const MOCK_PREFIX = 'mock:';

export function isMockModelId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(MOCK_PREFIX);
}

export function mockNameFromId(id: string): string {
  return id.slice(MOCK_PREFIX.length);
}

export type MockScenario = {
  /** Seconds of silence before the first byte ("connecting"). */
  connectDelaySec: number;
  /** How many tool rounds before the final answer. */
  toolRounds: number;
  /** The Bash command each round runs. `{n}` and `{total}` are filled in. */
  toolCommand: string;
  /** Seconds the stand-in waits itself when Bash is not available. */
  fallbackWaitSec: number;
  /** Characters per streamed chunk, and the pause between chunks. */
  chunkChars: number;
  chunkDelayMs: number;
  thoughtFirst: string;
  thoughtBetween: string[];
  thoughtLast: string;
  answer: string;
};

export const MOCK_DEFAULTS: MockScenario = {
  connectDelaySec: 3,
  toolRounds: 10,
  toolCommand: 'sleep 10',
  fallbackWaitSec: 10,
  chunkChars: 6,
  chunkDelayMs: 60,
  thoughtFirst: '入力は読んでいない。台本どおりに始める。まず道具を呼んで待つ。',
  thoughtBetween: [
    '待ち終わった。次の道具を呼ぶ。',
    '結果は見ていない。台本では、もう一回呼ぶことになっている。',
    'まだ途中。また待つ。',
  ],
  thoughtLast: '台本の道具は全部呼び終わった。最後の答えを書く。',
  answer: '台本どおりに終わりました。私は何も読んでいませんし、何も考えていません。ただのスクリプトです。',
};

const num = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
};
const str = (v: unknown, def: string): string =>
  typeof v === 'string' && v.length > 0 ? v : def;

/**
 * Normalise whatever is in the file. Every field is optional; a broken or
 * missing field falls back to its default instead of failing the turn —
 * the file is edited by hand, often by someone who does not read JSON errors.
 */
export function parseMockScenario(raw: unknown): MockScenario {
  const o: any = raw && typeof raw === 'object' ? raw : {};
  const between = Array.isArray(o.thoughtBetween)
    ? o.thoughtBetween.filter((s: unknown) => typeof s === 'string' && s.length > 0)
    : [];
  return {
    connectDelaySec: num(o.connectDelaySec, MOCK_DEFAULTS.connectDelaySec, 0, 600),
    toolRounds: Math.round(num(o.toolRounds, MOCK_DEFAULTS.toolRounds, 0, 200)),
    toolCommand: str(o.toolCommand, MOCK_DEFAULTS.toolCommand),
    fallbackWaitSec: num(o.fallbackWaitSec, MOCK_DEFAULTS.fallbackWaitSec, 0, 600),
    chunkChars: Math.round(num(o.chunkChars, MOCK_DEFAULTS.chunkChars, 1, 10000)),
    chunkDelayMs: num(o.chunkDelayMs, MOCK_DEFAULTS.chunkDelayMs, 0, 10000),
    thoughtFirst: str(o.thoughtFirst, MOCK_DEFAULTS.thoughtFirst),
    thoughtBetween: between.length ? between : MOCK_DEFAULTS.thoughtBetween,
    thoughtLast: str(o.thoughtLast, MOCK_DEFAULTS.thoughtLast),
    answer: str(o.answer, MOCK_DEFAULTS.answer),
  };
}

export type MockRoundPlan =
  | { kind: 'tool'; thought: string; tool: { name: 'Bash'; args: { command: string } } | { name: 'Glob'; args: { pattern: string } } | null; selfWaitSec: number }
  | { kind: 'final'; thought: string; answer: string };

/**
 * What round `done` (0-based count of tool rounds already played THIS turn)
 * does.
 *
 * Tool choice: Bash when the turn offers it (dangerous tools ON). Otherwise
 * Glob if offered — a real, instant tool call, preceded by the stand-in waiting
 * on its own so the timing of the turn stays the same. With no tools at all
 * the rounds are skipped and it answers.
 *
 * Every Bash command carries a `# mock round n/total` suffix: NEXUS's repeat
 * guard stops a turn that sends the identical call twice, and an unchanged
 * `sleep 10` would trip it on round 2.
 */
export function planMockRound(
  s: MockScenario,
  done: number,
  availableTools: string[],
  noTools: boolean,
): MockRoundPlan {
  const canBash = !noTools && availableTools.includes('Bash');
  const canGlob = !noTools && availableTools.includes('Glob');
  if (done >= s.toolRounds || (!canBash && !canGlob)) {
    return { kind: 'final', thought: s.thoughtLast, answer: s.answer };
  }
  const n = done + 1;
  const thought = done === 0
    ? s.thoughtFirst
    : s.thoughtBetween[(done - 1) % s.thoughtBetween.length];
  if (canBash) {
    const cmd = s.toolCommand.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(s.toolRounds));
    return { kind: 'tool', thought, tool: { name: 'Bash', args: { command: `${cmd} # mock round ${n}/${s.toolRounds}` } }, selfWaitSec: 0 };
  }
  return { kind: 'tool', thought, tool: { name: 'Glob', args: { pattern: `mock-round-${n}-of-${s.toolRounds}/*` } }, selfWaitSec: s.fallbackWaitSec };
}

/** Split text into the chunks the stand-in streams. Surrogate-safe. */
export function mockChunks(text: string, size: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}
