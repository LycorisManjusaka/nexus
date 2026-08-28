"use client";

import React, { useEffect, useRef, useState } from 'react';
import { Radio, Square, AlertCircle } from 'lucide-react';
import { useT, renderRich } from '@/lib/i18n';
import { applySinkId } from '@/lib/audioSink';

// Voice selection moved to per-folder settings (Sidebar → Folder Settings →
// Live Session Voice). The voiceName prop is passed in by ChatArea from the
// active folder's settings.

interface DiscoveredModel {
  id: string;
  version: string;
  displayName?: string;
}

interface LiveSessionProps {
  open: boolean;
  onClose: () => void;
  onCommit: (messages: any[], images: any[]) => void;
  systemPrompt: string;
  seedMessages: any[];
  voiceName: string;             // comes from folder settings
  aiVoice?: { engine?: number; char_idx?: number; style_idx?: number; char_name?: string; style_name?: string; speed?: number };
  audioOutDevice1?: string;
  audioOutDevice2?: string;
  // Durable device names. deviceId is salted per origin and rotates when the
  // browser permission or site storage is reset; the label survives that and is
  // used to re-bind the id. See audioSink.ts.
  audioOutLabel1?: string;
  audioOutLabel2?: string;
}

export default function LiveSession({
  open, onClose, onCommit, systemPrompt, seedMessages, voiceName, aiVoice,
  audioOutDevice1, audioOutDevice2, audioOutLabel1, audioOutLabel2,
}: LiveSessionProps) {
  const t = useT();
  const [phase, setPhase] = useState<'config' | 'starting' | 'live' | 'stopping'>('config');
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [contextLimit, setContextLimit] = useState(20000);
  const [vrchatPath, setVrchatPath] = useState('C:\\Users\\user\\Pictures\\VRChat');
  const [transcript, setTranscript] = useState<{ role: string; text: string; ts: number }[]>([]);
  const [tokens, setTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');

  const esRef = useRef<EventSource | null>(null);
  const fallbackAudioRefs = useRef<HTMLAudioElement[]>([]);
  const fallbackAbortRef = useRef<AbortController | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Stop any in-flight fallback synthesis or playback (also called from handleStop)
  const stopFallbackTts = () => {
    if (fallbackAbortRef.current) {
      try { fallbackAbortRef.current.abort(); } catch {}
      fallbackAbortRef.current = null;
    }
    fallbackAudioRefs.current.forEach(a => { try { a.pause(); } catch {} });
    fallbackAudioRefs.current = [];
  };

  // Fallback: if Gemini returned text-only (common with 3.x at large context),
  // synthesize via the existing Voicevox/Coeiroink pipeline. Mirrors the
  // sentence-streaming pattern from MessageBubble — split on Japanese punctuation,
  // synthesize sentences one at a time, queue them up, and play in order so
  // the first sentence starts speaking before later ones are ready.
  const playLocalTtsFallback = async (text: string) => {
    if (!text || !text.trim()) return;

    // Stop anything already playing before starting a new fallback
    stopFallbackTts();

    const baseSeg = {
      engine: aiVoice?.engine ?? 0,
      char_idx: aiVoice?.char_idx ?? 0,
      style_idx: aiVoice?.style_idx ?? 0,
      char_name: aiVoice?.char_name,
      style_name: aiVoice?.style_name,
      speed: aiVoice?.speed ?? 1.0,
    };

    // Split into sentences using the same punctuation rules MessageBubble uses
    const sentences: { text: string }[] = [];
    const parts = text.split(/([。！？\n」]+)/);
    for (let i = 0; i < parts.length; i += 2) {
      const chunk = (parts[i] || '') + (parts[i + 1] || '');
      const trimmed = chunk.trim();
      if (trimmed) sentences.push({ text: trimmed });
    }
    if (sentences.length === 0) return;

    const ctrl = new AbortController();
    fallbackAbortRef.current = ctrl;
    const signal = ctrl.signal;

    const audioQueue: string[] = [];
    let isPlaying = false;
    let producedCount = 0;

    const playNext = async () => {
      if (signal.aborted) return;
      if (audioQueue.length === 0) {
        isPlaying = false;
        return;
      }
      isPlaying = true;
      const url = audioQueue.shift()!;

      // One HTMLAudioElement per device, played in parallel
      const a1 = new Audio(url);
      fallbackAudioRefs.current.push(a1);
      if (audioOutDevice1 || audioOutLabel1) {
        await applySinkId(a1, { id: audioOutDevice1, label: audioOutLabel1 }, 'live-primary');
      }
      let a2: HTMLAudioElement | null = null;
      if (audioOutDevice2 || audioOutLabel2) {
        a2 = new Audio(url);
        fallbackAudioRefs.current.push(a2);
        await applySinkId(a2, { id: audioOutDevice2, label: audioOutLabel2 }, 'live-secondary');
      }

      try {
        const p1 = a1.play();
        const p2 = a2 ? a2.play() : null;
        await p1;
        if (p2) await p2;
      } catch (e: any) {
        console.error('fallback play error:', e);
        URL.revokeObjectURL(url);
        playNext();
        return;
      }

      a1.onended = () => {
        URL.revokeObjectURL(url);
        // Remove these refs as they're done
        fallbackAudioRefs.current = fallbackAudioRefs.current.filter(x => x !== a1 && x !== a2);
        playNext();
      };
    };

    // Synthesize sentences sequentially. Each completed blob is enqueued and
    // playback kicks off as soon as the FIRST sentence is ready, while the
    // remaining ones are still being synthesized in parallel with playback.
    for (let i = 0; i < sentences.length; i++) {
      if (signal.aborted) break;
      try {
        const res = await fetch('/api/tts/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: [{ ...baseSeg, text: sentences[i].text }] }),
          signal,
        });
        if (!res.ok) continue;
        const blob = await res.blob();
        // Skip empty (0-byte) responses — phoneme-less segments return no body.
        if (blob.size === 0) continue;
        const url = URL.createObjectURL(blob);
        audioQueue.push(url);
        producedCount++;
        if (!isPlaying && !signal.aborted) playNext();
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error('fallback synth error:', e);
      }
    }
  };
  const audioQueueRef = useRef<{ ts: number; ended: boolean }>({ ts: 0, ended: true });
  // Two HTMLAudioElement is ill-suited for streaming PCM; we use Web Audio
  // and route via setSinkId on the destination via MediaStreamAudioDestination.
  const destinations = useRef<{ ctx: AudioContext; el1: HTMLAudioElement; el2: HTMLAudioElement } | null>(null);

  /* ---------- Audio playback infrastructure ---------- */
  // Gemini Live emits PCM 24kHz 16-bit mono base64-encoded chunks.
  // We decode each chunk into an AudioBuffer and schedule it on a continuous
  // timeline so utterances play smoothly. Output is forked to two HTMLAudioElement
  // via MediaStreamAudioDestinationNode (one per device, with setSinkId).
  const ensureAudio = async () => {
    if (destinations.current) return destinations.current;
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx({ sampleRate: 24000 });
    // Create two destinations and bind each to an <audio> element
    const dest1 = ctx.createMediaStreamDestination();
    const dest2 = ctx.createMediaStreamDestination();
    const el1 = new Audio();
    const el2 = new Audio();
    el1.srcObject = dest1.stream;
    el2.srcObject = dest2.stream;
    el1.autoplay = true;
    el2.autoplay = true;
    if (audioOutDevice1 || audioOutLabel1) {
      await applySinkId(el1, { id: audioOutDevice1, label: audioOutLabel1 }, 'live-stream-primary');
    }
    if (audioOutDevice2 || audioOutLabel2) {
      await applySinkId(el2, { id: audioOutDevice2, label: audioOutLabel2 }, 'live-stream-secondary');
    }
    document.body.appendChild(el1);
    document.body.appendChild(el2);
    el1.play().catch(() => {});
    el2.play().catch(() => {});
    // Splitter: feed any node connected to "splitter" to both destinations
    const splitter = ctx.createGain();
    splitter.connect(dest1);
    splitter.connect(dest2);
    (ctx as any)._nx_splitter = splitter;
    audioCtxRef.current = ctx;
    audioQueueRef.current = { ts: ctx.currentTime, ended: true };
    destinations.current = { ctx, el1, el2 };
    return destinations.current;
  };

  const enqueuePcm = async (b64: string, mime: string) => {
    const d = await ensureAudio();
    const ctx = d.ctx;
    const splitter: AudioNode = (ctx as any)._nx_splitter;
    // Decode base64 to Int16 PCM
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Parse rate from mime, fallback 24000
    let sampleRate = 24000;
    const m = /rate=(\d+)/i.exec(mime);
    if (m) sampleRate = parseInt(m[1]);
    // Convert Int16 → Float32
    const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const buf = ctx.createBuffer(1, f32.length, sampleRate);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(splitter);
    const startAt = Math.max(audioQueueRef.current.ts, ctx.currentTime);
    src.start(startAt);
    audioQueueRef.current.ts = startAt + buf.duration;
    audioQueueRef.current.ended = false;
  };

  /* ---------- Session lifecycle ---------- */
  const handleStart = async () => {
    setPhase('starting');
    setError(null);
    setTranscript([]);
    setTokens(0);
    try {
      // Touch AudioContext on user gesture so it can play later
      await ensureAudio();
      const chosen = discoveredModels.find(m => m.id === model);
      const apiVersion = chosen?.version || 'v1alpha';
      const r = await fetch('/api/live/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, apiVersion, voiceName, systemPrompt, seedMessages, contextLimit, vrchatPath }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || t('live.startFailed').replace('{status}', String(r.status)));
      }
      const es = new EventSource('/api/live/stream');
      esRef.current = es;
      es.onmessage = (ev) => {
        let data: any;
        try { data = JSON.parse(ev.data); } catch { return; }
        if (data.type === 'connected') return;
        if (data.type === 'starting') return; // WS opened, waiting for setupComplete
        if (data.type === 'ready') setPhase('live');
        if (data.type === 'closed') {
          // If we're still in 'starting' phase, this is an early close — show error and bail
          if (phase === 'starting') {
            setError(prev => prev || t('live.closedEarly'));
            setPhase('config');
          }
        }
        if (data.type === 'audio') enqueuePcm(data.data, data.mime || 'audio/pcm;rate=24000');
        if (data.type === 'transcript_delta') {
          setTranscript(prev => [...prev, { role: data.role, text: data.text, ts: Date.now() }]);
        }
        if (data.type === 'usage') setTokens(data.tokens);
        if (data.type === 'limit_reached') {
          setError(t('live.limitReached').replace('{limit}', String(data.limit)).replace('{tokens}', String(data.tokens)));
          handleStop();
        }
        if (data.type === 'no_audio_warning') {
          // Non-fatal — model produced text but no audio. Show a banner and
          // try local TTS so the user still hears the response in character.
          setError(data.message);
          if (data.text) playLocalTtsFallback(data.text);
        }
        if (data.type === 'error') setError(data.message);
      };
      es.onerror = () => { /* auto-reconnect; ignore */ };
    } catch (e: any) {
      setError(e.message);
      setPhase('config');
    }
  };

  const handleSendText = async () => {
    if (!textInput.trim()) return;
    // Renamed from `t`: the translation hook now owns that name in this scope.
    const txt = textInput.trim();
    setTextInput('');
    try {
      await fetch('/api/live/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: txt }),
      });
    } catch (e: any) { setError(e.message); }
  };

  const handleStop = async () => {
    setPhase('stopping');
    let stopOk = false;
    let messages: any[] = [];
    let images: any[] = [];
    try {
      esRef.current?.close();
      esRef.current = null;
      const r = await fetch('/api/live/stop', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        stopOk = true;
        messages = Array.isArray(data.messages) ? data.messages : [];
        images = Array.isArray(data.images) ? data.images : [];
        if (data.mergeError) setError(t('live.mergeFailed').replace('{error}', String(data.mergeError)));
      } else {
        setError(data.error || t('live.stopFailed').replace('{status}', String(r.status)));
      }
    } catch (e: any) {
      setError(t('live.stopErrored').replace('{error}', e.message));
    }

    // Always tear down audio resources
    if (destinations.current) {
      try { destinations.current.ctx.close(); } catch {}
      try { destinations.current.el1.remove(); } catch {}
      try { destinations.current.el2.remove(); } catch {}
      destinations.current = null;
    }
    // Stop any fallback TTS — cancels in-flight synth requests AND playing audio
    stopFallbackTts();

    if (stopOk) {
      // Commit if we captured ANYTHING — text messages OR images.
      if (messages.length > 0 || images.length > 0) {
        onCommit(messages, images);
      } else {
        // Surface a warning to the user instead of silently dismissing.
        setError(t('live.nothingCaptured'));
        // Stay in config phase so the user sees the error before deciding to close.
        setPhase('config');
        return;
      }
      setPhase('config');
      onClose();
    } else {
      // Leave the modal open with the error visible — the user can press Stop
      // again to retry, or close manually. The next /api/live/start will
      // force-clean any orphan server state regardless.
      setPhase('live');
    }
  };

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  // Discover Live-capable models on the user's API key when the modal opens
  const discoverModels = async () => {
    setDiscoveryError(null);
    try {
      const r = await fetch('/api/live/models');
      const data = await r.json();
      if (!r.ok) {
        setDiscoveryError(data.error || `HTTP ${r.status}`);
        setDiscoveredModels([]);
        return;
      }
      const list: DiscoveredModel[] = data.models || [];
      setDiscoveredModels(list);
      if (list.length > 0 && !model) setModel(list[0].id);
      if (list.length === 0) {
        setDiscoveryError(t('live.noModelsHelp'));
      }
    } catch (e: any) {
      setDiscoveryError(e.message);
    }
  };
  useEffect(() => {
    if (open && phase === 'config' && discoveredModels.length === 0 && !discoveryError) {
      discoverModels();
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={phase === 'config' ? onClose : undefined}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio size={18} className={phase === 'live' ? 'text-red-500 animate-pulse' : 'text-muted-foreground'} />
            <h3 className="font-semibold text-lg">{t('live.title')}</h3>
            {phase === 'live' && <span className="text-xs text-muted-foreground">{t('live.tokens').replace('{used}', tokens.toLocaleString()).replace('{limit}', contextLimit.toLocaleString())}</span>}
          </div>
          {phase === 'config' && <button onClick={onClose} className="text-muted-foreground hover:text-foreground">×</button>}
        </div>

        {error && (
          <div className="mx-6 mt-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/40 text-red-500 text-sm flex items-center gap-2">
            <AlertCircle size={14} /> {error}
          </div>
        )}

        {phase === 'config' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted-foreground">{t('live.model')}</label>
                <button onClick={discoverModels} className="text-[10px] text-indigo-500 hover:underline" type="button">{t('live.refresh')}</button>
              </div>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={discoveredModels.length === 0}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm disabled:opacity-50"
              >
                {discoveredModels.length === 0 && <option value="">{t('live.noModels')}</option>}
                {discoveredModels.map(m => (
                  <option key={`${m.version}/${m.id}`} value={m.id}>
                    {m.id} ({m.version}{m.displayName ? ` — ${m.displayName}` : ''})
                  </option>
                ))}
              </select>
              {discoveryError && (
                <div className="text-[10px] text-red-500 mt-1 whitespace-pre-wrap">{discoveryError}</div>
              )}
            </div>
            <div className="text-xs text-muted-foreground bg-muted/30 px-3 py-2 rounded">
              {t('live.voice')} <span className="font-mono text-foreground">{voiceName}</span>
              <span className="ml-2 opacity-70">{t('live.voiceHint')}</span>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t('live.contextLimit')}</label>
              <input type="number" min={1000} step={1000} value={contextLimit} onChange={(e) => setContextLimit(parseInt(e.target.value) || 20000)}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
              <div className="text-[10px] text-muted-foreground mt-1">{t('live.contextHint')}</div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t('live.vrchatFolder')}</label>
              <input type="text" value={vrchatPath} onChange={(e) => setVrchatPath(e.target.value)} className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono" placeholder={t('live.vrchatPlaceholder')} />
            </div>
            <div className="text-xs text-muted-foreground bg-muted/30 px-3 py-2 rounded">
              {renderRich(t('live.seed').replace('{n}', String(seedMessages.length)))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-2 text-sm border border-border rounded-lg">{t('live.cancel')}</button>
              <button onClick={handleStart} className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 flex items-center gap-2">
                <Radio size={14} /> {t('live.start')}
              </button>
            </div>
          </div>
        )}

        {phase !== 'config' && (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
              {transcript.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8">
                  {phase === 'starting' ? t('live.connecting') : t('live.waiting')}
                </div>
              ) : (
                // `line`, not `t` — the translation hook owns that name here now.
                transcript.map((line, i) => (
                  <div key={i} className={`text-sm px-3 py-1.5 rounded-lg ${
                    line.role === 'assistant' ? 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' :
                    line.role === 'human' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' :
                    'bg-muted'
                  }`}>
                    <span className="text-[10px] uppercase tracking-wider mr-2 opacity-60">{line.role}</span>
                    {line.text}
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-border p-3 flex gap-2">
              <input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText(); } }}
                placeholder={t('live.inputPlaceholder')}
                className="flex-1 px-3 py-2 bg-background border border-border rounded-lg text-sm"
                disabled={phase !== 'live'}
              />
              <button onClick={handleStop} className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 flex items-center gap-2 text-sm">
                <Square size={14} /> {t('live.stop')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
