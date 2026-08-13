/**
 * A fetch that is allowed to fail.
 *
 * Several Preferences panels load optional, best-effort data on mount: the TTS
 * speaker catalogs, the identity map, engine status. None of these are required
 * for the panel to be usable — an identity with no voice is still an identity,
 * and an engine that isn't installed should show its "not running / Start"
 * affordance, not block the whole tab.
 *
 * The failure that motivated this helper: `fetch(url).then(r => r.json())`
 * throws a SyntaxError when the route answers with an HTML error page (a 404
 * from Next.js is a full HTML document, not JSON). If that rejection happens
 * inside an un-guarded mount effect, the component's `loading` flag never
 * clears and the panel sits on "Loading voices…" forever — with no error
 * anywhere in the UI to explain it. On a fresh install with no TTS engines and
 * a nearly-empty local_data, that is the FIRST thing a new user sees.
 *
 * So: any non-ok status, any non-JSON content type, any network or parse error
 * resolves to `fallback` instead of rejecting. The caller decides what "no data"
 * looks like; the caller never has to decide what "the request exploded" looks
 * like, because it can't observe the difference. That is deliberate — the two
 * cases have the same correct rendering here (empty list + a way to fix it), and
 * collapsing them keeps every call site from re-implementing the same guard.
 *
 * Do NOT use this where a failure must be reported (saving, deleting, anything
 * the user pressed a button for). Silence is only correct for data the panel can
 * render without.
 */
export async function fetchJsonSafe<T>(url: string, fallback: T, init?: RequestInit): Promise<T> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return fallback;
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('json')) return fallback;
    const data = await res.json();
    return (data ?? fallback) as T;
  } catch {
    return fallback;
  }
}
