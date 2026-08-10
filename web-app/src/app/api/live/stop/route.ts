import { NextResponse } from 'next/server';
import { getSession, setSession, teardown, type LiveTranscriptEntry } from '@/lib/liveSession';

/**
 * Merge consecutive same-role transcripts into single grouped messages
 * and return them as Nexus-style messages ready to splice into the chat log.
 */
function mergeAndGroup(entries: LiveTranscriptEntry[]) {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const grouped: { ts: number; role: 'user' | 'human' | 'assistant'; texts: string[]; thoughts: string[] }[] = [];
  for (const e of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.role === e.role) {
      if (e.text) last.texts.push(e.text);
      if (e.thought) last.thoughts.push(e.thought);
    } else {
      grouped.push({
        ts: e.ts,
        role: e.role,
        texts: e.text ? [e.text] : [],
        thoughts: e.thought ? [e.thought] : [],
      });
    }
  }
  return grouped.map(g => {
    // Map our internal "human" role to "user" for Nexus storage; the [人]
    // (or whatever humanLabel resolves to) prefix is already inside the text,
    // applied by the start route at line-arrival time.
    const role = g.role === 'assistant' ? 'assistant' : 'user';
    const body = g.texts.join(' ');
    const thought = g.thoughts.join('\n\n');
    return {
      role,
      content: body,
      timestamp: g.ts,
      ...(thought ? { thoughtProcess: thought } : {}),
    };
  });
}

export async function POST() {
  console.log('[live] >>> STOP called');
  const s = getSession();
  if (!s) {
    console.warn('[live] STOP: no session in memory');
    return NextResponse.json({ ok: true, messages: [], images: [], note: 'no active session' });
  }

  // Flush any in-flight assistant text/thought into transcripts BEFORE merging.
  // If the user presses Stop while the model is mid-reply, turnComplete never
  // fires and pendingAssistantText would otherwise be silently discarded.
  if (s.pendingAssistantText.trim() || s.pendingAssistantThought.trim()) {
    s.transcripts.push({
      ts: Date.now(),
      role: 'assistant',
      text: s.pendingAssistantText.trim(),
      ...(s.pendingAssistantThought.trim() ? { thought: s.pendingAssistantThought.trim() } : {}),
    });
    s.pendingAssistantText = '';
    s.pendingAssistantThought = '';
  }

  console.log(
    `[live] stop: ${s.transcripts.length} transcripts, ${s.images.length} images, ` +
    `${s.cumulativeTokens} tokens cumulative, duration ${Date.now() - s.startedAt}ms`
  );
  if (s.transcripts.length > 0) {
    console.log('[live] first transcript entry:', JSON.stringify(s.transcripts[0]).slice(0, 240));
    console.log('[live] last transcript entry:', JSON.stringify(s.transcripts[s.transcripts.length - 1]).slice(0, 240));
  } else {
    console.warn('[live] no transcript entries captured during this session — check that kohai.txt was tailed and that outputAudioTranscription was enabled');
  }

  // Always teardown + null the session, even if merge throws.
  let finalMessages: any[] = [];
  let images: any[] = [];
  let mergeError: string | null = null;
  try {
    finalMessages = mergeAndGroup(s.transcripts);
    images = s.images.map(i => ({
      ts: i.ts,
      name: i.filePath.split(/[\\/]/).pop() || 'vrchat.jpg',
      dataUrl: i.dataUrl,
    }));
  } catch (e: any) {
    mergeError = e?.message || String(e);
    console.error('[live] stop merge error:', e);
  }

  try { teardown(); } catch (e: any) { console.error('[live] stop teardown error:', e); }
  try { setSession(null); } catch {}

  return NextResponse.json({
    ok: true,
    messages: finalMessages,
    images,
    transcriptCount: s.transcripts.length,
    cumulativeTokens: s.cumulativeTokens,
    durationMs: Date.now() - s.startedAt,
    ...(mergeError ? { mergeError } : {}),
  });
}
