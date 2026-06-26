import { NextResponse } from 'next/server';
import { resolveAsk, type AskAnswer } from '@/lib/askUser';

// Receives the user's selection for an in-flight AskUserQuestion and resolves
// the paused tool handler waiting in /api/chat (via the globalThis rendezvous).
// Returns { ok: false } if the question already resolved / timed out / unknown.
export async function POST(req: Request) {
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const askId = body?.askId;
  const answers = body?.answers;
  if (typeof askId !== 'string' || !askId || !Array.isArray(answers)) {
    return NextResponse.json({ error: 'Missing askId or answers' }, { status: 400 });
  }
  // Light shape guard — each answer is { question, answers: string[] }.
  const clean: AskAnswer[] = answers
    .filter((a: any) => a && typeof a.question === 'string' && Array.isArray(a.answers))
    .map((a: any) => ({
      header: typeof a.header === 'string' ? a.header : undefined,
      question: String(a.question),
      answers: a.answers.map((x: any) => String(x)).filter(Boolean),
    }));
  const ok = resolveAsk(askId, clean);
  return NextResponse.json({ ok });
}
