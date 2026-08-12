import fs from 'fs';
import path from 'path';
import { readCharacterMap, findIdentity, CharacterMap, IdentityRule } from './characterMap';

/**
 * local_data/user_identity.json — the single layer of truth for "who is
 * speaking right now".
 *
 * Before this file existed, the answer lived inside the voice changer's own
 * chara_settings.json as a pair of numeric slot indices, which meant:
 *   - Nexus could not know the speaker unless the voice changer was installed,
 *     even though the identity is a Nexus concept and the voice is optional;
 *   - the indices silently repointed at a different character whenever a TTS
 *     engine's speaker list was renumbered.
 *
 * Now it is one small Nexus-owned file holding NAMES:
 *
 *   { "identity": "ふわふわ", "style": "あまあま" }
 *
 * `identity` is a `name` from character_map.json. `style` is optional and
 * means "speak in this style for now" — absent means the identity's own
 * defaultStyle (and, if that is absent too, whatever the engine defaults to).
 * Both the web app and the Python voice changer read this same file, so
 * selecting an identity anywhere is immediately visible everywhere.
 */
export interface UserIdentitySelection {
  identity: string;
  style?: string;
}

export const USER_IDENTITY_PATH = path.resolve(process.cwd(), '..', 'local_data', 'user_identity.json');

/** Separator inside a transcript speaker tag: "(Name|Style)". */
const LABEL_SEP = '|';

export function readUserIdentitySelection(): UserIdentitySelection | null {
  try {
    if (!fs.existsSync(USER_IDENTITY_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(USER_IDENTITY_PATH, 'utf-8'));
    const identity = typeof parsed?.identity === 'string' ? parsed.identity.trim() : '';
    if (!identity) return null;
    const style = typeof parsed?.style === 'string' && parsed.style.trim() ? parsed.style.trim() : undefined;
    return { identity, style };
  } catch {
    return null;
  }
}

/**
 * Atomic write — temp file beside the target, then rename. This file is read by
 * a separate OS process (the Python voice changer) on every utterance, so a
 * half-written file would be observed, not merely risked.
 */
export function writeUserIdentitySelection(sel: UserIdentitySelection): void {
  const dir = path.dirname(USER_IDENTITY_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const body: UserIdentitySelection = { identity: sel.identity };
  if (sel.style) body.style = sel.style;
  const tmp = path.join(dir, `.user_identity.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf-8');
  fs.renameSync(tmp, USER_IDENTITY_PATH);
}

export interface ResolvedIdentity {
  /** Display name — always present; falls back to character_map's `fallback`. */
  name: string;
  /** Label for anyone who is NOT the selected identity (the "ears" channel). */
  humanLabel: string;
  /** The matched rule, if the selection names a known identity. */
  rule?: IdentityRule;
  /** Style in effect right now: the session pick, else the rule's defaultStyle. */
  style?: string;
  /** True when the effective style was explicitly picked for this session. */
  styleIsOverride: boolean;
}

/** Resolves the current selection against character_map.json. */
export function resolveUserIdentity(map: CharacterMap = readCharacterMap()): ResolvedIdentity {
  const humanLabel = map.humanLabel || 'Human';
  const fallback = map.fallback || 'Anonymous';
  const sel = readUserIdentitySelection();

  const rule = sel ? findIdentity(map, sel.identity) : undefined;
  if (!rule) {
    // Selection missing, or names an identity that has since been renamed or
    // deleted. Show the configured fallback rather than a name that no longer
    // exists — but do NOT rewrite the file here; a read must not have side
    // effects, and the user may be mid-edit in the identity editor.
    const fallbackRule = findIdentity(map, fallback);
    return { name: fallback, humanLabel, rule: fallbackRule, style: fallbackRule?.defaultStyle, styleIsOverride: false };
  }

  const override = sel?.style && sel.style !== rule.defaultStyle ? sel.style : undefined;
  return {
    name: rule.name,
    humanLabel,
    rule,
    style: override || rule.defaultStyle,
    styleIsOverride: !!override,
  };
}

/**
 * Builds the speaker tag written into kohai.txt: "Name", or "Name|Style" when a
 * style OTHER than the identity's defaultStyle is in effect. Keeping the
 * default implicit is what makes the common line read as plain "(ふわふわ)".
 */
export function buildSpeakerLabel(name: string, style?: string, defaultStyle?: string): string {
  if (style && style !== defaultStyle) return `${name}${LABEL_SEP}${style}`;
  return name;
}

/** Inverse of buildSpeakerLabel, for reading a transcript line back. */
export function parseSpeakerLabel(label: string): { name: string; style?: string } {
  const i = (label || '').indexOf(LABEL_SEP);
  if (i < 0) return { name: (label || '').trim() };
  return { name: label.slice(0, i).trim(), style: label.slice(i + 1).trim() || undefined };
}

/** How a speaker tag is rendered in the transcript Nexus hands to the entity. */
export function displaySpeaker(label: string): string {
  const { name, style } = parseSpeakerLabel(label);
  return style ? `${name} (${style})` : name;
}
