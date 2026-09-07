/**
 * obsCamera — push the resolved camera file into an OBS Studio "Media Source"
 * (ffmpeg_source, the one OBS source type that plays both stills and video)
 * over obs-websocket v5, so the being's live state shows up on whatever OBS
 * is feeding (its virtual camera into Teams, a capture card, etc).
 *
 * Hand-rolled against the v5 protocol (Hello/Identify/Request-Response)
 * instead of pulling in obs-websocket-js: Node 24 ships a native WebSocket
 * global (verified at the DOM-typed interface this file uses), and the
 * protocol itself is four small JSON message shapes — the same "raw protocol
 * over SDK" call already made for the Kimi/MiMo Anthropic-compat adapter.
 * Zero new dependencies.
 *
 * Best-effort only, by design. OBS may not be running, the source name may
 * not exist yet, the password may be wrong — none of that may ever break the
 * in-app camera panel, which resolves and renders the same file completely
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

export interface ObsConfig {
  /** e.g. "ws://127.0.0.1:4455" — OBS's WebSocket server address. */
  url: string;
  /** Empty/undefined if OBS has "Enable Authentication" unchecked. */
  password?: string;
  /** Name of the Media Source in OBS's current scene to push files into. */
  sourceName: string;
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

/**
 * Point the configured Media Source at `absPath` and (re)start playback.
 * TriggerMediaInputAction is harmless to send for a still image — OBS simply
 * has nothing to restart — so callers never need to know the file's kind.
 */
export async function pushCameraFile(cfg: ObsConfig, absPath: string): Promise<ObsPushResult> {
  if (!cfg.url || !cfg.sourceName) {
    return { ok: false, reason: 'OBS integration is not configured (WebSocket URL / source name missing in Preferences -> Other).' };
  }
  try {
    await ensureConnected(cfg);
    await request('SetInputSettings', {
      inputName: cfg.sourceName,
      inputSettings: { local_file: absPath, is_local_file: true },
      overlay: true,
    });
    await request('TriggerMediaInputAction', {
      inputName: cfg.sourceName,
      mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    });
    armIdleTimer();
    return { ok: true };
  } catch (e: any) {
    resetConnectionState();
    return { ok: false, reason: e?.message || String(e) };
  }
}
