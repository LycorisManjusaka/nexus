/**
 * Which kind of device is at the other end of this connection.
 *
 * Deliberately NOT derived from screen size or window width. A narrow desktop
 * window is still a desktop: it has a mouse, hover works, and the person can
 * widen it at will. A phone cannot become a desktop by rotating. Sizing the UI
 * by viewport width means someone who drags a desktop window narrow gets a
 * touch layout they never asked for — the same class of mistake as naming a
 * gauge after a condition instead of after what it measures.
 *
 * Two independent surfaces can answer the question, and they fail in known
 * ways:
 *
 *   SERVER (request headers) — always present, even over plain HTTP on a LAN.
 *     `User-Agent` is the floor and is never missing. `Sec-CH-UA-Mobile` is a
 *     clean boolean, but Chromium only sends client hints in a secure context
 *     (HTTPS, or localhost), so over `http://192.168.x.x` it is simply absent.
 *
 *   CLIENT (navigator) — `navigator.userAgentData.mobile` is the honest
 *     boolean and carries the same secure-context limit; over plain HTTP the
 *     object itself is undefined and the UA string is all that is left.
 *
 * So on this house's LAN setup (plain HTTP to 192.168.10.2) the UA string is
 * expected to be the only working signal on both sides. That is acceptable —
 * it is also the one signal that is never missing. The probe page reports
 * which signal actually decided, so a wrong answer can be traced to a source
 * instead of guessed at.
 *
 * Known blind spot, stated rather than papered over: iPadOS 13+ presents a
 * desktop Macintosh UA by default. The server cannot tell it from a Mac. The
 * client can (a Mac reports maxTouchPoints 0, an iPad reports 5), but that
 * check is deliberately NOT wired into classification here — touch-capable
 * desktops exist, and a signal that is right about iPads and wrong about
 * touchscreen laptops is not an improvement. Touch is reported as context.
 */

export type DeviceKind = 'phone' | 'tablet' | 'desktop';

export type DeviceSource = 'client-hint' | 'ua-string' | 'unknown';

export interface DeviceClass {
  kind: DeviceKind;
  /** Which signal decided, so a wrong answer can be traced instead of guessed. */
  source: DeviceSource;
  /** True when every signal was absent and this is the fallback, not a reading. */
  guessed: boolean;
}

// `Mobile` is the token Chrome/Firefox for Android put on phones and leave off
// tablets; it is the only thing separating the two in the Android UA.
const PHONE_RE = /(android.*mobile|iphone|ipod|windows phone|iemobile|blackberry|bb10|opera mini)/i;
const TABLET_RE = /(ipad|android|tablet|kindle|silk|playbook)/i;

/** Classify from a UA string alone. The floor every other path falls back to. */
export function classifyUserAgent(ua: string): DeviceClass {
  const s = String(ua || '');
  if (!s.trim()) return { kind: 'desktop', source: 'unknown', guessed: true };
  if (PHONE_RE.test(s)) return { kind: 'phone', source: 'ua-string', guessed: false };
  // Reached only when PHONE_RE missed, so a bare `android` here is a tablet.
  if (TABLET_RE.test(s)) return { kind: 'tablet', source: 'ua-string', guessed: false };
  return { kind: 'desktop', source: 'ua-string', guessed: false };
}

/**
 * Server-side classification from request headers.
 *
 * `get` takes a header name (lowercase) and returns its value or null — pass
 * `(n) => req.headers.get(n)` or the Next.js `headers()` accessor.
 *
 * The hint only *adds* information when the UA string already said "desktop".
 * A device sending `?1` behind a desktop UA is asking for the narrow layout
 * and nothing else available would catch it; a device sending `?0` behind a
 * phone UA is asking for the desktop site, which is a request to honour, not
 * to override.
 */
export function classifyFromHeaders(
  get: (name: string) => string | null | undefined,
): DeviceClass {
  const ua = String(get('user-agent') || '');
  const byUa = classifyUserAgent(ua);
  const hint = String(get('sec-ch-ua-mobile') || '').trim();
  if (hint === '?1' && byUa.kind === 'desktop') {
    return { kind: 'phone', source: 'client-hint', guessed: false };
  }
  return byUa;
}

/**
 * Client-side classification. Safe to call during SSR — it reports `unknown`
 * rather than throwing, so a render on the server does not crash the page.
 */
export function classifyFromNavigator(): DeviceClass {
  if (typeof navigator === 'undefined') {
    return { kind: 'desktop', source: 'unknown', guessed: true };
  }
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  const byUa = classifyUserAgent(nav.userAgent || '');
  const mobile = nav.userAgentData?.mobile;
  if (mobile === true && byUa.kind === 'desktop') {
    return { kind: 'phone', source: 'client-hint', guessed: false };
  }
  return byUa;
}

/**
 * Everything either side can observe, including the things deliberately NOT
 * used for classification. Reported so a disagreement can be read off the
 * evidence instead of re-derived.
 */
export interface DeviceSignals {
  userAgent: string;
  /** `?1` / `?0` / '' when the browser sent no client hints. */
  secChUaMobile: string;
  secChUaPlatform: string;
  /** Context only — touch-capable desktops exist. Not used to classify. */
  maxTouchPoints: number | null;
  /** Context only. Not used to classify. */
  pointerCoarse: boolean | null;
  /** Context only. Not used to classify — see the header comment. */
  devicePixelRatio: number | null;
  /** Context only. Not used to classify — see the header comment. */
  viewportWidth: number | null;
  /** Context only. Not used to classify. */
  viewportHeight: number | null;
  /** False over plain HTTP to a LAN IP, which is why client hints go missing. */
  secureContext: boolean | null;
  /** Whether `navigator.userAgentData` exists at all on this connection. */
  hasUserAgentData: boolean | null;
}

/** Collect the client-visible signals. Returns nulls during SSR. */
export function collectClientSignals(): DeviceSignals {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return {
      userAgent: '',
      secChUaMobile: '',
      secChUaPlatform: '',
      maxTouchPoints: null,
      pointerCoarse: null,
      devicePixelRatio: null,
      viewportWidth: null,
      viewportHeight: null,
      secureContext: null,
      hasUserAgentData: null,
    };
  }
  const nav = navigator as Navigator & {
    userAgentData?: { mobile?: boolean; platform?: string };
  };
  let coarse: boolean | null = null;
  try {
    coarse = window.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = null;
  }
  return {
    userAgent: nav.userAgent || '',
    secChUaMobile:
      typeof nav.userAgentData?.mobile === 'boolean'
        ? nav.userAgentData.mobile
          ? '?1'
          : '?0'
        : '',
    secChUaPlatform: nav.userAgentData?.platform || '',
    maxTouchPoints: typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : null,
    pointerCoarse: coarse,
    devicePixelRatio: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : null,
    viewportWidth: window.innerWidth ?? null,
    viewportHeight: window.innerHeight ?? null,
    secureContext: typeof window.isSecureContext === 'boolean' ? window.isSecureContext : null,
    hasUserAgentData: Boolean(nav.userAgentData),
  };
}
