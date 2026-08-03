"use client";

import React, { useState } from 'react';
import { Pencil, Trash2, Check, X, FileText, Image as ImageIcon, Music, Video, File, EyeOff, Eye, RefreshCw, Brain, Volume2, Loader2, Copy, Square, Pause, Play, Bookmark, Globe, Link2, CornerDownRight } from 'lucide-react';
import { format } from 'date-fns';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { stripLeadingTimestamps, stripAllTimestamps, isOnlyTimestamps } from '@/lib/timestampStrip';
import { messageCost, resolvePrice } from '@/lib/modelPricing';
import { applyOutputFilter } from '@/lib/outputFilter';
import { attachmentSrc } from '@/lib/attachmentUrl';

export default function MessageBubble({ msg, onEdit, onDelete, onToggleAttachment, onDeleteAttachment, onToggleThinking, reuseThinking = false, onRerun, onContinue, onAudioStateChange, onTtsStatus, globalSettings, folders, folderName, isVRChatMode, isOriginal = true, isFirstOriginal = false, onSetFirstOriginal, onCopyLink, linkCopied = false }: any) {
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
  // Always-current mirrors of msg.content / msg.streaming. The streaming-TTS
  // pipeline and the (intentionally) stale-closure auto-play timer read these
  // refs instead of values captured at an earlier render. Without this, a short
  // reply that finished streaming before the 300ms auto-play timer fired would
  // speak only the first sentence (stale content) and then hang forever (the
  // "done" flag was computed from a stale streaming=true).
  const msgContentRef = React.useRef(msg.content);
  const msgStreamingRef = React.useRef(msg.streaming);
  msgContentRef.current = msg.content;
  msgStreamingRef.current = msg.streaming;
  // Latest-state mirror so handleTTS/stopTTS/handlePauseResume always see the
  // current ttsState rather than a closure-captured value. Without this, a
  // setTimeout from the auto-play effect can call handleTTS 300ms later with
  // a stale "idle" reading and start a SECOND playback while the first is
  // already running — desyncing button state and making Stop unreliable.
  const ttsStateRef = React.useRef<'idle' | 'playing' | 'paused'>('idle');
  React.useEffect(() => { ttsStateRef.current = ttsState; }, [ttsState]);
  // Track the auto-play timer so a manual click (or unmount) can cancel it.
  const autoPlayTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wraps this bubble's rendered content — used to tell whether a text
  // selection belongs to THIS message before "Read Aloud" reads the selection.
  const contentRef = React.useRef<HTMLDivElement>(null);

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
          if (ttsDebug) console.debug('[tts] auto-play firing', { id: msg.id, streaming: !!msgStreamingRef.current, len: (msgContentRef.current || '').length });
          // Always use the streaming pipeline. It now reads live refs, so it
          // also correctly handles a reply that already finished streaming
          // before this timer fired (speaks every sentence, then finishes
          // instead of hanging). Auto-play is only ever an assistant reply in
          // VRChat mode — a single AI voice — so the per-speaker handleTTS path
          // isn't needed here.
          handleStreamingTTS();
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
    // ALWAYS clear this message's "playing" flag when the effect is torn down —
    // on unmount, or before msg.id/ttsState is superseded. Without this, a
    // bubble that unmounts mid-playback (conversation switch, or auto-trim
    // dropping a copied message while its TTS is still going) leaves the
    // parent's audioPlayingStates[msg.id] stuck true. That pins isAudioPlaying
    // true forever, which silently blocks the VRChat send queue: captures keep
    // enqueuing and clearing kohai.txt but never send, until a reboot resets the
    // map. Reporting false on cleanup closes that leak. (A transient false→true
    // during a normal ttsState change is coalesced within one React batch, so
    // it can't spuriously fire a queued send.)
    return () => {
      if (onAudioStateChange) onAudioStateChange(msg.id, false);
    };
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
  // Ordered playback buffer: each synthesized segment is stored under its
  // DISPATCH sequence number (a url, or null for an empty/skipped segment). The
  // player only ever consumes nextPlaySeqRef, so segments always play in the
  // order they were dispatched — never in the order their async synthesis
  // happened to finish (which made short sentences jump ahead).
  const audioSlotsRef = React.useRef<Map<number, string | null>>(new Map());
  const nextDispatchSeqRef = React.useRef(0);
  const nextPlaySeqRef = React.useRef(0);
  const isCurrentlyPlayingRef = React.useRef(false);
  const synthInFlightCountRef = React.useRef(0);
  const streamingVoiceRef = React.useRef<any>(null);
  const streamingSignalRef = React.useRef<AbortSignal | null>(null);
  // Context mode: synthesize larger (paragraph / whole-message) blocks so a
  // context-aware engine (AivisSpeech) can infer emotion from the full text,
  // instead of one flat sentence at a time. Set per folder voice at TTS start.
  const streamingContextRef = React.useRef(false);

  // ── Live TTS diagnostics ───────────────────────────────────────────────────
  // Everything the pipeline knows, pushed up to ChatArea for the on-screen
  // indicator. Kept in a ref and flushed on change: synthesis runs several
  // fetches in parallel and the player advances on audio events, so driving
  // this through state directly would re-render the bubble on every tick.
  const ttsDiagRef = React.useRef<any>({
    active: false, engine: null, engineState: 'unknown', engineError: '',
    mode: 'sentence', dispatched: 0, done: 0, failed: 0, skipped: 0,
    inFlight: 0, buffered: 0, playing: null, lastChars: 0, lastMs: 0,
    lastError: '', streamDone: false,
  });
  const pushTtsDiag = React.useCallback((patch?: any) => {
    const d = ttsDiagRef.current;
    if (patch) Object.assign(d, patch);
    // Only the STREAMING pipeline owns these refs. The Read Aloud path knows its
    // own totals up front and sets them directly, so deriving here would reset
    // it to 0/0 on every push.
    if (streamingActiveRef.current) {
      d.inFlight = synthInFlightCountRef.current;
      d.buffered = audioSlotsRef.current.size;
      d.dispatched = nextDispatchSeqRef.current;
      d.playing = isCurrentlyPlayingRef.current ? nextPlaySeqRef.current - 1 : null;
      d.streamDone = streamingDoneRef.current;
    }
    if (onTtsStatus) onTtsStatus(msg.id, { ...d });
  }, [msg.id, onTtsStatus]);

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

  // Context mode: only treat a PARAGRAPH boundary (a blank line) as "complete",
  // so each synthesized block carries full context. Single-paragraph replies
  // therefore stream nothing mid-generation and get flushed whole at the end.
  const takeCompletedParagraphsFromTail = (text: string): { completed: string; consumed: number } => {
    let lastEnd = -1;
    const re = /\n[ \t]*\n/g;
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
      audioSlotsRef.current.size === 0 &&
      !isCurrentlyPlayingRef.current
    ) {
      streamingActiveRef.current = false;
      streamingSignalRef.current = null;
      ttsStateRef.current = 'idle';
      setTtsState('idle');
      abortControllerRef.current = null;
      pushTtsDiag({ active: false });
    }
  };

  const streamingPlayNext = async (signal: AbortSignal) => {
    if (signal.aborted) return;
    // Pull the NEXT-IN-ORDER segment. Skip past any empty/skipped slots (null).
    // If the next slot hasn't synthesized yet, stop and wait — a completing
    // synthesis will call back in. This guarantees in-order playback.
    let url: string | null = null;
    while (audioSlotsRef.current.has(nextPlaySeqRef.current)) {
      const u = audioSlotsRef.current.get(nextPlaySeqRef.current) ?? null;
      audioSlotsRef.current.delete(nextPlaySeqRef.current);
      nextPlaySeqRef.current++;
      if (u != null) { url = u; break; }
      // u === null → empty/skipped segment; keep scanning in order.
    }
    if (url == null) {
      isCurrentlyPlayingRef.current = false;
      maybeFinishStreaming();
      return;
    }
    isCurrentlyPlayingRef.current = true;
    const audio1 = new Audio(url);
    currentAudioRef.current = audio1;
    // Advance-the-chain handler. It MUST be attached BEFORE play()/awaits: in
    // VRChat dual-device mode we `await` the second device's play() promise
    // below, and a short clip can fire its 'ended' event DURING that await —
    // i.e. before a handler assigned afterwards exists. The missed event left
    // isCurrentlyPlayingRef stuck true and stalled the whole chain (first
    // phrase plays, then silence with the button stuck on "playing"). Setting
    // it up-front, with a one-shot guard, closes that race.
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      URL.revokeObjectURL(url);
      currentAudioRef.current = null;
      currentAudioRef2.current = null;
      streamingPlayNext(signal);
    };
    audio1.onended = advance;
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
      // play() failed → 'ended' will never fire, so advance the chain manually
      // (the one-shot guard prevents a double-advance).
      audio1.onended = null;
      advance();
      return;
    }
  };

  const synthesizeStreamingSegment = async (segment: any, signal: AbortSignal, seq: number) => {
    if (signal.aborted) return;
    synthInFlightCountRef.current++;
    pushTtsDiag({ lastChars: (segment?.text || '').length });
    try {
      const res = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: [segment], folderName }),
        signal,
      });
      // The engine's own account of itself, sent back on every response.
      const dec = (v: string | null) => { try { return v ? decodeURIComponent(v) : ''; } catch { return v || ''; } };
      const engHdr = res.headers.get('X-Tts-Engine');
      pushTtsDiag({
        engine: engHdr !== null && engHdr !== '-1' ? Number(engHdr) : ttsDiagRef.current.engine,
        engineState: res.headers.get('X-Tts-Engine-State') || ttsDiagRef.current.engineState,
        engineError: dec(res.headers.get('X-Tts-Engine-Error')) || ttsDiagRef.current.engineError,
        lastMs: Number(res.headers.get('X-Tts-Ms') || 0),
      });
      if (!res.ok) {
        // Previously the body was thrown away and the slot silently skipped —
        // a failing engine looked exactly like silence. Now the reason surfaces.
        let why = dec(res.headers.get('X-Tts-Error'));
        if (!why) { try { why = (await res.json())?.error || ''; } catch { /* not JSON */ } }
        audioSlotsRef.current.set(seq, null);
        ttsDiagRef.current.failed++;
        pushTtsDiag({ lastError: why || `HTTP ${res.status}` });
        return;
      }
      const blob = await res.blob();
      if (signal.aborted) return;
      if (res.headers.get('X-Tts-Skipped') === '1') ttsDiagRef.current.skipped++;
      // The server returns an empty body (0 bytes) when a segment has no
      // speakable phonemes (symbol/emoji/punctuation-only — it would crash
      // OpenJTalk/VITS). Record the slot as a null (skip) so the in-order player
      // advances past it instead of waiting forever for this sequence number.
      if (blob.size === 0) { audioSlotsRef.current.set(seq, null); pushTtsDiag(); return; }
      audioSlotsRef.current.set(seq, URL.createObjectURL(blob));
      ttsDiagRef.current.done++;
      pushTtsDiag();
    } catch (e: any) {
      // Ignore aborts — stopTTS will have cleaned up. For any other failure,
      // mark the slot skipped so it doesn't block the playback order.
      if (!signal.aborted) {
        audioSlotsRef.current.set(seq, null);
        ttsDiagRef.current.failed++;
        pushTtsDiag({ lastError: e?.message || 'request failed' });
      }
    } finally {
      synthInFlightCountRef.current--;
      pushTtsDiag();
      // Kick the in-order player if idle. If something is already playing, the
      // onended chain will pick this up once earlier sequences have played.
      if (!signal.aborted && !isCurrentlyPlayingRef.current) {
        streamingPlayNext(signal);
      }
      maybeFinishStreaming();
    }
  };

  const processStreamingTick = (signal: AbortSignal) => {
    if (signal.aborted || !streamingActiveRef.current) return;
    const fullText = msgContentRef.current || '';
    const isFirstChunk = streamingProcessedLenRef.current === 0;
    const unprocessed = fullText.slice(streamingProcessedLenRef.current);
    if (!unprocessed) return;
    const ctx = streamingContextRef.current;
    const { completed, consumed } = ctx
      ? takeCompletedParagraphsFromTail(unprocessed)
      : takeCompletedFromTail(unprocessed);
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
    dispatchTtsBlock(textToSpeak, ctx, signal);
  };

  // Dispatch a span of text for synthesis. In context mode the whole block is a
  // SINGLE segment (max context for the engine); otherwise it's split per
  // sentence (lower latency). Each dispatched segment gets the next sequence
  // number so the ordered player keeps everything in order.
  const dispatchTtsBlock = (textToSpeak: string, ctx: boolean, signal: AbortSignal) => {
    if (ctx) {
      if (isOnlyTimestamps(textToSpeak) || !textToSpeak.trim()) return;
      const seq = nextDispatchSeqRef.current++;
      synthesizeStreamingSegment({ text: textToSpeak, ...streamingVoiceRef.current }, signal, seq);
      return;
    }
    const sentences = splitIntoSentenceChunks(textToSpeak);
    for (const s of sentences) {
      // Belt-and-suspenders: when a timestamp stack is split across streaming
      // ticks, a later (non-first) chunk can still start with a lone
      // timestamp. Never queue a segment that is only timestamp(s).
      if (isOnlyTimestamps(s)) continue;
      const seq = nextDispatchSeqRef.current++;
      synthesizeStreamingSegment({ text: s, ...streamingVoiceRef.current }, signal, seq);
    }
  };

  const flushStreamingTail = (signal: AbortSignal) => {
    if (signal.aborted) return;
    const fullText = msgContentRef.current || '';
    const tail = fullText.slice(streamingProcessedLenRef.current).trim();
    if (!tail) return;
    const isFirstChunk = streamingProcessedLenRef.current === 0;
    let textToSpeak = tail;
    if (isFirstChunk) {
      textToSpeak = stripLeadingTimestamps(textToSpeak);
    }
    textToSpeak = applyOutputFilter(textToSpeak, globalSettings);
    streamingProcessedLenRef.current = fullText.length;
    // The tail is the final, un-terminated remainder — in context mode this is
    // typically the whole (single-paragraph) message, sent as one block.
    dispatchTtsBlock(textToSpeak, streamingContextRef.current, signal);
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
    // Fresh run — reset the diagnostics so the indicator reflects THIS play.
    ttsDiagRef.current = { active: true, engine: null, engineState: 'unknown', engineError: '',
      mode: 'sentence', dispatched: 0, done: 0, failed: 0, skipped: 0, inFlight: 0,
      buffered: 0, playing: null, lastChars: 0, lastMs: 0, lastError: '', streamDone: false };
    pushTtsDiag();
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
    // Context mode: explicit per-voice flag, else default ON for AivisSpeech
    // (engine 2) since that's where larger chunks pay off.
    streamingContextRef.current = voice.contextChunks ?? (voice.engine === 2);
    pushTtsDiag({ mode: streamingContextRef.current ? 'context' : 'sentence', engine: voice.engine });

    streamingActiveRef.current = true;
    streamingDoneRef.current = !msgStreamingRef.current;
    streamingProcessedLenRef.current = 0;
    audioSlotsRef.current = new Map();
    nextDispatchSeqRef.current = 0;
    nextPlaySeqRef.current = 0;
    isCurrentlyPlayingRef.current = false;
    synthInFlightCountRef.current = 0;

    // First tick — speak whatever is already complete.
    processStreamingTick(ac.signal);

    // If the message wasn't streaming when TTS was triggered (manual click on a
    // finished message, OR an auto-play timer that fired after the stream ended),
    // flush the tail right now and finish.
    if (!msgStreamingRef.current) {
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
    pushTtsDiag({ active: false });
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
      for (const url of audioSlotsRef.current.values()) {
        if (url) { try { URL.revokeObjectURL(url); } catch {} }
      }
      audioSlotsRef.current = new Map();
      nextDispatchSeqRef.current = 0;
      nextPlaySeqRef.current = 0;
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
    // Fresh run — reset the diagnostics so the indicator reflects THIS play.
    ttsDiagRef.current = { active: true, engine: null, engineState: 'unknown', engineError: '',
      mode: 'sentence', dispatched: 0, done: 0, failed: 0, skipped: 0, inFlight: 0,
      buffered: 0, playing: null, lastChars: 0, lastMs: 0, lastError: '', streamDone: false };
    pushTtsDiag();
    const ac = new AbortController();
    abortControllerRef.current = ac;
    const signal = ac.signal;

    let segments: any[] = [];
    const defaultUserVoice = globalSettings?.userVoice || { engine: 0, char_idx: 1, style_idx: 0, speed: 1.0 };

    // Selection-aware Read Aloud: if the user has highlighted text INSIDE this
    // bubble (and we're not in VRChat mode), speak only the selection — resolved
    // to the correct speaker's voice — instead of the whole message. Anything
    // else (no selection, or selection in another bubble) falls through to the
    // default full-message behavior below.
    //
    // `ttsSource` replaces `msg.content` as the text the segment builder reads;
    // `seedTag` carries the [name] speaker in effect at the selection's start so
    // a partial selection of a multi-speaker user message still uses the right
    // voice.
    let ttsSource = msg.content || '';
    let seedTag = '';
    if (!isVRChatMode && typeof window !== 'undefined') {
      const sel = window.getSelection();
      const selText = sel && sel.rangeCount > 0 ? sel.toString() : '';
      const node = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).commonAncestorContainer : null;
      if (selText.trim() && node && contentRef.current && contentRef.current.contains(node)) {
        ttsSource = selText;
        // Seed the speaker tag from the last [name] before the selection so a
        // mid-message selection of a user turn keeps the right voice.
        if (msg.role === 'user') {
          const probe = selText.trim().slice(0, 24);
          const at = (msg.content || '').indexOf(probe);
          if (at > 0) {
            const tags = (msg.content || '').slice(0, at).match(/\[([^\]]*)\]/g);
            if (tags && tags.length) seedTag = tags[tags.length - 1].slice(1, -1);
          }
        }
      }
    }

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
      // Strip "[YYYY-MM-DD HH:MM:SS]" timestamp tags before sending to TTS.
      // The dateTimeVisibility feature injects these into prompts, and the AI
      // echoes them back — sometimes a whole STACK, sometimes mid-message after
      // a tool call. Hearing the date read out loud breaks immersion, so strip
      // them ALL (anywhere, not just leading) from the spoken text. This is the
      // complete-message path, so an all-strip is offset-safe here.
      const cleaned = stripAllTimestamps(ttsSource);
      // If the whole message was nothing but timestamps, there's nothing to say.
      if (!isOnlyTimestamps(ttsSource) && cleaned.trim()) {
        segments.push({ text: cleaned, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, speed: voice.speed || 1.0, pitch });
      }
    } else {
      const regex = /\[(.*?)\]/g;
      let lastIndex = 0;
      let match;
      let currentTag = seedTag;

      while ((match = regex.exec(ttsSource)) !== null) {
        const textBefore = ttsSource.slice(lastIndex, match.index).trim();
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

      const textAfter = ttsSource.slice(lastIndex).trim();
      if (textAfter) {
        let voice = defaultUserVoice;
        if (currentTag) {
          const v = lookupVoiceForTag(currentTag);
          if (v) voice = v;
        }
        const tagPitch = currentTag ? (folders?.find((f: any) => f.name === currentTag)?.settings?.voicePitch ?? voice.pitch ?? 0.0) : (voice.pitch ?? 0.0);
        segments.push({ text: textAfter, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, speed: voice.speed || 1.0, pitch: tagPitch });
      }

      if (segments.length === 0 && ttsSource.trim()) {
        // Fallback: untagged selection/message → seed voice from seedTag if any.
        let voice = defaultUserVoice;
        if (seedTag) {
          const v = lookupVoiceForTag(seedTag);
          if (v) voice = v;
        }
        const fbPitch = seedTag ? (folders?.find((f: any) => f.name === seedTag)?.settings?.voicePitch ?? voice.pitch ?? 0.0) : (voice.pitch ?? 0.0);
        segments.push({ text: ttsSource.trim(), engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, speed: voice.speed || 1.0, pitch: fbPitch });
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

    // Asynchronously fetch sentences.
    //
    // This is the NON-streaming path (the Read Aloud button): sentences are
    // known up front, so `dispatched` is the real total rather than a running
    // count. Diagnostics are reported here as well as in the streaming path —
    // instrumenting only one of the two would leave the indicator stuck at
    // "chunk 0/0" for the button most used from the UI.
    const dec = (v: string | null) => { try { return v ? decodeURIComponent(v) : ''; } catch { return v || ''; } };
    ttsDiagRef.current.dispatched = sentences.length;
    pushTtsDiag({ mode: 'sentence' });
    for (let i = 0; i < sentences.length; i++) {
      if (signal.aborted) break;
      currentIndex = i + 1;
      ttsDiagRef.current.inFlight = 1;
      pushTtsDiag({ lastChars: (sentences[i]?.text || '').length });
      try {
        const res = await fetch('/api/tts/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: [sentences[i]], folderName }),
          signal
        });
        const engHdr = res.headers.get('X-Tts-Engine');
        pushTtsDiag({
          engine: engHdr !== null && engHdr !== '-1' ? Number(engHdr) : ttsDiagRef.current.engine,
          engineState: res.headers.get('X-Tts-Engine-State') || ttsDiagRef.current.engineState,
          engineError: dec(res.headers.get('X-Tts-Engine-Error')) || ttsDiagRef.current.engineError,
          lastMs: Number(res.headers.get('X-Tts-Ms') || 0),
        });
        if (!res.ok) {
          let why = dec(res.headers.get('X-Tts-Error'));
          if (!why) { try { why = (await res.json())?.error || ''; } catch { /* not JSON */ } }
          ttsDiagRef.current.failed++;
          pushTtsDiag({ lastError: why || `HTTP ${res.status}` });
          continue;
        }
        const blob = await res.blob();
        // Skip empty (0-byte) responses — the server returns no body for
        // phoneme-less segments. Queuing an empty blob stalls playback.
        if (res.headers.get('X-Tts-Skipped') === '1' || blob.size === 0) {
          ttsDiagRef.current.skipped++;
          pushTtsDiag();
          continue;
        }
        const url = URL.createObjectURL(blob);
        audioQueue.push(url);
        ttsDiagRef.current.done++;
        pushTtsDiag();

        // Start playing immediately if we aren't already
        if (!isCurrentlyPlaying && !signal.aborted) {
          playNext();
        }
      } catch(e: any) {
         if (e.name !== 'AbortError') {
           console.error(e);
           ttsDiagRef.current.failed++;
           pushTtsDiag({ lastError: e?.message || 'request failed' });
         }
      } finally {
        ttsDiagRef.current.inFlight = 0;
      }
    }
    pushTtsDiag();
  };

  const getAttachmentPreview = (att: any) => {
    // An attachment's bytes live in ONE of two places, and both are supported
    // permanently — not as a migration window:
    //   • `ref`     — content-addressed payload served by /api/attachments/<ref>.
    //   • `dataUrl` — inline base64, the original format. Every existing backup
    //                 is in this shape, and a restored backup has to still work.
    // Preferring `ref` keeps the heavy path off the page: a `data:` URL has to
    // be held in the document as a string, while a URL streams and caches.
    // `loading="lazy"` means off-screen attachments cost nothing at all, which
    // is most of why media-heavy conversations felt heavy.
    const src = attachmentSrc(att);
    if (att.isImage && src) {
      return <img
        src={src}
        alt={att.name}
        loading="lazy"
        className="max-w-xs max-h-48 rounded-md mt-2 object-contain bg-black/5 cursor-zoom-in hover:opacity-90 transition-opacity"
        onClick={() => setZoomImage(src)}
      />;
    }
    if (att.isVideo && src) {
      return <video src={src} controls preload="metadata" className="max-w-xs rounded-md mt-2" />;
    }
    if (att.isAudio && src) {
      return <audio src={src} controls preload="metadata" className="mt-2 w-full max-w-xs" />;
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
        {/* Generation time — how long this turn took (thinking + tool loops +
            streaming). Display-only, persisted to the log, never sent to the
            entity. Only on AI messages that recorded it. */}
        {!isUser && typeof msg.generationMs === 'number' && msg.generationMs > 0 && (() => {
          const ms = msg.generationMs;
          const label =
            ms < 1000 ? `${ms} ms` :
            ms < 60000 ? `${(ms / 1000).toFixed(1)}s` :
            `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
          return (
            <span
              className="bg-sky-500/15 text-sky-700 dark:text-sky-400 px-2 py-0.5 rounded-full font-mono"
              title={`This turn took ${(ms / 1000).toFixed(1)}s to generate (thinking + tool use + streaming)`}
            >
              ⏱ {label}
            </span>
          );
        })()}
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
            `\n  (includes thinking + files written / tool calls —\n   the plain token count on the left is visible text only)` +
            `\nProvider: ${cu.providerHint || 'unknown'}` +
            `\nTotals cover every API call in this turn (tool loops + subagents).`;
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
              {/* Real billed output from the provider — includes thinking tokens
                  and tool_use payloads (file contents the entity wrote). This is
                  the number that drives cost. Shown here because it used to be
                  hover-only, while the prominent count next to it is textTokens
                  (visible text only, for context-window accounting). */}
              {cu.outputTokens > 0 && (
                <span className="ml-1 opacity-80">· {cu.outputTokens.toLocaleString()} out</span>
              )}
            </span>
          );
        })()}
        {msg.continuationCount > 0 && (
          <span className="bg-amber-500/15 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full" title={`Auto-continued ${msg.continuationCount} time${msg.continuationCount === 1 ? '' : 's'} after hitting the model's output token cap`}>
            ↵ continued ×{msg.continuationCount}
          </span>
        )}
        {/* Estimated cost of this turn — shows only a "$" glyph; the actual USD
            figure is in the hover tooltip (per request). Priced from this
            message's own token usage (cacheUsage) × the model's row in
            modelPricing.json. Skipped for local models. A model with no price
            row shows a muted "$" whose tooltip points at the JSON to edit. */}
        {!isUser && msg.modelFamily !== 'Local' && (() => {
          const modelId = msg.modelSpecific || '';
          if (!resolvePrice(modelId)) {
            return (
              <span
                className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/50 font-mono cursor-default"
                title={`No price configured for "${modelId || 'this model'}".\nAdd it in src/lib/modelPricing.json`}
              >$</span>
            );
          }
          const cost = messageCost(msg.cacheUsage, modelId, displayTokens);
          if (!cost) return null;
          return (
            <span
              className="px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-mono cursor-default"
              title={cost.breakdown}
            >$</span>
          );
        })()}
        {/* Copy a link straight to this message: /c/<folder>/<convoId>/m/<id>.
            Opening it loads the conversation and scrolls here. */}
        {/* A lucide glyph, not an emoji: emoji render in their own fixed colors
            and ignore `text-muted-foreground`, which is what made this sit
            brighter than the timestamp and token count beside it. */}
        {onCopyLink && (
          <button
            onClick={onCopyLink}
            title="Copy a link to this message"
            className="opacity-70 hover:opacity-100 transition"
          >
            {linkCopied ? <Check size={12} /> : <Link2 size={12} />}
          </button>
        )}
      </div>

      {/* Turn-stopped diagnostics. Deliberately rendered OUTSIDE the message
          body: this is Nexus talking to the user about why a turn ended, not
          something the entity said. Keeping it separate is what lets it stay
          out of the reply text, the outgoing context and the token count. */}
      {!isUser && Array.isArray(msg.notices) && msg.notices.length > 0 && (
        <div className="mb-2 max-w-2xl rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          {msg.notices.map((n: string, i: number) => (
            <div key={i} className="flex gap-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              <span aria-hidden>⚠️</span>
              <span>{n}</span>
            </div>
          ))}
          <div className="mt-1 text-[10px] text-amber-700/60 dark:text-amber-300/50">
            Shown to you only — not part of the conversation or the context sent to the model.
          </div>
        </div>
      )}

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
              <details className={`border rounded-xl px-4 py-3 text-sm group/details max-w-full shadow-sm text-muted-foreground transition-colors ${msg.thinkingExcluded ? 'bg-muted/10 border-dashed border-border/60 opacity-60' : 'bg-muted/30 border-border open:bg-muted/50'}`}>
                <summary className="font-semibold cursor-pointer flex items-center gap-2 select-none hover:text-foreground transition-colors outline-none">
                  <Brain size={16} className="text-indigo-400 shrink-0" />
                  <span>Thought Process</span>
                  {/* Reusable-thinking visibility toggle — mirrors attachment
                      exclusion. Shown whenever the entity's "Save & reuse
                      thinking process" toggle is on (we're already inside a
                      `msg.thoughtProcess &&` guard, so thinking text exists).
                      Keyed on thoughtProcess, NOT claudeThinkingBlocks, because
                      the OAuth path stores thinking as text only. */}
                  {reuseThinking && (
                    <>
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleThinking?.(); }}
                        className="ml-auto p-1 rounded hover:bg-muted transition-colors shrink-0"
                        title={msg.thinkingExcluded ? "Include this thinking in context" : "Exclude this thinking from context"}
                      >
                        {msg.thinkingExcluded ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      {msg.thinkingExcluded && (
                        <span className="text-[10px] text-red-500 font-bold bg-red-500/10 rounded px-1.5 py-0.5 shrink-0">EXCLUDED</span>
                      )}
                    </>
                  )}
                </summary>
                <div className="mt-3 pt-3 border-t border-border/50 text-[13px] leading-relaxed whitespace-pre-wrap font-mono opacity-80">
                  {msg.thoughtProcess}
                </div>
              </details>
            )}
            <div ref={contentRef} className={`px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm w-fit max-w-full overflow-hidden ${
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
              <button onMouseDown={(e) => e.preventDefault()} onClick={handleTTS} className={`p-1.5 bg-background border border-border rounded-lg shadow-sm transition-colors text-muted-foreground hover:text-green-500`} title="Read Aloud (select text to read only the selection)">
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
            {!isUser && onContinue && (
              <button
                onClick={onContinue}
                className="p-1.5 bg-background border border-border rounded-lg text-muted-foreground hover:text-amber-500 shadow-sm"
                title="Continue this reply — the model carries on from where it stopped and the new text is appended to this same message"
              >
                <CornerDownRight size={14} />
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
