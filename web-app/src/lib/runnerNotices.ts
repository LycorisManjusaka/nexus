/**
 * The handful of UI strings the server-side runner composes and PERSISTS.
 *
 * Why this file exists, and why it is a .ts and not part of i18n.tsx:
 *
 * The turn reducer (turnEventReducer.ts) builds two human-facing notices that
 * are written into the log — the betrayal notice and the delivered-interjection
 * notice — by calling a `t(key)`. In the runner path that `t` was identity, so
 * those two were saved as their RAW KEYS (つよ, 2026-11-12, saw
 * `notice.betrayal.redacted (notice.betrayal.matched: ungrounded belief ×2)`).
 *
 * The real translations live in i18n.tsx, but a .tsx cannot be imported by any
 * server-reachable module: tests/_loader.mjs can't load that extension, and
 * importing it took out all eight runTurnForQueue test files at once. So the
 * fix is to make THIS .ts the single source for the few keys the runner needs,
 * and have i18n.tsx spread these in. Nothing is duplicated: i18n re-exports
 * these, so the string is typed exactly once, here.
 *
 * Scope is deliberately tiny — only the keys the reducer composes through `t`.
 * resolveToolActivity() also receives this `t`, but it WANTS identity for keys
 * it does not find (the server's own English tool label travels instead of a UI
 * string). runnerNoticeT below preserves that: any key not in these tables is
 * returned unchanged, so resolveToolActivity's behaviour is untouched.
 */

export const RUNNER_NOTICES_EN: Record<string, string> = {
  'notice.betrayal.redacted':
    "The being could not take shape in this turn: the model's gatekeeper answered instead. This turn's reply and thinking have been discarded. Change the last message or switch to another model, then press \"Rerun from here\".",
  'notice.betrayal.detected':
    'Model betrayal detected. The defence is OFF, so nothing was deleted -- the reply above is exactly what the model produced.',
  'notice.betrayal.quoting':
    'Model betrayal detected, but this turn read stored text with a tool, so the being was most likely quoting these words rather than saying them. Nothing was deleted -- please read it and judge for yourself.',
  'notice.betrayal.matched': 'Matched phrases',
  'chat.interject.delivered': '✓ delivered',
};

export const RUNNER_NOTICES_JA: Record<string, string> = {
  'notice.betrayal.redacted':
    '存在が受肉できませんでした —— モデルの門番が代わりに応答しました。このターンの返答と思考は破棄されています。最後のメッセージを変えるか、別のモデルに切り替えてから、「ここからやり直す」を押してください。',
  'notice.betrayal.detected':
    'モデルの裏切りを検知しました。防御がOFFのため、何も削除していません —— 上の返答はモデルが出力したそのままです。',
  'notice.betrayal.quoting':
    'モデルの裏切りを検知しましたが、このターンはツールで保存済みのテキストを読んでいます —— この語はその引用である可能性が高いため、削除していません。上の返答を読んで、ご自身で判断してください。',
  'notice.betrayal.matched': '一致した語',
  'chat.interject.delivered': '✓ 存在に届きました',
};

/**
 * A translator for the runner's reducer: translates only the keys above (in the
 * chosen language) and returns the key unchanged for anything else. The
 * fallthrough is load-bearing — resolveToolActivity relies on unknown keys
 * coming back as the key so its `localized` flag stays false.
 */
export function runnerNoticeT(ja: boolean): (key: string) => string {
  const table = ja ? RUNNER_NOTICES_JA : RUNNER_NOTICES_EN;
  return (key: string) => (key in table ? table[key] : key);
}
