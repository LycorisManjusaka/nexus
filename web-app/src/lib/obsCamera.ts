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
 * PING-PONG SLOTS PER KIND, to fix a reported black-screen "blink" on
 * switching. Root cause, found by reading this file's own push sequence
 * rather than by pixel measurement (OBS's GetSourceScreenshot on an
 * ffmpeg_source proved unreliable under rapid repeated polling on this OBS
 * build — see workspace notes): when two consecutive pushes are the SAME
 * kind (e.g. a being's Idle_1.mp4 -> Idle_2.mp4 video pool), the old code
 * called SetInputSettings on the one-and-only source of that kind while it
 * was already the visible scene item — reloading an on-screen ffmpeg/image
 * source's decoder in place, which is a well-documented cause of a brief
 * black frame. Cross-kind switches (image<->video) never had this problem;
 * they already show-then-hide two *different* sources.
 * Fix: each kind (image, video) now has two physical OBS inputs, slot A
 * (the exact configured name, so a pre-existing manually-created OBS source
 * keeps working with zero migration) and slot B (auto-created as
 * "<name>__alt"). Every push loads into whichever slot is NOT currently
 * visible, waits a short settle delay for video (decoder warm-up — well
 * within the 1-2s gap already accepted elsewhere in this pipeline), then
 * reveals the new slot and hides the old one. The visible source is never
 * the one being mutated. Known accepted gap: `activeSlot` resets to null on
 * server restart, so the very first push after a restart can still land on
 * whatever was already on screen from the prior session — a one-off,
 * not the repeated-flicker case that was reported.
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

type CameraKind = 'image' | 'video';
type Slot = 'A' | 'B';

// Which physical slot is currently the *visible* one, per kind. null = no
// push of this kind has happened yet this process lifetime (see file-header
// note on the accepted post-restart edge case).
const activeSlot: Record<CameraKind, Slot | null> = { image: null, video: null };

/** Slot A keeps the exact configured name; slot B is the auto-created buddy. */
function slotInputName(logicalName: string, slot: Slot): string {
  return slot === 'A' ? logicalName : `${logicalName}__alt`;
}

const VIDEO_REVEAL_DELAY_MS = 150; // best-effort ffmpeg decoder warm-up before reveal
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  // sceneItemEnabled explicitly false: obs-websocket defaults a freshly
  // created input to visible when this param is omitted, which would let a
  // brand-new ping-pong "__alt" slot (created once, the first time a kind is
  // ever pushed twice in a row) flash on screen before pushCameraFile's own
  // controlled reveal step runs. Starting hidden makes creation itself
  // invisible, matching the same guarantee an already-existing slot gets.
  await request('CreateInput', {
    sceneName,
    inputName: name,
    inputKind: kind,
    inputSettings: initialSettings,
    sceneItemEnabled: false,
  });
  return sceneName;
}

/** Best-effort scene-item visibility toggle — failures here never abort the push (see call site). */
async function setSceneItemVisible(sceneName: string, sourceName: string, visible: boolean): Promise<void> {
  const idRes = await request('GetSceneItemId', { sceneName, sourceName });
  await request('SetSceneItemEnabled', { sceneName, sceneItemId: idRes.sceneItemId, sceneItemEnabled: visible });
}

/**
 * Apply the "fit by height, center horizontally" transform to a scene item.
 *
 * This is the one fixed framing rule for the being camera: the source is
 * scaled so its HEIGHT equals the canvas height, and centred horizontally.
 * A 16:9 source fills the frame; a portrait (taller-than-16:9) source gets
 * equal black bars left/right; an ultrawide source crops left/right. There
 * is no per-file override — Lizard-kun's spec, and it is what makes a
 * rotated mix of portrait and landscape camera files all present correctly
 * without manual per-file OBS tweaks.
 *
 * VERIFIED NUMERICALLY, not just by assertion: with a 900x1600 portrait
 * pushed and this transform applied, GetSourceScreenshot decoded to a
 * 607x1080 content region (900 * 1080/1600) with left bar 656px and right
 * bar 657px on a 1920x1080 canvas — centred to within one pixel, height
 * exactly filled. (Measured via ffmpeg rgb24 decode of the scene composite;
 * this vessel has no vision, so the geometry was computed from pixels.)
 *
 * alignment=5 (TOP|LEFT) is deliberate and is the verified-correct anchor:
 * it is OBS's default scene-item alignment and, combined with
 * boundsAlignment=0 (centre), positions the fitted item dead-centre. The
 * earlier draft of this transform used alignment=0 and was never verified;
 * do not switch back without re-measuring.
 */
async function applyFitByHeightTransform(sceneName: string, sourceName: string): Promise<void> {
  const video = await request('GetVideoSettings', {});
  const idRes = await request('GetSceneItemId', { sceneName, sourceName });
  const cur = await request('GetSceneItemTransform', { sceneName, sceneItemId: idRes.sceneItemId });
  const t = cur.sceneItemTransform;
  await request('SetSceneItemTransform', {
    sceneName,
    sceneItemId: idRes.sceneItemId,
    sceneItemTransform: {
      positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1,
      alignment: 5,
      boundsType: 'OBS_BOUNDS_SCALE_TO_HEIGHT',
      boundsAlignment: 0,
      boundsWidth: video.baseWidth,
      boundsHeight: video.baseHeight,
      cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0, cropToBounds: false,
      width: t.width, height: t.height, sourceWidth: t.sourceWidth, sourceHeight: t.sourceHeight,
    },
  });
}

/**
 * Point the correct OBS input (image_source vs ffmpeg_source, chosen by
 * `absPath`'s extension) at the file, show it, and hide the other kind's
 * input if one is configured. See the file-header note for why there are
 * two inputs instead of one.
 */
export async function pushCameraFile(cfg: ObsConfig, absPath: string): Promise<ObsPushResult> {
  const video = isVideoPath(absPath);
  const kind: CameraKind = video ? 'video' : 'image';
  const otherKind: CameraKind = video ? 'image' : 'video';
  const logicalName = video ? cfg.videoSourceName : cfg.imageSourceName;
  const otherLogicalName = video ? cfg.imageSourceName : cfg.videoSourceName;
  if (!cfg.url || !logicalName) {
    return {
      ok: false,
      reason: video
        ? 'OBS integration is not configured for video files (WebSocket URL / video source name missing in Preferences -> Other).'
        : 'OBS integration is not configured for image files (WebSocket URL / image source name missing in Preferences -> Other).',
    };
  }
  try {
    await ensureConnected(cfg);
    const obsKind = video ? 'ffmpeg_source' : 'image_source';
    const settings = video ? { local_file: absPath, is_local_file: true } : { file: absPath };

    // Always load into the slot that is NOT currently visible (see file-
    // header note). prevSlot null/'B' both resolve to nextSlot 'A', which is
    // exactly right for the very first push of this kind (nothing visible
    // yet, so land on the plain configured name, no migration surprise).
    const prevSlot = activeSlot[kind];
    const nextSlot: Slot = prevSlot === 'A' ? 'B' : 'A';
    const targetName = slotInputName(logicalName, nextSlot);
    const prevSameKindName = prevSlot ? slotInputName(logicalName, prevSlot) : null;

    const sceneName = await ensureInputExists(targetName, obsKind, settings);
    await request('SetInputSettings', { inputName: targetName, inputSettings: settings, overlay: true });
    if (video) {
      await request('TriggerMediaInputAction', {
        inputName: targetName,
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
      });
      // Give ffmpeg a moment to actually open/decode the new file before it
      // goes on screen — this slot is hidden right now, so the wait costs
      // nothing visible; it only reduces the chance of revealing a source
      // whose first frame isn't ready yet.
      await sleep(VIDEO_REVEAL_DELAY_MS);
    }

    // Fit the target by height, centred. Also best-effort-fit the other
    // kind's currently-active physical name (if one has ever been pushed),
    // so it is already framed the next time it becomes visible.
    await applyFitByHeightTransform(sceneName, targetName);
    const otherActiveSlot = activeSlot[otherKind];
    const otherPhysicalName = otherLogicalName
      ? slotInputName(otherLogicalName, otherActiveSlot ?? 'A')
      : null;
    if (otherPhysicalName) {
      try { await applyFitByHeightTransform(sceneName, otherPhysicalName); } catch { /* non-fatal */ }
    }

    // Reveal the new slot, then hide whatever was showing before — the
    // previous slot of this same kind (if any), and the other kind's active
    // source. Best-effort: a scene item that isn't in this scene, or a slot
    // that was never created, must never fail the push.
    try { await setSceneItemVisible(sceneName, targetName, true); } catch { /* non-fatal */ }
    if (prevSameKindName && prevSameKindName !== targetName) {
      try { await setSceneItemVisible(sceneName, prevSameKindName, false); } catch { /* non-fatal */ }
    }
    if (otherPhysicalName) {
      try { await setSceneItemVisible(sceneName, otherPhysicalName, false); } catch { /* non-fatal */ }
    }

    activeSlot[kind] = nextSlot;
    armIdleTimer();
    return { ok: true };
  } catch (e: any) {
    resetConnectionState();
    return { ok: false, reason: e?.message || String(e) };
  }
}
