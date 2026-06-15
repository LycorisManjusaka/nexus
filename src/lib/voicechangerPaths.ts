import fs from 'fs';
import path from 'path';

/**
 * Centralized, *optional* resolution of the external "voicechanger" project.
 *
 * voicechanger is a separate (Python) real-time STT + voice-changer service used
 * for VRChat. The web-app only consumes a few of its files:
 *   - chara_settings.json : currently-selected voice character (read + written)
 *   - speakers.json       : Voicevox speaker catalog (for the voice dropdown)
 *   - kohai.txt           : the user's live speech transcript (Python writes, we tail)
 *   - ear_log.txt         : other people's live speech transcript ("ears")
 *
 * This module removes the former hard-coded absolute path
 * (`c:\dev\chat-manager\voicechanger\...`) so the app is portable. On a machine
 * where voicechanger is present (default: sibling folder of the web-app, like
 * local_data) everything behaves exactly as before. On a machine where it is
 * absent (e.g. a work PC syncing only the repo) the voice/VRChat/live features
 * degrade gracefully instead of crashing.
 *
 * Override the location per-machine with the NEXUS_VOICECHANGER_DIR env var;
 * leave it unset to disable the integration on machines without voicechanger.
 */

// Mirrors how local_data is resolved (process.cwd() is the web-app dir, so
// '..' is the chat-manager root that holds the voicechanger folder).
const DEFAULT_DIR = path.resolve(process.cwd(), '..', 'voicechanger');

export const VOICECHANGER_DIR = process.env.NEXUS_VOICECHANGER_DIR || DEFAULT_DIR;

export const charaSettingsPath = () => path.join(VOICECHANGER_DIR, 'chara_settings.json');
export const speakersJsonPath = () => path.join(VOICECHANGER_DIR, 'speakers.json');
export const kohaiPath = () => path.join(VOICECHANGER_DIR, 'kohai.txt');
export const earLogPath = () => path.join(VOICECHANGER_DIR, 'ear_log.txt');

/** True when the voicechanger project is reachable on this machine. */
export function voicechangerAvailable(): boolean {
  try {
    return fs.existsSync(VOICECHANGER_DIR);
  } catch {
    return false;
  }
}
