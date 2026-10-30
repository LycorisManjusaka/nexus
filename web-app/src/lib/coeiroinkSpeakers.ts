/**
 * COEIROINK's voice catalogue — fetched WITHOUT its 15 MB of artwork.
 *
 * WHY THIS FILE EXISTS (measured 2026-10-31)
 * COEIROINK 2.13.0 answers `GET /v1/speakers` with every character's and every
 * style's PNG inlined as base64:
 *
 *   /v1/speakers               15,787,422 bytes   ~1,084 ms idle
 *   /v1/speakers_path_variant       5,641 bytes        1.8 ms
 *
 * Same shape in both — `speakerName`, `speakerUuid`, `styles[].styleName`,
 * `styles[].styleId`, `version` — the images are the only difference
 * (`base64Icon`/`base64Portrait` vs `pathIcon`/`pathPortrait`).
 *
 * `base64Portrait` and `base64Icon` are referenced NOWHERE in src/. So all
 * three callers were downloading and JSON.parse-ing 15.8 MB to read 424 bytes
 * of it. The synthesize route does that ONCE PER CHUNK: a 89-sentence message
 * in sentence mode moved ~1.4 GB through the parser before speaking a word,
 * which is why 津代 measured COEIROINK as "really slow, and really wrong"
 * while VOICEVOX and AivisSpeech were fine on the same build:
 *
 *   AivisSpeech /speakers     4,388 bytes
 *   VOICEVOX    /speakers    12,208 bytes  (and the route reads it off disk)
 *
 * This is NOT a NEXUS branch difference — `git diff main..dev` touches no TTS
 * file. It is the engine's API shape, and it had been there all along.
 *
 * FALLBACK, AND WHY IT IS NARROW
 * `/v1/speakers_path_variant` exists in 2.13.0; older COEIROINK builds may not
 * have it. A 404 there must not mean "no voices", so a non-ok response falls
 * through to the heavy endpoint — correct, just slow.
 *
 * A thrown fetch does NOT fall through. Both URLs are the same host and port,
 * so a connection-level failure hits both; retrying only doubles the wait
 * before reporting the same thing. The error travels with its cause instead.
 */

export interface CoeiroinkStyle {
  styleName?: string;
  styleId: number;
  [k: string]: unknown;
}

export interface CoeiroinkSpeaker {
  speakerName?: string;
  speakerUuid: string;
  styles: CoeiroinkStyle[];
  version?: string;
  [k: string]: unknown;
}

export const COEIROINK_BASE = 'http://127.0.0.1:50032';
export const COEIROINK_SPEAKERS_LIGHT = `${COEIROINK_BASE}/v1/speakers_path_variant`;
export const COEIROINK_SPEAKERS_HEAVY = `${COEIROINK_BASE}/v1/speakers`;

export interface CoeiroinkSpeakersResult {
  speakers: CoeiroinkSpeaker[];
  /** Which endpoint answered. 'heavy' means the light one was missing. */
  via: 'light' | 'heavy';
  /** Bytes of JSON parsed, so a regression to the 15 MB path is visible. */
  bytes: number;
}

/**
 * Turn a failed `fetch()` into a string that says what actually happened.
 *
 * A connection-level failure gives `TypeError: fetch failed` and NOTHING else
 * at the top level — the reason (ECONNRESET, ECONNREFUSED, UND_ERR_HEADERS_TIMEOUT,
 * a DNS code) lives on `.cause`. 津代's TTS panel showed exactly "fetch failed",
 * which named the layer and withheld every fact about it. An AbortError from
 * `AbortSignal.timeout` is likewise only identifiable by name.
 *
 * Kept next to its one caller set rather than hoisted: a second reader will
 * make it a shared module, a single reader does not.
 */
export function describeFetchFailure(e: unknown): string {
  const err = e as { message?: unknown; name?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } };
  const msg = String(err?.message ?? e);
  const name = err?.name ? String(err.name) : '';
  const code = err?.cause?.code ? String(err.cause.code) : (err?.code ? String(err.code) : '');
  const causeMsg = err?.cause?.message ? String(err.cause.message) : '';
  const bits: string[] = [];
  if (name && name !== 'Error' && !msg.startsWith(name)) bits.push(name);
  bits.push(msg);
  if (code) bits.push(`code=${code}`);
  if (causeMsg && causeMsg !== msg) bits.push(causeMsg);
  return bits.join(' · ');
}

/**
 * Fetch the catalogue, preferring the endpoint that does not ship artwork.
 *
 * Returns the parsed list plus which endpoint answered and how many bytes were
 * parsed — both are diagnostics the callers can log or expose, and the byte
 * count is how a silent regression to the heavy path would be noticed.
 *
 * Throws on a connection-level failure, with the cause attached by
 * `describeFetchFailure`-friendly shape (the original error is re-thrown, so
 * `.cause` survives for the caller to describe).
 */
export async function fetchCoeiroinkSpeakers(
  opts?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<CoeiroinkSpeakersResult> {
  const doFetch = opts?.fetchImpl || fetch;
  const init = opts?.signal ? { signal: opts.signal } : undefined;

  const light = await doFetch(COEIROINK_SPEAKERS_LIGHT, init);
  if (light.ok) {
    const text = await light.text();
    return { speakers: JSON.parse(text) as CoeiroinkSpeaker[], via: 'light', bytes: text.length };
  }

  // Non-ok: the endpoint is absent on this build. Correct but slow.
  const heavy = await doFetch(COEIROINK_SPEAKERS_HEAVY, init);
  if (!heavy.ok) {
    throw new Error(
      `COEIROINK speakers → HTTP ${heavy.status} (light variant answered ${light.status})`,
    );
  }
  const text = await heavy.text();
  return { speakers: JSON.parse(text) as CoeiroinkSpeaker[], via: 'heavy', bytes: text.length };
}
