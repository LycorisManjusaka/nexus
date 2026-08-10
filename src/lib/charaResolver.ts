import fs from 'fs';
import path from 'path';
import { charaSettingsPath } from './voicechangerPaths';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

interface CharMap {
  engines: Record<string, string>;
  rules: { engine: string; charId: string; name: string }[];
  fallback: string;
  humanLabel: string;
}

const DEFAULT_MAP: CharMap = {
  engines: { voicevox: '0', coeiroink: '1' },
  rules: [],
  fallback: 'Anonymous',
  humanLabel: '人',
};

function readJson<T>(p: string, fallback: T): T {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Resolves the currently active user/character from the voicechanger's
 * chara_settings.json, mapped through local_data/character_map.json.
 *
 * Returns { name, humanLabel }:
 *   - name:        what to use for the user's prefix (e.g. "つよ")
 *   - humanLabel:  what to use for "Human" (other-person) prefix (e.g. "人")
 */
export function resolveCurrentChara(): { name: string; humanLabel: string } {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  const settings = readJson<any>(charaSettingsPath(), null);

  const humanLabel = charMap.humanLabel || '人';
  const fallback = charMap.fallback || 'Anonymous';

  if (!settings || !settings.current_engine) {
    return { name: fallback, humanLabel };
  }

  const engineName = settings.current_engine;
  const engineNum = charMap.engines?.[engineName];
  const engineSection = settings[engineName];
  if (!engineSection || engineNum === undefined) {
    return { name: fallback, humanLabel };
  }

  const charId = String(engineSection.current_character);
  const rule = charMap.rules.find(r => r.engine === engineNum && r.charId === charId);
  return { name: rule?.name || fallback, humanLabel };
}

/**
 * Maps a raw (engineNum, charId) pair — as found in voicechanger's kohai.txt
 * "[engine-char-style]" header lines — to a display name, using
 * local_data/character_map.json. Falls back to the map's `fallback` when no
 * rule matches. This is the shared lookup so VRChat speaker labeling stays in
 * sync with the same file that drives Live Session / message author labels,
 * instead of a separate hardcoded table.
 */
export function resolveCharaByIds(engineNum: string, charId: string): string {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  const rule = charMap.rules.find(
    (r) => r.engine === String(engineNum) && r.charId === String(charId)
  );
  return rule?.name || charMap.fallback || 'Anonymous';
}

/** The configured fallback speaker name from character_map.json. */
export function getCharaFallback(): string {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  return charMap.fallback || 'Anonymous';
}
