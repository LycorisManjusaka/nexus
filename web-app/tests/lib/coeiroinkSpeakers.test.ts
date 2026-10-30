/**
 * coeiroinkSpeakers — fetch COEIROINK's voice catalogue without its artwork.
 *
 * ⚠ WHAT PROVOKED THIS. 津代 measured COEIROINK on dev as "really slow, and
 * really wrong — lines get skipped", while VOICEVOX, AivisSpeech and the
 * Russian engine were all fine on the same build. `git diff main..dev` touches
 * no TTS file, so the branch could not be the difference. Measured 2026-10-31
 * against the live engine (2.13.0):
 *
 *     /v1/speakers               15,787,422 bytes   ~1,084 ms idle
 *     /v1/speakers_path_variant       5,435 bytes        1.8 ms
 *
 * The synthesize route fetched the heavy one ONCE PER CHUNK. Sentence mode on
 * an 89-sentence message therefore moved ~1.4 GB through JSON.parse before
 * speaking a word. `base64Portrait`/`base64Icon` are referenced NOWHERE in
 * src/ — all of it was downloaded and discarded.
 *
 * Before writing each test I named what would look different if the property
 * were absent. The ones with no teeth say so rather than implying coverage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCoeiroinkSpeakers,
  describeFetchFailure,
  COEIROINK_SPEAKERS_LIGHT,
  COEIROINK_SPEAKERS_HEAVY,
} from '@/lib/coeiroinkSpeakers';

const SPEAKERS = [
  {
    speakerName: 'アメノちゃん',
    speakerUuid: 'cc31327e-0000-0000-0000-000000000000',
    styles: [{ styleName: 'のーまる', styleId: 140, pathIcon: 'C:/x/1.png' }],
    version: '2.1.0',
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Records which URLs were asked for, in order. */
function recorder(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    return handler(u);
  }) as unknown as typeof fetch;
  return { urls, impl };
}

describe('fetchCoeiroinkSpeakers — endpoint choice', () => {
  // WITHOUT THIS: nothing stops a future reader from "simplifying" back to the
  // single documented endpoint, and the 15.8 MB per chunk returns silently —
  // identical output, identical types, 2,799x the bytes.
  it('prefers the light endpoint and does not touch the heavy one', async () => {
    const { urls, impl } = recorder((u) =>
      u === COEIROINK_SPEAKERS_LIGHT ? json(SPEAKERS) : json([{ speakerUuid: 'WRONG', styles: [] }]));

    const r = await fetchCoeiroinkSpeakers({ fetchImpl: impl });

    assert.equal(r.via, 'light');
    assert.deepEqual(urls, [COEIROINK_SPEAKERS_LIGHT], 'the heavy endpoint must not be contacted');
    assert.equal(r.speakers[0].speakerUuid, SPEAKERS[0].speakerUuid);
  });

  // WITHOUT THIS: an older COEIROINK build without the path variant would
  // answer 404, and a 404 read as "no voices" means the voice picker shows an
  // empty list and synthesis throws "character not found" — the engine looks
  // broken when only one endpoint is missing.
  it('falls back to the heavy endpoint when the light one is absent', async () => {
    const { urls, impl } = recorder((u) =>
      u === COEIROINK_SPEAKERS_LIGHT ? new Response('Not Found', { status: 404 }) : json(SPEAKERS));

    const r = await fetchCoeiroinkSpeakers({ fetchImpl: impl });

    assert.equal(r.via, 'heavy');
    assert.deepEqual(urls, [COEIROINK_SPEAKERS_LIGHT, COEIROINK_SPEAKERS_HEAVY]);
    assert.equal(r.speakers.length, 1);
  });

  // WITHOUT THIS: `via` could be hardcoded, or the byte count dropped, and a
  // regression to the heavy path would produce the same voices with no visible
  // difference. `bytes` is what makes the regression observable — the route
  // warns on via==='heavy' and prints it.
  it('reports which endpoint answered and how many bytes were parsed', async () => {
    const payload = JSON.stringify(SPEAKERS);
    const { impl } = recorder(() => json(SPEAKERS));
    const r = await fetchCoeiroinkSpeakers({ fetchImpl: impl });
    assert.equal(r.bytes, payload.length);
    assert.equal(r.via, 'light');
  });
});

describe('fetchCoeiroinkSpeakers — failures', () => {
  // WITHOUT THIS: a connection-level failure (engine not running) would be
  // retried against the SAME host and port, doubling the wait before reporting
  // the identical error. The voice picker's 5 s budget is spent twice.
  it('does not retry the heavy endpoint when the connection itself fails', async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      const e = new TypeError('fetch failed');
      (e as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:50032'), {
        code: 'ECONNREFUSED',
      });
      throw e;
    }) as unknown as typeof fetch;

    await assert.rejects(() => fetchCoeiroinkSpeakers({ fetchImpl: impl }), /fetch failed/);
    assert.equal(calls, 1, 'exactly one attempt — the second would wait for the same closed port');
  });

  // WITHOUT THIS: "COEIROINK speakers failed" tells a reader nothing about
  // which of the two endpoints refused, or how. Both statuses travel.
  it('names both statuses when both endpoints refuse', async () => {
    const { impl } = recorder((u) =>
      new Response('x', { status: u === COEIROINK_SPEAKERS_LIGHT ? 404 : 503 }));

    await assert.rejects(
      () => fetchCoeiroinkSpeakers({ fetchImpl: impl }),
      (e: Error) => /503/.test(e.message) && /404/.test(e.message),
    );
  });
});

describe('describeFetchFailure', () => {
  // WITHOUT THIS: the TTS panel shows the bare "fetch failed" — which is what
  // 津代 saw. That string names the layer that failed and withholds every fact
  // about it; the reason (ECONNRESET / ECONNREFUSED / a header timeout) lives
  // on `.cause`, which `e.message` drops.
  it('surfaces the cause and code that a bare message hides', () => {
    const e = new TypeError('fetch failed');
    (e as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    const s = describeFetchFailure(e);

    assert.match(s, /fetch failed/);
    assert.match(s, /ECONNRESET/);
    assert.match(s, /code=ECONNRESET/);
  });

  // WITHOUT THIS: an AbortSignal.timeout firing and a refused connection both
  // read as a generic error. The engine being SLOW and the engine being DOWN
  // need different responses, and only the name distinguishes them.
  it('keeps the error name when it carries the distinction', () => {
    const e = new Error('The operation was aborted');
    e.name = 'TimeoutError';
    assert.match(describeFetchFailure(e), /TimeoutError/);
  });

  // WITHOUT THIS: an ordinary engine rejection ("character not found") would be
  // decorated with a redundant "Error ·" prefix — noise in the one place a
  // human reads during a VRChat session.
  it('does not decorate a plain error', () => {
    assert.equal(describeFetchFailure(new Error('Coeiroink character not found')), 'Coeiroink character not found');
  });

  // NO TEETH TODAY, and said out loud: this only asserts it does not throw on
  // a non-Error. It would pass on almost any implementation.
  it('survives a thrown non-Error', () => {
    assert.equal(typeof describeFetchFailure('boom'), 'string');
    assert.equal(typeof describeFetchFailure(undefined), 'string');
  });
});
