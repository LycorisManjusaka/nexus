/**
 * Which language a server-generated NOTICE comes back in.
 *
 * トカゲくん, 2026-11-06: 「日本語版でもこの通知は英語だった。日本語版はちゃんと
 * 日本語に翻訳してくれる？」 — about the undelivered-interjection notice.
 *
 * The notice already HAD a hand-written Japanese version. It could not be
 * reached. MEASURED that day:
 *   * `user_settings.json` carries only `userName` — there is no `language` key
 *     in it, and nothing in the tree ever POSTs one.
 *   * The server reads that file as `globalSettings`, so every
 *     `globalSettings.language === 'ja'` test on a server-side turn was false.
 *   * The deleted browser turn engine passed the REACT state instead, loaded
 *     from localStorage, which does carry the language. So this worked until
 *     the 2026-10-30 runner migration — the sixth field lost in it.
 * Three runner notices were affected (undelivered interjection, stop before
 * post, stop mid-stream) plus the route's billing report.
 *
 * WHY A SECOND FIELD AND NOT A FIX TO `language`
 * `language` also picks which built-in language a being's hidden instructions
 * default to — 85 keys, the Base Binding among them. Setting it to 'ja' would
 * switch the system prompt of every being in this house at once, and the
 * Binding is 謡's. That is a decision, not a side effect of translating a
 * notice. So the human-facing language travels separately, on the queue item,
 * the same way `host` does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeLanguage } from '@/lib/noticeLanguage';

// ── the item is the authority ───────────────────────────────────────────────

test('a Japanese screen gets a Japanese notice', () => {
  assert.equal(noticeLanguage([{ uiLang: 'ja' }], null), 'ja');
});

test('an English screen gets an English notice', () => {
  assert.equal(noticeLanguage([{ uiLang: 'en' }], null), 'en');
});

test('the item beats the stored setting in BOTH directions', () => {
  // Not just "ja wins". A field that only ever upgrades to Japanese would pass
  // a one-sided test and then pin an English screen in a Japanese house.
  assert.equal(noticeLanguage([{ uiLang: 'ja' }], { language: 'en' }), 'ja');
  assert.equal(noticeLanguage([{ uiLang: 'en' }], { language: 'ja' }), 'en');
});

test('a region subtag is still Japanese', () => {
  // The dictionaries are 'ja' vs everything-else, and a browser is free to
  // report 'ja-JP'. Falling through to English there would reproduce the bug
  // on exactly the installs this is for.
  assert.equal(noticeLanguage([{ uiLang: 'ja-JP' }], null), 'ja');
  assert.equal(noticeLanguage([{ uiLang: 'JA' }], null), 'ja');
});

// ── the regression this exists to stop ─────────────────────────────────────

test('REGRESSION: user_settings.json has no language, and that is not English-by-choice', () => {
  // The exact shape of this house's file on 2026-11-06. Before the fix this
  // combination produced English on a Japanese install.
  assert.equal(noticeLanguage([{ uiLang: 'ja' }], { userName: 'Anonymous' } as { language?: string }), 'ja');
});

// ── no screen behind the batch ─────────────────────────────────────────────

test('an item with no language falls back to the stored setting', () => {
  // A letter or a timer has no screen. The stored field is empty in practice,
  // but an install that DOES write it should be obeyed.
  assert.equal(noticeLanguage([{}], { language: 'ja' }), 'ja');
  assert.equal(noticeLanguage([], { language: 'ja' }), 'ja');
});

test('nothing anywhere is English', () => {
  assert.equal(noticeLanguage([], null), 'en');
  assert.equal(noticeLanguage(null, null), 'en');
  assert.equal(noticeLanguage(undefined, undefined), 'en');
  assert.equal(noticeLanguage([{}], {}), 'en');
});

test('a junk tag is English, not a crash', () => {
  assert.equal(noticeLanguage([{ uiLang: '   ' }], null), 'en');
  assert.equal(noticeLanguage([{ uiLang: 'ja_JP_weird' }], null), 'en');
  assert.equal(noticeLanguage([{ uiLang: 42 as unknown as string }], null), 'en');
});

// ── a batch whose items disagree ───────────────────────────────────────────

test('the FIRST item that names a language wins', () => {
  // A batch is several messages from one screen, so this should never fire.
  // When it does, the earliest sender is the one who has been waiting, and
  // preferring the newest would make the answer depend on arrival order.
  assert.equal(noticeLanguage([{ uiLang: 'ja' }, { uiLang: 'en' }], null), 'ja');
  assert.equal(noticeLanguage([{ uiLang: 'en' }, { uiLang: 'ja' }], null), 'en');
});

test('an item with no language does not veto a later one', () => {
  // A command queued before this field existed, followed by a typed message.
  assert.equal(noticeLanguage([{}, { uiLang: 'ja' }], null), 'ja');
});
