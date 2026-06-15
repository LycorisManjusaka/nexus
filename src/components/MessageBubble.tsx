"use client";

import React, { useState } from 'react';
import { Pencil, Trash2, Check, X, FileText, Image as ImageIcon, Music, Video, File, EyeOff, Eye, RefreshCw, Brain, Volume2, Loader2, Copy, Square, Pause, Play, Bookmark, Globe } from 'lucide-react';
import { format } from 'date-fns';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { stripLeadingTimestamps, isOnlyTimestamps } from '@/lib/timestampStrip';
import { applyOutputFilter } from '@/lib/outputFilter';

export default function MessageBubble({ msg, onEdit, onDelete, onToggleAttachment, onDeleteAttachment, onRerun, onAudioStateChange, globalSettings, folders, folderName, isVRChatMode, isOriginal = true, isFirstOriginal = false, onSetFirstOriginal }: any) {
  const isUser = msg.role === 'user';
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(msg.content);
  const [ttsState, setTtsState] = useState<'idle' | 'playing' | 'paused'>('idle');
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [isZoomedIn, setIsZoomedIn] = useState(false);
  // Full-content modal for text attachments. Holds {name, textData} or null.
  const [viewTextAttachment, setViewTextAttachment] = useState<{ name: string; textData: string } | null>(null);
  // Description-preview modal for media attachments processed via the
  // eyes/ears/watcher sense bridges. Holds the full report for one
  // attachment, populated when the user clicks the sense badge.
  const [viewDescription, setViewDescription] = useState<{
    name: string;
    kind: string;
    model: string;
    description: string;
    generatedAt?: number;
    fromCache?: boolean;
    error?: string;
  } | null>(null);
  const [textCopyState, setTextCopyState] = useState<'idle' | 'copied'>('idle');
  const [zoomPos, setZoomPos] = useState({ x: 50, y: 50 });
  const currentAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const currentAudioRef2 = React.useRef<HTMLAudioElement | null>(null);
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const hasAutoPlayed = React.useRef(false);
  // Latest-state mirror so handleTTS/stopTTS/handlePauseResume always see the
  // current ttsState rather than a closure-captured value. Without this, a
  // setTimeout from the auto-play effect can call handleTTS 300ms later with
  // a stale "idle" reading and start a SECOND playback while the first is
  // already running — desyncing button state and making Stop unreliable.
  const ttsStateRef = React.useRef<'idle' | 'playing' | 'paused'>('idle');
  React.useEffect(() => { ttsStateRef.current = ttsState; }, [ttsState]);
  // Track the auto-play timer so a manual click (or unmount) can cancel it.
  const autoPlayTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flip on with `window.__ttsDebug = true` in the browser console to trace
  // why auto-play / streaming TTS did or didn't start. No-op in production
  // unless explicitly enabled.
  const ttsDebug = typeof window !== 'undefined' && (window as any).__ttsDebug === true;

  let displayTokens = msg.textTokens !== undefined ? msg.textTokens : (msg.tokens || 0);
  if (!Array.isArray(msg.attachments)) {
    msg.attachments = [];
  }

  // --- Auto-Play Logic ---
  React.useEffect(() => {
    if (msg.autoPlay && !hasAutoPlayed.current && msg.role === 'assistant' && msg.content) {
      hasAutoPlayed.current = true;
      // Small timeout ensures the DOM has updated. Stored in a ref so a
      // manual click can cancel it (handleTTS / handleStreamingTTS clear it)
      // — otherwise the timer can fire AFTER the user has already started TTS
      // manually, creating a second parallel playback.
      //
      // IMPORTANT: this effect depends on msg.content, which changes on every
      // streamed token. We must NOT clear the timer in a per-dependency-change
      // cleanup — during streaming the next token would fire the cleanup and
      // cancel the pending auto-play before its 300 ms elapsed, and the
      // `hasAutoPlayed` guard would then block any reschedule. That race made
      // VRChat-mode audio "often not start". The timer is only cancelled by a
      // manual click or by the unmount-only effect below.
      autoPlayTimerRef.current = setTimeout(() => {
        autoPlayTimerRef.current = null;
        // Only auto-play if nothing has happened in the meantime.
        // Dispatch to streaming TTS when the message is still being
        // generated — gives VRChat mode immediate first-line audio without
        // waiting for the full response to finish.
        if (ttsStateRef.current === 'idle') {
          if (ttsDebug) console.debug('[tts] auto-play firing', { id: msg.id, streaming: !!msg.streaming, len: (msg.content || '').length });
          if (msg.streaming) handleStreamingTTS();
          else handleTTS();
        } else if (ttsDebug) {
          console.debug('[tts] auto-play skipped — ttsState not idle', { id: msg.id, state: ttsStateRef.current });
        }
      }, 300);
    }
  }, [msg.autoPlay, msg.content, msg.role]);

  // Unmount-only cleanup for the auto-play timer. Kept separate from the
  // effect above so streamed content updates don't cancel a pending timer.
  React.useEffect(() => {
    return () => {
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
        autoPlayTimerRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (onAudioStateChange) {
      onAudioStateChange(msg.id, ttsState !== 'idle');
    }
  }, [ttsState, msg.id, onAudioStateChange]);

  // Keep editContent in sync with msg.content (e.g. after streaming finishes)
  React.useEffect(() => {
    if (!isEditing) {
      setEditContent(msg.content);
    }
  }, [msg.content]);

  // Auto-grow the edit textarea when it opens and whenever content changes.
  const editTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    const el = editTextareaRef.current;
    if (!el || !isEditing) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [isEditing, editContent]);

  // ── Streaming TTS state ────────────────────────────────────────────────────
  // Used when an assistant message is currently being generated (msg.streaming
  // === true). Sentences are extracted as they complete (terminated by 。 ！
  // ？ \n 」) and queued for synthesis; the audio player keeps draining the
  // queue while more sentences arrive. An un-terminated tail is held back
  // until either more content arrives or streaming ends, at which point the
  // tail is flushed as a final segment.
  const streamingActiveRef = React.useRef(false);
  const streamingProcessedLenRef = React.useRef(0);
  const streamingDoneRef = React.useRef(false);
  const audioQueueRef = React.useRef<string[]>([]);
  const isCurrentlyPlayingRef = React.useRef(false);
  const synthInFlightCountRef = React.useRef(0);
  const streamingVoiceRef = React.useRef<any>(null);
  const streamingSignalRef = React.useRef<AbortSignal | null>(null);

  const takeCompletedFromTail = (text: string): { completed: string; consumed: number } => {
    // Walk every sentence terminator and record the LAST one. The slice up to
    // that point is "safe to speak"; anything after is the in-progress tail
    // that may still be appended to.
    let lastEnd = -1;
    const re = /[。！？\n」]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd <= 0) return { completed: '', consumed: 0 };
    return { completed: text.slice(0, lastEnd), consumed: lastEnd };
  };

  const splitIntoSentenceChunks = (text: string): string[] => {
    const parts = text.split(/([。！？\n」]+)/);
    const out: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const chunk = (parts[i] || '') + (parts[i + 1] || '');
      if (chunk.trim()) out.push(chunk.trim());
    }
    return out;
  };

  const maybeFinishStreaming = () => {
    if (!streamingActiveRef.current) return;
    if (
      streamingDoneRef.current &&
      synthInFlightCountRef.current === 0 &&
      audioQueueRef.current.length === 0 &&
      !isCurrentlyPlayingRef.current
    ) {
      streamingActiveRef.current = false;
      streamingSignalRef.current = null;
      ttsStateRef.current = 'idle';
      setTtsState('idle');
      abortControllerRef.current = null;
    }
  };

  const streamingPlayNext = async (signal: AbortSignal) => {
    if (signal.aborted) return;
    if (audioQueueRef.current.length === 0) {
      isCurrentlyPlayingRef.current = false;
      maybeFinishStreaming();
      return;
    }
    isCurrentlyPlayingRef.current = true;
    const url = audioQueueRef.current.shift()!;
    const audio1 = new Audio(url);
    currentAudioRef.current = audio1;
    if (isVRChatMode && globalSettings?.device1Id && typeof (audio1 as any).setSinkId === 'function') {
      try { await (audio1 as any).setSinkId(globalSettings.device1Id); } catch {}
    }
    const p1 = audio1.play();
    let p2: Promise<void> | null = null;
    if (isVRChatMode && globalSettings?.device2Id) {
      const audio2 = new Audio(url);
      currentAudioRef2.current = audio2;
      if (typeof (audio2 as any).setSinkId === 'function') {
        try { await (audio2 as any).setSinkId(globalSettings.device2Id); } catch {}
      }
      p2 = audio2.play();
    }
    try {
      await p1;
      if (p2) await p2;
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        // Browser blocked programmatic playback — there's been no user gesture
        // (or it expired). This is the other classic reason VRChat-mode audio
        // doesn't start. Surface it loudly so it's diagnosable instead of a
        // silent stop.
        console.warn('[tts] playback blocked by browser autoplay policy (NotAllowedError). A user gesture is required to start audio in this tab. Click anywhere / press the TTS button once to unlock.');
        stopTTS();
        return;
      }
      if (ttsDebug) console.debug('[tts] audio.play() rejected (non-fatal, skipping segment)', { name: e?.name, message: e?.message });
      URL.revokeObjectURL(url);
      currentAudioRef.current = null;
      currentAudioRef2.current = null;
      streamingPlayNext(signal);
      return;
    }
    audio1.onended = () => {
      URL.revokeObjectURL(url);
      currentAudioRef.current = null;
      currentAudioRef2.current = null;
      streamingPlayNext(signal);
    };
  };

  const synthesizeStreamingSegment = async (segment: any, signal: AbortSignal) => {
    if (signal.aborted) return;
    synthInFlightCountRef.current++;
    try {
      const res = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: [segment] }),
        signal,
      });
      if (!res.ok) return;
      const blob = await res.blob();
      if (signal.aborted) return;
      // The server returns an empty body (0 bytes) when a segment has no
      // speakable phonemes (symbol/emoji/punctuation-only — it would crash
      // OpenJTalk/VITS). Queuing an empty blob stalls the playback queue:
      // new Audio(emptyUrl).play() never fires onended, so isCurrentlyPlaying
      // stays true and no later segment ever plays. Skip it entirely.
      if (blob.size === 0) return;
      const url = URL.createObjectURL(blob);
      audioQueueRef.current.push(url);
      if (!isCurrentlyPlayingRef.current && !signal.aborted) {
        streamingPlayNext(signal);
      }
    } catch (e: any) {
      // Ignore aborts — stopTTS will have cleaned up.
    } finally {
      synthInFlightCountRef.current--;
      maybeFinishStreaming();
    }
  };

  const processStreamingTick = (signal: AbortSignal) => {
    if (signal.aborted || !streamingActiveRef.current) return;
    const fullText = msg.content || '';
    const isFirstChunk = streamingProcessedLenRef.current === 0;
    const unprocessed = fullText.slice(streamingProcessedLenRef.current);
    if (!unprocessed) return;
    const { completed, consumed } = takeCompletedFromTail(unprocessed);
    if (!completed) return;
    streamingProcessedLenRef.current += consumed;
    let textToSpeak = completed;
    if (isFirstChunk) {
      // Strip the leading [YYYY-MM-DD HH:MM:SS] timestamp(s) the AI echoes —
      // including a whole STACK of them — from the very start of the reply.
      textToSpeak = stripLeadingTimestamps(textToSpeak);
    }
    // Custom regex filter — strip user-defined patterns from spoken text too.
    textToSpeak = applyOutputFilter(textToSpeak, globalSettings);
    const sentences = splitIntoSentenceChunks(textToSpeak);
    for (const s of sentences) {
      // Belt-and-suspenders: when a timestamp stack is split across streaming
      // ticks, a later (non-first) chunk can still start with a lone
      // timestamp. Never queue a segment that is only timestamp(s).
      if (isOnlyTimestamps(s)) continue;
      synthesizeStreamingSegment({ text: s, ...streamingVoiceRef.current }, signal);
    }
  };

  const flushStreamingTail = (signal: AbortSignal) => {
    if (signal.aborted) return;
    const fullText = msg.content || '';
    const tail = fullText.slice(streamingProcessedLenRef.current).trim();
    if (!tail) return;
    const isFirstChunk = streamingProcessedLenRef.current === 0;
    let textToSpeak = tail;
    if (isFirstChunk) {
      textToSpeak = stripLeadingTimestamps(textToSpeak);
    }
    textToSpeak = applyOutputFilter(textToSpeak, globalSettings);
    streamingProcessedLenRef.current = fullText.length;
    const sentences = splitIntoSentenceChunks(textToSpeak);
    for (const s of sentences) {
      if (isOnlyTimestamps(s)) continue;
      synthesizeStreamingSegment({ text: s, ...streamingVoiceRef.current }, signal);
    }
  };

  const handleStreamingTTS = async () => {
    if (ttsStateRef.current !== 'idle') {
      stopTTS();
      return;
    }
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }
    // Synchronous lock — same pattern as the legacy handleTTS so a second
    // click during the await window can't spawn a parallel pipeline.
    ttsStateRef.current = 'playing';
    setTtsState('playing');
    const ac = new AbortController();
    abortControllerRef.current = ac;
    streamingSignalRef.current = ac.signal;

    // Resolve voice (synchronous from folders prop — no await window here).
    const activeFolder = folders?.find((f: any) => f.name === folderName);
    const voice = activeFolder?.settings?.aiVoice || { engine: 0, char_idx: 0, style_idx: 0, speed: 1.0 };
    const pitch = activeFolder?.settings?.voicePitch ?? 0.0;
    streamingVoiceRef.current = {
      engine: voice.engine || 0,
      char_idx: voice.char_idx || 0,
      style_idx: voice.style_idx || 0,
      speed: voice.speed || 1.0,
      pitch,
    };

    streamingActiveRef.current = true;
    streamingDoneRef.current = !msg.streaming;
    streamingProcessedLenRef.current = 0;
    audioQueueRef.current = [];
    isCurrentlyPlayingRef.current = false;
    synthInFlightCountRef.current = 0;

    // First tick — speak whatever is already complete.
    processStreamingTick(ac.signal);

    // If the message wasn't streaming when TTS was triggered (manual click on
    // a finished message), flush the tail right now and finish.
    if (!msg.streaming) {
      flushStreamingTail(ac.signal);
      streamingDoneRef.current = true;
      maybeFinishStreaming();
    }
  };

  // Process more sentences as the streaming message grows.
  React.useEffect(() => {
    if (!streamingActiveRef.current) return;
    const sig = streamingSignalRef.current;
    if (!sig || sig.aborted) return;
    processStreamingTick(sig);
  }, [msg.content]);

  // Stream ended — pick up any final terminator-bearing chunk, then flush
  // the un-terminated tail as a last segment.
  React.useEffect(() => {
    if (!streamingActiveRef.current) return;
    if (msg.streaming) return;
    const sig = streamingSignalRef.current;
    if (!sig || sig.aborted) return;
    processStreamingTick(sig);
    flushStreamingTail(sig);
    streamingDoneRef.current = true;
    maybeFinishStreaming();
  }, [msg.streaming]);

  if (msg.attachments) {
    msg.attachments.forEach((att: any) => {
      if (!att.excluded) displayTokens += (att.tokens || 0);
    });
  }

  const handleSave = () => {
    onEdit(editContent);
    setIsEditing(false);
  };

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(msg.content || '');
  };

  const stopTTS = () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    if (currentAudioRef2.current) {
      currentAudioRef2.current.pause();
      currentAudioRef2.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Streaming TTS cleanup — drop the queue and revoke any pending blob URLs
    // so the streaming pipeline doesn't keep playing after Stop.
    if (streamingActiveRef.current) {
      for (const url of audioQueueRef.current) {
        try { URL.revokeObjectURL(url); } catch {}
      }
      audioQueueRef.current = [];
      streamingActiveRef.current = false;
      streamingDoneRef.current = false;
      streamingProcessedLenRef.current = 0;
      synthInFlightCountRef.current = 0;
      isCurrentlyPlayingRef.current = false;
      streamingSignalRef.current = null;
    }
    // Synchronous-mirror update too — the useEffect that syncs ttsStateRef
    // from ttsState fires only on the next render, which is too late to
    // protect against a follow-up handleTTS in the same tick.
    ttsStateRef.current = 'idle';
    setTtsState('idle');
  };

  const handlePauseResume = () => {
    if (ttsStateRef.current === 'playing') {
      if (currentAudioRef.current) currentAudioRef.current.pause();
      if (currentAudioRef2.current) currentAudioRef2.current.pause();
      setTtsState('paused');
    } else if (ttsStateRef.current === 'paused') {
      if (currentAudioRef.current) currentAudioRef.current.play().catch(e => console.error("Resume error", e));
      if (currentAudioRef2.current) currentAudioRef2.current.play().catch(e => console.error("Resume error 2", e));
      setTtsState('playing');
    }
  };

  const handleTTS = async () => {
    // Read the LATEST state via ref, not closure-captured ttsState — otherwise
    // a setTimeout-triggered or stale invocation can mistake 'playing' for
    // 'idle' and start a parallel TTS pipeline, breaking the state machine.
    if (ttsStateRef.current !== 'idle') {
      stopTTS();
      return;
    }
    // Streaming dispatch: if the user clicks the button while generation is
    // still in progress, route to the streaming TTS pipeline so audio starts
    // immediately and grows with the response. Falls through to the legacy
    // path for user messages and finished assistant messages.
    if (msg.streaming && msg.role === 'assistant') {
      return handleStreamingTTS();
    }
    // A manual play also cancels any pending auto-play timer so the two
    // never race.
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
      autoPlayTimerRef.current = null;
    }

    // CRITICAL: take the lock SYNCHRONOUSLY here, before any await.
    // Without this, the chara/voices fetch below (which can sit behind a
    // busy React render after a long Gemini response) leaves us in 'idle'
    // for hundreds of ms — long enough for a frustrated user to click again
    // and spawn a second parallel TTS pipeline. The two parallel pipelines
    // then race on abortControllerRef / currentAudioRef and Stop only
    // catches whichever one wrote those refs last.
    ttsStateRef.current = 'playing';
    setTtsState('playing');
    const ac = new AbortController();
    abortControllerRef.current = ac;
    const signal = ac.signal;

    let segments: any[] = [];
    const defaultUserVoice = globalSettings?.userVoice || { engine: 0, char_idx: 1, style_idx: 0, speed: 1.0 };

    // Pull the user-character voices from character_map.json so [name] tags can
    // resolve to a user character's voice without needing a dummy folder.
    // Fetched once per TTS click — cheap and always fresh (style index reflects
    // any voice-changer style switch since last read).
    let charaVoices: { name: string; voice: any }[] = [];
    try {
      const r = await fetch('/api/chara/voices', { signal });
      if (r.ok) {
        const d = await r.json();
        charaVoices = d.characters || [];
      }
    } catch {}

    // If the user clicked Stop during the fetch above, bail without starting playback.
    if (signal.aborted) return;

    // Look up a tag's voice by checking folders (AI characters) FIRST, then
    // character_map.json (user characters). Folders win on collision so an
    // intentionally-overridden folder voice keeps priority.
    const lookupVoiceForTag = (tag: string): any | null => {
      const f = folders?.find((folder: any) => folder.name === tag);
      if (f && f.settings?.aiVoice) return f.settings.aiVoice;
      const c = charaVoices.find(c => c.name === tag);
      if (c) return c.voice;
      return null;
    };

    if (msg.role !== 'user') {
      const activeFolder = folders?.find((f: any) => f.name === folderName);
      const voice = activeFolder?.settings?.aiVoice || { engine: 0, char_idx: 0, style_idx: 0, speed: 1.0 };
      const pitch = activeFolder?.settings?.voicePitch ?? 0.0;
      // Strip leading "[YYYY-MM-DD HH:MM:SS]" timestamp tag(s) before sending
      // to TTS. The dateTimeVisibility feature injects these into prompts, and
      // the AI sometimes echoes them back — occasionally a whole STACK of them
      // — at the start of its reply. Hearing the date read out loud breaks
      // immersion, so strip them all here while keeping them visible in the
      // bubble.
      const cleaned = stripLeadingTimestamps(msg.content || '');
      // If the whole message was nothing but timestamps, there's nothing to say.
      if (!isOnlyTimestamps(msg.content || '') && cleaned.trim()) {
        segments.push({ text: cleaned, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, speed: voice.speed || 1.0, pitch });
      }
    } else {
      const regex = /\[(.*?)\]/g;
      let lastIndex = 0;
      let match;
      let currentTag = '';

      while ((match = regex.exec(msg.content)) !== null) {
        const textBefore = msg.content.slice(lastIndex, match.index).trim();
        if (textBefore) {
          let voice = defaultUserVoice;
          if (currentTag) {
            const v = lookupVoiceForTag(currentTag);
            if (v) voice = v;
          }
          const tagPitch = currentTag ? (folders?.find((f: any) => f.name === currentTag)?.settings?.voicePitch ?? voice.pitch ?? 0.0) : (voice.pitch ?? 0.0);
          segments.push({ text: textBefore, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, speed: voice.speed || 1.0, pitch: tagPitch });
        }
        currentTag = match[1];
        lastIndex = regex.lastIndex;
      }

      const textAfter = msg.content.slice(lastIndex).trim();
      if (textAfter) {
        let voice = defaultUserVoice;
        if (currentTag) {
          const v = lookupVoiceForTag(currentTag);
          if (v) voice = v;
        }
        const tagPitch = currentTag ? (folders?.find((f: any) => f.name === currentTag)?.settings?.voicePitch ?? voice.pitch ?? 0.0) : (voice.pitch ?? 0.0);
        segments.push({ text: textAfter, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, speed: voice.speed || 1.0, pitch: tagPitch });
      }

      if (segments.length === 0 && msg.content.trim()) {
        segments.push({ text: msg.content.trim(), engine: defaultUserVoice.engine || 0, char_idx: defaultUserVoice.char_idx || 0, style_idx: defaultUserVoice.style_idx || 0, speed: defaultUserVoice.speed || 1.0, pitch: defaultUserVoice.pitch ?? 0.0 });
      }
    }
    
    // Nothing to say — release the lock acquired up top.
    const releaseIdle = () => {
      ttsStateRef.current = 'idle';
      setTtsState('idle');
      if (abortControllerRef.current === ac) abortControllerRef.current = null;
    };

    if (segments.length === 0) { releaseIdle(); return; }

    // Split Japanese text into sentences by punctuation
    const sentences: any[] = [];
    segments.forEach(seg => {
      const parts = seg.text.split(/([。！？\n」]+)/);
      for (let i = 0; i < parts.length; i += 2) {
        const chunk = parts[i] + (parts[i+1] || '');
        if (chunk.trim()) {
           sentences.push({ ...seg, text: chunk.trim() });
        }
      }
    });

    if (sentences.length === 0) { releaseIdle(); return; }

    // State + AbortController already set up at the top of the function.

    let currentIndex = 0;
    const audioQueue: string[] = [];
    let isCurrentlyPlaying = false;

    const playNext = async () => {
      if (signal.aborted) return;
      if (audioQueue.length > 0) {
        isCurrentlyPlaying = true;
        const url = audioQueue.shift()!;
        const audio1 = new Audio(url);
        currentAudioRef.current = audio1;
        if (isVRChatMode && globalSettings?.device1Id && typeof (audio1 as any).setSinkId === 'function') {
          try { await (audio1 as any).setSinkId(globalSettings.device1Id); } catch(e) {}
        }
        let p1 = audio1.play();
        let p2 = null;

        if (isVRChatMode && globalSettings?.device2Id) {
          const audio2 = new Audio(url);
          currentAudioRef2.current = audio2;
          if (typeof (audio2 as any).setSinkId === 'function') {
            try { await (audio2 as any).setSinkId(globalSettings.device2Id); } catch(e) {}
          }
          p2 = audio2.play();
        }

        try {
          await p1;
          if (p2) await p2;
        } catch(e: any) {
          console.error("Audio play error:", e);
          if (e.name === 'NotAllowedError') {
            stopTTS();
            return;
          } else {
            // Other errors just skip to next
            URL.revokeObjectURL(url);
            currentAudioRef.current = null;
            currentAudioRef2.current = null;
            playNext();
            return;
          }
        }

        audio1.onended = () => {
          URL.revokeObjectURL(url);
          currentAudioRef.current = null;
          currentAudioRef2.current = null;
          playNext();
        };
      } else {
        isCurrentlyPlaying = false;
        if (currentIndex >= sentences.length) {
          setTtsState('idle');
        }
      }
    };

    // Asynchronously fetch sentences
    for (let i = 0; i < sentences.length; i++) {
      if (signal.aborted) break;
      currentIndex = i + 1;
      try {
        const res = await fetch('/api/tts/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: [sentences[i]] }),
          signal
        });
        if (!res.ok) continue;
        const blob = await res.blob();
        // Skip empty (0-byte) responses — the server returns no body for
        // phoneme-less segments. Queuing an empty blob stalls playback.
        if (blob.size === 0) continue;
        const url = URL.createObjectURL(blob);
        audioQueue.push(url);
        
        // Start playing immediately if we aren't already
        if (!isCurrentlyPlaying && !signal.aborted) {
          playNext();
        }
      } catch(e: any) {
         if (e.name !== 'AbortError') console.error(e);
      }
    }
  };

  const getAttachmentPreview = (att: any) => {
    if (att.isImage && att.dataUrl) {
      return <img 
        src={att.dataUrl} 
        alt={att.name} 
        className="max-w-xs max-h-48 rounded-md mt-2 object-contain bg-black/5 cursor-zoom-in hover:opacity-90 transition-opacity" 
        onClick={() => setZoomImage(att.dataUrl)}
      />;
    }
    if (att.isVideo && att.dataUrl) {
      return <video src={att.dataUrl} controls className="max-w-xs rounded-md mt-2" />;
    }
    if (att.isAudio && att.dataUrl) {
      return <audio src={att.dataUrl} controls className="mt-2 w-full max-w-xs" />;
    }
    if (att.isText && att.textData) {
      const truncated = att.textData.length > 500;
      return (
        <div className="mt-2 bg-muted/50 rounded-md border border-border overflow-hidden">
          <div className="max-h-32 overflow-y-auto p-2 text-xs font-mono whitespace-pre-wrap">
            {att.textData.slice(0, 500)}{truncated ? '…' : ''}
          </div>
          {truncated && (
            <button
              onClick={() => setViewTextAttachment({ name: att.name, textData: att.textData })}
              className="w-full text-center text-[10px] py-1 bg-background/50 hover:bg-background text-muted-foreground hover:text-indigo-500 border-t border-border transition-colors"
              title="Open full file in a modal"
            >
              {att.textData.length.toLocaleString()} chars · click to view full file
            </button>
          )}
        </div>
      );
    }
    return null;
  };

  const getIcon = (att: any) => {
    if (att.isText) return <FileText size={16} className="text-blue-500" />;
    if (att.isImage) return <ImageIcon size={16} className="text-green-500" />;
    if (att.isAudio) return <Music size={16} className="text-yellow-500" />;
    if (att.isVideo) return <Video size={16} className="text-purple-500" />;
    return <File size={16} className="text-gray-500" />;
  };

  return (
    <>
    <div className={`flex flex-col group ${isUser ? 'items-end' : 'items-start'} ${!isOriginal ? 'opacity-55' : ''} ${isFirstOriginal ? 'ring-1 ring-indigo-500/30 rounded-2xl p-1 -m-1' : ''}`}>
      
      {/* Meta Bar */}
      <div className={`flex items-center gap-3 text-[11px] text-muted-foreground mb-1.5 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
        {/* User-role messages intentionally have no name label — the user's
            identity lives in `[username]` tags inside the message content
            (parsed by TTS / MD export / agent log). Old logs that still
            carry `msg.name = "User"` simply don't render it here. */}
        {!isUser && msg.name && (
          <span className="font-semibold text-foreground/80">{msg.name}</span>
        )}
        {/* Model + thinking-mode tag emitted by the backend's
            `model_selected` SSE event on every AI message. Stored as
            display-only metadata on the message (modelFamily / modelSpecific
            / modelThinking / modelLabel) — NEVER sent back to the model on
            subsequent turns. Old log entries that predate this field simply
            don't render the tag. */}
        {!isUser && (msg.modelLabel || msg.modelSpecific) && (
          <span
            className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px] font-mono"
            title={
              msg.modelFamily
                ? `${msg.modelFamily} / ${msg.modelSpecific || ''}${msg.modelThinking ? ' · thinking on' : ' · thinking off'}`
                : (msg.modelSpecific || '')
            }
          >
            {msg.modelLabel || `${msg.modelFamily || ''} ${msg.modelSpecific || ''}${msg.modelThinking ? ' Thinking' : ''}`.trim()}
          </span>
        )}
        <span>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(msg.timestamp))}</span>
        {displayTokens > 0 && (
          <span className="bg-muted px-2 py-0.5 rounded-full">{displayTokens} tokens</span>
        )}
        {/* Prompt-cache stats from the provider's `usage` block. Shown only
            on AI messages and only when the backend captured non-zero input
            usage. Color: green when there was a cache hit, gray otherwise.
            Tooltip details the buckets (cached / uncached / cache-write for
            Claude / provider). */}
        {!isUser && msg.cacheUsage && msg.cacheUsage.totalInputTokens > 0 && (() => {
          const cu = msg.cacheUsage;
          const pct = cu.totalInputTokens > 0
            ? Math.round((cu.cachedInputTokens / cu.totalInputTokens) * 100)
            : 0;
          const hit = cu.cachedInputTokens > 0;
          const tooltip =
            `Input: ${cu.totalInputTokens.toLocaleString()} tokens\n` +
            `  cached (cheap):   ${cu.cachedInputTokens.toLocaleString()} (${pct}%)\n` +
            `  uncached (full):  ${cu.uncachedInputTokens.toLocaleString()}` +
            (cu.cacheCreationTokens > 0 ? `\n  cache write:      ${cu.cacheCreationTokens.toLocaleString()} (1.25× one-shot)` : '') +
            `\nOutput: ${cu.outputTokens.toLocaleString()} tokens` +
            `\nProvider: ${cu.providerHint || 'unknown'}`;
          return (
            <span
              className={`px-2 py-0.5 rounded-full font-mono ${
                hit
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              }`}
              title={tooltip}
            >
              {cu.totalInputTokens.toLocaleString()} in
              {hit && (
                <span className="ml-1 opacity-80">· {cu.cachedInputTokens.toLocaleString()} cached ({pct}%)</span>
              )}
            </span>
          );
        })()}
        {msg.continuationCount > 0 && (
          <span className="bg-amber-500/15 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full" title={`Auto-continued ${msg.continuationCount} time${msg.continuationCount === 1 ? '' : 's'} after hitting the model's output token cap`}>
            ↵ continued ×{msg.continuationCount}
          </span>
        )}
      </div>

      {/* Web-search sources — clickable proof that the model actually consulted
          live pages. Only shown for AI messages that carried citations. If a
          model claims it searched the web but no sources appear here, treat its
          "facts" as unverified (likely hallucinated). */}
      {!isUser && Array.isArray(msg.webSources) && msg.webSources.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
            <Globe size={12} />
            <span>Web sources ({msg.webSources.length}) — verified, clickable</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {msg.webSources.map((s: any, i: number) => {
              let host = s.url;
              try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch {}
              return (
                <a
                  key={`${s.url}-${i}`}
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={s.title ? `${s.title}\n${s.url}` : s.url}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-700 dark:text-sky-400 hover:bg-sky-500/20 transition-colors text-xs max-w-[220px]"
                >
                  <span className="font-medium shrink-0">{i + 1}.</span>
                  <span className="truncate">{s.title || host}</span>
                  <span className="opacity-60 shrink-0">({host})</span>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* Attachments */}
      {msg.attachments && msg.attachments.length > 0 && (
        <div className={`flex flex-wrap gap-2 mb-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
          {msg.attachments.map((att: any) => (
            <div key={att.id} className={`flex flex-col p-2 border rounded-xl max-w-sm ${att.excluded ? 'border-dashed bg-muted/20' : 'bg-card border-border shadow-sm'}`}>
              <div className="flex items-center gap-2">
                {getIcon(att)}
                <span className="text-xs font-medium truncate max-w-[150px]">{att.name}</span>
                {att.toolAction && (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wide ${
                    att.toolAction === 'created' ? 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-300' :
                    att.toolAction === 'modified' ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300' :
                    'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
                  }`} title="Action the AI performed on this file via tool use">
                    {att.toolAction}
                  </span>
                )}
                {att.tokens > 0 && <span className="text-muted-foreground bg-muted px-1.5 py-0.5 rounded text-[10px]">{att.tokens} t</span>}
                {att.isText && att.textData && (
                  <button
                    onClick={() => setViewTextAttachment({ name: att.name, textData: att.textData })}
                    className="ml-auto p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-indigo-500"
                    title="View full file content"
                  >
                    <FileText size={14} />
                  </button>
                )}
                <button
                  onClick={() => onToggleAttachment(att.id)}
                  className={`${att.isText && att.textData ? '' : 'ml-auto'} p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground`}
                  title={att.excluded ? "Include in context" : "Exclude from context"}
                >
                  {att.excluded ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                {onDeleteAttachment && (
                  <button
                    onClick={() => onDeleteAttachment(att.id)}
                    className="p-1 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500"
                    title="Permanently remove attachment from this log"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              <div className="transition-all duration-300">
                {getAttachmentPreview(att)}
              </div>
              {/* Sense-bridge badge: appears whenever a description has been
                  generated by Eyes/Ears/Video Watcher. Click → preview modal.
                  Shows which sense ran and which bridge model produced the
                  text. Tiny "cached" dot when the description came from the
                  on-disk cache rather than a fresh call. Red tint if the
                  bridge call errored — error text in the modal. */}
              {(att.description || att.descriptionError) && (
                <button
                  onClick={() => setViewDescription({
                    name: att.name,
                    kind: att.descriptionKind || 'sense',
                    model: att.descriptionModel || 'unknown',
                    description: att.description || '',
                    generatedAt: att.descriptionGeneratedAt,
                    fromCache: att.descriptionFromCache,
                    error: att.descriptionError,
                  })}
                  className={`mt-1 flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
                    att.descriptionError
                      ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300 hover:bg-red-500/15'
                      : 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/15'
                  }`}
                  title="Click to view full description"
                >
                  {att.descriptionKind === 'eyes'    ? <Eye size={11} /> :
                   att.descriptionKind === 'ears'    ? <Volume2 size={11} /> :
                   att.descriptionKind === 'watcher' ? <Video size={11} /> :
                                                       <FileText size={11} />}
                  <span className="uppercase tracking-wide">
                    {att.descriptionKind === 'eyes'    ? 'Eyes' :
                     att.descriptionKind === 'ears'    ? 'Ears' :
                     att.descriptionKind === 'watcher' ? 'Watcher' :
                                                        'Sense'}
                  </span>
                  <span className="font-mono opacity-80 truncate max-w-[120px]">{att.descriptionModel || ''}</span>
                  {att.descriptionFromCache && !att.descriptionError && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="Description loaded from disk cache" />
                  )}
                  {att.descriptionError && (
                    <span
                      title={att.descriptionError}
                      className="flex items-center gap-1 normal-case font-normal max-w-[260px] truncate"
                    >
                      <span>⚠</span>
                      <span className="truncate">{att.descriptionError}</span>
                    </span>
                  )}
                </button>
              )}
              {att.excluded && <div className="text-[10px] text-red-500 font-bold mt-1 text-center bg-red-500/10 rounded py-0.5">EXCLUDED FROM CONTEXT</div>}
            </div>
          ))}
        </div>
      )}

      {/* Content Bubble */}
      <div className={`relative group/bubble ${isEditing ? 'w-full max-w-full' : 'max-w-[85%]'}`}>
        {isEditing ? (
          <div className="bg-card border border-border rounded-2xl p-4 shadow-lg w-full">
            <textarea
              ref={editTextareaRef}
              value={editContent}
              onChange={(e) => {
                setEditContent(e.target.value);
                e.currentTarget.style.height = 'auto';
                e.currentTarget.style.height = e.currentTarget.scrollHeight + 'px';
              }}
              className="w-full bg-transparent resize-none outline-none min-h-[200px] text-sm leading-relaxed"
            />
            <div className="flex justify-end gap-2 mt-2 pt-2 border-t border-border">
              <button onClick={() => setIsEditing(false)} className="p-1.5 hover:bg-muted rounded-md text-muted-foreground"><X size={16}/></button>
              <button onClick={handleSave} className="p-1.5 bg-primary text-primary-foreground rounded-md hover:opacity-90"><Check size={16}/></button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {msg.creativityLabel && !isUser && (
              <div className="text-[10px] font-mono text-indigo-400/70 select-none px-1">
                {msg.creativityLabel.trim()}
              </div>
            )}
            {msg.thoughtProcess && (
              <details className="bg-muted/30 border border-border rounded-xl px-4 py-3 text-sm group/details max-w-full shadow-sm text-muted-foreground open:bg-muted/50 transition-colors">
                <summary className="font-semibold cursor-pointer flex items-center gap-2 select-none hover:text-foreground transition-colors outline-none">
                  <Brain size={16} className="text-indigo-400 shrink-0" />
                  <span>Thought Process</span>
                </summary>
                <div className="mt-3 pt-3 border-t border-border/50 text-[13px] leading-relaxed whitespace-pre-wrap font-mono opacity-80">
                  {msg.thoughtProcess}
                </div>
              </details>
            )}
            <div className={`px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm w-fit max-w-full overflow-hidden ${
              isUser
                ? 'bg-primary text-primary-foreground rounded-tr-sm ml-auto'
                : 'bg-card border border-border text-card-foreground rounded-tl-sm mr-auto'
            }`}>
              {msg.content ? (
                isUser ? (
                  // Inherit color from the bubble (text-primary-foreground) so
                  // a custom globals.css theme can recolor user messages.
                  // `prose-invert` sets dark-background prose defaults, then
                  // [&_*]:text-inherit forces every prose child element to
                  // pick up the bubble's foreground colour instead of the
                  // plugin's hard-coded greys/whites.
                  <div className={`prose prose-sm max-w-none prose-invert [&_*]:text-inherit`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <div className={`prose prose-sm max-w-none dark:prose-invert`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                )
              ) : (
                msg.attachments?.length > 0
                  ? <span className="italic opacity-50">(Attachment only)</span>
                  : null
              )}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        {!isEditing && (
          <div className={`absolute bottom-2 opacity-0 group-hover/bubble:opacity-100 transition-opacity flex gap-1 ${
            isUser ? 'right-full mr-2' : 'left-full ml-2'
          }`}>
            {ttsState === 'idle' ? (
              <button onClick={handleTTS} className={`p-1.5 bg-background border border-border rounded-lg shadow-sm transition-colors text-muted-foreground hover:text-green-500`} title="Read Aloud">
                <Volume2 size={14} />
              </button>
            ) : (
              <>
                <button onClick={handlePauseResume} className={`p-1.5 bg-background border border-border rounded-lg shadow-sm transition-colors text-blue-500 hover:text-blue-600`} title={ttsState === 'playing' ? "Pause" : "Resume"}>
                  {ttsState === 'playing' ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                </button>
                <button onClick={stopTTS} className={`p-1.5 bg-background border border-border rounded-lg shadow-sm transition-colors text-red-500 hover:text-red-600`} title="Stop TTS">
                  <Square size={14} fill="currentColor" />
                </button>
              </>
            )}
            <button onClick={handleCopyMarkdown} className="p-1.5 bg-background border border-border rounded-lg text-muted-foreground hover:text-foreground shadow-sm" title="Copy as Markdown">
              <Copy size={14} />
            </button>
            <button onClick={() => setIsEditing(true)} className="p-1.5 bg-background border border-border rounded-lg text-muted-foreground hover:text-foreground shadow-sm">
              <Pencil size={14} />
            </button>
            {!isUser && onRerun && (
              <button onClick={onRerun} className="p-1.5 bg-background border border-border rounded-lg text-muted-foreground hover:text-indigo-500 shadow-sm" title="Rerun from here">
                <RefreshCw size={14} />
              </button>
            )}
            {onSetFirstOriginal && (
              <button
                onClick={onSetFirstOriginal}
                className={`p-1.5 bg-background border border-border rounded-lg shadow-sm ${isFirstOriginal ? 'text-indigo-500 hover:text-muted-foreground' : 'text-muted-foreground hover:text-indigo-500'}`}
                title={isFirstOriginal ? "Clear first-original marker" : "Set as first original message"}
              >
                <Bookmark size={14} fill={isFirstOriginal ? "currentColor" : "none"} />
              </button>
            )}
            <button onClick={onDelete} className="p-1.5 bg-background border border-border rounded-lg text-red-400 hover:text-red-500 shadow-sm" title={isOriginal ? "Delete (original — confirm)" : "Delete (cloned)"}>
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
    </div>

      {/* Zoom Modal */}
      {viewTextAttachment && (
        <div
          className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setViewTextAttachment(null)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileText size={16} className="text-blue-500 shrink-0" />
                <span className="font-mono text-sm truncate" title={viewTextAttachment.name}>{viewTextAttachment.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {viewTextAttachment.textData.length.toLocaleString()} chars
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(viewTextAttachment.textData);
                      setTextCopyState('copied');
                      setTimeout(() => setTextCopyState('idle'), 1500);
                    } catch {}
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground flex items-center gap-1"
                  title="Copy file contents to clipboard"
                >
                  <Copy size={12} /> {textCopyState === 'copied' ? 'Copied!' : 'Copy'}
                </button>
                <button
                  onClick={() => setViewTextAttachment(null)}
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                  title="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
                {viewTextAttachment.textData}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Sense-bridge description preview modal */}
      {viewDescription && (
        <div
          className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setViewDescription(null)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {viewDescription.kind === 'eyes'    ? <Eye size={16} className="text-indigo-500 shrink-0" /> :
                 viewDescription.kind === 'ears'    ? <Volume2 size={16} className="text-indigo-500 shrink-0" /> :
                 viewDescription.kind === 'watcher' ? <Video size={16} className="text-indigo-500 shrink-0" /> :
                                                      <FileText size={16} className="text-indigo-500 shrink-0" />}
                <div className="flex flex-col min-w-0">
                  <span className="font-mono text-sm truncate" title={viewDescription.name}>{viewDescription.name}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {viewDescription.kind === 'eyes'    ? 'Eyes' :
                     viewDescription.kind === 'ears'    ? 'Ears' :
                     viewDescription.kind === 'watcher' ? 'Video Watcher' :
                                                          'Sense bridge'}
                    {' · '}
                    <span className="font-mono">{viewDescription.model}</span>
                    {viewDescription.fromCache && <span className="ml-2 text-emerald-600">cached</span>}
                    {viewDescription.generatedAt && (
                      <span className="ml-2">{format(new Date(viewDescription.generatedAt), 'yyyy-MM-dd HH:mm')}</span>
                    )}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(viewDescription.description);
                      setTextCopyState('copied');
                      setTimeout(() => setTextCopyState('idle'), 1500);
                    } catch {}
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground flex items-center gap-1"
                  title="Copy description to clipboard"
                >
                  <Copy size={12} /> {textCopyState === 'copied' ? 'Copied!' : 'Copy'}
                </button>
                <button
                  onClick={() => setViewDescription(null)}
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                  title="Close"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {viewDescription.error && (
                <div className="mb-3 p-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-700 dark:text-red-300">
                  <div className="text-[10px] uppercase tracking-wider font-semibold opacity-70 mb-1">Bridge model reported an error</div>
                  <div className="leading-relaxed whitespace-pre-wrap break-words">{viewDescription.error}</div>
                </div>
              )}
              <p className="text-sm whitespace-pre-wrap leading-relaxed">
                {viewDescription.description || '(no description text)'}
              </p>
            </div>
          </div>
        </div>
      )}

      {zoomImage && (
        <div 
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => { setZoomImage(null); setIsZoomedIn(false); }}
        >
          <img 
            src={zoomImage} 
            className={`max-w-full max-h-full transition-transform duration-75 ${isZoomedIn ? 'scale-[2.5] cursor-zoom-out' : 'scale-100 cursor-zoom-in'}`}
            style={isZoomedIn ? { transformOrigin: `${zoomPos.x}% ${zoomPos.y}%` } : {}}
            onClick={(e) => {
              e.stopPropagation();
              if (isZoomedIn) {
                setIsZoomedIn(false);
              } else {
                const { left, top, width, height } = e.currentTarget.getBoundingClientRect();
                const x = ((e.clientX - left) / width) * 100;
                const y = ((e.clientY - top) / height) * 100;
                setZoomPos({ x, y });
                setIsZoomedIn(true);
              }
            }}
            onMouseMove={(e) => {
              if (!isZoomedIn) return;
              const { left, top, width, height } = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - left) / width) * 100;
              const y = ((e.clientY - top) / height) * 100;
              setZoomPos({ x, y });
            }}
            alt="Zoomed attachment"
          />
        </div>
      )}
    </>
  );
}
