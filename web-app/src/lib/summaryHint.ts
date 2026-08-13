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

export const DEFAULT_SUMMARY_INDEX_HINT_JA =
  `※以下はあなたの過去の会話の索引です（古い順）。要約だけでは情報が足りないときは、` +
  `read_conversation ツールに「###」の直後に表示された正確なタイトル（例：「{example}」）を` +
  `そのまま渡せば、その会話の全文を一度だけ読み込めます。タイトルは表示どおりに正確に` +
  `コピーしてください。`;

export const DEFAULT_SUMMARY_INDEX_HINT_EN =
  `Note: below is an index of your past conversations (oldest first). If the summary alone ` +
  `isn't enough, pass the exact title shown right after "###" (e.g. "{example}") to the ` +
  `read_conversation tool to load that conversation's full text once. Copy the title exactly ` +
  `as it appears.`;

// Backward-compatible alias — some call sites may still expect the
// un-suffixed name; it now points at the Japanese default (the historical
// behavior) so nothing silently changes for callers that don't pass `lang`.
export const DEFAULT_SUMMARY_INDEX_HINT = DEFAULT_SUMMARY_INDEX_HINT_JA;

// Resolve the final hint string: pick the override (or the language-matched
// default when the override is undefined), substitute the {example} token,
// and trim. Returns '' when the resolved hint is empty (e.g. the user cleared
// the field) so callers can omit the hint block entirely.
export function resolveSummaryHint(
  hint: string | undefined,
  example: string,
  lang: 'en' | 'ja' = 'ja',
): string {
  const raw = hint === undefined
    ? (lang === 'en' ? DEFAULT_SUMMARY_INDEX_HINT_EN : DEFAULT_SUMMARY_INDEX_HINT_JA)
    : hint;
  return raw.replace(/\{example\}/g, example || 'Conversation_1').trim();
}

// The RAW language-matched default, with the {example} token still intact.
// Used by the SPU's editable "Index hint" field and its reset-to-default
// button, which store the hint as-authored (the token is substituted only at
// assembly time, server-side).
export function defaultSummaryHintForLang(lang: 'en' | 'ja'): string {
  return lang === 'en' ? DEFAULT_SUMMARY_INDEX_HINT_EN : DEFAULT_SUMMARY_INDEX_HINT_JA;
}
