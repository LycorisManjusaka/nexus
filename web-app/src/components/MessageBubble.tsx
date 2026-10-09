"use client";

import React, { useState, useMemo } from 'react';
import { Pencil, Trash2, Check, X, FileText, Image as ImageIcon, Music, Video, File, EyeOff, Eye, RefreshCw, Brain, Volume2, Loader2, Copy, Square, Pause, Play, Bookmark, Globe, Link2, CornerDownRight, Wrench, Scissors, MessageSquare, MoreHorizontal, Download } from 'lucide-react';
import { format } from 'date-fns';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { stripLeadingTimestamps, stripAllTimestamps, isOnlyTimestamps } from '@/lib/timestampStrip';
import { messageCost, resolvePrice } from '@/lib/modelPricing';
import { applyOutputFilter } from '@/lib/outputFilter';
import { attachmentSrc } from '@/lib/attachmentUrl';
import { useT } from '@/lib/i18n';
import { useDevice } from './DeviceProvider';
import ClickTip from './ClickTip';
import { applySinkId } from '@/lib/audioSink';
import { highlightTtsPhrase, reapplyTtsHighlight, clearTtsHighlight } from '@/lib/ttsHighlight';
import { attachmentTokens, attachmentKind, undeliverableReason } from '@/lib/attachmentVisibility';
import { copyText } from '@/lib/clipboard';
import { isLocalFileRef, mediaKindOf, workspaceFileUrl, baseNameOf, makeMarkdownUrlTransform } from '@/lib/inlineMedia';

// Module-level so the reference is stable across renders for free (see the
// memoisation note on mdComponents — react-markdown re-parses every tick).
const MD_URL_TRANSFORM = makeMarkdownUrlTransform(defaultUrlTransform);
const MD_PLUGINS = [remarkGfm, remarkBreaks];

// Audio/TTS runtime conditions go to console.WARN, deliberately, and every
// such site in this file goes through here so the reason lives in one place.
//
// Next's dev overlay patches console.error ONLY (read it:
// next/dist/next-devtools/userspace/app/errors/intercept-console-error.js —
// console.warn is untouched). So a console.error here raises the red "N
// Issues" bubble in the bottom-left corner of a phone, over the composer,
// for conditions that are ordinary rather than broken:
//   • "Failed to fetch" — the tab was backgrounded, the phone changed network,
//     or the dev server recompiled mid-request.
//   • NotAllowedError  — the browser's autoplay policy, which this app is
//     built to expect (it stops TTS and waits for a gesture).
//   • play() rejections on resume, for the same family of reasons.
// None of these are lost by warning instead: each one also lands in the TTS
// diagnostics (pushTtsDiag → the status bar's lastError), which is the surface
// actually built for them and the one a phone user can see.
//
// Do NOT promote these back to console.error to "make them visible". That
// trades a readable indicator for a badge that covers the attach button.
const ttsWarn = (...args: any[]) => console.warn(...args);

// The rendered markdown body, as a memoised leaf.
//
// WHY THIS EXISTS (measured, 2026-10-09): at the time, MessageBubble was not
// memoised, so EVERY ChatArea state change re-rendered every bubble in the
// conversation — and the TTS indicator alone pushes 5-7 status updates per
// spoken phrase. (MessageBubble is memoised now, later the same day; this leaf
// still earns its keep for the renders that DO get through — a streaming
// message, an edit, a TTS state change on this bubble.)
// With 400 messages one such state change cost ~700 ms of blocked main thread
// on this desktop (21 bubbles: ~54 ms), because each bubble re-parsed its
// markdown and React re-reconciled ~66 output nodes per bubble.
//
// react-markdown is a component: if it re-renders it re-parses. Wrapping it in
// React.memo with only (content, components, isUser) — all stable while a
// message is unchanged — lets React bail out of the whole subtree instead.
// The plugin array must be module-level for the same reason.
//
// This also HELPS the TTS highlighter rather than fighting it: the highlight
// holds a Range over real text nodes, and skipping the re-render means those
// nodes are never replaced, so the range stays attached (see the note above
// the content <div> and reapplyTtsHighlight).
const MarkdownBody = React.memo(function MarkdownBody(
  { content, components, isUser }: { content: string; components: any; isUser: boolean },
) {
  return (
    <div className={isUser
      // Inherit color from the bubble (text-primary-foreground) so a custom
      // globals.css theme can recolor user messages. `prose-invert` sets
      // dark-background prose defaults, then [&_*]:text-inherit forces every
      // prose child to pick up the bubble's foreground colour instead of the
      // plugin's hard-coded greys/whites.
      ? 'prose prose-sm max-w-none prose-invert [&_*]:text-inherit'
      : 'prose prose-sm max-w-none dark:prose-invert'}>
      <ReactMarkdown remarkPlugins={MD_PLUGINS} components={components} urlTransform={MD_URL_TRANSFORM}>
        {content}
      </ReactMarkdown>
    </div>
  );
});

function MessageBubble({ msg, onEdit, onDelete, onToggleAttachment, onDeleteAttachment, onToggleThinking, reuseThinking = false, onRerun, onContinue, onAudioStateChange, onSpeakingChange, onTtsStatus, globalSettings, folders, folderName, isVRChatMode, deliveryCtx, isPastMessage = false, isOriginal = true, isFirstOriginal = false, onSetFirstOriginal, onCopyLink, linkCopied = false }: any) {
  const t = useT();
  const { isMobile } = useDevice();
  const isUser = msg.role === 'user';
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(msg.content);
  const [ttsState, setTtsState] = useState<'idle' | 'playing' | 'paused'>('idle');
  // Precise "audio is actually sounding RIGHT NOW" flag, distinct from
  // `ttsState`. `ttsState` goes 'playing' the instant TTS is triggered (the
  // synchronous lock in handleTTS/handleStreamingTTS), which still includes
  // the synthesis/engine-cold-start window where nothing is audible yet — and
  // it stays non-'idle' while paused. The camera's "Speaking" state must mean
  // "voice is audible", so it keys off THIS flag, which is only true between
  // an audio element's actual play() and its end/pause/stop.
  const [isSpeaking, setIsSpeaking] = useState(false);
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
  const [textCopyState, setTextCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Copy-the-message-body feedback. On a phone there is no other way to tell a
  // copy apart from a mis-tap, and a copy that silently fails looks identical
  // to one that worked — so this reports what actually happened, not that the
  // button was pressed.
  const [copiedBody, setCopiedBody] = useState<'idle' | 'ok' | 'fail'>('idle');
  // Tool report popup — the evidence panel for "did it really call the tool?".
  const [toolReportOpen, setToolReportOpen] = useState(false);
  const [zoomPos, setZoomPos] = useState({ x: 50, y: 50 });
  const currentAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const currentAudioRef2 = React.useRef<HTMLAudioElement | null>(null);

  // Markdown overrides that turn a local path in the message body into real
  // media / a real download, so a being can show a picture by writing plain
  // `![](camera/Idle.jpg)` with no tool call and no Nexus-specific syntax.
  //
  // Web URLs and in-app links are passed through untouched (isLocalFileRef
  // decides, see lib/inlineMedia.ts) — measured: `/api/attachments/x.png`,
  // `/c/Cairn/x`, `#frag` and `//cdn.example.com/a.png` all survive the url
  // guard unchanged, so existing messages render exactly as before.
  // NOT passed through: a `data:` URI, which react-markdown's default
  // sanitiser blanks. That is unchanged from before this feature — body-text
  // data: images never rendered — but it is a blank, not a pass-through, and
  // the img branch below is what keeps it from becoming a broken image.
  //
  // MUST be memoised: react-markdown re-parses on every streaming tick, and a
  // fresh components object each render makes React replace the rendered
  // nodes — which would fight the TTS highlighter's direct DOM ranges (see
  // the note above the content <div>).
  const mdComponents = useMemo(() => {
    // Without a folder we cannot build a workspace URL, so leave markdown
    // completely alone rather than emitting ?folder=undefined and rendering a
    // broken image where the plain text used to be.
    if (!folderName) return undefined;
    return {
      img: (props: any) => {
        // Already decoded by MD_URL_TRANSFORM — decoding again here would
        // corrupt a filename containing a literal %20.
        const src = String(props.src || '');
        // The url sanitiser blanks what it refuses (data:, javascript:, ...).
        // Rendering <img src=""> makes React warn and the browser re-request
        // the page as an image; showing the alt text keeps the author's words
        // instead of a broken-image icon. Pre-existing behaviour, surfaced by
        // the console probe for this change.
        if (!src) return <span className="italic opacity-60">{props.alt || ''}</span>;
        if (!isLocalFileRef(src)) return <img {...props} />;
        const kind = mediaKindOf(src);
        const url = workspaceFileUrl(folderName, src);
        if (kind === 'video') {
          // preload="metadata" so a long clip doesn't pull megabytes over the
          // LAN before anyone presses play.
          return <video src={url} controls preload="metadata" className="max-w-full rounded-lg my-2" />;
        }
        if (kind === 'audio') {
          return <audio src={url} controls preload="metadata" className="w-full my-2" />;
        }
        if (kind === 'image') {
          return (
            <img
              src={url}
              alt={props.alt || baseNameOf(src)}
              className="max-w-full h-auto rounded-lg my-2 cursor-zoom-in"
              onClick={() => setZoomImage(url)}
            />
          );
        }
        // Image syntax pointing at something that is not media (e.g. a .zip the
        // model mislabelled). Offering the download beats a broken-image icon.
        return (
          <a href={workspaceFileUrl(folderName, src, true)} download={baseNameOf(src)}
             className="inline-flex items-center gap-1.5 underline">
            <Download size={14} /> {props.alt || baseNameOf(src)}
          </a>
        );
      },
      a: (props: any) => {
        const href = String(props.href || '');   // decoded by MD_URL_TRANSFORM
        if (!isLocalFileRef(href)) {
          return <a {...props} target="_blank" rel="noopener noreferrer" />;
        }
        // A link (as opposed to ![]()) means "give me the file" for every
        // extension — the route sets Content-Disposition: attachment, and the
        // download attribute covers browsers that would otherwise navigate.
        return (
          <a href={workspaceFileUrl(folderName, href, true)} download={baseNameOf(href)}
             className="inline-flex items-center gap-1.5 underline">
            <Download size={14} />
            {props.children}
          </a>
        );
      },
    };
  }, [folderName]);
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

  // Report the precise "actually sounding" flag up to ChatArea for the camera
  // (separate channel from onAudioStateChange above, which stays broad so the
  // VRChat send queue keeps gating on "any TTS activity" — synthesis, playing,
  // or paused — rather than only on audible playback). Cleanup reports false so
  // a bubble that unmounts mid-playback can't leave the camera stuck Speaking.
  React.useEffect(() => {
    if (onSpeakingChange) {
      onSpeakingChange(msg.id, isSpeaking);
    }
    return () => {
      if (onSpeakingChange) onSpeakingChange(msg.id, false);
    };
  }, [isSpeaking, msg.id, onSpeakingChange]);

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
  // Parallel to audioSlotsRef: the TEXT each dispatch sequence speaks. The
  // player knows only urls, so without this there is no way to say which
  // phrase is currently sounding. Written at dispatch, consumed and dropped
  // when its slot plays.
  const segTextRef = React.useRef<Map<number, string>>(new Map());
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
    let playedSeq = -1;
    while (audioSlotsRef.current.has(nextPlaySeqRef.current)) {
      const seq = nextPlaySeqRef.current;
      const u = audioSlotsRef.current.get(seq) ?? null;
      audioSlotsRef.current.delete(seq);
      nextPlaySeqRef.current++;
      if (u != null) { url = u; playedSeq = seq; break; }
      // u === null → empty/skipped segment; keep scanning in order.
      segTextRef.current.delete(seq);
    }
    if (url == null) {
      isCurrentlyPlayingRef.current = false;
      setIsSpeaking(false);
      clearTtsHighlight();
      maybeFinishStreaming();
      return;
    }
    isCurrentlyPlayingRef.current = true;
    setIsSpeaking(true);
    // Tint the phrase about to sound. Decoration only — never awaited, never
    // able to throw into the player (the helper swallows its own failures).
    if (globalSettings?.ttsHighlight !== false) {
      highlightTtsPhrase(contentRef.current, segTextRef.current.get(playedSeq) || '', isUser);
    }
    segTextRef.current.delete(playedSeq);
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
    if (isVRChatMode && (globalSettings?.device1Id || globalSettings?.device1Label)) {
      await applySinkId(audio1, { id: globalSettings.device1Id, label: globalSettings.device1Label }, 'primary');
    }
    const p1 = audio1.play();
    let p2: Promise<void> | null = null;
    if (isVRChatMode && (globalSettings?.device2Id || globalSettings?.device2Label)) {
      const audio2 = new Audio(url);
      currentAudioRef2.current = audio2;
      await applySinkId(audio2, { id: globalSettings.device2Id, label: globalSettings.device2Label }, 'secondary');
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
      segTextRef.current.set(seq, textToSpeak);
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
      segTextRef.current.set(seq, s);
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
      char_name: voice.char_name,
      style_name: voice.style_name,
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
    segTextRef.current = new Map();
    clearTtsHighlight();
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

  // A Range points at real text nodes. While a message is still streaming,
  // react-markdown re-parses on every tick and React can replace the nodes of
  // the block being appended to — which silently detaches the highlight. This
  // costs one `isConnected` check per tick and only re-walks the text when the
  // anchor has actually gone away.
  React.useEffect(() => {
    if (ttsStateRef.current === 'idle') return;
    if (globalSettings?.ttsHighlight === false) return;
    reapplyTtsHighlight(contentRef.current);
  }, [msg.content]);

  // Leaving the conversation mid-speech must not leave a stale tint behind.
  // Guarded: an unrelated bubble unmounting must not clear a highlight that
  // belongs to the bubble currently speaking.
  React.useEffect(() => () => {
    if (ttsStateRef.current !== 'idle') clearTtsHighlight();
  }, []);

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

  // What an attachment costs on the path that will actually run. `att.tokens`
  // is the raw media size measured at attach time, and it is only the truth
  // when the bytes themselves reach the model. A bridged attachment arrives as
  // a text description (so it costs the description), and an attachment the
  // path cannot carry costs nothing. Showing the media figure regardless is how
  // an image the entity never received still looked like it was included.
  const attachTokens = (att: any): number => {
    if (!deliveryCtx) return att.excluded ? 0 : (att.tokens || 0);  // no context → old behavior
    return attachmentTokens(att, !!isPastMessage, deliveryCtx);
  };

  // Why this path cannot carry the attachment, or null when it can. The eye is
  // disabled for these: a button that claims to make an image visible, and does
  // not, is the lie in a smaller box. The REASON is shown too, because the two
  // causes have different escapes — switching billing rescues a past image and
  // does nothing at all for a video.
  const undeliverableWhy = (att: any) =>
    deliveryCtx ? undeliverableReason(attachmentKind(att), !!isPastMessage, deliveryCtx) : null;
  const isUndeliverable = (att: any): boolean => undeliverableWhy(att) !== null;

  if (msg.attachments) {
    msg.attachments.forEach((att: any) => {
      displayTokens += attachTokens(att);
    });
  }

  const handleSave = () => {
    onEdit(editContent);
    setIsEditing(false);
  };

  const handleCopyMarkdown = async () => {
    // copyText, not navigator.clipboard: over plain HTTP (how a phone reaches
    // this house) the clipboard object does not exist and the bare call throws
    // before anything is copied. See lib/clipboard.ts.
    const ok = await copyText(msg.content || '');
    setCopiedBody(ok ? 'ok' : 'fail');
    setTimeout(() => setCopiedBody('idle'), 1600);
  };

  const stopTTS = () => {
    pushTtsDiag({ active: false });
    setIsSpeaking(false);
    clearTtsHighlight();
    segTextRef.current = new Map();
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
      setIsSpeaking(false);
      setTtsState('paused');
    } else if (ttsStateRef.current === 'paused') {
      if (currentAudioRef.current) currentAudioRef.current.play().catch(e => ttsWarn("TTS resume failed", e));
      if (currentAudioRef2.current) currentAudioRef2.current.play().catch(e => ttsWarn("TTS resume failed (secondary device)", e));
      setIsSpeaking(true);
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
    clearTtsHighlight();

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
        segments.push({ text: cleaned, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, char_name: voice.char_name, style_name: voice.style_name, speed: voice.speed || 1.0, pitch });
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
          segments.push({ text: textBefore, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, char_name: voice.char_name, style_name: voice.style_name, speed: voice.speed || 1.0, pitch: tagPitch });
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
        segments.push({ text: textAfter, engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, char_name: voice.char_name, style_name: voice.style_name, speed: voice.speed || 1.0, pitch: tagPitch });
      }

      if (segments.length === 0 && ttsSource.trim()) {
        // Fallback: untagged selection/message → seed voice from seedTag if any.
        let voice = defaultUserVoice;
        if (seedTag) {
          const v = lookupVoiceForTag(seedTag);
          if (v) voice = v;
        }
        const fbPitch = seedTag ? (folders?.find((f: any) => f.name === seedTag)?.settings?.voicePitch ?? voice.pitch ?? 0.0) : (voice.pitch ?? 0.0);
        segments.push({ text: ttsSource.trim(), engine: voice.engine || 0, char_idx: voice.char_idx || 0, style_idx: voice.style_idx || 0, char_name: voice.char_name, style_name: voice.style_name, speed: voice.speed || 1.0, pitch: fbPitch });
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
    // The queue carries the spoken TEXT next to its url so the phrase
    // highlight knows what is sounding. Positional association through
    // `sentences` would break the moment a segment is skipped.
    const audioQueue: { url: string; text: string }[] = [];
    let isCurrentlyPlaying = false;

    const playNext = async () => {
      if (signal.aborted) return;
      if (audioQueue.length > 0) {
        isCurrentlyPlaying = true;
        setIsSpeaking(true);
        const item = audioQueue.shift()!;
        const url = item.url;
        if (globalSettings?.ttsHighlight !== false) {
          highlightTtsPhrase(contentRef.current, item.text, isUser);
        }
        const audio1 = new Audio(url);
        currentAudioRef.current = audio1;
        if (isVRChatMode && (globalSettings?.device1Id || globalSettings?.device1Label)) {
          await applySinkId(audio1, { id: globalSettings.device1Id, label: globalSettings.device1Label }, 'primary');
        }
        let p1 = audio1.play();
        let p2 = null;

        if (isVRChatMode && (globalSettings?.device2Id || globalSettings?.device2Label)) {
          const audio2 = new Audio(url);
          currentAudioRef2.current = audio2;
          await applySinkId(audio2, { id: globalSettings.device2Id, label: globalSettings.device2Label }, 'secondary');
          p2 = audio2.play();
        }

        try {
          await p1;
          if (p2) await p2;
        } catch(e: any) {
          ttsWarn("TTS playback failed:", e);
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
        setIsSpeaking(false);
        if (currentIndex >= sentences.length) {
          clearTtsHighlight();
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
        audioQueue.push({ url, text: sentences[i]?.text || '' });
        ttsDiagRef.current.done++;
        pushTtsDiag();

        // Start playing immediately if we aren't already
        if (!isCurrentlyPlaying && !signal.aborted) {
          playNext();
        }
      } catch(e: any) {
         if (e.name !== 'AbortError') {
           ttsWarn("TTS request failed", e);
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
              title={t('bubble.att.openModal')}
            >
              {t('bubble.att.charsClick').replace('{n}', att.textData.length.toLocaleString())}
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
        {/* User-role messages intentionally have no name label — the partner's
            identity lives in `[username]` tags inside the message content
            (parsed by TTS / MD export / agent log). Old logs that still
            carry `msg.name = "User"` (or the current sentinel `"Anonymous"`)
            simply don't render it here. */}
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
                ? `${msg.modelFamily} / ${msg.modelSpecific || ''}${msg.modelThinking ? t('bubble.thinkingOn') : t('bubble.thinkingOff')}`
                : (msg.modelSpecific || '')
            }
          >
            {msg.modelLabel || `${msg.modelFamily || ''} ${msg.modelSpecific || ''}${msg.modelThinking ? ' Thinking' : ''}`.trim()}
          </span>
        )}
        {/* Time tag — only when the message actually HAS a timestamp. Imported
            messages whose source file carried no time have no `timestamp` field
            (see markdownLogic.ts); rendering them would print "Invalid Date".
            Showing nothing is correct: the time is genuinely unknown. */}
        {typeof msg.timestamp === 'number' && msg.timestamp > 0 && (
          <span>{new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(msg.timestamp))}</span>
        )}
        {displayTokens > 0 && (
          <span className="bg-muted px-2 py-0.5 rounded-full">{t('bubble.tokens').replace('{n}', String(displayTokens))}</span>
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
              title={t('bubble.genTime').replace('{s}', (ms / 1000).toFixed(1))}
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
          const tooltip = t('bubble.cache.tooltip')
            .replace('{total}', cu.totalInputTokens.toLocaleString())
            .replace('{cached}', cu.cachedInputTokens.toLocaleString())
            .replace('{pct}', String(pct))
            .replace('{uncached}', cu.uncachedInputTokens.toLocaleString())
            .replace('{write}', cu.cacheCreationTokens > 0
              ? t('bubble.cache.writeLine').replace('{n}', cu.cacheCreationTokens.toLocaleString())
              : '')
            .replace('{out}', cu.outputTokens.toLocaleString())
            .replace('{provider}', cu.providerHint || 'unknown');
          return (
            <span
              className={`px-2 py-0.5 rounded-full font-mono ${
                hit
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              }`}
              title={tooltip}
            >
              {cu.totalInputTokens.toLocaleString()} {t('bubble.cache.in')}
              {hit && (
                <span className="ml-1 opacity-80">{t('bubble.cache.cached').replace('{n}', cu.cachedInputTokens.toLocaleString()).replace('{pct}', String(pct))}</span>
              )}
              {/* Real billed output from the provider — includes thinking tokens
                  and tool_use payloads (file contents the entity wrote). This is
                  the number that drives cost. Shown here because it used to be
                  hover-only, while the prominent count next to it is textTokens
                  (visible text only, for context-window accounting). */}
              {cu.outputTokens > 0 && (
                <span className="ml-1 opacity-80">{t('bubble.cache.out').replace('{n}', cu.outputTokens.toLocaleString())}</span>
              )}
            </span>
          );
        })()}
        {msg.continuationCount > 0 && (
          <span className="bg-amber-500/15 text-amber-600 dark:text-amber-400 px-2 py-0.5 rounded-full" title={t('bubble.continued.title').replace('{n}', String(msg.continuationCount))}>
            {t('bubble.continued.badge').replace('{n}', String(msg.continuationCount))}
          </span>
        )}
        {/* Estimated cost of this turn — shows only a "$" glyph; the actual USD
            figure is in the tip. Priced from this message's own token usage
            (cacheUsage) × the model's row in modelPricing.json. Skipped for
            local models. A model with no price row shows a muted "$" whose tip
            points at the JSON to edit.
            ClickTip, not a bare `title`: a native tooltip needs a hover, and a
            phone has none — the glyph was unreadable there. The `title` is still
            passed through, so desktop hover is unchanged. */}
        {!isUser && msg.modelFamily !== 'Local' && (() => {
          const modelId = msg.modelSpecific || '';
          if (!resolvePrice(modelId)) {
            return (
              <ClickTip
                className="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/50 font-mono cursor-pointer"
                text={t('bubble.price.none').replace('{model}', modelId || '—')}
              >$</ClickTip>
            );
          }
          const cost = messageCost(msg.cacheUsage, modelId, displayTokens, msg.timestamp);
          if (!cost) return null;
          return (
            <ClickTip
              className="px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 font-mono cursor-pointer"
              text={cost.breakdown}
            >$</ClickTip>
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
            title={t('bubble.copyLink')}
            className="opacity-70 hover:opacity-100 transition"
          >
            {linkCopied ? <Check size={12} /> : <Link2 size={12} />}
          </button>
        )}
        {/* Tool report. Present only when the model actually dispatched at
            least one tool this turn — so its ABSENCE on a reply that claims
            tool use is itself the finding. Shown to the user only; the entity
            never sees this and it is not part of the context. */}
        {!isUser && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0 && (() => {
          // The list also carries `kind: 'event'` entries — things that happened
          // BETWEEN the tool calls (automatic compaction). They are counted
          // separately so the wrench number keeps meaning exactly what it has
          // always meant: tools the model actually dispatched.
          const entries = msg.toolCalls as any[];
          const eventCount = entries.filter((c) => c?.kind === 'event').length;
          const toolCount = entries.length - eventCount;
          return (
            <button
              onClick={() => setToolReportOpen(true)}
              title={(eventCount > 0
                ? t('bubble.toolCallsTitleWithEvents').replace('{e}', String(eventCount))
                : t('bubble.toolCallsTitle')
              ).replace('{n}', String(toolCount))}
              className="flex items-center gap-1 opacity-70 hover:opacity-100 transition"
            >
              {toolCount > 0 && (
                <>
                  <Wrench size={12} />
                  <span className="text-[10px]">{toolCount}</span>
                </>
              )}
              {eventCount > 0 && (
                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <Scissors size={12} />
                  <span className="text-[10px]">{eventCount}</span>
                </span>
              )}
            </button>
          );
        })()}
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
            {t('bubble.noticeFooter')}
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
            <span>{t('bubble.webSources').replace('{n}', String(msg.webSources.length))}</span>
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
                  }`} title={t('bubble.att.toolAction')}>
                    {att.toolAction}
                  </span>
                )}
                {attachTokens(att) > 0 && <span className="text-muted-foreground bg-muted px-1.5 py-0.5 rounded text-[10px]">{attachTokens(att)} t</span>}
                {att.isText && att.textData && (
                  <button
                    onClick={() => setViewTextAttachment({ name: att.name, textData: att.textData })}
                    className="ml-auto p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-indigo-500"
                    title={t('bubble.att.viewFull')}
                  >
                    <FileText size={14} />
                  </button>
                )}
                <button
                  onClick={() => { if (!isUndeliverable(att)) onToggleAttachment(att.id); }}
                  disabled={isUndeliverable(att)}
                  className={`${att.isText && att.textData ? '' : 'ml-auto'} p-1 rounded-md text-muted-foreground ${
                    isUndeliverable(att)
                      ? 'opacity-40 cursor-not-allowed'
                      : 'hover:bg-muted hover:text-foreground'
                  }`}
                  title={
                    undeliverableWhy(att) === 'wire' ? t('bubble.att.undeliverableWireHelp')
                      : undeliverableWhy(att) === 'oauth-transcript' ? t('bubble.att.undeliverableHelp')
                      : att.excluded ? t('bubble.att.include')
                      : t('bubble.att.exclude')
                  }
                >
                  {att.excluded ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                {onDeleteAttachment && (
                  <button
                    onClick={() => onDeleteAttachment(att.id)}
                    className="p-1 rounded-md hover:bg-red-500/10 text-muted-foreground hover:text-red-500"
                    title={t('bubble.att.delete')}
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
                  title={t('bubble.att.viewDesc')}
                >
                  {att.descriptionKind === 'eyes'    ? <Eye size={11} /> :
                   att.descriptionKind === 'ears'    ? <Volume2 size={11} /> :
                   att.descriptionKind === 'watcher' ? <Video size={11} /> :
                                                       <FileText size={11} />}
                  <span className="uppercase tracking-wide">
                    {att.descriptionKind === 'eyes'    ? t('bubble.sense.eyes') :
                     att.descriptionKind === 'ears'    ? t('bubble.sense.ears') :
                     att.descriptionKind === 'watcher' ? t('bubble.sense.watcher') :
                                                        t('bubble.sense.other')}
                  </span>
                  <span className="font-mono opacity-80 truncate max-w-[120px]">{att.descriptionModel || ''}</span>
                  {att.descriptionFromCache && !att.descriptionError && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title={t('bubble.desc.cachedDot')} />
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
              {att.excluded && (
                isUndeliverable(att)
                  // Not a choice anyone made — a statement about the path.
                  ? <div className="text-[10px] text-amber-600 dark:text-amber-400 font-bold mt-1 text-center bg-amber-500/10 rounded py-0.5" title={undeliverableWhy(att) === 'wire' ? t('bubble.att.undeliverableWireHelp') : t('bubble.att.undeliverableHelp')}>{t('bubble.att.undeliverable')}</div>
                  : <div className="text-[10px] text-red-500 font-bold mt-1 text-center bg-red-500/10 rounded py-0.5">{t('bubble.att.excluded')}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Content Bubble.
          Width, non-editing: desktop caps at 85% (leaves the margin the
          hover action bar lives in — see the action-bar comment below).
          Mobile uses `max-w-full`, so `w-fit` on the inner content div +
          `items-end`/`items-start` on the outer column give the Gemini
          shape: a SHORT message hugs its own side, a LONG one fills the
          row. Mobile's action bar sits BELOW the bubble (`top-full`), so
          removing the side margin costs it nothing; desktop's bar sits in
          the margin, which is why desktop keeps the 85% cap. */}
      <div className={`relative group/bubble ${isEditing ? 'w-full max-w-full' : (isMobile ? 'max-w-full' : 'max-w-[85%]')}`}>
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
            {/* Creativity Control itself was deleted (2026-10-08) — nothing
                writes this field any more. The RENDER stays because 21 saved
                log files already carry `creativityLabel` on real messages;
                dropping the render would make history that exists stop being
                visible. Delete this only after those values are gone. */}
            {msg.creativityLabel && !isUser && (
              <div className="text-[10px] font-mono text-indigo-400/70 select-none px-1">
                {msg.creativityLabel.trim()}
              </div>
            )}
            {(() => {
              // The thinking panel now also carries the tool calls inline, in
              // the order they happened (think → call → think). Two reasons it is
              // the right home: the SSE stream already arrives time-ordered, and
              // vessels that HIDE their thinking (ChatGPT, Meta Muse Spark) emit
              // no thinking text at all — so the panel shows ONLY the tool calls,
              // which is the one window into what an opaque model actually did.
              //
              // This is a pure VIEW-layer merge: thoughtProcess (replayed to the
              // model via claudeThinkingBlocks) and toolCalls (display-only,
              // dropped from slimHistory) stay separate structures end to end.
              // Nothing mixed here is ever serialized — "continue this reply" and
              // "reuse thinking" both send claudeThinkingBlocks only, never a
              // tool chip. The 🔧 badge and the copy-all window below are left
              // untouched; this is an addition, not a replacement.
              const thinkingText = msg.thoughtProcess || '';
              const calls: any[] = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
              if (!thinkingText && calls.length === 0) return null;
              // Order chips by where they landed in the thinking stream. Clamp to
              // the text bounds so a wiped/short buffer (betrayal redaction) can't
              // throw; stable on ties by original index, so same-offset chips
              // (hidden-thinking → all 0) keep arrival order. Missing offset
              // (old logs) → end of text, a graceful "all at the bottom".
              const ordered = calls
                .map((c, i) => {
                  const raw = Number(c?.thinkingOffset);
                  const off = Number.isFinite(raw)
                    ? Math.max(0, Math.min(thinkingText.length, raw))
                    : thinkingText.length;
                  return { c, i, off };
                })
                .sort((a, b) => (a.off - b.off) || (a.i - b.i));
              const textSpan = (key: string, s: string) =>
                s ? <span key={key} className="whitespace-pre-wrap font-mono opacity-80">{s}</span> : null;
              const nodes: React.ReactNode[] = [];
              let cursor = 0;
              ordered.forEach(({ c, i, off }) => {
                if (off > cursor) { nodes.push(textSpan(`t${i}`, thinkingText.slice(cursor, off))); cursor = off; }
                const isEvent = c?.kind === 'event';
                const isInterjection = c?.name === 'partner interjection';
                const eventLabel = c?.name === 'automatic compaction'
                  ? t('bubble.tool.event.compaction')
                  : isInterjection
                  ? t('bubble.tool.event.interjection')
                  : String(c?.name ?? '');
                nodes.push(
                  <details key={`c${i}`} className={`my-1.5 rounded-lg border overflow-hidden ${isEvent ? 'border-amber-500/40' : 'border-border'}`}>
                    <summary className={`px-2.5 py-1 flex items-center gap-2 cursor-pointer select-none ${isEvent ? 'bg-amber-500/10' : 'bg-muted/50'}`}>
                      {isEvent
                        ? (isInterjection
                          ? <MessageSquare size={12} className="text-amber-600 dark:text-amber-400 shrink-0" />
                          : <Scissors size={12} className="text-amber-600 dark:text-amber-400 shrink-0" />)
                        : <Wrench size={12} className="text-blue-500 shrink-0" />}
                      <span className={isEvent ? 'text-[11px] font-medium text-amber-700 dark:text-amber-300' : 'font-mono text-[11px] font-medium text-foreground'}>
                        {isEvent ? eventLabel : c.name}
                      </span>
                      {c.at && (
                        <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                          {new Date(c.at).toLocaleTimeString()}
                        </span>
                      )}
                    </summary>
                    <pre className="px-2.5 py-1.5 text-[10px] leading-relaxed whitespace-pre-wrap break-all font-mono max-h-56 overflow-y-auto opacity-90">
                      {(() => { try { return JSON.stringify(c.input, null, 2); } catch { return String(c.input); } })()}
                    </pre>
                  </details>
                );
              });
              if (cursor < thinkingText.length) nodes.push(textSpan('t-end', thinkingText.slice(cursor)));
              return (
                <details className={`border rounded-xl px-4 py-3 text-sm group/details max-w-full shadow-sm text-muted-foreground transition-colors ${msg.thinkingExcluded ? 'bg-muted/10 border-dashed border-border/60 opacity-60' : 'bg-muted/30 border-border open:bg-muted/50'}`}>
                  <summary className="font-semibold cursor-pointer flex items-center gap-2 select-none hover:text-foreground transition-colors outline-none">
                    <Brain size={16} className="text-indigo-400 shrink-0" />
                    <span>{thinkingText ? t('bubble.thoughtProcess') : t('bubble.thoughtProcess.toolsOnly')}</span>
                    {/* Reusable-thinking visibility toggle — mirrors attachment
                        exclusion. Shown only when the reuse toggle is on AND real
                        thinking text exists (a tools-only panel has nothing to
                        exclude from replay). Keyed on thoughtProcess, NOT
                        claudeThinkingBlocks, because OAuth stores thinking as
                        text only. */}
                    {reuseThinking && thinkingText && (
                      <>
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleThinking?.(); }}
                          className="ml-auto p-1 rounded hover:bg-muted transition-colors shrink-0"
                          title={msg.thinkingExcluded ? t('bubble.thinking.include') : t('bubble.thinking.exclude')}
                        >
                          {msg.thinkingExcluded ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        {msg.thinkingExcluded && (
                          <span className="text-[10px] text-red-500 font-bold bg-red-500/10 rounded px-1.5 py-0.5 shrink-0">{t('bubble.thinking.excludedBadge')}</span>
                        )}
                      </>
                    )}
                  </summary>
                  <div className="mt-3 pt-3 border-t border-border/50 text-[13px] leading-relaxed">
                    {nodes}
                  </div>
                </details>
              );
            })()}
            <div ref={contentRef} className={`px-5 py-3.5 rounded-2xl text-[15px] leading-relaxed shadow-sm w-fit max-w-full overflow-hidden ${
              isUser
                ? 'bg-primary text-primary-foreground rounded-tr-sm ml-auto'
                : 'bg-card border border-border text-card-foreground rounded-tl-sm mr-auto'
            }`}>
              {msg.content ? (
                // Memoised leaf — see MarkdownBody. The user/assistant prose
                // classes live inside it so both roles share one memo boundary.
                <MarkdownBody content={msg.content} components={mdComponents} isUser={isUser} />
              ) : (
                msg.attachments?.length > 0
                  ? <span className="italic opacity-50">{t('bubble.attachmentOnly')}</span>
                  : null
              )}
            </div>
          </div>
        )}

        {/* Action Buttons.
            `no-hover:` on the bar is not decoration — see globals.css. In a
            remote session the browser reports no hover-capable pointer, and a
            hover-revealed bar is then unreachable at all. */}
        {/* On mobile: horizontal, BELOW the bubble, tail actions behind a "…".
            Three measured facts forced this shape, in order.
            (1) An early version positioned the bar against the bubble wrapper.
                On mobile the wrapper is now `max-w-full` (full-width when long,
                matching Gemini), so a long bubble leaves NO horizontal margin
                beside it at all — and even back when mobile capped at 85% the
                ~15% leftover was only ~62px on a 414px phone, not enough for a
                horizontal row. That is why it was stacked vertically.
            (2) Stacking moved the problem instead of fixing it. The bar was
                anchored `bottom-2` and grows UPWARD, so on a SHORT message a
                7-8 button column overhangs and covers the message above.
                Reported from a phone: "it overlaps the message above".
            (3) Below the bubble the whole row width is available, so neither
                failure applies. 22px of buttons (`p-1` + a 14px icon) sit
                inside the 24px gutter ChatArea already leaves between messages
                (`space-y-6`). That coupling is real: shrink that spacing and
                this bar starts poking into the next message.
            Anchored to the bubble's own outer edge — user right, assistant
            left — so it grows toward the middle of the screen: into the empty
            space for a short bubble, under the bubble for a long one. Neither
            can run off the edge.
            Trimming to three primary actions is Lizard-kun's call, not a
            layout requirement (all eight fit on a 414px row). It also keeps
            Delete off the first tap, which on a touch screen earns its place.
            DESKTOP IS UNCHANGED: same order, same classes, same position. */}
        {!isEditing && (() => {
          // `p-1.5` on desktop is the original padding, unchanged. `transition-colors`
          // is added per-button below exactly where it already was, so the
          // desktop class sets stay byte-for-byte what they were.
          const btnBase = `${isMobile ? 'p-1' : 'p-1.5'} bg-background border border-border rounded-lg shadow-sm`;
          // The tail actions as DATA, not JSX: they render in two places
          // (inline on desktop, inside the menu on mobile) and the menu has to
          // close itself after acting — a menu still open after you pick from
          // it reads as "nothing happened". Order matches the old bar.
          const tail: Array<{ key: string; run: () => void; label: string; icon: React.ReactNode; tone: string }> = [];
          if (!isUser && onRerun) tail.push({ key: 'rerun', run: onRerun, label: t('bubble.rerun'), icon: <RefreshCw size={14} />, tone: 'text-muted-foreground hover:text-indigo-500' });
          if (!isUser && onContinue) tail.push({ key: 'continue', run: onContinue, label: t('bubble.continue'), icon: <CornerDownRight size={14} />, tone: 'text-muted-foreground hover:text-amber-500' });
          if (onSetFirstOriginal) tail.push({ key: 'first', run: onSetFirstOriginal, label: isFirstOriginal ? t('bubble.firstOriginal.clear') : t('bubble.firstOriginal.set'), icon: <Bookmark size={14} fill={isFirstOriginal ? 'currentColor' : 'none'} />, tone: isFirstOriginal ? 'text-indigo-500 hover:text-muted-foreground' : 'text-muted-foreground hover:text-indigo-500' });
          tail.push({ key: 'delete', run: onDelete, label: isOriginal ? t('bubble.delete.original') : t('bubble.delete.cloned'), icon: <Trash2 size={14} />, tone: 'text-red-400 hover:text-red-500' });
          return (
          <div className={`absolute transition-opacity flex gap-1 ${
            globalSettings?.alwaysShowHoverControls === true
              ? 'opacity-100'
              : 'opacity-0 group-hover/bubble:opacity-100 no-hover:opacity-100'
          } ${isMobile
              ? `top-full ${isUser ? 'right-0' : 'left-0'}`
              : `bottom-2 ${isUser ? 'right-full mr-2' : 'left-full ml-2'}`}`}>
            {ttsState === 'idle' ? (
              <button onMouseDown={(e) => e.preventDefault()} onClick={handleTTS} className={`${btnBase} transition-colors text-muted-foreground hover:text-green-500`} title={t('bubble.tts.read')}>
                <Volume2 size={14} />
              </button>
            ) : (
              <>
                <button onClick={handlePauseResume} className={`${btnBase} transition-colors text-blue-500 hover:text-blue-600`} title={ttsState === 'playing' ? t('bubble.tts.pause') : t('bubble.tts.resume')}>
                  {ttsState === 'playing' ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                </button>
                <button onClick={stopTTS} className={`${btnBase} transition-colors text-red-500 hover:text-red-600`} title={t('bubble.tts.stop')}>
                  <Square size={14} fill="currentColor" />
                </button>
              </>
            )}
            <button
              onClick={handleCopyMarkdown}
              className={`${btnBase} ${
                copiedBody === 'ok' ? 'text-emerald-500'
                  : copiedBody === 'fail' ? 'text-red-500'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={copiedBody === 'fail' ? t('common.copyFailed') : t('bubble.copyMd')}
            >
              {copiedBody === 'ok' ? <Check size={14} />
                : copiedBody === 'fail' ? <X size={14} />
                : <Copy size={14} />}
            </button>
            <button onClick={() => setIsEditing(true)} className={`${btnBase} text-muted-foreground hover:text-foreground`} title={t('bubble.edit')}>
              <Pencil size={14} />
            </button>
            {isMobile
              ? tail.length > 0 && (
                  <ClickTip
                    maxWidth={240}
                    title={t('bubble.more')}
                    className={`${btnBase} text-muted-foreground hover:text-foreground`}
                    panel={(close) => (
                      <div className="flex flex-col gap-0.5">
                        {tail.map((a) => (
                          <button
                            key={a.key}
                            onClick={() => { close(); a.run(); }}
                            className={`flex items-center gap-2 px-2 py-2 rounded text-[12px] text-left hover:bg-muted ${a.tone}`}
                          >
                            {a.icon}
                            <span className="truncate">{a.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  >
                    <MoreHorizontal size={14} />
                  </ClickTip>
                )
              : tail.map((a) => (
                  <button key={a.key} onClick={a.run} className={`${btnBase} ${a.tone}`} title={a.label}>
                    {a.icon}
                  </button>
                ))}
          </div>
          );
        })()}
      </div>
    </div>

      {/* Zoom Modal */}
      {/* Tool report. Lists exactly what the model dispatched this turn, with
          the arguments it passed. Read it against what the reply CLAIMS: a
          message saying "I saved the file" with no Write here means the tool
          call never happened. */}
      {toolReportOpen && (
        <div
          className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setToolReportOpen(false)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Wrench size={16} className="text-blue-500 shrink-0" />
                <span className="text-sm font-medium">{t('bubble.tool.title')}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {t('bubble.tool.count').replace(
                    '{n}',
                    String((msg.toolCalls || []).filter((c: any) => c?.kind !== 'event').length),
                  )}
                </span>
                {(msg.toolCalls || []).some((c: any) => c?.kind === 'event') && (
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
                    {t('bubble.tool.eventCount').replace(
                      '{e}',
                      String((msg.toolCalls || []).filter((c: any) => c?.kind === 'event').length),
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={async () => {
                    const ok = await copyText(JSON.stringify(msg.toolCalls || [], null, 2));
                    setTextCopyState(ok ? 'copied' : 'failed');
                    setTimeout(() => setTextCopyState('idle'), 1500);
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground flex items-center gap-1"
                  title={t('bubble.tool.copyJson')}
                >
                  <Copy size={12} /> {textCopyState === 'copied' ? t('common.copied')
                    : textCopyState === 'failed' ? t('common.copyFailed')
                    : t('common.copy')}
                </button>
                <button
                  onClick={() => setToolReportOpen(false)}
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t('common.close')}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="p-4 overflow-y-auto space-y-3">
              {(msg.toolCalls || []).map((c: any, i: number) => {
              // Events are drawn in the same ordered list — that ordering IS
              // the information ("it happened between which two calls?") — but
              // tinted and un-monospaced so they read as something that
              // happened to the turn, not something the model called.
              const isEvent = c?.kind === 'event';
              const isInterjection = c?.name === 'partner interjection';
              const eventLabel = c?.name === 'automatic compaction'
                ? t('bubble.tool.event.compaction')
                : isInterjection
                ? t('bubble.tool.event.interjection')
                : String(c?.name ?? '');
              return (
                <div key={i} className={`rounded-lg border overflow-hidden ${isEvent ? 'border-amber-500/40' : 'border-border'}`}>
                  <div className={`px-3 py-1.5 flex items-center gap-2 ${isEvent ? 'bg-amber-500/10' : 'bg-muted/50'}`}>
                    <span className="text-[10px] text-muted-foreground w-5 shrink-0">#{i + 1}</span>
                    {isEvent && (isInterjection
                      ? <MessageSquare size={12} className="text-amber-600 dark:text-amber-400 shrink-0" />
                      : <Scissors size={12} className="text-amber-600 dark:text-amber-400 shrink-0" />)}
                    <span className={isEvent ? 'text-xs font-medium text-amber-700 dark:text-amber-300' : 'font-mono text-xs font-medium'}>
                      {isEvent ? eventLabel : c.name}
                    </span>
                    {c.at && (
                      <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                        {new Date(c.at).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                  <pre className="px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all font-mono max-h-64 overflow-y-auto">
                    {(() => {
                      try { return JSON.stringify(c.input, null, 2); }
                      catch { return String(c.input); }
                    })()}
                  </pre>
                  {c.input?._truncated && (
                    <div className="px-3 pb-2 text-[10px] text-amber-600 dark:text-amber-400">
                      {t('bubble.tool.truncated').replace('{n}', Number(c.input._originalChars).toLocaleString())}
                    </div>
                  )}
                </div>
              );
              })}
            </div>
            <div className="px-5 py-2 border-t border-border text-[10px] text-muted-foreground shrink-0">
              {t('bubble.tool.footer')}
            </div>
          </div>
        </div>
      )}

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
                  {t('bubble.att.chars').replace('{n}', viewTextAttachment.textData.length.toLocaleString())}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={async () => {
                    // The old `catch {}` here swallowed the TypeError a phone
                    // throws (no navigator.clipboard off a secure context), so
                    // the button did nothing at all and said nothing either.
                    const ok = await copyText(viewTextAttachment.textData);
                    setTextCopyState(ok ? 'copied' : 'failed');
                    setTimeout(() => setTextCopyState('idle'), 1500);
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground flex items-center gap-1"
                  title={t('bubble.copyFile')}
                >
                  <Copy size={12} /> {textCopyState === 'copied' ? t('common.copied')
                    : textCopyState === 'failed' ? t('common.copyFailed')
                    : t('common.copy')}
                </button>
                <button
                  onClick={() => setViewTextAttachment(null)}
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t('common.close')}
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
                    {viewDescription.kind === 'eyes'    ? t('bubble.sense.eyes') :
                     viewDescription.kind === 'ears'    ? t('bubble.sense.ears') :
                     viewDescription.kind === 'watcher' ? t('bubble.sense.watcherLong') :
                                                          t('bubble.sense.bridge')}
                    {' · '}
                    <span className="font-mono">{viewDescription.model}</span>
                    {viewDescription.fromCache && <span className="ml-2 text-emerald-600">{t('bubble.desc.cached')}</span>}
                    {viewDescription.generatedAt && (
                      <span className="ml-2">{format(new Date(viewDescription.generatedAt), 'yyyy-MM-dd HH:mm')}</span>
                    )}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={async () => {
                    const ok = await copyText(viewDescription.description);
                    setTextCopyState(ok ? 'copied' : 'failed');
                    setTimeout(() => setTextCopyState('idle'), 1500);
                  }}
                  className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted text-muted-foreground hover:text-foreground flex items-center gap-1"
                  title={t('bubble.copyDesc')}
                >
                  <Copy size={12} /> {textCopyState === 'copied' ? t('common.copied')
                    : textCopyState === 'failed' ? t('common.copyFailed')
                    : t('common.copy')}
                </button>
                <button
                  onClick={() => setViewDescription(null)}
                  className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t('common.close')}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {viewDescription.error && (
                <div className="mb-3 p-3 rounded-md border border-red-500/40 bg-red-500/10 text-sm text-red-700 dark:text-red-300">
                  <div className="text-[10px] uppercase tracking-wider font-semibold opacity-70 mb-1">{t('bubble.desc.errorHeading')}</div>
                  <div className="leading-relaxed whitespace-pre-wrap break-words">{viewDescription.error}</div>
                </div>
              )}
              <p className="text-sm whitespace-pre-wrap leading-relaxed">
                {viewDescription.description || t('bubble.desc.noText')}
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
            alt={t('bubble.zoomAlt')}
          />
        </div>
      )}
    </>
  );
}

// Memoised with the DEFAULT shallow comparison — no custom comparator.
//
// MEASURED 2026-10-09: unmemoised, one ChatArea state change re-rendered every
// bubble in the conversation (696 ms of blocked main thread at 400 messages;
// 70 ms after the MarkdownBody memo above). The streaming path flushes once per
// animation frame, so that was the whole frame budget — which is why typing
// felt sluggish while a reply was being written.
//
// A hand-written comparator is deliberately avoided: forgetting one prop there
// freezes a bubble for the rest of the session, and nothing fails loudly. The
// default compare is only useful because ChatArea feeds this component stable
// props — the nine per-message callbacks come from its cached `bubbleCallbacks`
// bundle, and `deliveryCtx` / `onTtsStatus` / `onAudioStateChange` /
// `onSpeakingChange` are memoised there too. If a future prop is added as an
// inline arrow at the call site, memoisation silently stops helping (it will
// not break correctness) — add it to the bundle instead.
export default React.memo(MessageBubble);
