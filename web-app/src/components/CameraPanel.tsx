"use client";

// CameraPanel — the being's "avatar camera": a right-side GUI panel that
// mirrors whatever asset best matches the being's current activity, and
// (best-effort, independently) pushes the same file into an OBS Studio Media
// Source over obs-websocket (see src/lib/obsCamera.ts) so it shows up on the
// "Camera" checkbox output the user described. The two are deliberately
// decoupled: this panel renders from local state + a manifest fetch, and
// never waits on or depends on whether the OBS push succeeds.
//
// State resolution itself (which filename wins for a given CameraSignal) is
// shared, pure logic in src/lib/cameraTypes.ts (pickResolvedState) — this
// component only owns the PLAYBACK machine on top of that: pool cycling for
// videos, one-shot transition clips between states, and graceful fallback
// when no transition (or no asset at all) exists for a given jump.
//
// Deliberately un-eager about interrupting itself: a signal change is only
// acted on immediately if it changes the RESOLVED TARGET STATE. Reassigning
// `currentFile` (via the `key={currentFile}` on the <video>) is what aborts
// an in-flight transition clip early if the target changes again mid-flight;
// letting an already-settled state's clip keep looping/cycling is what stops
// the panel from re-triggering the same transition on every ChatArea render.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cameraFileKind, pickResolvedState, type CameraManifest, type CameraSignal } from '@/lib/cameraTypes';
import { useT } from '@/lib/i18n';

interface CameraPanelProps {
  folderName: string;
  enabled: boolean;
  signal: CameraSignal;
}

function randomPick<T>(arr: T[], exclude?: T): T {
  if (arr.length <= 1) return arr[0];
  const pool = exclude !== undefined ? arr.filter(x => x !== exclude) : arr;
  const from = pool.length > 0 ? pool : arr;
  return from[Math.floor(Math.random() * from.length)];
}

const EMPTY_MANIFEST: CameraManifest = { states: {}, transitions: {} };

export default function CameraPanel({ folderName, enabled, signal }: CameraPanelProps) {
  const t = useT();
  const [manifest, setManifest] = useState<CameraManifest | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [loopCurrent, setLoopCurrent] = useState(false);

  // Mirrors of the state above, readable synchronously from inside callbacks
  // (onEnded, the manifest fetch) without falling prey to stale closures —
  // the same pattern ChatArea's own SSE handlers use for exactly this reason.
  const manifestRef = useRef<CameraManifest | null>(null);
  const currentFileRef = useRef<string | null>(null);
  const settledStateRef = useRef<string | null>(null);
  const transitioningRef = useRef(false);
  const pendingTargetRef = useRef<string | null>(null);

  const pushToObs = useCallback((file: string) => {
    if (!folderName || !file) return;
    fetch('/api/camera/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folderName, file }),
    }).catch(() => { /* best-effort — the panel already rendered its own copy */ });
  }, [folderName]);

  const showFile = useCallback((file: string, loop: boolean) => {
    currentFileRef.current = file;
    setCurrentFile(file);
    setLoopCurrent(loop);
    pushToObs(file);
  }, [pushToObs]);

  const clearFile = useCallback(() => {
    currentFileRef.current = null;
    setCurrentFile(null);
    setLoopCurrent(false);
  }, []);

  // Land on `state`'s own pool: pick one entry and display it. Terminal step
  // of every resolution path — a direct jump (no transition asset available)
  // or the settle-in after a transition clip finishes. A single-video pool
  // is set to loop so it doesn't need an onEnded round-trip just to replay
  // itself; a multi-video pool plays once and cycles via handleEnded below.
  const settleIntoState = useCallback((state: string) => {
    const pool = manifestRef.current?.states[state];
    settledStateRef.current = state;
    transitioningRef.current = false;
    if (!pool || pool.length === 0) { clearFile(); return; }
    const file = randomPick(pool);
    showFile(file, cameraFileKind(file) === 'video' && pool.length === 1);
  }, [showFile, clearFile]);

  // Re-resolve against the manifest + the latest signal. Called whenever the
  // manifest or signal changes, and again from handleEnded once a transition
  // clip finishes (re-resolving there, rather than trusting the target
  // computed when the clip started, is what lets a signal that changed AGAIN
  // mid-clip take effect without ever aborting a clip that's already playing).
  const evaluate = useCallback(() => {
    const m = manifestRef.current;
    if (!m) return;
    const target = pickResolvedState(m, signal);
    if (!target) { settledStateRef.current = null; transitioningRef.current = false; clearFile(); return; }

    const from = settledStateRef.current;
    if (from === target) {
      // Either already fully settled here (pool cycling, if any, is handled
      // entirely by handleEnded — nothing to do), or already mid-transition
      // toward exactly this target — let that clip finish naturally.
      return;
    }

    const transKey = from ? `${from}->${target}` : null;
    const transPool = transKey ? m.transitions[transKey] : undefined;
    if (transPool && transPool.length > 0) {
      transitioningRef.current = true;
      pendingTargetRef.current = target;
      // Transition clips never loop — they MUST fire onEnded so evaluate()
      // can settle (or redirect, if the signal moved again) once they finish.
      // Setting a new currentFile here also remounts the <video> (key=file),
      // which is what aborts a DIFFERENT in-flight transition clip early if
      // the target changed again before the previous one finished.
      showFile(randomPick(transPool), false);
    } else {
      // No transition asset for this exact jump — "even a simple fallback
      // should work": just cut straight to the destination state's own file.
      settleIntoState(target);
    }
  }, [signal, showFile, settleIntoState, clearFile]);

  // Load (or clear) the manifest whenever the being or the enabled flag
  // changes. Missing/empty camera/ folder resolves to an empty manifest, not
  // an error — the panel then just shows its "nothing here yet" placeholder.
  useEffect(() => {
    if (!enabled || !folderName) {
      manifestRef.current = null;
      setManifest(null);
      return;
    }
    let cancelled = false;
    (async () => {
      let m: CameraManifest = EMPTY_MANIFEST;
      try {
        const r = await fetch(`/api/camera-files?folder=${encodeURIComponent(folderName)}`);
        const d = await r.json();
        if (d?.manifest) m = d.manifest;
      } catch {
        // network hiccup — empty manifest, same as "no camera/ folder yet".
      }
      if (!cancelled) {
        manifestRef.current = m;
        setManifest(m);
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, folderName]);

  // Switching beings: a file from the PREVIOUS being's camera/ folder must
  // never linger on screen once a different being is active.
  useEffect(() => {
    settledStateRef.current = null;
    transitioningRef.current = false;
    pendingTargetRef.current = null;
    clearFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderName]);

  useEffect(() => { evaluate(); }, [manifest, signal, evaluate]);

  const handleEnded = useCallback(() => {
    if (transitioningRef.current) {
      transitioningRef.current = false;
      const intended = pendingTargetRef.current;
      pendingTargetRef.current = null;
      // Re-resolve against the LATEST signal rather than blindly settling on
      // the state the clip was aimed at when it started — the signal may have
      // moved again while the transition played. This closes the old bug where
      // the code first assigned settledStateRef = pendingTargetRef and then
      // called evaluate(): evaluate saw from === target and returned early,
      // so settleIntoState(target) never ran and the loop=false transition
      // clip stayed parked on its last frame forever.
      const m = manifestRef.current;
      if (!m) {
        settledStateRef.current = null;
        clearFile();
        return;
      }
      const target = pickResolvedState(m, signal);
      if (!target) {
        settledStateRef.current = null;
        clearFile();
        return;
      }
      if (target === intended || target === settledStateRef.current) {
        // Still heading where we were going, or the signal reverted to the
        // state we were transitioning FROM — land on it directly (no loop).
        settleIntoState(target);
      } else {
        // Moved to a third state — evaluate() sees from(old) !== target(new)
        // and plays the right follow-on transition (or settles straight in).
        evaluate();
      }
      return;
    }
    // A multi-entry pool video finished — cycle to another random entry from
    // the SAME state's pool. (Single-entry video pools loop and never reach
    // here; images never fire onEnded at all.)
    const state = settledStateRef.current;
    const pool = state ? manifestRef.current?.states[state] : undefined;
    if (pool && pool.length > 0) {
      const next = randomPick(pool, currentFileRef.current || undefined);
      showFile(next, cameraFileKind(next) === 'video' && pool.length === 1);
    }
  }, [evaluate, showFile, settleIntoState, clearFile]);

  if (!enabled) return null;

  const kind = currentFile ? cameraFileKind(currentFile) : null;
  const src = currentFile && folderName
    ? `/api/camera-file?folder=${encodeURIComponent(folderName)}&file=${encodeURIComponent(currentFile)}`
    : null;

  return (
    <aside className="w-64 sm:w-72 h-full flex flex-col items-center justify-center bg-secondary/30 backdrop-blur-xl border-l border-border shadow-2xl z-10 shrink-0 overflow-hidden">
      {src ? (
        kind === 'video' ? (
          <video
            key={currentFile}
            src={src}
            autoPlay
            muted
            playsInline
            loop={loopCurrent}
            onEnded={handleEnded}
            className="max-w-full max-h-full object-contain"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={currentFile} src={src} alt="" className="max-w-full max-h-full object-contain" />
        )
      ) : (
        <p className="text-xs text-muted-foreground text-center px-4">{t('camera.empty')}</p>
      )}
    </aside>
  );
}
