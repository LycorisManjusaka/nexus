/**
 * Provider error shaping — shared by the server request paths and the client.
 *
 * Two jobs, both about not lying to the reader.
 *
 * 1) `parseRetryDelayMs` — Gemini's per-minute INPUT-token quota (TPM) rejects
 *    the whole request with 429 / RESOURCE_EXHAUSTED *before* any generation
 *    happens, and hands back an authoritative wait in `RetryInfo.retryDelay`
 *    (e.g. "41s"). Nothing was generated, nothing was billed, nothing is lost:
 *    the request never started. So the correct response is to wait exactly that
 *    long and re-send the identical payload — not to fail the turn.
 *
 *    Why this fires on ordinary work rather than abuse: the agentic tool loop
 *    resends the whole conversation plus every prior tool result on each round,
 *    so input is quadratic in rounds. Measured on real logs, one complex turn
 *    sustains 1.3-1.9M input tok/min against a 3M/min ceiling — a single turn
 *    can exhaust the quota by itself.
 *
 * 2) `describeProviderError` — a raw provider error is a wall of nested JSON.
 *    It belongs in the notice strip as an explanation *about* the turn, never
 *    in the reply body as if the entity had said it.
 */

/** Flatten whatever an SDK threw into one searchable string. */
export function errorBlob(err: any): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const parts: string[] = [];
  if (typeof err.message === 'string') parts.push(err.message);
  try {
    const j = JSON.stringify(err);
    if (j && j !== '{}') parts.push(j);
  } catch {}
  if (!parts.length) parts.push(String(err));
  return parts.join(' ');
}

/** True when the blob is a rate/quota rejection (429 / RESOURCE_EXHAUSTED). */
export function isQuotaError(blob: string): boolean {
  if (!blob) return false;
  return /RESOURCE_EXHAUSTED/i.test(blob)
    || /"code"\s*:\s*429/.test(blob)
    || /\b429\b/.test(blob)
    || /too many requests/i.test(blob);
}

/**
 * Server-supplied wait for a quota rejection, in ms — or null when the error is
 * not a retryable quota rejection.
 *
 * The delay is authoritative: Google computes it from the quota window, so it
 * beats any backoff curve we could invent. (The pre-existing subagent retry
 * used 800ms/1600ms against a 41-second window, which could never succeed.)
 *
 * A 429 with no parsable delay still returns a conservative default rather than
 * null — the request definitely didn't run, so retrying is still correct.
 */
export function parseRetryDelayMs(err: any): number | null {
  const blob = errorBlob(err);
  if (!isQuotaError(blob)) return null;
  const m = blob.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i)
    || blob.match(/retry in\s+([\d.]+)\s*s/i);
  const secs = m ? Number(m[1]) : NaN;
  // +1s of slack: the window is measured server-side, and a wait that lands
  // exactly on the boundary tends to bounce a second time.
  if (!Number.isFinite(secs)) return 30_000;
  return Math.min(Math.round(secs * 1000) + 1000, 120_000);
}

/** Quota metadata worth showing the reader, when the payload carries it. */
function quotaFacts(blob: string): string {
  const bits: string[] = [];
  const model = blob.match(/"model"\s*:\s*"([^"]+)"/)?.[1]
    || blob.match(/model:\s*([\w.\-]+)/)?.[1];
  const value = blob.match(/"quotaValue"\s*:\s*"?(\d+)"?/)?.[1]
    || blob.match(/limit:\s*(\d+)/)?.[1];
  if (model) bits.push(model);
  if (value) bits.push(`limit ${Number(value).toLocaleString('en-US')} input tokens/min`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

/**
 * Turn a raw provider error into one readable line for the notice strip.
 * Falls back to the raw text rather than swallowing detail we can't classify —
 * an unexplained failure is worse than an ugly one.
 */
export function describeProviderError(raw: any): string {
  const blob = errorBlob(raw);
  if (!blob) return 'The turn failed, and the provider gave no reason.';

  if (isQuotaError(blob)) {
    return `Provider rate limit reached${quotaFacts(blob)}.`
      + ` This is a per-minute input-token quota, not a refusal — the request was rejected before the model ran, so nothing was generated or billed.`
      + ` Nexus waits the delay the provider asks for and resumes automatically; this notice means the retries were also refused.`
      + ` Waiting a minute and re-running usually works. Shorter context, fewer tool rounds, or putting the sense bridges on a different model all reduce how much of the quota one turn spends.`;
  }

  // Unwrap the common `{ error: { message } }` envelope, possibly nested twice
  // (providers routinely stringify one error inside another).
  let msg = '';
  let cur: any = blob;
  for (let depth = 0; depth < 3; depth++) {
    try {
      const parsed = typeof cur === 'string' ? JSON.parse(cur) : cur;
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === 'string' && inner.trim()) { msg = inner.trim(); cur = inner; continue; }
      break;
    } catch { break; }
  }
  const text = msg || blob;
  const trimmed = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  return `The turn failed: ${trimmed}`;
}
