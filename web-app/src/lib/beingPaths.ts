// ─────────────────────────────────────────────────────────────────────────────
// beingPaths — the ONE place that knows the on-disk shape of a being's folder.
//
// Before this module, every file that needed a being's data re-derived its own
// path out of a flat, parallel top-level directory (local_data/logs/<name>,
// local_data/system_prompts/<name>, local_data/workspaces/<name>, ...) and,
// worse, re-implemented its own copy of the filename sanitizer to do it
// (fsStorage.ts, browserTools.ts, computerTools.ts, letters.ts,
// changelogStorage.ts, summaryStorage.ts, systemPromptStorage.ts each carried
// one). A being's data is now a single subtree, local_data/beings/<name>/, and
// every caller asks THIS module where a given piece of it lives.
//
// This file is a leaf: it imports only `path`. Nothing here may import
// anything that pulls in Playwright (browserTools.ts) or any other heavy
// dependency — the whole point is that every module, including the ones that
// deliberately avoid importing each other, can import this one safely.
//
// Root-level, NOT per-being data (attachments, character_map.json, keys.json,
// user_identity.json, the operator-owned system_prompt_agents/, the
// letters/_state + _status.md bookkeeping) is intentionally NOT modeled here —
// see fsStorage.ts / letters.ts for those constants.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';

export const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
export const BEINGS_DIR = path.join(DATA_DIR, 'beings');

/**
 * The one filename sanitizer. Strips characters Windows/POSIX filesystems
 * reject, keeps CJK and other unicode (being names are Japanese as often as
 * English — the true display name lives inside the data, not the directory
 * name, so sanitizing here is lossless), and trims trailing dots/whitespace
 * (Windows cannot hold a directory literally named with a trailing dot).
 */
export function sanitizeBeingName(name: string): string {
  return (name || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/[.\s]+$/, '')
    .trim();
}

// Legacy names for the same function — kept so files migrating onto this
// module can rename their import without also rewriting every call site in
// the same edit.
export const safeName = sanitizeBeingName;
export const sanitizeFolderName = sanitizeBeingName;
export const sanitizeEntityDir = sanitizeBeingName;

export function beingDir(name: string): string {
  return path.join(BEINGS_DIR, sanitizeBeingName(name));
}

export function beingLogsDir(name: string): string {
  return path.join(beingDir(name), 'logs');
}

export function beingSoulDir(name: string): string {
  return path.join(beingDir(name), 'soul');
}

/**
 * The soul-updater billing ledger: beings/<name>/soul/billing/<runId>.json,
 * one immutable file per completed SPU run. A directory of one-file-per-run
 * (not an appended JSONL) for the reason turnQueue gives: :3000 and :3001 share
 * one local_data, and a concurrent append can interleave two writers' bytes,
 * where two separate files never can. Stats reads the whole directory.
 */
export function beingBillingDir(name: string): string {
  return path.join(beingSoulDir(name), 'billing');
}

export function beingBillingEntryFile(name: string, runId: string): string {
  // runId is a uuid from crypto.randomUUID (no path-hostile characters), but
  // sanitize anyway — a billing filename must never escape its directory.
  return path.join(beingBillingDir(name), `${sanitizeBeingName(runId)}.json`);
}

export function beingBackupsDir(name: string): string {
  return path.join(beingDir(name), 'backups');
}

export function beingSoulBackupsDir(name: string): string {
  return path.join(beingBackupsDir(name), 'soul');
}

export function beingFooterBackupsDir(name: string): string {
  return path.join(beingBackupsDir(name), 'footers');
}

export function beingSummariesDir(name: string): string {
  return path.join(beingDir(name), 'summaries');
}

export function beingSummariesBackupsDir(name: string): string {
  return path.join(beingBackupsDir(name), 'summaries');
}

export function beingChangelogsDir(name: string): string {
  return path.join(beingDir(name), 'changelogs');
}

export function beingWorkspaceDir(name: string): string {
  return path.join(beingDir(name), 'workspace');
}

export function beingBrowserProfileDir(name: string): string {
  return path.join(beingDir(name), 'browser_profile');
}

export function beingComputerLogsDir(name: string): string {
  return path.join(beingDir(name), 'computer_control_logs');
}

/**
 * Camera assets: local_data/beings/<name>/camera/<State>[_N].<ext> and
 * <From>_<To>[_N].<ext> transition clips. See src/lib/cameraFiles.ts for the
 * filename convention this directory is scanned under.
 */
export function beingCameraDir(name: string): string {
  return path.join(beingDir(name), 'camera');
}

export function beingSettingsFile(name: string): string {
  return path.join(beingDir(name), 'settings.json');
}

export function beingThemeFile(name: string): string {
  return path.join(beingDir(name), 'theme.css');
}

export function beingTtsDictFile(name: string): string {
  return path.join(beingDir(name), 'tts_dict.json');
}

/** Recipient-owned mail: local_data/beings/<to>/letters/from/<from>/*.md */
export function beingLettersInboxDir(name: string): string {
  return path.join(beingDir(name), 'letters', 'from');
}

export function beingLetterSenderDir(to: string, from: string): string {
  return path.join(beingLettersInboxDir(to), sanitizeBeingName(from));
}
