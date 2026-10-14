"use client";

import React from 'react';
import { TTS_ENGINES } from '@/lib/ttsEngineCatalog';
import { useT } from '@/lib/i18n';

// Live TTS pipeline indicator, and the store that feeds it.
//
// WHY THE STORE EXISTS (measured, 2026-10-09): the synthesis pipeline pushes a
// status update 5-7 times per spoken phrase (dispatch, request start, request
// done, slot filled, playback start, playback end). While that status lived in
// ChatArea's useState, every one of those pushes re-rendered the WHOLE message
// list. With 400 messages that cost ~700 ms of blocked main thread per push
// before the markdown memo and ~70 ms after — i.e. hundreds of milliseconds of
// silence BETWEEN phrases, growing with conversation length. Exactly the
// reported symptom: "one phrase sounds fine, the gaps get longer".
//
// Now the detail lives outside React's tree and only this component subscribes,
// so a status push re-renders this one bar and nothing else. ChatArea keeps a
// single boolean (is the bar on screen) because two LAYOUT decisions read it,
// and that flips twice per playback rather than 5-7 times per phrase.
//
// Engine labels come from the shared catalog rather than a fourth copy of
// the same three-entry map: this bar names the engine in a diagnostic, and a
// bar that says "Coeiroink" while Russian audio plays is worse than one that
// says nothing.
const TTS_ENGINE_NAMES: Record<number, string> = Object.fromEntries(
  TTS_ENGINES.map(e => [e.num, e.label])
);

export type TtsStatusStore = {
  get: () => any;
  publish: (s: any) => void;
  subscribe: (fn: () => void) => () => void;
};

// One store per ChatArea instance (held in a ref, so the identity is stable).
// Deliberately NOT module-level: a module singleton would survive a
// conversation switch and leak the previous reading into the next one.
export function createTtsStatusStore(): TtsStatusStore {
  let value: any = null;
  const listeners = new Set<() => void>();
  return {
    // useSyncExternalStore requires a cached snapshot: returning a fresh object
    // here would loop forever. The publisher already hands us a new object per
    // push, so holding the reference is both correct and enough.
    get: () => value,
    publish: (s: any) => {
      if (value === s) return;
      value = s;
      for (const fn of listeners) fn();
    },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}

export default function TtsStatusBar(
  { store, ownRow, onDismiss }: { store: TtsStatusStore; ownRow: boolean; onDismiss: () => void },
) {
  const t = useT();
  const ttsStatus = React.useSyncExternalStore(store.subscribe, store.get, store.get);
  // The visibility gate is ChatArea's (it drives the layout rows); this guard
  // only covers the gap between a publish(null) and ChatArea's re-render.
  if (!ttsStatus) return null;

  return (
    <div className={ownRow
      ? 'flex items-center gap-2 min-w-0 flex-1'
      : 'absolute left-6 top-0 -translate-y-1/2 z-10 flex items-center gap-2 pointer-events-auto max-w-[52%]'}>
      <div
        className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] backdrop-blur-sm ${
          ttsStatus.failed > 0
            ? 'border-red-500/50 bg-red-500/10 text-red-500'
            : ttsStatus.engineState === 'launched'
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-500'
              : 'border-border/50 bg-background/60 text-muted-foreground'
        }`}
        title={ttsStatus.lastError
          ? t('chat.tts.lastError').replace('{error}', ttsStatus.lastError)
          : t('chat.tts.state')}
      >
        <span>{ttsStatus.active ? '🔊' : '⚠️'}</span>
        <span className="font-semibold">{TTS_ENGINE_NAMES[ttsStatus.engine] || 'TTS'}</span>
        <span className="opacity-70">
          {ttsStatus.engineState === 'launched' ? t('chat.tts.starting')
            : ttsStatus.engineState === 'failed' ? t('chat.tts.notRunning')
            : ttsStatus.engineState === 'running' ? t('chat.tts.up')
            : '…'}
        </span>
        <span className="opacity-50">·</span>
        <span>{ttsStatus.mode === 'context' ? t('chat.tts.modeContext') : t('chat.tts.modeSentence')}</span>
        <span className="opacity-50">·</span>
        {/* done / dispatched, so "3/7" reads as "3 of 7 chunks ready" */}
        <span>{t('chat.tts.chunk')} {ttsStatus.done}/{ttsStatus.dispatched}</span>
        {ttsStatus.playing !== null && ttsStatus.playing >= 0 && (
          <><span className="opacity-50">·</span><span>▶ #{ttsStatus.playing}</span></>
        )}
        {ttsStatus.inFlight > 0 && (
          <><span className="opacity-50">·</span><span className="animate-pulse">{t('chat.tts.synth')} {ttsStatus.inFlight}</span></>
        )}
        {ttsStatus.buffered > 0 && (
          <><span className="opacity-50">·</span><span>{t('chat.tts.queued')} {ttsStatus.buffered}</span></>
        )}
        {ttsStatus.lastChars > 0 && (
          <><span className="opacity-50">·</span><span>{ttsStatus.lastChars}ch</span></>
        )}
        {ttsStatus.lastMs > 0 && (
          <><span className="opacity-50">·</span><span>{ttsStatus.lastMs}ms</span></>
        )}
        {ttsStatus.skipped > 0 && (
          <><span className="opacity-50">·</span><span>{t('chat.tts.skipped')} {ttsStatus.skipped}</span></>
        )}
        {ttsStatus.failed > 0 && (
          <><span className="opacity-50">·</span><span className="font-semibold">{t('chat.tts.failed')} {ttsStatus.failed}</span></>
        )}
        {!ttsStatus.active && ttsStatus.failed > 0 && (
          <button
            onClick={onDismiss}
            className="ml-1 opacity-60 hover:opacity-100"
            title={t('chat.tts.dismiss')}
          >✕</button>
        )}
      </div>
      {ttsStatus.lastError && (
        <span className="truncate text-[10px] text-red-400/90" title={ttsStatus.lastError}>
          {ttsStatus.lastError}
        </span>
      )}
    </div>
  );
}
