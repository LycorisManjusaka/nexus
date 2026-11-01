// ── gzip for the JSON that actually costs something ─────────────────────────
//
// WHY THIS EXISTS (measured 2026-11-01):
//
// Everything NEXUS puts on the wire is gzipped EXCEPT the one thing that is
// big. HTML and the JS chunks go through Next's compression middleware (4.5×
// on the chunks). API route handlers do not: measured by sending the same
// request with and without `Accept-Encoding: gzip` and comparing bytes —
// identical, and the response carries no `Vary: Accept-Encoding`, which is
// that middleware's signature. The middleware is mounted in the router layer
// and the route handler's Response does not pass through it.
//
// Measured over all 305 real conversations in this house, `GET /api/logs/<id>`:
//
//   p50   426 KB  ->  154 KB gzip   (2.8x)
//   p90 2,027 KB  ->  668 KB
//   p100 5,144 KB -> 1,610 KB
//
// And that payload is re-fetched at the END OF EVERY TURN (ChatArea reloads
// the whole log from disk to adopt what the runner saved), not just when a
// conversation is opened. On a slow link it is paid once per message.
//
// ── Why a `plan` function and not just an if ────────────────────────────────
//
// The decision has four inputs (header present? gzip listed? q=0? body big
// enough?) and lives in a route handler, where `next/server` makes unit tests
// impossible (measured 10-27: 68 API routes, zero tests). Same reason
// resolveActiveTurn, decideRunRecord, showStockPanel and shouldReloadFromDisk
// were pulled out: a rule inside a handler is a rule no test and no mutation
// check can reach.
//
// ── X-Raw-Length is NOT decoration (measured 2026-11-01) ────────────────────
//
// ChatArea shows a progress bar while a conversation downloads. It divides
// bytes counted off the ReadableStream by a total taken from a header. The
// browser transparently inflates a gzipped body, so the numerator is
// UNCOMPRESSED bytes; dividing by the COMPRESSED wire length would put the bar
// at 100% around 36% and print "0.42 / 0.15 MB".
//
// And the thing that was actually there is smaller than that: measured on this
// house's dev server, `GET /api/logs/<id>` answers `Transfer-Encoding: chunked`
// with NO Content-Length, gzip or not. The bar has always been in its
// indeterminate mode. X-Raw-Length is the first denominator it has ever had —
// so this header is not damage control for gzip, it is the one new thing a
// person on a slow link gets out of this change.
//
// Either way the rule is the same: state the pre-compression size explicitly
// so both sides of the division are in the same units.

import { promisify } from 'util';
import { gzip as gzipCb } from 'zlib';

const gzipBuffer = promisify(gzipCb);

/**
 * gzip, returning a view a `Response` body will accept.
 *
 * zlib hands back a `Buffer<ArrayBufferLike>`, which does not satisfy
 * `BodyInit` — the same type error that already blocks `next build` in two
 * other files (live/start, tts/synthesize). Those two are the whole reason a
 * production build cannot run today; adding a third would make the shortest
 * path to a built server longer, so this one re-wraps instead of casting.
 * The copy is the price: measured p50 154 KB after compression, so it is a
 * rounding error next to the transfer it saves.
 *
 * Allocated by LENGTH, not from the Buffer: `new Uint8Array(buf)` propagates
 * the source's `ArrayBufferLike` and fails the same check. `new
 * Uint8Array(n)` is `Uint8Array<ArrayBuffer>`, which is the type `BodyInit`
 * wants — the distinction exists because a Buffer can sit on a
 * SharedArrayBuffer, and a Response body may not.
 */
async function gzip(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const out = await gzipBuffer(input);
  const copy = new Uint8Array(out.byteLength);
  copy.set(out);
  return copy;
}

/**
 * Bodies below this are sent uncompressed.
 *
 * gzip costs CPU on the server and inflate costs CPU on the client; under a
 * packet or two there is nothing to win and the framing overhead can make the
 * response LARGER. 1 KiB is the same threshold Next's own compression
 * middleware uses, so small API responses behave identically either way.
 */
export const GZIP_MIN_BYTES = 1024;

/**
 * Header carrying the byte length BEFORE compression.
 *
 * Named like the house's other custom headers (`X-Turn-Bus`, `X-Tts-Engine`).
 * Always set — on compressed AND uncompressed responses — so the client has
 * one field to read instead of two code paths.
 */
export const RAW_LENGTH_HEADER = 'X-Raw-Length';

/**
 * Does this client accept gzip?
 *
 * Takes the header VALUE, not the Request, so it is callable from a test
 * without constructing one. `null` (header absent) is a refusal: HTTP/1.1
 * lets a server compress only when the client said it could.
 *
 * `gzip;q=0` is an explicit REFUSAL, not a preference — RFC 9110 §12.5.3.
 * Treating it as acceptance is the one way this function can be wrong in the
 * direction that breaks a client, so it is tested.
 */
export function acceptsGzip(acceptEncoding: string | null | undefined): boolean {
  if (!acceptEncoding) return false;
  for (const part of acceptEncoding.split(',')) {
    const segs = part.split(';');
    const token = (segs[0] || '').trim().toLowerCase();
    if (token !== 'gzip' && token !== '*') continue;
    const q = segs.slice(1).map((s) => s.trim().toLowerCase()).find((s) => s.startsWith('q='));
    if (q) {
      const v = parseFloat(q.slice(2));
      // NaN means a malformed q — treat as present-with-default (q=1) rather
      // than as a refusal, matching how servers read broken Accept headers.
      if (!Number.isNaN(v) && v <= 0) return false;
    }
    return true;
  }
  return false;
}

export type GzipDecision = 'gzip' | 'raw';

/**
 * Should this body be compressed?
 *
 * Pure. Both inputs come from the request/response pair; no IO, no Request.
 */
export function gzipPlan(acceptEncoding: string | null | undefined, byteLength: number): GzipDecision {
  if (byteLength < GZIP_MIN_BYTES) return 'raw';
  if (!acceptsGzip(acceptEncoding)) return 'raw';
  return 'gzip';
}

/**
 * JSON response, gzipped when it is worth it and the client allows it.
 *
 * Returns a plain `Response`, not `NextResponse` — Next's App Router accepts
 * either, and a plain Response is constructible in a test process (importing
 * `next/server` outside the Next runtime fails; measured 10-27).
 *
 * `Vary: Accept-Encoding` is mandatory, not polish: without it a cache
 * anywhere between here and the browser may hand the gzipped bytes to a
 * client that never asked for them, which arrives as corrupt JSON.
 */
export async function jsonMaybeGzip(
  req: Request,
  value: unknown,
  init?: {
    status?: number;
    /**
     * Seam for testing the failure branch below. Production callers never
     * pass this — zlib.gzip cannot be made to reject on demand, and an
     * untested fallback is a claim, not a safety net.
     */
    gzipImpl?: (b: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  },
): Promise<Response> {
  // TextEncoder, not Buffer.from: its return type is `Uint8Array<ArrayBuffer>`,
  // which `BodyInit` accepts. Buffer's is `Buffer<ArrayBufferLike>`, which does
  // not — see the note on gzip() above. Both always encode UTF-8.
  const raw = new TextEncoder().encode(JSON.stringify(value));
  const status = init?.status ?? 200;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Accept-Encoding',
    [RAW_LENGTH_HEADER]: String(raw.byteLength),
  };

  if (gzipPlan(req.headers.get('accept-encoding'), raw.byteLength) === 'raw') {
    return new Response(raw, { status, headers });
  }

  try {
    const gz = await (init?.gzipImpl ?? gzip)(raw);
    return new Response(gz, {
      status,
      headers: { ...headers, 'Content-Encoding': 'gzip' },
    });
  } catch (e) {
    // Falling back to uncompressed is always safe: the client reads the body
    // as JSON because no Content-Encoding is set. Loud, because a compression
    // failure here means something is wrong with the process (zlib only fails
    // on allocation), and silence would turn it into "the link got slow".
    //
    // Exercised by a test through init.gzipImpl, never live — zlib.gzip has
    // not been observed to reject in this house.
    console.warn('[jsonGzip] gzip failed, sending uncompressed:', e);
    return new Response(raw, { status, headers });
  }
}
