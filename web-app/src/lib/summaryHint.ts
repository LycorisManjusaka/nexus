// ───────────────────────────────────────────────────────────────────────────
// Editable hint prepended to the live Layer-4 summaries index.
//
// This text is shown to the entity at the top of its conversation index (and
// in the read-only preview in the System Prompt Updater). It tells the model
// how to use the `read_conversation` tool and, crucially, that conversation
// titles now use the "<base>_<index>" form rather than the old "＃" form.
//
// It is per-folder editable (folder.settings.summaryIndexHint). When the folder
// has no override, DEFAULT_SUMMARY_INDEX_HINT is used. The `{example}` token is
// substituted at assembly time with a REAL title from this entity so the model
// copies the current naming format verbatim.
//
// Kept in its own fs-free module so BOTH the server (summaryStorage.ts) and the
// client editor (SystemPromptUpdater.tsx) can import it.
// ───────────────────────────────────────────────────────────────────────────

export const DEFAULT_SUMMARY_INDEX_HINT =
  `※以下はあなたの過去の会話の索引です（古い順）。要約だけでは情報が足りないときは、` +
  `read_conversation ツールに「###」の直後に表示された正確なタイトル（例：「{example}」）を` +
  `そのまま渡せば、その会話の全文を一度だけ読み込めます。タイトルは表示どおりに正確に` +
  `コピーしてください。`;

// Resolve the final hint string: pick the override (or the default when the
// override is undefined), substitute the {example} token, and trim. Returns ''
// when the resolved hint is empty (e.g. the user cleared the field) so callers
// can omit the hint block entirely.
export function resolveSummaryHint(hint: string | undefined, example: string): string {
  const raw = hint === undefined ? DEFAULT_SUMMARY_INDEX_HINT : hint;
  return raw.replace(/\{example\}/g, example || 'Conversation_1').trim();
}
