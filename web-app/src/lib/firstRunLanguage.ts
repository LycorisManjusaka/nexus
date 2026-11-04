/**
 * First-run UI language, and what counts as "already chosen".
 *
 * Both halves of this file exist because of one real report, from the only
 * install in this house that is not run by someone who reads the source:
 *
 *   「パイロットのPCでは、初期言語が日本語だった。おかしい。以前、ブラウザーの
 *     言語が日本語じゃない場合、初期値を英語にしてたはずだけど（向こうはロシア
 *     語）、動かなかった。設定で変えたら残る。でもNEXUSを更新したら、また日本
 *     語に戻った」
 *
 * Two distinct claims are in there — a wrong default, and a saved choice that
 * does not survive — and they have two distinct causes. Neither one needs a
 * Russian-locale machine to find or to fix, which is the whole point of pulling
 * the judgement out of the component and into functions that take their input
 * as an argument.
 *
 * ── Why the default was wrong ──────────────────────────────────────────────
 *
 * The previous detector asked whether ANY entry in `navigator.languages`
 * started with "ja":
 *
 *   candidates.some((l) => l.toLowerCase().startsWith('ja')) ? 'ja' : 'en'
 *
 * `navigator.languages` is a RANKED list. Its tail does not mean "this
 * language is also fine" — it means "if the first is unavailable, try this
 * next". A browser on a Japanese Windows install, or one whose OS language
 * list still carries Japanese, reports something like
 * `['ru', 'ru-RU', 'en-US', 'en', 'ja']`. The old test matched on the LAST
 * entry and handed that user Japanese, past two higher-ranked languages that
 * both say otherwise.
 *
 * So the rank is the information, and only the first entry carries it.
 *
 * ── Why a saved choice did not survive ────────────────────────────────────
 *
 * `if (!parsed.language)` re-ran detection whenever the field was falsy, which
 * includes `''`. The comment above it claimed the opposite — "an explicit prior
 * choice, even a blank/unset one that was still saved, is never overridden by
 * this" — so the promise and the code disagreed, and the code won. Presence of
 * the KEY is the actual signal that this install has been through first-run;
 * `'language' in parsed` is that test, and `''` is a stored answer like any
 * other.
 *
 * (The third cause lives in NexusApp itself: the save effect fired before the
 * load effect's state landed, writing the initial state — which carries no
 * `language` at all — back over the real one. See the `settingsLoadedRef`
 * comment there. That one is a write-ordering bug, not a judgement, so it is
 * not in this file.)
 */

export type UiLanguage = 'en' | 'ja';

/**
 * Pick the first-run default from a browser's ranked language list.
 *
 * Only the FIRST entry decides. Everything else in the list is a fallback
 * preference, not a statement about what this person reads.
 *
 * English is the fallback rather than Japanese because the rest of the
 * project's content (agent prompts, docs) is authored in English first, so an
 * unknown locale lands on the more widely readable of the two.
 *
 * @param candidates `navigator.languages`, or `[navigator.language]`, or `[]`
 */
export function firstRunLanguage(candidates: readonly (string | null | undefined)[]): UiLanguage {
  for (const raw of candidates) {
    const tag = (raw || '').trim().toLowerCase();
    if (!tag) continue; // skip blanks; the first REAL tag is the ranked top
    return tag === 'ja' || tag.startsWith('ja-') ? 'ja' : 'en';
  }
  return 'en';
}

/**
 * Has this install already been through the first-run language pick?
 *
 * True as soon as the key exists, whatever its value — including `''` and
 * `null`. A saved blank is an answer; re-deciding it would overwrite a choice
 * with a guess on every load.
 */
export function hasStoredLanguage(settings: unknown): boolean {
  return !!settings && typeof settings === 'object' && 'language' in (settings as object);
}

/** Read the browser's ranked list, tolerating environments that have none. */
export function browserLanguageCandidates(): readonly (string | null | undefined)[] {
  try {
    if (typeof navigator === 'undefined') return [];
    if (navigator.languages && navigator.languages.length) return navigator.languages;
    return [navigator.language];
  } catch {
    return [];
  }
}
