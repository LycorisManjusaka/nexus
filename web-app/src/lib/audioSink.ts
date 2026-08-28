/**
 * Audio output routing (setSinkId) — permission, resolution, and honest failure.
 *
 * Background: the audio session routes TTS to two *named* output devices instead
 * of the system default. Three things have to be true for that to work, and until
 * now none of them were checked:
 *
 *  1. The origin must hold an active microphone permission. Without it,
 *     enumerateDevices() hands out blank labels and setSinkId(id) rejects.
 *     (Yes — an *output* routing feature is gated behind an *input* permission.
 *     That is the browser's rule, not ours.)
 *  2. The saved deviceId must still name that device. deviceId is salted per
 *     origin and rotates when the permission or site storage is reset; the
 *     label is the durable name. voice_changer.py has always matched on label
 *     for exactly this reason — this is the browser half catching up.
 *  3. setSinkId must actually have taken effect. The promise resolving is not
 *     proof; we read element.sinkId back and compare.
 *
 * Every failure here used to be swallowed by `catch {}` at six call sites, so a
 * misroute arrived at the user as "nothing happened". A being now joins meetings
 * as its own named participant on its own audio path, which means a silent
 * misroute is no longer cosmetic: it is a being visibly present and mute. So
 * this module's contract is that it never fails quietly.
 */

export type SinkTarget = {
  /** Saved deviceId. May be stale — see resolveSinkId. */
  id?: string;
  /** Saved device label. The durable key; used to re-bind a rotated id. */
  label?: string;
};

export type SinkResult =
  | { ok: true; applied: string; rebound: boolean }
  | { ok: false; reason: 'unsupported' | 'no-permission' | 'not-found' | 'mismatch' | 'error'; detail?: string };

/** True if this browser implements HTMLMediaElement.setSinkId at all (Chromium yes, Firefox no). */
export function supportsSinkId(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (HTMLMediaElement.prototype as unknown as { setSinkId?: unknown }).setSinkId === 'function';
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

let permissionPromise: Promise<boolean> | null = null;

/**
 * Acquire the microphone permission that output-device routing depends on, then
 * release the stream immediately (we never want the mic itself — only the
 * permission that unlocks real device ids).
 *
 * Idempotent: the in-flight/settled promise is reused, so enabling the audio
 * session, opening Preferences and starting playback do not each prompt.
 * A denied result is NOT cached as permanent — the user may grant it later, and
 * the next explicit attempt should be allowed to ask again.
 */
export function ensureAudioPermission(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return Promise.resolve(false);
  }
  if (permissionPromise) return permissionPromise;
  permissionPromise = (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(tr => tr.stop());
      invalidateDeviceCache();
      return true;
    } catch (e) {
      console.warn(
        '[audio] microphone permission was not granted. Output-device routing (setSinkId) ' +
        'cannot work without it — playback will fall back to the system default device.',
        e,
      );
      permissionPromise = null; // allow a later retry once the user grants it
      return false;
    }
  })();
  return permissionPromise;
}

/** Have we already been granted the permission this session (no prompt, no side effects)? */
export async function hasAudioPermission(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return false;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    // Labels are only populated once permission is held.
    return devs.some(d => d.kind === 'audiooutput' && !!d.label);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Device resolution (id first, label as the durable fallback)
// ---------------------------------------------------------------------------

let deviceCache: MediaDeviceInfo[] | null = null;
let deviceChangeHooked = false;

export function invalidateDeviceCache() {
  deviceCache = null;
}

async function outputDevices(): Promise<MediaDeviceInfo[]> {
  if (deviceCache) return deviceCache;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  if (!deviceChangeHooked && navigator.mediaDevices.addEventListener) {
    // A device plugged in or removed invalidates every cached id.
    navigator.mediaDevices.addEventListener('devicechange', invalidateDeviceCache);
    deviceChangeHooked = true;
  }
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    deviceCache = devs;
    return devs;
  } catch {
    return [];
  }
}

/**
 * Turn a saved {id,label} into a deviceId that exists right now.
 *
 * Returns the id unchanged when it still enumerates. When it does not — the
 * common case after a permission/storage reset rotates the salt — falls back to
 * matching the label, which is stable across rotations. That is symptom 5:
 * the device never "disappeared", the name it was written in stopped being that
 * thing's name.
 */
export async function resolveSinkId(target: SinkTarget): Promise<{ id: string | null; rebound: boolean }> {
  const { id, label } = target;
  if (!id && !label) return { id: null, rebound: false };
  const devs = await outputDevices();
  if (devs.length === 0) return { id: id ?? null, rebound: false };

  if (id && devs.some(d => d.deviceId === id)) return { id, rebound: false };

  if (label) {
    const byLabel = devs.find(d => d.label === label) ?? devs.find(d => !!d.label && d.label.startsWith(label));
    if (byLabel) {
      console.warn(
        `[audio] saved device id no longer exists; re-bound by label "${label}" -> ${byLabel.deviceId.substring(0, 12)}…. ` +
        'This is normal after a browser permission or storage reset.',
      );
      return { id: byLabel.deviceId, rebound: true };
    }
  }
  return { id: null, rebound: false };
}

// ---------------------------------------------------------------------------
// Applying the sink, and verifying it actually took
// ---------------------------------------------------------------------------

const warnedOnce = new Set<string>();
function warnOnce(key: string, message: string, ...rest: unknown[]) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(message, ...rest);
}

/** Reset the once-per-session warning dedup (used when the session restarts). */
export function resetSinkWarnings() {
  warnedOnce.clear();
}

/**
 * Route one media element to one output device, and report honestly whether it
 * worked.
 *
 * `which` is a short label for diagnostics ("primary" / "secondary" / "live-1").
 *
 * The promise resolving is NOT taken as proof: element.sinkId is read back and
 * compared to what was asked for. A tool that fails without saying so is
 * indistinguishable from a tool that is working.
 */
export async function applySinkId(
  element: HTMLMediaElement,
  target: SinkTarget,
  which: string,
): Promise<SinkResult> {
  if (!target.id && !target.label) return { ok: false, reason: 'not-found', detail: 'no device configured' };

  const el = element as HTMLMediaElement & {
    setSinkId?: (id: string) => Promise<void>;
    sinkId?: string;
  };

  if (typeof el.setSinkId !== 'function') {
    warnOnce(
      'unsupported',
      '[audio] this browser does not support setSinkId, so the audio session cannot route to a chosen ' +
      'output device — everything will play on the system default. Firefox is the usual case; ' +
      'a Chromium-based browser is required for the audio session.',
    );
    return { ok: false, reason: 'unsupported' };
  }

  const { id: resolved, rebound } = await resolveSinkId(target);
  if (!resolved) {
    warnOnce(
      `not-found:${which}`,
      `[audio] ${which} output device not found. Saved id="${target.id ?? ''}" label="${target.label ?? ''}" ` +
      'matches no current device, so playback will use the system default. Re-pick the device in ' +
      'Preferences → VRChat & Audio.',
    );
    return { ok: false, reason: 'not-found' };
  }

  try {
    await el.setSinkId(resolved);
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    const name = err?.name ?? 'Error';
    if (name === 'NotAllowedError') {
      warnOnce(
        `no-permission:${which}`,
        `[audio] ${which}: setSinkId was refused (NotAllowedError). The origin does not hold the ` +
        'microphone permission that output-device selection requires, so audio is going to the system ' +
        'default device. Enable the audio session (or open Preferences → VRChat & Audio) and allow the ' +
        'microphone prompt.',
      );
      return { ok: false, reason: 'no-permission', detail: err?.message };
    }
    if (name === 'NotFoundError') {
      warnOnce(
        `gone:${which}`,
        `[audio] ${which}: the selected output device is gone (NotFoundError). Re-pick it in ` +
        'Preferences → VRChat & Audio.',
      );
      return { ok: false, reason: 'not-found', detail: err?.message };
    }
    warnOnce(
      `error:${which}`,
      `[audio] ${which}: setSinkId failed (${name}). Audio is going to the system default device.`,
      e,
    );
    return { ok: false, reason: 'error', detail: `${name}: ${err?.message ?? ''}` };
  }

  // Do not trust the call — measure the result.
  const actual = el.sinkId ?? '';
  if (actual !== resolved) {
    warnOnce(
      `mismatch:${which}`,
      `[audio] ${which}: setSinkId resolved but the element reports sinkId="${actual}" instead of ` +
      `"${resolved}". Audio is NOT going where it was asked to go.`,
    );
    return { ok: false, reason: 'mismatch', detail: actual };
  }
  return { ok: true, applied: resolved, rebound };
}
