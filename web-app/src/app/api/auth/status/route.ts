import { NextResponse } from 'next/server';
import { SESSION_COOKIE, isBroken, readLoginSync, verifyToken } from '@/lib/adminAuth';

/**
 * Exempt from the gate (the login page and the settings panel both need to know
 * whether a gate exists), so this answers to anyone who can reach the port.
 *
 * It therefore says as little as it can: whether a gate is configured, and
 * whether THIS caller is already through it. The admin's username is returned
 * only to a caller who has already proved it knows the password — an
 * unauthenticated reader learns a boolean, not a name to guess against.
 */
export async function GET(req: Request) {
  const rec = readLoginSync();
  const enabled = rec !== null;
  const token = req.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const authenticated = !!(rec && verifyToken(rec, token));
  return NextResponse.json(
    {
      enabled,
      authenticated,
      // A hand-broken or truncated login.json is reported rather than silently
      // treated as "no login" — the gate stays shut and the operator is told
      // why, with the documented way out (delete the file).
      broken: enabled && isBroken(rec),
      username: authenticated && rec && !isBroken(rec) ? rec.username : undefined,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
