// Which language a server-generated NOTICE comes back in.
//
// WHY THIS IS NOT `body.language`
// A turn request carries one `language` field, and it answers a DIFFERENT
// question: which built-in language a being's hidden instructions default to
// (tool descriptions, the Base Binding, letter framings — 85 keys in
// DEFAULT_AGENT_INSTRUCTIONS_JA). That one is house-wide by necessity: it goes
// into the being's own context, so it must not flip with whichever device sent
// the message, or a being's tool descriptions would change language by phone
// vs. desktop and break prompt caching on every alternation.
//
// A notice is the opposite. It is never sent to the model (`notices` is not in
// buildSlimHistory's allowlist) and it is read by the person who sent the
// message. So its language should follow the SCREEN, and the screen's language
// lives in the browser (localStorage `nexus_globalSettings`), not on disk.
//
// MEASURED 2026-11-06 (トカゲくん reported the undelivered-interjection notice
// arriving in English on a Japanese install):
//   * `user_settings.json` has NO `language` key — only `userName`.
//   * The server reads `loadUserSettings()` as `globalSettings`, so
//     `g?.language || 'en'` has been 'en' on every server-side turn.
//   * The deleted browser turn engine passed the REACT state (loaded from
//     localStorage, which does carry `language`), so this worked until the
//     2026-10-30 runner migration. Sixth field lost in that migration.
// Three notices were affected: undelivered interjection, stop-before-post,
// and stop-mid-stream. All three had a hand-written Japanese version that
// could never be reached.
//
// WHY THE ITEM CARRIES IT
// Same reasoning as `QueueItem.host`: the installation whose screen you typed
// into is the one that answers, so the language that screen was speaking is
// the language the answer comes back in. An item nobody typed (letter, timer)
// has no screen, and falls back to the stored setting and then to English.

/** The shape this reads off a queue item — just the one field. */
export interface NoticeLangSource {
  uiLang?: string;
}

/** 'ja' or 'en'. Anything unrecognised is English, as everywhere else. */
export type NoticeLang = 'ja' | 'en';

function normalise(tag: unknown): NoticeLang | null {
  if (typeof tag !== 'string') return null;
  const t = tag.trim().toLowerCase();
  if (!t) return null;
  // Match the UI's own test: the dictionaries are 'ja' vs everything-else, so
  // a region subtag must not fall through to English ('ja-JP' is Japanese).
  if (t === 'ja' || t.startsWith('ja-')) return 'ja';
  return 'en';
}

/**
 * Pick the notice language for one runner pass.
 *
 * The items are the batch being answered. The FIRST item that names a language
 * wins rather than the last: a batch is several messages from the same screen,
 * and if they somehow disagree the earliest sender is the one who has been
 * waiting. Ties cannot be broken better than that from here, and silently
 * preferring the newest would make the answer depend on arrival order.
 */
export function noticeLanguage(
  items: readonly NoticeLangSource[] | null | undefined,
  storedSettings: { language?: string } | null | undefined,
): NoticeLang {
  for (const it of items ?? []) {
    const picked = normalise(it?.uiLang);
    if (picked) return picked;
  }
  // No screen behind this batch. The stored setting is empty in practice (see
  // the header), so this is almost always 'en' — kept because it is the only
  // honest answer available and because an install that DOES write the field
  // should be obeyed.
  return normalise(storedSettings?.language) ?? 'en';
}
