import fs from 'fs';
import { beingTtsDictFile } from './beingPaths';

// ───────────────────────────────────────────────────────────────────────────
// Per-entity (folder) TTS pronunciation dictionary.
//
// A plain JSON object at local_data/beings/<FolderName>/tts_dict.json mapping a source
// string to its replacement, e.g.:
//   {
//     "GLM": "ジーエルエム",
//     "朔": "さく",
//     "ネクサス": "ねくさす"
//   }
//
// Replacement is literal SUBSTRING replacement (no word boundaries) — exactly
// what CJK needs, since Japanese/Chinese text has no spaces between words. It is
// applied to each segment's text right before synthesis, ahead of the global
// English→Katakana pass, so an entity can fix names/readings TTS gets wrong.
//
// The file is the source of truth (hand-editable). It's cached in-process and
// invalidated on mtime change, so edits are picked up without a restart.
// ───────────────────────────────────────────────────────────────────────────

export function ttsDictPath(folder: string): string {
  return beingTtsDictFile(folder);
}

interface CacheEntry { mtimeMs: number; pairs: [string, string][]; }
const cache = new Map<string, CacheEntry>();

// Load the folder's dictionary as an ordered list of [from, to] pairs, sorted
// longest-key-first so a specific phrase wins over its own substrings. Returns
// [] when there is no dictionary (or it's malformed).
export function loadTtsDictPairs(folder: string): [string, string][] {
  if (!folder) return [];
  const p = ttsDictPath(folder);
  let stat: fs.Stats;
  try { stat = fs.statSync(p); } catch { cache.delete(folder); return []; }

  const cached = cache.get(folder);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.pairs;

  let pairs: [string, string][] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      pairs = Object.entries(raw)
        .filter(([k, v]) => typeof k === 'string' && k.length > 0 && typeof v === 'string')
        .map(([k, v]) => [k, v as string]) as [string, string][];
      pairs.sort((a, b) => b[0].length - a[0].length);
    }
  } catch { pairs = []; }

  cache.set(folder, { mtimeMs: stat.mtimeMs, pairs });
  return pairs;
}

// Apply the dictionary to a piece of text (literal, no word boundaries).
export function applyTtsDict(text: string, pairs: [string, string][]): string {
  if (!text || pairs.length === 0) return text;
  let out = text;
  for (const [from, to] of pairs) {
    if (from) out = out.split(from).join(to);
  }
  return out;
}
