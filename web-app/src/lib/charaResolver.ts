import fs from 'fs';
import path from 'path';
import { charaSettingsPath } from './voicechangerPaths';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

interface CharMap {
  engines?: Record<string, string>;
  rules: {
    engine?: string;
    charId?: string;
    charName?: string;
    name: string;
  }[];
  fallback: string;
  humanLabel: string;
}

const DEFAULT_MAP: CharMap = {
  engines: { voicevox: '0', coeiroink: '1', aivisspeech: '2' },
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
 * Supports both new name-based rules (charName) and legacy numeric rules (charId).
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
  const engineSection = settings[engineName];
  if (!engineSection) {
    return { name: fallback, humanLabel };
  }

  const enginesMap: Record<string, string> = charMap.engines || { voicevox: '0', coeiroink: '1', aivisspeech: '2' };
  const engineNum = enginesMap[engineName];

  // 1. Try name-based matching if current_character_name is set
  const charName = engineSection.current_character_name;
  if (charName) {
    const nameRule = charMap.rules.find(r => 
      (r.engine === engineName || r.engine === engineNum) && 
      (r.charName === charName || r.name === charName)
    );
    if (nameRule?.name) {
      return { name: nameRule.name, humanLabel };
    }
  }

  // 2. Fall back to numeric ID matching if current_character is set
  const currentCharId = engineSection.current_character !== undefined && engineSection.current_character !== null
    ? String(engineSection.current_character)
    : null;

  if (currentCharId !== null) {
    const idRule = charMap.rules.find(r => 
      (r.engine === engineName || r.engine === engineNum) && 
      r.charId === currentCharId
    );
    if (idRule?.name) {
      return { name: idRule.name, humanLabel };
    }
  }

  return { name: fallback, humanLabel };
}

/**
 * Maps a raw (engineName, charName) pair — as found in voicechanger's
 * kohai.txt "[VOICE|engine|char|style]" header lines — to a display name,
 * using local_data/character_map.json.
 */
export function resolveCharaByName(engineName: string, charName: string): string {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  const enginesMap = charMap.engines || { voicevox: '0', coeiroink: '1', aivisspeech: '2' };
  const engineNum = enginesMap[engineName];

  const rule = charMap.rules.find(
    (r) => (r.engine === engineName || r.engine === engineNum) &&
           (r.charName === charName || r.charId === charName || r.name === charName)
  );
  return rule?.name || charMap.fallback || 'Anonymous';
}

/**
 * Maps a raw (engineNum, charId) pair — as found in legacy voicechanger logs —
 * to a display name.
 */
export function resolveCharaByIds(engineNum: string, charId: string): string {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  const enginesMap = charMap.engines || { voicevox: '0', coeiroink: '1', aivisspeech: '2' };

  let engineName = engineNum;
  for (const [name, num] of Object.entries(enginesMap)) {
    if (num === String(engineNum)) {
      engineName = name;
      break;
    }
  }

  const rule = charMap.rules.find(
    (r) => (r.engine === String(engineNum) || r.engine === engineName) &&
           (r.charId === String(charId) || r.charName === String(charId))
  );
  return rule?.name || charMap.fallback || 'Anonymous';
}

/** The configured fallback speaker name from character_map.json. */
export function getCharaFallback(): string {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  return charMap.fallback || 'Anonymous';
}