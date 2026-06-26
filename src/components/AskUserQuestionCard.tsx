'use client';

import { useState } from 'react';

// Renders the interactive "AskUserQuestion" card. Two modes:
//   • Live (onSubmit provided): the user picks options and submits; the answer
//     is sent back to the paused server handler via the parent.
//   • Read-only (answered provided, no onSubmit): shows a past Q&A as persisted
//     on a reloaded conversation.
//
// Multiple questions are shown ONE PER PAGE (Next / Previous), like Claude
// Code's question UI — not all at once — and each question's option list is
// independently scrollable so a long option set never makes the card unusable.

export interface AskCardQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface AskCardAnswer {
  header?: string;
  question: string;
  answers: string[];
}

function OptionRow({
  label, description, selected, onToggle, disabled,
}: { label: string; description?: string; selected: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
        selected
          ? 'border-sky-500 bg-sky-500/15'
          : 'border-border bg-secondary/40 hover:bg-secondary/70'
      } ${disabled ? 'cursor-default opacity-90' : 'cursor-pointer'}`}
    >
      <div className="text-sm font-medium text-foreground">{label}</div>
      {description ? <div className="text-xs text-muted-foreground mt-0.5 leading-snug">{description}</div> : null}
    </button>
  );
}

export default function AskUserQuestionCard({
  questions, answered, onSubmit,
}: {
  questions: AskCardQuestion[];
  answered?: AskCardAnswer[] | null;
  onSubmit?: (answers: AskCardAnswer[]) => void;
}) {
  const readOnly = !onSubmit;
  const total = questions.length;
  // selections[qIndex] = array of chosen labels (1 entry for single-select).
  const [selections, setSelections] = useState<string[][]>(() =>
    questions.map((q, i) => (answered?.[i]?.answers ? [...answered[i].answers] : [])),
  );
  const [otherText, setOtherText] = useState<string[]>(() => questions.map(() => ''));
  const [submitted, setSubmitted] = useState(false);
  const [page, setPage] = useState(0);

  const q = questions[page];
  const isLast = page >= total - 1;
  const isFirst = page <= 0;

  const toggle = (label: string, multi: boolean) => {
    if (readOnly || submitted) return;
    setSelections((prev) => {
      const next = prev.map((a) => [...a]);
      const cur = next[page];
      if (multi) {
        const at = cur.indexOf(label);
        if (at >= 0) cur.splice(at, 1);
        else cur.push(label);
      } else {
        next[page] = cur.length === 1 && cur[0] === label ? [] : [label];
      }
      return next;
    });
  };

  const answeredFor = (i: number) => selections[i].length > 0 || otherText[i].trim().length > 0;
  const canSubmit = questions.every((_, i) => answeredFor(i));

  const submit = () => {
    if (readOnly || submitted || !canSubmit) return;
    const out: AskCardAnswer[] = questions.map((qq, i) => {
      const chosen = [...selections[i]];
      if (otherText[i].trim()) chosen.push(otherText[i].trim());
      return { header: qq.header, question: qq.question, answers: chosen };
    });
    setSubmitted(true);
    onSubmit!(out);
  };

  if (!q) return null;

  return (
    <div className="rounded-xl border border-sky-500/50 bg-background/95 shadow-lg p-4 space-y-3 max-h-[60vh] flex flex-col">
      {/* Header: live banner + page indicator */}
      <div className="flex items-center justify-between gap-2">
        {!readOnly ? (
          <div className="flex items-center gap-2 text-sky-500 text-sm font-semibold">
            <span>💬</span><span>The assistant is asking{submitted ? ' — answer sent…' : '…'}</span>
          </div>
        ) : <span />}
        {total > 1 ? (
          <span className="text-[11px] text-muted-foreground font-medium shrink-0">
            Question {page + 1} of {total}
            <span className="ml-1 text-sky-500">{answeredFor(page) ? '●' : '○'}</span>
          </span>
        ) : null}
      </div>

      {/* Current question + scrollable options */}
      <div className="space-y-2 overflow-y-auto custom-scrollbar pr-1 flex-1 min-h-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          {q.header ? (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-600 font-semibold">{q.header}</span>
          ) : null}
          <span className="text-sm font-medium text-foreground">{q.question}</span>
          {q.multiSelect ? <span className="text-[10px] text-muted-foreground">(choose any)</span> : null}
        </div>
        <div className="space-y-1.5">
          {q.options.map((o, oi) => (
            <OptionRow
              key={oi}
              label={o.label}
              description={o.description}
              selected={selections[page].includes(o.label)}
              onToggle={() => toggle(o.label, !!q.multiSelect)}
              disabled={readOnly || submitted}
            />
          ))}
          {/* Read-only: surface any custom ("Other") answers that aren't one of
              the predefined options, so they're visible on reload. */}
          {readOnly && (() => {
            const optionLabels = new Set(q.options.map((o) => o.label));
            const customs = (selections[page] || []).filter((a) => !optionLabels.has(a));
            return customs.map((c, ci) => (
              <div key={`custom-${ci}`} className="w-full text-left px-3 py-2 rounded-lg border border-sky-500 bg-sky-500/15">
                <div className="text-sm font-medium text-foreground">{c}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Custom answer</div>
              </div>
            ));
          })()}
          {!readOnly && (
            <input
              type="text"
              value={otherText[page]}
              disabled={submitted}
              onChange={(e) => setOtherText((prev) => prev.map((t, i) => (i === page ? e.target.value : t)))}
              placeholder="Other (type a custom answer)…"
              className="w-full px-3 py-2 rounded-lg border border-border bg-secondary/40 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-sky-500"
            />
          )}
        </div>
      </div>

      {/* Footer: Prev / Next pager + Send */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-border">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={isFirst}
            className="px-3 py-1.5 rounded-lg border border-border text-sm text-foreground disabled:opacity-30 disabled:cursor-not-allowed hover:bg-secondary/70 transition-colors"
          >‹ Prev</button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
            disabled={isLast}
            className="px-3 py-1.5 rounded-lg border border-border text-sm text-foreground disabled:opacity-30 disabled:cursor-not-allowed hover:bg-secondary/70 transition-colors"
          >Next ›</button>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitted}
            title={canSubmit ? '' : 'Answer every question first'}
            className="px-4 py-1.5 rounded-lg bg-sky-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-sky-600 transition-colors"
          >
            {submitted ? 'Sent' : (canSubmit ? 'Send answer' : `Answer all (${questions.filter((_, i) => answeredFor(i)).length}/${total})`)}
          </button>
        )}
      </div>
    </div>
  );
}
