import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Modality } from '@google/genai';
import { loadKeys } from '@/lib/fsStorage';
import { resolveCurrentChara } from '@/lib/charaResolver';
import { getSession, setSession, emit, teardown, type LiveSessionState } from '@/lib/liveSession';
import { kohaiPath, earLogPath } from '@/lib/voicechangerPaths';

const KOHAI_PATH = kohaiPath();
const EAR_PATH = earLogPath();

export async function POST(req: Request) {
  // If a previous session is still hanging around (closed or not), force-clean
  // it so the user is never permanently locked out by a stale singleton.
  const stale = getSession();
  if (stale) {
    console.warn('[live] start: clearing stale previous session (closed=' + stale.closed + ')');
    try { teardown(); } catch {}
    try { setSession(null); } catch {}
  }

  const body = await req.json();
  const {
    model = 'gemini-2.5-flash-preview-native-audio-dialog',
    apiVersion = 'v1alpha',    // which API version the model lives on; discovered upstream
    systemPrompt = '',
    seedMessages = [],         // [{role, name, content, attachments?}]  (already filtered to "original")
    contextLimit = 20000,
    vrchatPath = null,
    voiceName = 'Aoede',       // optional voice for native audio
  } = body;

  const keys = await loadKeys();
  if (!keys.gemini) {
    return NextResponse.json({ error: 'Gemini API key missing in settings.' }, { status: 400 });
  }

  // Use the API version that the discovery step found this model on
  const ai = new GoogleGenAI({
    apiKey: keys.gemini,
    httpOptions: { apiVersion },
  });

  // Build seed system text
  const historyTranscript = seedMessages.map((m: any) => {
    const who = m.role === 'assistant' ? '[assistant]' : `[${m.name || 'Anonymous'}]`;
    return `${who} ${m.content || ''}`;
  }).join('\n');
  const fullSystem = [
    systemPrompt,
    historyTranscript ? `\n\n--- Prior conversation transcript ---\n${historyTranscript}\n--- End transcript ---\nResume conversation naturally from this point.` : '',
  ].filter(Boolean).join('\n');

  const sessionId = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  const session: LiveSessionState = {
    sessionId,
    ws: null,
    setupComplete: false,
    controller: null,
    encoder: new TextEncoder(),
    bufferedEvents: [],
    watchers: [],
    filePos: { kohai: 0, ear: 0 },
    transcripts: [],
    images: [],
    cumulativeTokens: 0,
    contextLimit,
    pendingAssistantText: '',
    pendingAssistantThought: '',
    startedAt: Date.now(),
    closed: false,
  };
  setSession(session);

  try { session.filePos.kohai = fs.existsSync(KOHAI_PATH) ? fs.statSync(KOHAI_PATH).size : 0; } catch {}
  try { session.filePos.ear   = fs.existsSync(EAR_PATH)   ? fs.statSync(EAR_PATH).size   : 0; } catch {}

  let messageCount = 0;
  let audioChunksThisTurn = 0;

  let liveSession: any;
  try {
    liveSession = await ai.live.connect({
      model: model.startsWith('models/') ? model : `models/${model}`,
      config: {
        responseModalities: [Modality.AUDIO],
        ...(voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } : {}),
        ...(fullSystem ? { systemInstruction: { parts: [{ text: fullSystem }] } } : {}),
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          console.log('[live] connected to Gemini Live, model =', model, 'apiVersion =', apiVersion);
          emit({ type: 'starting' });
        },
        onmessage: (msg: any) => {
          const s = getSession();
          // Ownership check — ignore messages from sessions that have been
          // superseded (hot-reload, manual restart, etc.). Without this an
          // orphan WS would push messages onto whatever new session exists.
          if (!s || s.closed || s.sessionId !== sessionId) return;
          messageCount++;
          // Log a compact summary of every message so we can see turnComplete arrivals
          const summary = JSON.stringify(msg).slice(0, 240);
          console.log('[live] msg', messageCount, '←', summary);

          if (msg.setupComplete) {
            s.setupComplete = true;
            emit({ type: 'ready' });
            return;
          }
          const sc = msg.serverContent;
          if (sc) {
            if (sc.modelTurn?.parts) {
              for (const part of sc.modelTurn.parts) {
                if (part.inlineData?.mimeType?.startsWith('audio/') && part.inlineData.data) {
                  audioChunksThisTurn++;
                  emit({ type: 'audio', mime: part.inlineData.mimeType, data: part.inlineData.data });
                }
                if (part.text) {
                  if (part.thought === true) {
                    // Internal reasoning — keep separate from spoken transcript
                    s.pendingAssistantThought += part.text;
                    emit({ type: 'thought_delta', role: 'assistant', text: part.text });
                  } else {
                    s.pendingAssistantText += part.text;
                    emit({ type: 'transcript_delta', role: 'assistant', text: part.text });
                  }
                }
              }
            }
            if (sc.outputTranscription?.text) {
              s.pendingAssistantText += sc.outputTranscription.text;
              emit({ type: 'transcript_delta', role: 'assistant', text: sc.outputTranscription.text });
            }
            if (sc.turnComplete) {
              const visibleText = s.pendingAssistantText.trim();
              const thoughtText = s.pendingAssistantThought.trim();
              console.log(`[live] turnComplete: visible=${visibleText.length}c thought=${thoughtText.length}c transcripts=${s.transcripts.length} audioChunks=${audioChunksThisTurn}`);
              // If we got text but no audio, the model fell back to text-only
              // (common with 3.x at large context). Surface it so the user knows.
              if (visibleText && audioChunksThisTurn === 0) {
                console.warn('[live] turn ended with text but NO audio — model returned text-only (likely a Gemini-side limit at this context size)');
                emit({
                  type: 'no_audio_warning',
                  message: 'Gemini returned text only — falling back to local TTS.',
                  text: visibleText,
                });
              }
              audioChunksThisTurn = 0;
              if (visibleText || thoughtText) {
                s.transcripts.push({
                  ts: Date.now(),
                  role: 'assistant',
                  text: visibleText,
                  ...(thoughtText ? { thought: thoughtText } : {}),
                });
                console.log(`[live] pushed assistant transcript (now ${s.transcripts.length})`);
              }
              s.pendingAssistantText = '';
              s.pendingAssistantThought = '';
              emit({ type: 'turn_complete', role: 'assistant' });
            }
          }
          if (msg.usageMetadata?.totalTokenCount) {
            s.cumulativeTokens = msg.usageMetadata.totalTokenCount;
            emit({ type: 'usage', tokens: s.cumulativeTokens });
            if (s.cumulativeTokens > s.contextLimit) {
              emit({ type: 'limit_reached', tokens: s.cumulativeTokens, limit: s.contextLimit });
              teardown();
            }
          }
        },
        onerror: (e: any) => {
          console.error('[live] error:', e);
          emit({ type: 'error', message: e?.message || String(e) });
        },
        onclose: (e: any) => {
          console.log('[live] close:', e?.code, e?.reason);
          const s = getSession();
          if (s && !s.setupComplete) {
            const reason = e?.reason ? ` reason=${e.reason}` : '';
            const code = e?.code ? ` code=${e.code}` : '';
            emit({ type: 'error', message: `Gemini Live closed before setup completed.${code}${reason}` });
          }
          emit({ type: 'closed' });
        },
      },
    });
    // Stash the SDK session object so input/stop routes can use it.
    (session as any).live = liveSession;
  } catch (e: any) {
    console.error('[live] connect failed:', e);
    emit({ type: 'error', message: e?.message || 'Failed to connect to Gemini Live' });
    teardown();
    setSession(null);
    return NextResponse.json({ error: e?.message || 'connect failed' }, { status: 500 });
  }

  // ---- File tailing for kohai.txt and ear_log.txt ----
  const tailFile = (filePath: string, posKey: 'kohai' | 'ear', role: 'user' | 'human') => {
    if (!fs.existsSync(filePath)) return null;
    const watcher = fs.watch(filePath, async () => {
      const s = getSession();
      // Ownership check + setup gate — see message handler comment above.
      if (!s || s.closed || s.sessionId !== sessionId || !s.setupComplete) return;
      try {
        const stat = fs.statSync(filePath);
        if (stat.size <= s.filePos[posKey]) {
          if (stat.size < s.filePos[posKey]) s.filePos[posKey] = 0; // truncated
          return;
        }
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(stat.size - s.filePos[posKey]);
        fs.readSync(fd, buf, 0, buf.length, s.filePos[posKey]);
        fs.closeSync(fd);
        s.filePos[posKey] = stat.size;
        const text = buf.toString('utf-8');
        for (const rawLine of text.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          // Skip voice_changer.py engine/character/style header lines like
          // "[1-3-0]" that get written when switching voices. These are voice
          // state markers, not user speech, and would confuse Gemini.
          if (/^\[\d+-\d+-\d+\]$/.test(line)) {
            console.log('[live] skipping voice header line:', line);
            continue;
          }
          // Strip HH:MM:SS timestamp prefix
          const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(?:\(.*?\)\s*)?(.*)$/);
          const cleanText = m ? m[2] : line;
          if (!cleanText) continue;
          // Resolve character name fresh on each line — user may switch voices mid-session
          const { name: userLabel, humanLabel } = resolveCurrentChara();
          const tag = role === 'user' ? userLabel : humanLabel;
          // Skip the prefix for the literal fallback "Anonymous" (or legacy
          // "User", or empty) — same convention as the regular chat input.
          const labeled = (tag && tag !== 'User' && tag !== 'Anonymous') ? `[${tag}] ${cleanText}` : cleanText;
          // Store the labeled text in transcripts so the merged log preserves the prefix
          s.transcripts.push({ ts: Date.now(), role, text: labeled });
          console.log(`[live] pushed ${role} transcript from ${posKey}: "${labeled.slice(0, 80)}" (now ${s.transcripts.length})`);
          emit({ type: 'transcript_delta', role, text: cleanText });
          // Send to Gemini via SDK session
          const live = (s as any).live;
          if (live) {
            try {
              live.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: labeled }] }],
                turnComplete: true,
              });
            } catch (e: any) { console.error('[live] sendClientContent failed:', e?.message); }
          }
        }
      } catch (e: any) {
        emit({ type: 'error', message: `tail ${posKey}: ${e.message}` });
      }
    });
    return watcher;
  };

  const w1 = tailFile(KOHAI_PATH, 'kohai', 'user');
  const w2 = tailFile(EAR_PATH, 'ear', 'human');
  if (w1) session.watchers.push(w1);
  if (w2) session.watchers.push(w2);

  // ---- VRChat folder watcher ----
  if (vrchatPath && fs.existsSync(vrchatPath)) {
    const vw = fs.watch(vrchatPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return;
      const fullPath = path.join(vrchatPath, filename.toString());
      // Delay a moment to allow file write to finish
      setTimeout(async () => {
        const s = getSession();
        if (!s || s.closed || s.sessionId !== sessionId || !s.setupComplete) return;
        if (!fs.existsSync(fullPath)) return;
        try {
          const buf = fs.readFileSync(fullPath);
          // Convert PNG → JPEG via sharp if available, else send as-is
          let mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          let data = buf;
          try {
            // Dynamic import — sharp may or may not be installed
            const sharp = (await import('sharp')).default;
            const out = await sharp(buf).resize(1568, 1568, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
            data = out;
            mime = 'image/jpeg';
          } catch { /* fall through with original bytes */ }
          const b64 = data.toString('base64');
          s.images.push({ ts: Date.now(), filePath: fullPath, dataUrl: `data:${mime};base64,${b64}`, width: 0, height: 0 });
          emit({ type: 'image_sent', filename: filename.toString() });
          const live = (s as any).live;
          if (live) {
            try {
              live.sendClientContent({
                turns: [{
                  role: 'user',
                  parts: [
                    { text: `<attached_file name="${filename}" type="${mime}" />` },
                    { inlineData: { mimeType: mime, data: b64 } },
                  ],
                }],
                turnComplete: true,
              });
            } catch (e: any) { console.error('[live] sendClientContent (image) failed:', e?.message); }
          }
        } catch (e: any) {
          emit({ type: 'error', message: `vrchat image: ${e.message}` });
        }
      }, 800);
    });
    session.watchers.push(vw);
  }

  return NextResponse.json({ ok: true });
}
