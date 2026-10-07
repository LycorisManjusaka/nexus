import { NextResponse } from 'next/server';
import {
  buildSessionCookie,
  clearFailures,
  failureDelayMs,
  isBroken,
  issueToken,
  readLoginSync,
  recordFailure,
  verifyPassword,
} from '@/lib/adminAuth';

function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'local';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const rec = readLoginSync();
  if (!rec) {
    // Nothing to sign in to. Reported as a specific condition rather than a
    // wrong-password error, because the two call for opposite actions.
    return NextResponse.json({ error: 'notConfigured' }, { status: 400 });
  }
  if (isBroken(rec)) {
    return NextResponse.json({ error: 'broken' }, { status: 500 });
  }

  let username = '';
  let password = '';
  try {
    const body = await req.json();
    username = String(body?.username ?? '');
    password = String(body?.password ?? '');
  } catch {
    return NextResponse.json({ error: 'badRequest' }, { status: 400 });
  }

  const client = clientKey(req);
  const delay = failureDelayMs(client);
  if (delay > 0) await sleep(delay);

  // The username is compared too, but a mismatch is NOT reported separately:
  // telling a caller "that user does not exist" hands them the account name
  // for free. Both halves failing produce one answer.
  const ok = username.trim() === rec.username && verifyPassword(rec, password);
  if (!ok) {
    recordFailure(client);
    return NextResponse.json({ error: 'invalid' }, { status: 401 });
  }

  clearFailures(client);
  const secure = new URL(req.url).protocol === 'https:';
  return NextResponse.json(
    { ok: true },
    {
      headers: {
        'Set-Cookie': buildSessionCookie(issueToken(rec), secure),
        'Cache-Control': 'no-store',
      },
    },
  );
}
