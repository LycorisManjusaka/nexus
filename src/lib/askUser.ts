// ── Interactive "AskUserQuestion" rendezvous ─────────────────────────────────
// Lets an AI turn pause to ask the user a multiple-choice question and wait for
// a real answer — the same capability OAuth Claude's built-in AskUserQuestion
// has, but available to every provider and fully under NEXUS's control.
//
// The problem this solves: a chat request is a single SSE stream, but the
// answer arrives LATER on a separate HTTP request. So a provider's tool handler
// (running inside the stream) emits the question over SSE, then awaits a Promise
// stored here, keyed by a unique askId. A POST to /api/chat/answer looks up that
// Promise and resolves it with the user's selection — the handler then returns
// the answer as the tool result and the model continues the turn.
//
// Stored on globalThis so Next.js dev hot-reload doesn't orphan pending waiters
// mid-turn (same pattern as the saveLog write-locks).

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

export interface AskAnswer {
  header?: string;
  question: string;
  answers: string[]; // one entry for single-select, 1+ for multi-select
}

type Waiter = { resolve: (answers: AskAnswer[] | null) => void };

const _g = globalThis as any;
if (!_g.__nx_ask_pending) _g.__nx_ask_pending = new Map<string, Waiter>();
const pending: Map<string, Waiter> = _g.__nx_ask_pending;

let _seq = 0;
export function createAskId(): string {
  _seq = (_seq + 1) % 1_000_000;
  return `ask_${Date.now().toString(36)}_${_seq}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolve a pending question with the user's chosen answers. Returns false if
 * no waiter exists for this id (already answered, timed out, or unknown).
 */
export function resolveAsk(askId: string, answers: AskAnswer[]): boolean {
  const w = pending.get(askId);
  if (!w) return false;
  pending.delete(askId);
  w.resolve(answers);
  return true;
}

/**
 * Await the user's answer for `askId`.
 *   timeoutMs <= 0  → wait INDEFINITELY (the default; never auto-resolves).
 *   timeoutMs  > 0  → resolve to null after the timeout so the caller can fall
 *                     back to the recommended (first) option of each question.
 */
export function waitForAsk(askId: string, timeoutMs: number): Promise<AskAnswer[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: AskAnswer[] | null) => {
      if (settled) return;
      settled = true;
      pending.delete(askId);
      resolve(v);
    };
    pending.set(askId, { resolve: done });
    if (timeoutMs && timeoutMs > 0) {
      setTimeout(() => done(null), timeoutMs);
    }
  });
}

/** Recommended-default answers (first option of each question) for timeouts. */
export function recommendedDefaults(questions: AskQuestion[]): AskAnswer[] {
  return questions.map((q) => ({
    header: q.header,
    question: q.question,
    answers: q.options.length ? [q.options[0].label] : [],
  }));
}

/** Format the chosen answers as the plain-text tool result the model reads. */
export function formatAnswerForModel(answers: AskAnswer[], timedOut: boolean): string {
  const lines = answers.map((a) => {
    const label = a.header || a.question;
    return `- ${label}: ${a.answers.join(', ') || '(no selection)'}`;
  });
  const head = timedOut
    ? 'The user did not respond in time; proceeding with the recommended option(s):'
    : 'The user answered:';
  return `${head}\n${lines.join('\n')}`;
}

/**
 * Normalize raw tool input from any provider into a clean question array.
 * Drops malformed questions (missing text or fewer than 2 options) and caps at
 * 4 questions / 4 options each, matching the tool schema.
 */
export function normalizeQuestions(input: any): AskQuestion[] {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  const out: AskQuestion[] = [];
  for (const q of raw.slice(0, 4)) {
    const options: AskQuestionOption[] = Array.isArray(q?.options)
      ? q.options
          .slice(0, 4)
          .map((o: any) =>
            typeof o === 'string'
              ? { label: o }
              : { label: String(o?.label ?? ''), description: o?.description ? String(o.description) : undefined },
          )
          .filter((o: AskQuestionOption) => !!o.label)
      : [];
    if (!q?.question || options.length < 2) continue;
    out.push({
      question: String(q.question),
      header: q?.header ? String(q.header) : undefined,
      multiSelect: !!q?.multiSelect,
      options,
    });
  }
  return out;
}
