import { NextResponse } from 'next/server';
import { getSession, emit } from '@/lib/liveSession';
import { resolveCurrentChara } from '@/lib/charaResolver';

export async function POST(req: Request) {
  const s = getSession();
  if (!s || s.closed) {
    return NextResponse.json({ error: 'No active live session.' }, { status: 400 });
  }
  const live = (s as any).live;
  if (!live) {
    return NextResponse.json({ error: 'Live session not connected.' }, { status: 400 });
  }
  if (!s.setupComplete) {
    return NextResponse.json({ error: 'Session is still initializing.' }, { status: 425 });
  }

  const body = await req.json();
  const { text } = body;
  if (!text || typeof text !== 'string') {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  const { name: userLabel } = resolveCurrentChara();
  // Suppress the prefix when the resolved name is the literal fallback
  // "Anonymous" (or legacy "User", or empty) — same convention as InputArea.
  const labeled = (userLabel && userLabel !== 'User' && userLabel !== 'Anonymous') ? `[${userLabel}] ${text}` : text;
  s.transcripts.push({ ts: Date.now(), role: 'user', text: labeled });
  emit({ type: 'transcript_delta', role: 'user', text: labeled });

  try {
    live.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: labeled }] }],
      turnComplete: true,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
