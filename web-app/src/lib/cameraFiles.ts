// cameraFiles — scans local_data/beings/<name>/camera/ and turns whatever is
// on disk into a resolved CameraManifest.
//
// Filename convention (see the spec this implements, verbatim from Lizard-kun):
//   <State>.<ext>          fallback file for State, used ONLY if no numbered
//                           variant exists ("If there is no figure use it as
//                           fallback")
//   <State>_<N>.<ext>      one entry in State's pool (N = 1, 2, 3, ...);
//                           "take a random one" picks from this pool
//   <From>_<To>.<ext>      fallback transition clip, played once when the
//                           resolved state changes From -> To
//   <From>_<To>_<N>.<ext>  one entry in the From->To transition pool
//
// State tokens must not contain underscores (the seven camera states — Idle /
// Speaking / Thinking / Writing / Reading / Acting / Waiting — are all single
// words, and tool calls map onto them via toolNameToGroup in cameraTypes.ts).
// That's what makes "2 parts after stripping a trailing number" unambiguously
// a transition and "1 part" unambiguously a state.
// Anything else (0 parts, 3+ parts, an unrecognized extension) is silently
// skipped rather than rejected: a stray file in this folder must never break
// the being's camera, only fail to appear in it.
//
// This module is server-only (fs access) — the client only ever sees the
// resolved manifest via GET /api/camera-files.

import fs from 'fs';
import path from 'path';
import { beingCameraDir } from './beingPaths';
import { cameraFileKind, type CameraManifest } from './cameraTypes';

// Re-exported for existing callers/imports of this module — the actual
// implementation now lives in cameraTypes.ts (pure, no `fs`) so the client
// panel can use it too without pulling this server-only module in.
export { cameraFileKind };

export function buildCameraManifest(beingName: string): CameraManifest {
  const manifest: CameraManifest = { states: {}, transitions: {} };
  const dir = beingCameraDir(beingName);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // No camera/ folder yet (or unreadable) — empty manifest. Every caller
    // (the API route, the client panel) treats this exactly like "camera
    // disabled": nothing renders, nothing is pushed, nothing throws.
    return manifest;
  }

  const stateNumbered: Record<string, string[]> = {};
  const stateFallback: Record<string, string> = {};
  const transNumbered: Record<string, string[]> = {};
  const transFallback: Record<string, string> = {};

  for (const entry of entries) {
    if (cameraFileKind(entry) === null) continue; // not a recognized image/video extension
    const ext = path.extname(entry);
    const base = entry.slice(0, -ext.length);
    const parts = base.split('_').filter(p => p.length > 0);
    if (parts.length === 0) continue;

    let n: number | null = null;
    let core = parts;
    const last = parts[parts.length - 1];
    if (parts.length > 1 && /^\d+$/.test(last)) {
      n = parseInt(last, 10);
      core = parts.slice(0, -1);
    }

    if (core.length === 1) {
      const state = core[0];
      if (n !== null) {
        (stateNumbered[state] ||= []).push(entry);
      } else {
        stateFallback[state] = entry;
      }
    } else if (core.length === 2) {
      const key = `${core[0]}->${core[1]}`;
      if (n !== null) {
        (transNumbered[key] ||= []).push(entry);
      } else {
        transFallback[key] = entry;
      }
    }
    // core.length >= 3: unrecognized shape (e.g. an extra underscore in a
    // state name) — skipped, not an error. Keeps future filenames that don't
    // quite fit the convention from taking the whole camera down.
  }

  const stateNames = new Set([...Object.keys(stateNumbered), ...Object.keys(stateFallback)]);
  for (const state of stateNames) {
    const pool = stateNumbered[state];
    manifest.states[state] = pool?.length ? pool.slice().sort() : (stateFallback[state] ? [stateFallback[state]] : []);
  }

  const transKeys = new Set([...Object.keys(transNumbered), ...Object.keys(transFallback)]);
  for (const key of transKeys) {
    const pool = transNumbered[key];
    manifest.transitions[key] = pool?.length ? pool.slice().sort() : (transFallback[key] ? [transFallback[key]] : []);
  }

  return manifest;
}
