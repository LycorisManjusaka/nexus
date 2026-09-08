/**
 * obsCamera — push the resolved camera file into OBS Studio over
 * obs-websocket v5, so the being's live state shows up on whatever OBS is
 * feeding (its virtual camera into Teams, a capture card, etc).
 *
 * Hand-rolled against the v5 protocol (Hello/Identify/Request-Response)
 * instead of pulling in obs-websocket-js: Node 24 ships a native WebSocket
 * global (verified at the DOM-typed interface this file uses), and the
 * protocol itself is four small JSON message shapes — the same "raw protocol
 * over SDK" call already made for the Kimi/MiMo Anthropic-compat adapter.
 * Zero new dependencies.
 *
 * TWO SOURCE KINDS, MEASURED, NOT ASSUMED. The original version of this file
 * pushed every file (image or video) through the `ffmpeg_source` ("Media
 * Source") settings shape — `local_file`/`is_local_file` + a restart action —
 * on the theory that ffmpeg_source is "the one OBS source type that plays
 * both stills and video". Live testing against the actual running OBS
 * instance (GetSourceScreenshot against throwaway diagnostic inputs)
 * falsified both halves of that theory at once:
 *   - ffmpeg_source correctly decoded a synthetic test .mp4 (colour bars, not
 *     black) — video playback works.
 *   - ffmpeg_source rendered BOTH a .jpg and a .png as a blank/white frame —
 *     still-image decode is broken on this OBS build's ffmpeg_source, for
 *     more than one file and more than one format, not "one bad JPEG".
 *   - `image_source` (a completely different OBS source kind, manually
 *     created by Lizard-kun as a workaround) rendered the same .jpg
 *     correctly, but has no video/playback semantics at all.
 * So there is no single source kind that reliably handles both file kinds
 * here. Fix: maintain two OBS inputs — one `image_source` for stills, one
 * `ffmpeg_source` for video — push into whichever matches the resolved
 * file's extension, and toggle scene-item visibility so only the active one
 * is on screen. Each is auto-created (via CreateInput, in the current
 * program scene) the first time its configured name doesn't already exist,
 * so a fresh install needs zero manual OBS source setup beyond naming them.
 *
 * Best-effort only, by design. OBS may not be running, a source name may be
 * blank, the password may be wrong — none of that may ever break the in-app
 * camera panel, which resolves and renders the same file completely
 * independently (see CameraPanel.tsx). Every failure here is reported back
 * as {ok:false, reason}, never thrown past this module's boundary, matching
 * the "never fails quietly" contract audioSink.ts set for output-device
 * routing.
 *
 * obs-websocket v5 auth (only when OBS has "Enable Authentication" checked):
 *   secret    = base64(sha256(password + salt))
 *   response  = base64(sha256(secret + challenge))
 * (salt/challenge arrive in the server's Hello message.)
 */

import { createHash } from 'crypto';
import { VIDEO_EXTENSIONS } from './cameraTypes';
import path from 'path';

export interface ObsConfig {
  /** e.g. "ws://127.0.0.1:4455" — OBS's WebSocket server address. */
  url: string;
  /** Empty/undefined if OBS has "Enable Authentication" unchecked. */
  password?: string;
  /**
   * Name of an `image_source`-kind input in OBS's current scene, used for
   * still images (png/jpg/webp/gif). Auto-created if it doesn't exist yet.
   * Blank = image pushes are skipped (reported as {ok:false}).
   */
  imageSourceName: string;
  /**
   * Name of an `ffmpeg_source`-kind ("Media Source") input in OBS's current
   * scene, used for video files (mp4/webm/mov/m4v). Auto-created if it
   * doesn't exist yet. Blank = video pushes are skipped (reported as
   * {ok:false}).
   */
  videoSourceName: string;
}

export type ObsPushResult = { ok: true } | { ok: false; reason: string };

function sha256b64(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64');
}

// One connection per server process — OBS itself only has one "camera" pushed
// into one physical webcam, so there is never a reason to hold more than one
// socket regardless of how many beings/browsers are pushing to it.
let socket: WebSocket | null = null;
let identified = false;
let connectPromise: Promise<void> | null = null;
let reqCounter = 0;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();

let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_CLOSE_MS = 5 * 60 * 1000; // close after 5 minutes of no pushes — cheap to reopen

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    try { socket?.close(); } catch { /* already gone */ }
  }, IDLE_CLOSE_MS);
}

function resetConnectionState(err?: Error) {
  socket = null;
  identified = false;
  connectPromise = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  for (const p of pending.values()) p.reject(err || new Error('OBS connection closed'));
  pending.clear();
}

function ensureConnected(cfg: ObsConfig): Promise<void> {
  if (socket && identified && socket.readyState === WebSocket.OPEN) {
    armIdleTimer();
    return Promise.resolve();
  }
  if (connectPromise) return connectPromise;

  connectPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settleReject = (e: Error) => { if (!settled) { settled = true; reject(e); } };
    const settleResolve = () => { if (!settled) { settled = true; resolve(); } };

    let ws: WebSocket;
    try {
      ws = new WebSocket(cfg.url);
    } catch (e: any) {
      settleReject(new Error(`Could not open OBS WebSocket URL "${cfg.url}": ${e?.message || e}`));
      return;
    }

    const connectTimeout = setTimeout(() => {
      settleReject(new Error('OBS WebSocket handshake timed out (is OBS running with Tools -> WebSocket Server Settings enabled?)'));
      try { ws.close(); } catch { /* ignore */ }
    }, 5000);

    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }

      if (msg.op === 0) {
        // Hello — reply with Identify, computing auth only if the server asked for it.
        const d = msg.d || {};
        const identify: any = { op: 1, d: { rpcVersion: d.rpcVersion ?? 1, eventSubscriptions: 0 } };
        if (d.authentication) {
          if (!cfg.password) {
            clearTimeout(connectTimeout);
            settleReject(new Error('OBS requires authentication but no password is configured (Preferences -> Other -> OBS WebSocket password).'));
            try { ws.close(); } catch { /* ignore */ }
            return;
          }
          const secret = sha256b64(cfg.password + d.authentication.salt);
          identify.d.authentication = sha256b64(secret + d.authentication.challenge);
        }
        ws.send(JSON.stringify(identify));
      } else if (msg.op === 2) {
        // Identified — handshake complete.
        clearTimeout(connectTimeout);
        socket = ws;
        identified = true;
        armIdleTimer();
        settleResolve();
      } else if (msg.op === 7) {
        // RequestResponse
        const d = msg.d || {};
        const p = pending.get(d.requestId);
        if (!p) return;
        pending.delete(d.requestId);
        if (d.requestStatus?.result) {
          p.resolve(d.responseData || {});
        } else {
          p.reject(new Error(d.requestStatus?.comment || `OBS request "${d.requestType}" failed (code ${d.requestStatus?.code})`));
        }
      }
      // Event (op 5) messages are ignored — the push caller owns sequencing
      // client-side (1-2s gaps are explicitly acceptable per spec), so there
      // is no need to subscribe to or react to OBS's own media-end events.
    });

    ws.addEventListener('error', () => {
      clearTimeout(connectTimeout);
      settleReject(new Error(`OBS WebSocket connection error (is OBS running with the WebSocket server enabled on ${cfg.url}?)`));
    });

    ws.addEventListener('close', () => {
      clearTimeout(connectTimeout);
      settleReject(new Error('OBS WebSocket closed before the handshake completed.'));
      resetConnectionState();
    });
  }).finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

function request(requestType: string, requestData?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!socket || !identified) { reject(new Error('OBS is not connected')); return; }
    const requestId = String(++reqCounter);
    pending.set(requestId, { resolve, reject });
    try {
      socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    } catch (e: any) {
      pending.delete(requestId);
      reject(new Error(`Failed to send OBS request "${requestType}": ${e?.message || e}`));
      return;
    }
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error(`OBS request "${requestType}" timed out`));
      }
    }, 8000);
  });
}

function isVideoPath(absPath: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(path.extname(absPath).toLowerCase());
}

async function getCurrentSceneName(): Promise<string> {
  const res = await request('GetSceneList', {});
  const name = res?.currentProgramSceneName;
  if (!name) throw new Error('OBS reported no current program scene.');
  return name;
}

/**
 * True if an input with this exact name already exists (of any kind) —
 * checked via GetInputList rather than GetInputSettings so a wrong-kind
 * name collision is visible as "exists, but as inputKind X" instead of a
 * bare request failure.
 */
async function findExistingInput(name: string): Promise<{ inputKind: string } | null> {
  const res = await request('GetInputList', {});
  const found = (res?.inputs || []).find((i: any) => i.inputName === name);
  return found ? { inputKind: found.inputKind } : null;
}

/**
 * Ensure an input named `name` of kind `kind` exists in the current scene,
 * creating it (with `initialSettings`) if it doesn't. Returns the scene it
 * lives in, needed by the caller to toggle scene-item visibility afterward.
 * Throws (caller wraps in try/catch) if `name` exists but as a different
 * kind — that is a real misconfiguration, not something to silently paper
 * over by writing settings the source can't use (the exact bug this file
 * used to have).
 */
async function ensureInputExists(
  name: string,
  kind: 'image_source' | 'ffmpeg_source',
  initialSettings: Record<string, unknown>,
): Promise<string> {
  const sceneName = await getCurrentSceneName();
  const existing = await findExistingInput(name);
  if (existing) {
    if (existing.inputKind !== kind) {
      throw new Error(
        `OBS source "${name}" already exists but as kind "${existing.inputKind}", not "${kind}" — ` +
        `rename one of them (Preferences -> Other) or delete it in OBS so it can be auto-recreated with the right kind.`
      );
    }
    return sceneName;
  }
  await request('CreateInput', { sceneName, inputName: name, inputKind: kind, inputSettings: initialSettings });
  return sceneName;
}

/** Best-effort scene-item visibility toggle — failures here never abort the push (see call site). */
async function setSceneItemVisible(sceneName: string, sourceName: string, visible: boolean): Promise<void> {
  const idRes = await request('GetSceneItemId', { sceneName, sourceName });
  await request('SetSceneItemEnabled', { sceneName, sceneItemId: idRes.sceneItemId, sceneItemEnabled: visible });
}

/**
 * Point the correct OBS input (image_source vs ffmpeg_source, chosen by
 * `absPath`'s extension) at the file, show it, and hide the other kind's
 * input if one is configured. See the file-header note for why there are
 * two inputs instead of one.
 */
export async function pushCameraFile(cfg: ObsConfig, absPath: string): Promise<ObsPushResult> {
  const video = isVideoPath(absPath);
  const targetName = video ? cfg.videoSourceName : cfg.imageSourceName;
  const otherName = video ? cfg.imageSourceName : cfg.videoSourceName;
  if (!cfg.url || !targetName) {
    return {
      ok: false,
      reason: video
        ? 'OBS integration is not configured for video files (WebSocket URL / video source name missing in Preferences -> Other).'
        : 'OBS integration is not configured for image files (WebSocket URL / image source name missing in Preferences -> Other).',
    };
  }
  try {
    await ensureConnected(cfg);
    const kind = video ? 'ffmpeg_source' : 'image_source';
    const settings = video ? { local_file: absPath, is_local_file: true } : { file: absPath };
    const sceneName = await ensureInputExists(targetName, kind, settings);
    await request('SetInputSettings', { inputName: targetName, inputSettings: settings, overlay: true });
    if (video) {
      await request('TriggerMediaInputAction', {
        inputName: targetName,
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      });
    }
    // Show the active source, hide the inactive one. Best-effort: a scene
    // item that isn't in this scene, or an unconfigured `otherName`, must
    // never fail the push — the file is already showing correctly either way.
    try { await setSceneItemVisible(sceneName, targetName, true); } catch { /* non-fatal */ }
    if (otherName) {
      try { await setSceneItemVisible(sceneName, otherName, false); } catch { /* non-fatal */ }
    }
    armIdleTimer();
    return { ok: true };
  } catch (e: any) {
    resetConnectionState();
    return { ok: false, reason: e?.message || String(e) };
  }
}
