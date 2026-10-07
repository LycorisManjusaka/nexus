import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/adminAuth';

/**
 * Unconditional: clearing your own cookie needs no proof, and a logout that
 * could fail would leave a signed-in browser with no way out.
 *
 * Only this browser is affected. To hang up every session at once — a lost
 * laptop, a shared cookie — change the password: that rotates the signing
 * secret, and every outstanding token stops verifying.
 */
export async function POST() {
  return NextResponse.json(
    { ok: true },
    { headers: { 'Set-Cookie': clearSessionCookie(), 'Cache-Control': 'no-store' } },
  );
}
