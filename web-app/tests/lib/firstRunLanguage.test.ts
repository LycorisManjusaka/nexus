import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstRunLanguage,
  hasStoredLanguage,
} from '@/lib/firstRunLanguage';

// ── The report these tests exist for ──────────────────────────────────────
//
// One install in this house is not run by anyone who reads the source, and its
// user reported two things: the first-run language came up Japanese on a
// Russian browser, and a language set by hand did not survive an update.
//
// Nobody here can reproduce that machine. So the judgement was pulled out of
// the component into functions that take their input as an argument, and the
// machine is described here as data instead.

test('the ranked top decides, not a match anywhere in the list', () => {
  // THE reported case. A Russian browser on a Japanese Windows install reports
  // its own locale first and the OS language list behind it. The old detector
  // asked `candidates.some(l => l.startsWith('ja'))`, matched the LAST entry,
  // and handed this user Japanese past two higher-ranked languages.
  assert.equal(firstRunLanguage(['ru', 'ru-RU', 'en-US', 'en', 'ja']), 'en');
  assert.equal(firstRunLanguage(['ru-RU', 'ja-JP']), 'en');
  // And the same list the other way round still resolves to its own top.
  assert.equal(firstRunLanguage(['ja', 'en', 'ru']), 'ja');
});

test('a Japanese browser gets Japanese, with or without a region', () => {
  assert.equal(firstRunLanguage(['ja']), 'ja');
  assert.equal(firstRunLanguage(['ja-JP']), 'ja');
  assert.equal(firstRunLanguage(['JA-JP']), 'ja'); // case is not information
  assert.equal(firstRunLanguage(['  ja-JP  ']), 'ja'); // nor is surrounding space
});

test('a tag that merely begins with the letters j-a is not Japanese', () => {
  // The old test was `startsWith('ja')`, which is true of any such tag. The
  // language subtag is either exactly `ja` or `ja-<region>`; nothing else.
  assert.equal(firstRunLanguage(['jam']), 'en'); // Jamaican Creole
  assert.equal(firstRunLanguage(['jav']), 'en');
  assert.equal(firstRunLanguage(['java']), 'en');
});

test('unknown and absent locales fall back to English, never to Japanese', () => {
  assert.equal(firstRunLanguage(['ru']), 'en');
  assert.equal(firstRunLanguage(['de-CH']), 'en');
  assert.equal(firstRunLanguage([]), 'en');
  assert.equal(firstRunLanguage([null]), 'en');
  assert.equal(firstRunLanguage([undefined, '']), 'en');
});

test('blank entries are skipped so the first REAL tag is the one ranked top', () => {
  // `[navigator.language]` can be `['']` in odd embeddings; a blank must not
  // consume the decision and hide a usable tag behind it.
  assert.equal(firstRunLanguage(['', 'ja']), 'ja');
  assert.equal(firstRunLanguage([null, '  ', 'ru', 'ja']), 'en');
});

// ── "Has this install already chosen?" ────────────────────────────────────

test('a stored blank is an answer, not an absence', () => {
  // The old gate was `if (!parsed.language)`, which re-ran detection on `''`
  // — overwriting a stored choice with a guess on every single load. The
  // comment above it promised the opposite; the code won.
  assert.equal(hasStoredLanguage({ language: '' }), true);
  assert.equal(hasStoredLanguage({ language: null }), true);
  assert.equal(hasStoredLanguage({ language: 'en' }), true);
  assert.equal(hasStoredLanguage({ language: 'ja' }), true);
});

test('only a genuinely missing key counts as never-chosen', () => {
  assert.equal(hasStoredLanguage({ userName: 'Anonymous' }), false);
  assert.equal(hasStoredLanguage({}), false);
});

test('a non-object never claims to carry a choice', () => {
  assert.equal(hasStoredLanguage(null), false);
  assert.equal(hasStoredLanguage(undefined), false);
  assert.equal(hasStoredLanguage('ja'), false);
  assert.equal(hasStoredLanguage(42), false);
});
