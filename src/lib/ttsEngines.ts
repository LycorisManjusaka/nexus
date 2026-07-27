import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn, execFile } from 'child_process';
// Reused rather than reimplemented: the Audio Session panel already solved
// "who owns this port?" for the voicechanger services.
import { findPidByPort } from './audioServices';

// Auto-start for the local TTS engines.
//
// All three are VOICEVOX-API-compatible HTTP servers listening on fixed local
// ports, so "is it running?" is answered by a cheap GET, and "start it" is just
// spawning the .exe the user pointed us at. Paths are stored SERVER-SIDE
// (local_data/tts_engines.json) rather than in the browser's globalSettings,
// because the launch happens here — putting them in localStorage would mean
// threading the path through every TTS call site in the UI.
//
// Nothing is guessed: an engine with no configured path is simply never
// launched, and TTS behaves exactly as it did before.

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const ENGINES_FILE = path.join(DATA_DIR, 'tts_engines.json');

export interface EngineDef {
  key: string;
  name: string;
  base: string;
  /** A GET endpoint that answers only when the engine is fully up. */
  health: string;
}

// Health endpoints are picked per engine rather than assuming a shared one:
// each is an endpoint this codebase already calls successfully, so we know it
// exists on that engine's build.
export const ENGINES: Record<number, EngineDef> = {
  0: { key: 'voicevox',    name: 'VOICEVOX',    base: 'http://127.0.0.1:50021', health: '/version' },
  1: { key: 'coeiroink',   name: 'COEIROINK',   base: 'http://127.0.0.1:50032', health: '/v1/speakers' },
  2: { key: 'aivisspeech', name: 'AivisSpeech', base: process.env.NEXUS_AIVISSPEECH_URL || 'http://127.0.0.1:10101', health: '/speakers' },
};

export type EnginePaths = Partial<Record<string, string>>;

/**
 * Windows Explorer's "Copy as path" (Shift+Right-click) wraps the path in
 * double quotes, and pasting that straight in produces a stored value like
 *   "C:\Program Files\AivisSpeech\AivisSpeech-Engine\run.exe"
 * — quotes included. `fs.existsSync` then fails and auto-start silently reports
 * "executable not found" for a path that is, to the eye, obviously correct.
 * Strip them on the way in, and defensively again before use.
 */
export function normalizeExePath(p: string): string {
  let s = String(p || '').trim();
  while (s.length > 1 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export async function loadEnginePaths(): Promise<EnginePaths> {
  try {
    return JSON.parse(await fsp.readFile(ENGINES_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

export async function saveEnginePaths(paths: EnginePaths): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  // Keep only the three known keys, trimmed. Stops arbitrary junk from a
  // malformed request landing in the file.
  const clean: EnginePaths = {};
  for (const def of Object.values(ENGINES)) {
    const v = normalizeExePath(paths?.[def.key] || '');
    if (v) clean[def.key] = v;
  }
  await fsp.writeFile(ENGINES_FILE, JSON.stringify(clean, null, 2), 'utf-8');
}

/** Cheap liveness probe. Short timeout: this runs before every synthesis. */
export async function isEngineUp(engine: number): Promise<boolean> {
  const def = ENGINES[engine];
  if (!def) return false;
  try {
    const res = await fetch(`${def.base}${def.health}`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Launch state ─────────────────────────────────────────────────────────────
// Kept on globalThis so Next.js hot-reload in dev doesn't reset it and orphan a
// launch that's already in progress.
interface LaunchState {
  inFlight: Map<number, Promise<EnsureResult>>;
  healthyUntil: Map<number, number>;
  failedUntil: Map<number, string>;
}
const g = globalThis as any;
if (!g.__nexusTtsEngineState) {
  g.__nexusTtsEngineState = {
    inFlight: new Map(),
    healthyUntil: new Map(),
    failedUntil: new Map(),
  } as LaunchState;
}
const state: LaunchState = g.__nexusTtsEngineState;

// Streaming TTS fires one synthesis request per sentence, back to back. Without
// a short positive cache every one of them would pay a health round-trip, and
// without the in-flight map a cold engine would be spawned once PER REQUEST —
// a dozen copies of VOICEVOX racing to bind the same port.
const HEALTH_CACHE_MS = 5000;
// After a failed launch, fail fast for a moment instead of re-spawning on every
// queued segment.
const FAILURE_COOLDOWN_MS = 15000;
// VOICEVOX/AivisSpeech load models on boot; first start is genuinely slow.
const BOOT_TIMEOUT_MS = 90000;
const POLL_INTERVAL_MS = 500;

export interface EnsureResult {
  ok: boolean;
  wasRunning: boolean;
  launched: boolean;
  error?: string;
}

async function launchAndWait(engine: number, rawPath: string): Promise<EnsureResult> {
  const def = ENGINES[engine];
  // Defensive: a config written before normalizeExePath existed may still carry
  // Explorer's "Copy as path" quotes.
  const exePath = normalizeExePath(rawPath);

  if (!fs.existsSync(exePath)) {
    return { ok: false, wasRunning: false, launched: false, error: `${def.name}: executable not found at "${exePath}"` };
  }
  try {
    if (!fs.statSync(exePath).isFile()) {
      return { ok: false, wasRunning: false, launched: false, error: `${def.name}: "${exePath}" is not a file` };
    }
  } catch (e: any) {
    return { ok: false, wasRunning: false, launched: false, error: `${def.name}: cannot read "${exePath}" (${e.message})` };
  }

  try {
    // cwd MUST be the engine's own directory — these apps resolve their model
    // and dictionary files relative to it, and launching from Nexus's cwd makes
    // them start and then fail to synthesize.
    // detached + unref so the engine outlives this request and isn't killed
    // when the Next.js dev server reloads.
    const child = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`[tts-engine] launching ${def.name}: ${exePath}`);
  } catch (e: any) {
    return { ok: false, wasRunning: false, launched: false, error: `${def.name}: failed to launch (${e.message})` };
  }

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    if (await isEngineUp(engine)) {
      const secs = ((BOOT_TIMEOUT_MS - (deadline - Date.now())) / 1000).toFixed(1);
      console.log(`[tts-engine] ${def.name} ready after ${secs}s`);
      return { ok: true, wasRunning: false, launched: true };
    }
  }
  return {
    ok: false,
    wasRunning: false,
    launched: true,
    error: `${def.name}: started but did not answer on ${def.base} within ${BOOT_TIMEOUT_MS / 1000}s`,
  };
}

/**
 * Make sure an engine is reachable, starting it if a path is configured.
 *
 * Never throws. A missing path, a bad path, or a boot timeout all resolve to
 * `ok: false` with a message — the caller then proceeds and lets the normal
 * synthesis error surface, so behaviour with no configuration is unchanged.
 */
export async function ensureEngineRunning(engine: number): Promise<EnsureResult> {
  const def = ENGINES[engine];
  if (!def) return { ok: false, wasRunning: false, launched: false, error: `unknown engine ${engine}` };

  // Recently verified — skip the probe entirely (streaming hot path).
  const until = state.healthyUntil.get(engine) || 0;
  if (Date.now() < until) return { ok: true, wasRunning: true, launched: false };

  if (await isEngineUp(engine)) {
    state.healthyUntil.set(engine, Date.now() + HEALTH_CACHE_MS);
    state.failedUntil.delete(engine);
    return { ok: true, wasRunning: true, launched: false };
  }

  // A launch for this engine is already underway — join it rather than
  // starting a second copy.
  const pending = state.inFlight.get(engine);
  if (pending) return pending;

  const cooling = state.failedUntil.get(engine);
  if (cooling && Date.now() < Number(cooling.split('|')[0])) {
    return { ok: false, wasRunning: false, launched: false, error: cooling.split('|').slice(1).join('|') };
  }

  const paths = await loadEnginePaths();
  const exePath = paths[def.key];
  if (!exePath) {
    // Not configured: stay out of the way completely.
    return { ok: false, wasRunning: false, launched: false, error: `${def.name} is not running and no executable path is configured` };
  }

  const p = (async () => {
    const res = await launchAndWait(engine, exePath);
    if (res.ok) {
      state.healthyUntil.set(engine, Date.now() + HEALTH_CACHE_MS);
      state.failedUntil.delete(engine);
    } else {
      state.failedUntil.set(engine, `${Date.now() + FAILURE_COOLDOWN_MS}|${res.error || 'launch failed'}`);
      console.error(`[tts-engine] ${res.error}`);
    }
    return res;
  })();

  state.inFlight.set(engine, p);
  try {
    return await p;
  } finally {
    state.inFlight.delete(engine);
  }
}

// ── Explicit lifecycle control (Start / Stop / Restart) ──────────────────────
//
// WHY STOP WORKS BY PORT, NOT BY REMEMBERED PID:
// engines are spawned `detached` + `unref()` so they survive a dev-server reload
// — and the child handle is thrown away, so Nexus keeps no record of what it
// started. Asking Windows "who is listening on :10101?" instead means Stop works
// for an engine Nexus never started, or started before it was last restarted.
// That is the whole point: previously the engine could not be stopped at all,
// even by closing Nexus.

export interface EngineActionResult { ok: boolean; message: string; }

/** Host + port from an engine's base URL. */
export function engineEndpoint(engine: number): { host: string; port: number } | null {
  const def = ENGINES[engine];
  if (!def) return null;
  try {
    const u = new URL(def.base);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return { host: u.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

/**
 * Only engines on THIS machine may be killed. AivisSpeech's base can be pointed
 * elsewhere via NEXUS_AIVISSPEECH_URL — without this guard, "stop the engine on
 * port 10101" would find and kill a LOCAL process while the real engine runs on
 * another host.
 */
export function isLocalEngine(engine: number): boolean {
  const ep = engineEndpoint(engine);
  return !!ep && LOOPBACK_HOSTS.has(ep.host);
}

function killTree(pid: number): Promise<void> {
  // /T kills the child processes too: the VOICEVOX-family apps are a GUI shell
  // plus a separate engine worker, and killing only the port owner can orphan it.
  return new Promise(resolve => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Launch an engine and return IMMEDIATELY.
 *
 * Deliberately does NOT wait for boot the way `ensureEngineRunning` does: an
 * engine takes up to 90s to load its models, and blocking the HTTP response for
 * that long freezes the settings panel — including the Stop button. Readiness is
 * reported by the caller's status poll instead.
 */
export async function startEngine(engine: number): Promise<EngineActionResult> {
  const def = ENGINES[engine];
  if (!def) return { ok: false, message: `Unknown engine ${engine}` };
  if (await isEngineUp(engine)) return { ok: true, message: 'already running' };

  const paths = await loadEnginePaths();
  const exePath = normalizeExePath(paths[def.key] || '');
  if (!exePath) return { ok: false, message: `No executable path is configured for ${def.name}.` };
  if (!fs.existsSync(exePath)) return { ok: false, message: `${def.name}: executable not found at "${exePath}"` };

  // An explicit Start is a deliberate user action — clear the auto-start failure
  // cooldown so it always actually tries rather than replaying a stale error.
  state.failedUntil.delete(engine);

  try {
    const child = spawn(exePath, [], { cwd: path.dirname(exePath), detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e: any) {
    return { ok: false, message: `${def.name}: failed to launch (${e.message})` };
  }
  console.log(`[tts-engine] start requested: ${def.name}`);
  return { ok: true, message: 'starting… (loading voice models can take up to a minute)' };
}

export async function stopEngine(engine: number): Promise<EngineActionResult> {
  const def = ENGINES[engine];
  if (!def) return { ok: false, message: `Unknown engine ${engine}` };
  if (!isLocalEngine(engine)) {
    return { ok: false, message: `${def.name} is configured at ${def.base}. Nexus only stops engines running on this machine.` };
  }

  // Drop the positive health cache FIRST. Otherwise synthesis could still treat
  // a just-killed engine as healthy for up to HEALTH_CACHE_MS.
  state.healthyUntil.delete(engine);
  state.failedUntil.delete(engine);

  if (!(await isEngineUp(engine))) return { ok: true, message: 'already stopped' };

  const ep = engineEndpoint(engine)!;
  const pid = await findPidByPort(ep.port);
  if (!pid) {
    return { ok: false, message: `${def.name} is answering on :${ep.port} but the owning process could not be identified.` };
  }

  await killTree(pid);
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    if (!(await isEngineUp(engine))) {
      state.healthyUntil.delete(engine);
      console.log(`[tts-engine] stopped ${def.name} (pid ${pid})`);
      return { ok: true, message: 'stopped' };
    }
  }
  return { ok: false, message: `${def.name}: PID ${pid} did not exit.` };
}

/**
 * Stop, wait for the port to actually be released, then start.
 *
 * This is the button for "I installed new voices and need the engine to reload".
 * Clicking Stop then Start by hand tends to fail: the new instance races the old
 * one for the port before Windows has released it, and dies on bind.
 */
export async function restartEngine(engine: number): Promise<EngineActionResult> {
  const def = ENGINES[engine];
  if (!def) return { ok: false, message: `Unknown engine ${engine}` };

  if (await isEngineUp(engine)) {
    const stopped = await stopEngine(engine);
    if (!stopped.ok) return { ok: false, message: `restart aborted — ${stopped.message}` };
  }

  // Wait for the listening socket to be released, not merely for the health
  // endpoint to stop answering.
  const ep = engineEndpoint(engine);
  if (ep && isLocalEngine(engine)) {
    for (let i = 0; i < 20; i++) {
      if (!(await findPidByPort(ep.port))) break;
      await sleep(300);
    }
  }

  const started = await startEngine(engine);
  return started.ok
    ? { ok: true, message: 'restarting… (loading voice models can take up to a minute)' }
    : started;
}
