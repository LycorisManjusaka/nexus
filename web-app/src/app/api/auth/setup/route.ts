import { NextResponse } from 'next/server';
import {
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  buildSessionCookie,
  clearSessionCookie,
  createLoginRecord,
  deleteLogin,
  issueToken,
  readLoginSync,
  validatePasswordPair,
  verifyToken,
  writeLogin,
} from '@/lib/adminAuth';

/**
 * Configure, change, or remove the gate.
 *
 * AUTHORISATION IS DONE HERE, BY HAND. This path is exempt from the middleware
 * (the login page needs `/api/auth/*` open), so if this file did not check for
 * itself, anyone who could reach the port could overwrite the password and lock
 * the operator out of their own machine. The rule:
 *
 *   - no login configured  -> anyone may configure one. That is not a hole; it
 *     is what "no login configured" already means. Every other endpoint is
 *     equally open in that state.
 *   - login configured     -> a valid session cookie is required to change the
 *     password or to remove the gate.
 */

function tokenFrom(req: Request): string | undefined {
  return req.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

function requireSessionIfConfigured(req: Request): NextResponse | null {
  const existing = readLoginSync();
  if (!existing) return null;
  if (verifyToken(existing, tokenFrom(req))) return null;
  return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
}

export async function POST(req: Request) {
  const denied = requireSessionIfConfigured(req);
  if (denied) return denied;

  let username = '';
  let password = '';
  let confirm = '';
  try {
    const body = await req.json();
    username = String(body?.username ?? '').trim();
    password = String(body?.password ?? '');
    confirm = String(body?.confirm ?? '');
  } catch {
    return NextResponse.json({ error: 'badRequest' }, { status: 400 });
  }

  if (!username) return NextResponse.json({ error: 'noUsername' }, { status: 400 });
  if (username.length > 64) return NextResponse.json({ error: 'usernameTooLong' }, { status: 400 });
  const bad = validatePasswordPair(password, confirm);
  if (bad) {
    return NextResponse.json({ error: bad, minLength: MIN_PASSWORD_LENGTH }, { status: 400 });
  }

  const rec = createLoginRecord(username, password);
  await writeLogin(rec);

  // Hand this browser a session in the same response. Without it, saving the
  // setting would immediately lock out the person who just saved it — the gate
  // goes up the instant the file lands, and their next request has no cookie.
  const secure = new URL(req.url).protocol === 'https:';
  return NextResponse.json(
    { ok: true, username: rec.username },
    {
      headers: {
        'Set-Cookie': buildSessionCookie(issueToken(rec), secure),
        'Cache-Control': 'no-store',
      },
    },
  );
}

export async function DELETE(req: Request) {
  const denied = requireSessionIfConfigured(req);
  if (denied) return denied;

  const removed = await deleteLogin();
  return NextResponse.json(
    { ok: true, removed },
    { headers: { 'Set-Cookie': clearSessionCookie(), 'Cache-Control': 'no-store' } },
  );
}
