import fs from 'fs';
import path from 'path';
import { charaSettingsPath } from './voicechangerPaths';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

interface CharMap {
  // `engine`/`charName` are optional: a name-only rule is valid (e.g.
  // registered purely as a letters recipient or display name with no TTS
  // voice behind it). Only `name` is required. Anything that needs an actual
  // voice must check for both being present rather than assuming they always
  // are. `engine` is the engine's own NAME string ("voicevox" / "coeiroink" /
  // "aivisspeech" / any future engine) — never a numeric index, and
  // `charName` is the character's real name as reported by that engine's own
  // speaker list — never a numeric slot. Indices into a TTS engine's speaker
  // list shift whenever a new voice is installed (confirmed on Coeiroink and
  // AivisSpeech; Voicevox happens to be stable but is not guaranteed to stay
  // that way), so nothing here may be identified by index — only by the
  // engine's own stable name strings.
  rules: { engine?: string; charName?: string; name: string }[];
  fallback: string;
  humanLabel: string;
}

const DEFAULT_MAP: CharMap = {
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
  const engineSection = settings[engineName];
  const charName = engineSection?.current_character_name;
  if (!engineSection || !charName) {
    return { name: fallback, humanLabel };
  }

  const rule = charMap.rules.find(r => r.engine === engineName && r.charName === charName);
  return { name: rule?.name || fallback, humanLabel };
}

/**
 * Maps a raw (engineName, charName) pair — as found in voicechanger's
 * kohai.txt "[VOICE|engine|char|style]" header lines — to a display name,
 * using local_data/character_map.json. Falls back to the map's `fallback`
 * when no rule matches. This is the shared lookup so VRChat speaker labeling
 * stays in sync with the same file that drives Live Session / message author
 * labels, instead of a separate hardcoded table.
 */
export function resolveCharaByName(engineName: string, charName: string): string {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  const rule = charMap.rules.find(
    (r) => r.engine === engineName && r.charName === charName
  );
  return rule?.name || charMap.fallback || 'Anonymous';
}

/** The configured fallback speaker name from character_map.json. */
export function getCharaFallback(): string {
  const charMap = readJson<CharMap>(CHAR_MAP_PATH, DEFAULT_MAP);
  return charMap.fallback || 'Anonymous';
}
