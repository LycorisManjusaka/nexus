import fs from 'fs';
import path from 'path';
import { speakersJsonPath, coeiroinkSpeakersJsonPath } from './voicechangerPaths';

/**
 * local_data/character_map.json — the list of human identities Nexus knows.
 *
 * An "identity" is a display name (the label a message is attributed to) plus,
 * OPTIONALLY, a TTS voice the voice changer should speak it in. The voice half
 * is entirely optional: an identity with no engine/character is a perfectly
 * valid identity, it simply has no voice. The voice changer itself is optional
 * too — Nexus is now the only front-end, so nothing here requires it to exist.
 *
 * ── Why every field is a NAME, never an index ──────────────────────────────
 * The original schema stored numeric slot indices (`engine: "0", charId: "21"`)
 * because the voice changer predates Nexus and was driven by SPOKEN commands —
 * speech recognition cannot reliably hear a Japanese character name, but it can
 * hear a number. Nexus is now the only front-end, so that constraint is gone,
 * and indices are actively harmful: Coeiroink and AivisSpeech renumber their
 * whole speaker list whenever a new voice is installed, silently repointing
 * every saved identity at a different character.
 *
 * So the schema is:
 *
 *   { "name": "トカゲくん",           // display name — the only required field
 *     "engine": "voicevox",           // engine's own name; new engines need no schema change
 *     "character": "麒ヶ島宗麟",       // character's real name inside that engine
 *     "defaultStyle": "ノーマル" }     // style spoken when nothing else is picked
 *
 * Indices are re-derived at the moment of synthesis, from whatever the engine
 * reports right then, and never persisted.
 */
export interface IdentityRule {
  name: string;
  engine?: string;
  character?: string;
  defaultStyle?: string;
}

export interface CharacterMap {
  _comment?: string;
  rules: IdentityRule[];
  fallback: string;
  humanLabel: string;
}

export const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

export const DEFAULT_COMMENT =
  'Human identities Nexus can attribute a message to. `name` is the only required field; ' +
  'engine/character/defaultStyle are the OPTIONAL voice a voice changer should speak this ' +
  'identity in, stored by name (never by slot index — engines renumber their speaker lists ' +
  'when voices are installed). Edit via Preferences → User Identity, or by hand.';

/** Default tag for speech coming through the OTHER input channel (a second
 *  mic / virtual audio cable carrying someone else's voice). Kept abstract on
 *  purpose: this house has no "user", and the other speaker need not be human.
 *  Single source so the empty map, the editor route, and userIdentity cannot
 *  drift apart. */
export const DEFAULT_OTHERS_LABEL = 'Guest';

export const EMPTY_MAP: CharacterMap = {
  _comment: DEFAULT_COMMENT,
  rules: [{ name: 'Anonymous' }],
  fallback: 'Anonymous',
  humanLabel: DEFAULT_OTHERS_LABEL,
};

/** Legacy numeric engine ids, as written by the pre-name schema. */
const LEGACY_ENGINE_BY_NUM: Record<string, string> = { '0': 'voicevox', '1': 'coeiroink', '2': 'aivisspeech' };

function readJson<T>(p: string, fallback: T): T {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Legacy bridge: turn an engine's numeric slot index back into the character's
 * real name, using the speaker catalog voice_changer.py caches to disk. Only
 * used to READ a character_map.json that still holds pre-name `charId` rules —
 * nothing written from here on stores an index again. Returns null when the
 * catalog isn't on disk (the engine has never been run on this machine), in
 * which case the rule is simply presented without a voice rather than guessed.
 */
function legacyCharIdToName(engineName: string, charId: string): string | null {
  const catalogPath =
    engineName === 'voicevox' ? speakersJsonPath() : engineName === 'coeiroink' ? coeiroinkSpeakersJsonPath() : null;
  if (!catalogPath) return null;
  const catalog = readJson<any[]>(catalogPath, []);
  const idx = Number(charId);
  if (!Array.isArray(catalog) || !Number.isInteger(idx) || idx < 0 || idx >= catalog.length) return null;
  const c = catalog[idx];
  return (c?.name || c?.speakerName) || null;
}

/**
 * Normalize one rule from any schema generation into the current one:
 *   gen 1  { engine: "0", charId: "21", name }          — numeric everything
 *   gen 2  { engine: "voicevox", charName, styleName }  — names, old field names
 *   gen 3  { engine: "voicevox", character, defaultStyle }  — current
 * Unresolvable voice data is DROPPED (identity kept, voice absent) rather than
 * carried forward as a number that would eventually point at a stranger.
 */
export function normalizeRule(raw: any): IdentityRule {
  const out: IdentityRule = { name: String(raw?.name ?? '').trim() };
  if (!raw) return out;

  let engine: string | undefined = raw.engine ? String(raw.engine) : undefined;
  if (engine && LEGACY_ENGINE_BY_NUM[engine]) engine = LEGACY_ENGINE_BY_NUM[engine];
  if (!engine) return out;

  let character: string | undefined = raw.character || raw.charName || undefined;
  if (!character && raw.charId !== undefined && raw.charId !== null) {
    character = legacyCharIdToName(engine, String(raw.charId)) || undefined;
  }
  // Engine without a character IS a usable signal: it means "this identity has
  // a voice, on THIS engine, and the character needs to be re-picked in the UI
  // because the speaker catalog isn't available right now." Dropping engine here
  // makes the editor show "no voice" for a rule the user deliberately configured
  // — that's actively misleading, not just incomplete. The engine is preserved;
  // the character is left at whatever was resolved (possibly undefined), and the
  // UI shows the engine dropdown ready with the character picker empty.
  out.engine = engine;
  if (character) out.character = character;

  const style: string | undefined = raw.defaultStyle || raw.styleName || undefined;
  // A legacy numeric styleId is deliberately NOT translated: style order shifts
  // with the speaker list too, and an absent style already means "the engine's
  // own default", which is what a wrong guess would only pretend to improve on.
  if (style && typeof style === 'string') out.defaultStyle = style;

  return out;
}

/** Reads character_map.json, normalizing every rule to the current schema. */
export function readCharacterMap(): CharacterMap {
  const parsed = readJson<any>(CHAR_MAP_PATH, null);
  if (!parsed) return { ...EMPTY_MAP, rules: [...EMPTY_MAP.rules] };
  const rules: IdentityRule[] = (Array.isArray(parsed.rules) ? parsed.rules : [])
    .map(normalizeRule)
    .filter((r: IdentityRule) => !!r.name);
  return {
    _comment: parsed._comment || DEFAULT_COMMENT,
    rules,
    fallback: parsed.fallback || 'Anonymous',
    humanLabel: parsed.humanLabel || DEFAULT_OTHERS_LABEL,
  };
}

/** Finds an identity by display name. */
export function findIdentity(map: CharacterMap, name: string): IdentityRule | undefined {
  if (!name) return undefined;
  return map.rules.find(r => r.name === name);
}

/** The configured fallback identity name. */
export function characterMapFallback(): string {
  return readCharacterMap().fallback || 'Anonymous';
}
