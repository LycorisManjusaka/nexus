import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './beingPaths';
import { MOCK_PREFIX, parseMockScenario, type MockScenario } from './mockModel';

/**
 * Where the soulless machine's scenarios live: `local_data/mock_models/`.
 * One `<name>.json` per machine; it appears in the Local list as `mock:<name>`.
 * The folder is never created by NEXUS — no folder, no entries.
 */
export const MOCK_DIR = path.join(DATA_DIR, 'mock_models');

export function listMockModelIds(): string[] {
  try {
    return fs.readdirSync(MOCK_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
      .map((f) => MOCK_PREFIX + f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read the scenario fresh every call, so editing the file takes effect on the
 * next turn with no restart. A broken file plays the defaults (and says so in
 * `error`) rather than killing the turn.
 */
export function loadMockScenario(name: string): { scenario: MockScenario; error?: string } {
  // The name came from the model id; refuse anything that would leave the folder.
  if (!name || /[\\/]|\.\./.test(name)) return { scenario: parseMockScenario({}), error: 'invalid name' };
  const file = path.join(MOCK_DIR, `${name}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return { scenario: parseMockScenario(JSON.parse(raw)) };
  } catch (e: any) {
    return { scenario: parseMockScenario({}), error: e?.message || String(e) };
  }
}
