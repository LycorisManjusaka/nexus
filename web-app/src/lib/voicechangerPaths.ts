import fs from 'fs';
import path from 'path';

/**
 * Centralized, *optional* resolution of the external "voicechanger" project.
 *
 * voicechanger is a separate (Python) real-time STT + voice-changer service used
 * for VRChat. It splits into two things that used to be conflated under one
 * directory:
 *
 *   - PROGRAM  (`voicechanger/`, git-tracked): the .py/.bat launchers and the
 *     notification .wav assets. Unchanging unless the code itself changes.
 *   - DATA     (`local_data/voicechanger/`, gitignored): everything read or
 *     written at runtime — chara_settings.json (currently-selected voice
 *     character), device_settings.json, quirks.json, speakers.json (cached
 *     Voicevox speaker catalog), gairaigo.txt (pronunciation dictionary),
 *     kohai.txt (the user's live speech transcript — Python writes, we tail),
 *     ear_log.txt (other people's live speech transcript, "ears"), and their
 *     *_backup/ snapshot folders.
 *
 * Before this split, `chara_settings.json` and friends lived inside
 * `voicechanger/` itself and were git-tracked — every character switch or
 * spoken line dirtied git status, forcing a commit before a frozen copy
 * (e.g. the Cairn instance) could pull cleanly. Splitting data into
 * `local_data/` fixes that: local_data already has its own sync story
 * (rclone) and is already blanket-gitignored.
 *
 * This module removes the former hard-coded absolute path
 * (`c:\dev\chat-manager\voicechanger\...`) so the app is portable. On a machine
 * where voicechanger is present (default: sibling folder of the web-app, like
 * local_data) everything behaves exactly as before. On a machine where it is
 * absent (e.g. a work PC syncing only the repo) the voice/VRChat/live features
 * degrade gracefully instead of crashing.
 *
 * Override the program location per-machine with the NEXUS_VOICECHANGER_DIR
 * env var; leave it unset to disable the integration on machines without
 * voicechanger. The data directory normally never needs an override — it
 * follows local_data exactly like every other Nexus data file — but
 * NEXUS_VOICECHANGER_DATA_DIR exists for the rare case that needs to point it
 * elsewhere.
 */

// Mirrors how local_data is resolved (process.cwd() is the web-app dir, so
// '..' is the repo root that holds the voicechanger folder).
const DEFAULT_DIR = path.resolve(process.cwd(), '..', 'voicechanger');

export const VOICECHANGER_DIR = process.env.NEXUS_VOICECHANGER_DIR || DEFAULT_DIR;

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), '..', 'local_data', 'voicechanger');

export const VOICECHANGER_DATA_DIR = process.env.NEXUS_VOICECHANGER_DATA_DIR || DEFAULT_DATA_DIR;

export const charaSettingsPath = () => path.join(VOICECHANGER_DATA_DIR, 'chara_settings.json');
export const speakersJsonPath = () => path.join(VOICECHANGER_DATA_DIR, 'speakers.json');
// Coeiroink's speaker catalog, cached to disk by voice_changer.py's
// _load_coeiroink_speakers() the same way speakers.json caches Voicevox's.
export const coeiroinkSpeakersJsonPath = () => path.join(VOICECHANGER_DATA_DIR, 'coeiroink_speakers.json');
export const kohaiPath = () => path.join(VOICECHANGER_DATA_DIR, 'kohai.txt');
export const earLogPath = () => path.join(VOICECHANGER_DATA_DIR, 'ear_log.txt');

/** True when the voicechanger project is reachable on this machine. */
export function voicechangerAvailable(): boolean {
  try {
    return fs.existsSync(VOICECHANGER_DIR);
  } catch {
    return false;
  }
}

/**
 * Ensures local_data/voicechanger exists, creating it if necessary. Safe to
 * call before every write — mkdirSync recursive is a cheap no-op once the
 * directory is already there.
 */
export function ensureVoicechangerDataDir(): void {
  fs.mkdirSync(VOICECHANGER_DATA_DIR, { recursive: true });
}
