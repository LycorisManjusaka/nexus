import fs from 'fs';
import path from 'path';
import { escapeForRegExp } from './convoNaming';

const DICT_PATH = path.resolve(process.cwd(), '..', 'local_data', 'en_katakana_dict.json');

let cachedDict: Record<string, string> | null = null;
let cachedRegex: RegExp | null = null;

function loadDict(): void {
  try {
    const raw = fs.readFileSync(DICT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;

    // Normalise all keys to lowercase. The regex uses the `i` flag so matching
    // is case-insensitive; the lowercase key is used for the dict lookup.
    cachedDict = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('_')) continue; // skip comment keys
      cachedDict[k.toLowerCase()] = v;
    }
  } catch {
    // Dict file missing or malformed — silently continue with no replacements.
    cachedDict = {};
  }

  const keys = Object.keys(cachedDict);
  if (keys.length === 0) {
    cachedRegex = null;
    return;
  }

  // Sort longest-first so multi-word phrases ("thank you") are tried before
  // their component words ("thank", "you") in the alternation.
  keys.sort((a, b) => b.length - a.length);
  const escaped = keys.map(k => escapeForRegExp(k));

  // \b word-boundaries work correctly next to Japanese characters: Japanese
  // code-points are non-\w, which creates a boundary with any ASCII letter.
  // So "APIを" correctly matches \bAPI\b, and "RAPID" does not match \bAPI\b.
  cachedRegex = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
}

/**
 * Replace English words/phrases in `text` with their Katakana equivalents
 * from local_data/en_katakana_dict.json. Unknown English sequences pass
 * through unchanged — Voicevox will handle them as-is.
 *
 * The dictionary is loaded once on first call and cached for the lifetime of
 * the server process. Call invalidateKatakanaCache() to force a reload.
 */
export function convertEnglishToKatakana(text: string): string {
  if (cachedDict === null) loadDict();
  if (!cachedRegex) return text;
  return text.replace(cachedRegex, (match) => cachedDict![match.toLowerCase()] ?? match);
}

/**
 * Discard the cached dictionary and regex so the next call to
 * convertEnglishToKatakana() reloads from disk.
 * Intended for use after programmatic edits to en_katakana_dict.json.
 */
export function invalidateKatakanaCache(): void {
  cachedDict = null;
  cachedRegex = null;
}
