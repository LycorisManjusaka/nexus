// ───────────────────────────────────────────────────────────────────────────
// GUI string translation. Small and deliberately incomplete.
//
// This is NOT the same mechanism as src/lib/agentInstructions.ts's
// DEFAULT_AGENT_INSTRUCTIONS_JA — that dict is what an ENTITY reads (tool
// descriptions, letter notices, etc.); this one is what a HUMAN reads in the
// Nexus interface itself. They're both keyed off the same Preferences
// language selector, but they're separate dictionaries with separate
// coverage, because they're translating different things for different
// readers.
//
// Coverage here is intentionally small: a handful of structural-chrome
// strings (tab labels, a modal title) rather than an attempt at exhaustive
// UI translation. Exhaustive coverage would mean either machine-translating
// hundreds of strings of explanatory prose — which breaks the same
// "hand-written, never auto-translated" principle applied to the entity-side
// dictionary — or a much longer hand-translation effort than this pass
// covers. Extend this dict incrementally, by hand, as real Japanese wording
// gets written for more of the interface.
// ───────────────────────────────────────────────────────────────────────────

export type UiLanguage = 'en' | 'ja';

export const UI_STRINGS_EN: Record<string, string> = {
  'settings.title': 'Preferences',
  'settings.tab.keys': 'API Keys',
  'settings.tab.vrchat': 'VRChat & Audio',
  'settings.tab.other': 'Other',
  'settings.cancel': 'Cancel',
  'settings.saveChanges': 'Save Changes',
};

// Hand-written Japanese. Any key NOT present here falls back to English —
// see t() below — so an incomplete dict never produces a blank label.
export const UI_STRINGS_JA: Record<string, string> = {
  'settings.title': '設定',
  'settings.tab.keys': 'APIキー',
  'settings.tab.vrchat': 'VRChat・音声',
  'settings.tab.other': 'その他',
  'settings.cancel': 'キャンセル',
  'settings.saveChanges': '変更を保存',
};

/**
 * Look up a GUI string by key for the given language. Falls back to the
 * English string (then to the key itself) when the key is missing from the
 * Japanese dict, so partial coverage never shows a blank label.
 */
export function t(key: string, language?: string | null): string {
  const lang: UiLanguage = language === 'ja' ? 'ja' : 'en';
  if (lang === 'ja' && key in UI_STRINGS_JA) return UI_STRINGS_JA[key];
  if (key in UI_STRINGS_EN) return UI_STRINGS_EN[key];
  return key;
}
