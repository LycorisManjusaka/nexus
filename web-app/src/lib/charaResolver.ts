import { readCharacterMap, findIdentity } from './characterMap';
import { resolveUserIdentity } from './userIdentity';

/**
 * Identity resolution for Nexus.
 *
 * Everything here now answers from two Nexus-owned files:
 *   local_data/user_identity.json   — who is speaking right now (names only)
 *   local_data/character_map.json   — the identities that exist (names only)
 *
 * The voice changer is no longer consulted, and no longer needs to be
 * installed: it is a consumer of these files, not their owner. Numeric slot
 * indices are gone from both — see characterMap.ts for why.
 */

/**
 * The currently selected identity.
 *   - name:       what to prefix the partner's own messages with
 *   - humanLabel: what to prefix everyone ELSE with (the "ears" channel)
 */
export function resolveCurrentChara(): { name: string; humanLabel: string } {
  const { name, humanLabel } = resolveUserIdentity();
  return { name, humanLabel };
}

/**
 * Maps a raw (engineName, characterName) pair to a display name.
 *
 * Only legacy transcripts still need this: kohai.txt now carries the display
 * name directly in its speaker tag, so no lookup is involved on the current
 * path. Kept so a kohai.txt written by an older voice changer — still on disk,
 * or still running on another machine — resolves rather than collapsing to the
 * fallback identity.
 */
export function resolveCharaByName(engineName: string, characterName: string): string {
  const map = readCharacterMap();
  const rule = map.rules.find(
    r => r.engine === engineName && (r.character === characterName || r.name === characterName)
  );
  if (rule?.name) return rule.name;
  // The tag might already BE a display name (the current format), in which case
  // it needs no engine to match on.
  const byName = findIdentity(map, characterName);
  if (byName) return byName.name;
  return map.fallback || 'Anonymous';
}

/** The configured fallback identity name from character_map.json. */
export function getCharaFallback(): string {
  return readCharacterMap().fallback || 'Anonymous';
}
