import fs from 'fs';
import path from 'path';
import { charaSettingsPath, speakersJsonPath, coeiroinkSpeakersJsonPath } from './voicechangerPaths';

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
 * Finds `charName`'s numeric slot index within the given engine's cached
 * speaker catalog (speakers.json for voicevox, coeiroink_speakers.json for
 * coeiroink — both written to disk by voice_changer.py). Returns the index
 * as a string ("2"), or null if the catalog is missing or the name isn't
 * found in it. This is only ever used to bridge a real character NAME (as
 * now written into kohai.txt headers) back to an old-style character_map.json
 * rule that still stores a numeric `charId` from before the name-based
 * rewrite — a rule saved through the current User Identity GUI never needs
 * this, since it already stores `charName` directly.
 */
function resolveCharIndexFromName(engineName: string, charName: string): string | null {
  const catalogPath = engineName === 'voicevox' ? speakersJsonPath() : engineName === 'coeiroink' ? coeiroinkSpeakersJsonPath() : null;
  if (!catalogPath) return null;
  const catalog = readJson<any[]>(catalogPath, []);
  if (!Array.isArray(catalog) || catalog.length === 0) return null;
  const idx = catalog.findIndex((c: any) => (c?.name || c?.speakerName) === charName);
  return idx >= 0 ? String(idx) : null;
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

  const engineMatches = (r: CharMap['rules'][number]) => r.engine === engineName || r.engine === engineNum;

  const rule = charMap.rules.find(
    (r) => engineMatches(r) && (r.charName === charName || r.charId === charName || r.name === charName)
  );
  if (rule?.name) return rule.name;

  // Legacy fallback: the rule was saved before name-based identification and
  // only has a numeric charId. Resolve the incoming real name to its slot
  // index in the engine's speaker catalog and retry the match on that index.
  if (charName) {
    const idx = resolveCharIndexFromName(engineName, charName);
    if (idx !== null) {
      const idRule = charMap.rules.find((r) => engineMatches(r) && r.charId === idx);
      if (idRule?.name) return idRule.name;
    }
  }

  return charMap.fallback || 'Anonymous';
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