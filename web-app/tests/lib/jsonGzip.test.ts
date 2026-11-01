/**
 * jsonGzip — compress the one payload that was never compressed.
 *
 * NEW TEST, new lib. Measured 2026-11-01: HTML and JS go through Next's
 * compression middleware, API route handlers do not, and `GET /api/logs/<id>`
 * is both the biggest thing on the wire (p50 426 KB over 305 real
 * conversations) and re-fetched at the end of EVERY turn. On パイロット's
 * Sakhalin link that is the dominant per-message cost.
 *
 * The decision lives in a lib rather than in the route because `next/server`
 * makes route handlers untestable in this repo (measured 10-27: 68 API routes,
 * zero tests), and because the last rule left inside a handler vanished when
 * the handler moved (F76).
 *
 * Each case names what would look different if its rule were missing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'zlib';
import {
  acceptsGzip,
  gzipPlan,
  jsonMaybeGzip,
  GZIP_MIN_BYTES,
  RAW_LENGTH_HEADER,
} from '../../src/lib/jsonGzip';

const reqWith = (acceptEncoding?: string) =>
  new Request('http://localhost/api/logs/x', {
    headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  });

// Big enough to be over the threshold after JSON.stringify.
const bigValue = { messages: Array.from({ length: 200 }, (_, i) => ({ id: i, text: 'stone upon stone' })) };

describe('acceptsGzip', () => {
  // ── absence is refusal, not permission ──────────────────────────────────
  //
  // HTTP only lets a server compress when the client said it could. Invert
  // this and every non-browser caller (curl, a script, an old client) gets
  // gzipped bytes it will read as corrupt JSON — and the symptom appears far
  // from here.

  it('absent header is a refusal', () => {
    assert.equal(acceptsGzip(null), false);
    assert.equal(acceptsGzip(undefined), false);
    assert.equal(acceptsGzip(''), false);
  });

  it('accepts a plain gzip', () => {
    assert.equal(acceptsGzip('gzip'), true);
  });

  it('accepts gzip inside a list', () => {
    assert.equal(acceptsGzip('gzip, deflate, br, zstd'), true);
  });

  it('refuses when gzip is not in the list', () => {
    // Without this, a client offering only br/deflate is handed gzip.
    assert.equal(acceptsGzip('deflate, br'), false);
    assert.equal(acceptsGzip('identity'), false);
  });

  // ── q=0 is an explicit REFUSAL (RFC 9110 §12.5.3) ───────────────────────
  //
  // The one way this function can be wrong in the direction that breaks a
  // client: `gzip;q=0` names gzip, so a substring check says yes. It means no.

  it('treats gzip;q=0 as a refusal', () => {
    assert.equal(acceptsGzip('gzip;q=0'), false);
    assert.equal(acceptsGzip('gzip;q=0.0'), false);
    assert.equal(acceptsGzip('deflate, gzip;q=0'), false);
  });

  it('a nonzero q is still acceptance', () => {
    // A preference, not a refusal — q only ranks the codings a client allows.
    assert.equal(acceptsGzip('gzip;q=0.5'), true);
    assert.equal(acceptsGzip('gzip;q=1.0'), true);
  });

  it('a malformed q is acceptance, not refusal', () => {
    // Reading a broken header as "refuses gzip" would silently disable
    // compression for whoever sent it, with nothing to see. Default to q=1.
    assert.equal(acceptsGzip('gzip;q=banana'), true);
  });

  it('tokens are case-insensitive and may carry whitespace', () => {
    // Real clients send both. Without this, compression is on or off
    // depending on a client's capitalisation.
    assert.equal(acceptsGzip('GZIP'), true);
    assert.equal(acceptsGzip('  gzip  '), true);
    assert.equal(acceptsGzip('deflate,  GZip ;q=0.8'), true);
  });

  it('wildcard accepts, wildcard-with-q=0 refuses', () => {
    assert.equal(acceptsGzip('*'), true);
    assert.equal(acceptsGzip('*;q=0'), false);
  });
});

describe('gzipPlan', () => {
  // ── the threshold exists so small responses are not made larger ─────────
  //
  // gzip framing is ~20 bytes plus a dictionary; under a packet there is
  // nothing to win. Remove the threshold and every tiny {"ok":true} pays CPU
  // on both ends — the measurable cost is latency on 60+ small API routes.

  it('does not compress below the threshold', () => {
    assert.equal(gzipPlan('gzip', GZIP_MIN_BYTES - 1), 'raw');
    assert.equal(gzipPlan('gzip', 0), 'raw');
  });

  it('compresses at and above the threshold', () => {
    assert.equal(gzipPlan('gzip', GZIP_MIN_BYTES), 'gzip');
    assert.equal(gzipPlan('gzip', 500_000), 'gzip');
  });

  it('never compresses without permission, however big', () => {
    // The size test must not be able to overrule the client's refusal.
    assert.equal(gzipPlan(null, 5_000_000), 'raw');
    assert.equal(gzipPlan('gzip;q=0', 5_000_000), 'raw');
  });
});

describe('jsonMaybeGzip', () => {
  it('compresses a large body and the bytes round-trip', async () => {
    const res = await jsonMaybeGzip(reqWith('gzip'), bigValue);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    const wire = Buffer.from(await res.arrayBuffer());
    // The whole point: what arrives must inflate back to the same JSON.
    assert.deepEqual(JSON.parse(gunzipSync(wire).toString('utf-8')), bigValue);
    // And it must actually be smaller, or the feature does nothing.
    assert.ok(wire.byteLength < JSON.stringify(bigValue).length);
  });

  // ── X-Raw-Length is the progress bar (measured 2026-11-01) ──────────────
  //
  // ChatArea divides bytes-read-off-the-stream (which the browser has already
  // inflated) by this number. If it carried the COMPRESSED length instead,
  // the bar would reach 100% at ~36% and the label would read
  // "0.42 / 0.15 MB". That is the only thing on screen telling someone on a
  // slow link that anything is happening.

  it('X-Raw-Length is the UNCOMPRESSED size when compressed', async () => {
    const res = await jsonMaybeGzip(reqWith('gzip'), bigValue);
    const raw = JSON.stringify(bigValue).length;
    assert.equal(res.headers.get(RAW_LENGTH_HEADER), String(raw));
    // Explicitly NOT the wire size — that is the inversion being guarded.
    const wire = (await res.arrayBuffer()).byteLength;
    assert.notEqual(Number(res.headers.get(RAW_LENGTH_HEADER)), wire);
  });

  it('X-Raw-Length is present on uncompressed responses too', async () => {
    // One field for the client to read instead of two code paths.
    const res = await jsonMaybeGzip(reqWith(), bigValue);
    assert.equal(res.headers.get('content-encoding'), null);
    assert.equal(res.headers.get(RAW_LENGTH_HEADER), String(JSON.stringify(bigValue).length));
  });

  it('sends a large body uncompressed when the client refuses', async () => {
    const res = await jsonMaybeGzip(reqWith('deflate'), bigValue);
    assert.equal(res.headers.get('content-encoding'), null);
    assert.deepEqual(await res.json(), bigValue);
  });

  it('leaves a small body alone', async () => {
    const res = await jsonMaybeGzip(reqWith('gzip'), { ok: true });
    assert.equal(res.headers.get('content-encoding'), null);
    assert.deepEqual(await res.json(), { ok: true });
  });

  // ── Vary is mandatory, not polish ───────────────────────────────────────
  //
  // Without it, any cache between here and the browser may serve the gzipped
  // bytes to a client that never asked for gzip. That arrives as corrupt
  // JSON, intermittently, for whoever is behind the cache.

  it('always sets Vary: Accept-Encoding', async () => {
    for (const ae of ['gzip', 'deflate', undefined]) {
      const res = await jsonMaybeGzip(reqWith(ae), bigValue);
      assert.equal(res.headers.get('vary'), 'Accept-Encoding');
    }
  });

  it('sets a JSON content type', async () => {
    const res = await jsonMaybeGzip(reqWith('gzip'), bigValue);
    assert.match(res.headers.get('content-type') || '', /^application\/json/);
  });

  it('carries the caller status through both branches', async () => {
    assert.equal((await jsonMaybeGzip(reqWith('gzip'), bigValue, { status: 207 })).status, 207);
    assert.equal((await jsonMaybeGzip(reqWith(), bigValue, { status: 207 })).status, 207);
    assert.equal((await jsonMaybeGzip(reqWith('gzip'), bigValue)).status, 200);
  });

  // ── the fallback, actually exercised ────────────────────────────────────
  //
  // A safety net that has never been dropped is a claim. zlib.gzip cannot be
  // made to reject on demand, so the seam exists for exactly this: a
  // compression failure must still deliver readable JSON, not a 500.

  it('falls back to uncompressed when gzip rejects', async () => {
    const res = await jsonMaybeGzip(reqWith('gzip'), bigValue, {
      gzipImpl: () => Promise.reject(new Error('boom')),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), null);
    assert.deepEqual(await res.json(), bigValue);
    // The raw length must still describe the body that was actually sent.
    assert.equal(res.headers.get(RAW_LENGTH_HEADER), String(JSON.stringify(bigValue).length));
  });

  it('uses the seam when it succeeds, proving the seam is load-bearing', async () => {
    // Without this, a seam wired to the wrong place would look fine: the
    // fallback test passes whether or not gzipImpl is ever consulted.
    const marker = new Uint8Array([1, 2, 3]);
    const res = await jsonMaybeGzip(reqWith('gzip'), bigValue, {
      gzipImpl: async () => marker,
    });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), marker);
  });
});
