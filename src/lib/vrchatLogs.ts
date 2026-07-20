import fs from 'fs';
import path from 'path';
import { kohaiPath, earLogPath, speakersJsonPath, VOICECHANGER_DIR } from './voicechangerPaths';
import { resolveCharaByIds, getCharaFallback } from './charaResolver';

// ───────────────────────────────────────────────────────────────────────────
// Noise-word filter.
//
// Speech recognition emits well-known garbage utterances from background noise
// (e.g. "ごめん", "ご視野"). local_data/vrchat_noise_words.txt lists one such
// word per line; any transcript line whose text EQUALS one of these words (a
// whole-line match — never a substring) is dropped from the merge. This never
// edits the middle of a real sentence: a line like "ごめん、遅れた" is kept,
// only a line that is exactly "ごめん" is ignored. Lines starting with '#' are
// treated as comments. The file is mtime-cached so edits apply live.
// ───────────────────────────────────────────────────────────────────────────
const NOISE_FILE = path.resolve(process.cwd(), '..', 'local_data', 'vrchat_noise_words.txt');
let noiseCache: { mtimeMs: number; words: Set<string> } | null = null;

function loadNoiseWords(): Set<string> {
  try {
    const stat = fs.statSync(NOISE_FILE);
    if (noiseCache && noiseCache.mtimeMs === stat.mtimeMs) return noiseCache.words;
    const raw = fs.readFileSync(NOISE_FILE, 'utf-8');
    const words = new Set<string>();
    raw.split('\n').forEach((line) => {
      const w = line.trim();
      if (w && !w.startsWith('#')) words.add(w);
    });
    noiseCache = { mtimeMs: stat.mtimeMs, words };
    return words;
  } catch {
    // Missing/unreadable file → no filtering.
    return new Set<string>();
  }
}

/**
 * True when `text`, taken as a whole line, is a pure noise word and should be
 * dropped. Trailing punctuation/whitespace (。！？ + spaces) is stripped before
 * comparison — mirroring the Python services' own hallucination filter — so
 * "ごめん。" still matches "ごめん". Matching is exact on the remaining text; the
 * word is never removed from inside a longer message.
 */
function isNoiseLine(text: string, noise: Set<string>): boolean {
  if (noise.size === 0) return false;
  const clean = text.trim().replace(/[。！？\s]+$/u, '');
  return clean.length > 0 && noise.has(clean);
}

// ───────────────────────────────────────────────────────────────────────────
// VRChat speech-log merge.
//
// Two external Python services write running transcripts:
//   • voice_changer.py → kohai.txt   (the local user's own speech)
//   • ear_service.py   → ear_log.txt (other people's speech, "ears")
//
// This merges both into a single, time-sorted transcript with `[Name] text`
// lines, exactly as the old inline processLogs() in /api/vrchat/watch did.
//
// `consume` controls whether the source files are truncated after reading:
//   • false (default) → non-destructive read, used for the live input preview
//     poll (GET /api/vrchat/logs) so the transcript can keep growing and stay
//     visible in the input box.
//   • true → empties both files, used when the merged text has been committed
//     to a message (clear-on-send) so the same speech isn't sent twice.
// ───────────────────────────────────────────────────────────────────────────

// Filesystem-safe timestamp for a backup filename: YYYY-MM-DD_HH-MM-SS-mmm.
function footerLikeStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function getStyleName(engine: string, charId: string, styleId: string): string {
  try {
    if (engine === '0' && fs.existsSync(speakersJsonPath())) {
      const data = JSON.parse(fs.readFileSync(speakersJsonPath(), 'utf-8'));
      if (data[parseInt(charId)]?.styles?.[parseInt(styleId)]) {
        return data[parseInt(charId)].styles[parseInt(styleId)].name;
      }
    }
  } catch (e) { /* fall through */ }
  return styleId;
}

export function mergeVrchatLogs(opts?: { consume?: boolean }): string {
  const consume = opts?.consume ?? false;
  const linesData: { time: string; speaker: string; styleId: string | null; styleName: string | null; text: string }[] = [];

  const kohaiFile = kohaiPath();
  const earFile = earLogPath();
  const noise = loadNoiseWords();

  // 1. Parse ear_log.txt — "[HH:MM:SS] (speaker) text"
  if (fs.existsSync(earFile)) {
    try {
      const content = fs.readFileSync(earFile, 'utf-8');
      content.split('\n').forEach((line) => {
        const m = line.trim().match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\((.*?)\)\s*(.*)/);
        if (m) linesData.push({ time: m[1], speaker: m[2], styleId: null, styleName: null, text: m[3] });
      });
    } catch (e) { /* ignore */ }
  }

  // 2. Parse kohai.txt — voice-state header lines "[engine-char-style]" set the
  //    current speaker; "[HH:MM:SS] text" lines are the user's utterances.
  if (fs.existsSync(kohaiFile)) {
    try {
      const content = fs.readFileSync(kohaiFile, 'utf-8');
      // Speaker/style default to the character_map.json fallback, not a
      // hardcoded name, so a kohai.txt with no leading header still labels
      // consistently with the rest of the app.
      let currentSpeaker = getCharaFallback();
      let currentStyleId = '0';
      let currentStyleName = 'ノーマル';

      content.split('\n').forEach((raw) => {
        const line = raw.trim();
        if (!line) return;

        const headerMatch = line.match(/^\[(\d+)-(\d+)-(\d+)\]$/);
        if (headerMatch) {
          const engine = headerMatch[1];
          const charId = headerMatch[2];
          currentStyleId = headerMatch[3];
          currentStyleName = getStyleName(engine, charId, currentStyleId);

          // Single source of truth: local_data/character_map.json (editable
          // without touching code), instead of an out-of-sync hardcoded table.
          currentSpeaker = resolveCharaByIds(engine, charId);
          return;
        }

        const timeMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
        if (timeMatch) {
          linesData.push({ time: timeMatch[1], speaker: currentSpeaker, styleId: currentStyleId, styleName: currentStyleName, text: timeMatch[2] });
        }
      });
    } catch (e) { /* ignore */ }
  }

  // Optionally empty both files (clear-on-send). BEFORE truncating, snapshot
  // each file's raw content to voicechanger/<name>_backup/<date_time>.txt so a
  // cleared transcript is never truly lost — even if a downstream bug clears the
  // files without actually sending the message. Best-effort; a backup failure
  // must not stop the clear.
  if (consume) {
    const stamp = footerLikeStamp();
    ([{ file: kohaiFile, name: 'kohai' }, { file: earFile, name: 'ear' }]).forEach(({ file, name }) => {
      if (!fs.existsSync(file)) return;
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        if (raw.trim()) {
          const backupDir = path.join(VOICECHANGER_DIR, `${name}_backup`);
          try {
            fs.mkdirSync(backupDir, { recursive: true });
            fs.writeFileSync(path.join(backupDir, `${stamp}.txt`), raw);
          } catch (e) { /* backup best-effort */ }
        }
      } catch (e) { /* read best-effort */ }
      try { fs.writeFileSync(file, ''); } catch (e) { /* ignore */ }
    });
  }

  if (linesData.length === 0) return '';

  // Sort chronologically — but the log timestamps are wall-clock HH:MM:SS with
  // NO date, so a plain string sort mis-orders a midnight rollover: "00:00:18"
  // sorts before "23:59:29" and the post-midnight speech jumps to the top.
  //
  // The live buffer is short (it's truncated on send), so it can't legitimately
  // span 12 hours. Therefore any line more than 12h EARLIER than the latest
  // timestamp is really on the far side of midnight — i.e. a day later — so we
  // add 24h to its sort key. A same-day buffer (no rollover) is untouched.
  const toSec = (t: string) => {
    const [h, m, s] = t.split(':').map(Number);
    return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
  };
  const WRAP_THRESHOLD = 12 * 3600; // 12h
  const DAY = 24 * 3600;
  const raw = linesData.map((r) => toSec(r.time));
  const maxRaw = Math.max(...raw);
  // Decorate with a rollover-aware key + original index (stable tiebreak so
  // same-second lines keep their file/insertion order).
  const ordered = linesData
    .map((r, i) => ({ r, i, key: raw[i] + (maxRaw - raw[i] > WRAP_THRESHOLD ? DAY : 0) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((d) => d.r);

  // Format with `[Name] text`, grouping consecutive lines from the same speaker.
  const parts: string[] = [];
  let lastSpeaker: string | null = null;
  for (const row of ordered) {
    if (row.speaker !== lastSpeaker) {
      parts.push(`\n[${row.speaker}] ${row.text}`);
    } else {
      parts.push(` ${row.text}`);
    }
    lastSpeaker = row.speaker;
  }
  return parts.join('').trim();
}
