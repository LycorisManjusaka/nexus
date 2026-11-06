import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, loginRequiredSync, readLoginSync, verifyToken } from '@/lib/adminAuth';

/**
 * `nodejs`, not the default edge runtime, because the gate has to read
 * `local_data/login.json` and the edge runtime has no filesystem. Measured on
 * Next 16.2.4: the middleware reported `node-v24.15.0` and `fs.existsSync`
 * returned true, on both a page request and an /api request.
 */
export const runtime = 'nodejs';

/**
 * ONE gate for the whole instance.
 *
 * Why here and not in the route handlers: there are 60 `route.ts` files under
 * `app/api/`. Adding a check to each is 60 chances to miss one, and every route
 * added later starts life unprotected — a silent hole that looks like working
 * code. Middleware is the only place every request must pass. Measured: `/`,
 * `/api/version`, `/api/logs`, `/c/Default`, `/favicon.ico` and even
 * `/_next/static/...` all arrive here.
 *
 * NO `config.matcher`. A matcher is a regex in a string, and the failure mode
 * of getting it subtly wrong is "everything is allowed through" — a hole that
 * no type check or passing test will show. The exclusions below are ordinary
 * code: readable, and wrong in a way that shows up as a locked-out login page
 * rather than a silently open door.
 */

function isExempt(pathname: string): boolean {
  // Build output and dev-overlay plumbing. These must stay open or the login
  // page itself cannot paint (it needs its own JS/CSS to render the form).
  // They carry no conversation data — the bundle is the MPL-2.0 source this
  // house intends to publish, and nothing in local_data is served from here.
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/__nextjs')) return true;
  if (pathname === '/favicon.ico') return true;

  // The login page and the endpoints it needs. Guarding these would lock the
  // door from the inside with the key behind it.
  if (pathname === '/login') return true;
  if (pathname.startsWith('/api/auth/')) return true;

  return false;
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isExempt(pathname)) return NextResponse.next();

  // Absence of login.json means the operator has not asked for a gate, which
  // is the shipped default: anyone who can reach the port is in. This is the
  // single cheapest path (one statSync, cached by mtime) and it is the one
  // almost every install takes.
  if (!loginRequiredSync()) return NextResponse.next();

  const rec = readLoginSync();
  if (rec && verifyToken(rec, req.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  // An API caller gets a status code it can act on. Sending it an HTML redirect
  // instead would surface as a JSON parse error deep in some unrelated fetch,
  // which is the kind of lie this house does not ship.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'unauthorized', loginRequired: true },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  // Where the person was heading, so signing in lands them there instead of
  // dumping them at the root. Read back only as a same-origin path — see the
  // login page.
  url.searchParams.set('next', pathname + (search || ''));
  return NextResponse.redirect(url);
}
