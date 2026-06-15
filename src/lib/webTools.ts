// ───────────────────────────────────────────────────────────────────────────
// Universal NEXUS web tools — server-side search + fetch exposed to ANY model
// (especially the OpenAI-compatible providers that have no first-party web
// access: Cohere, Local/LM Studio, DeepSeek-direct, Grok, and the snippet-only
// GLM/Kimi/MiniMax). Self-contained: no extra npm dependencies — uses the
// runtime `fetch` plus regex HTML extraction.
//
//   • webSearch(query)  → list of { title, url, snippet } from DuckDuckGo's
//                          keyless HTML endpoint. No API key required.
//   • webFetch(url)     → opens ONE specific URL and returns its readable text
//                          (scripts/styles/markup stripped, entity-decoded,
//                          length-capped). This is the "web access" half.
//
// Both enforce timeouts, response-size caps, and a basic SSRF guard that blocks
// loopback / private-network hostnames so a model can't probe internal
// services on the user's machine.
// ───────────────────────────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebFetchResult {
  url: string;
  title?: string;
  text: string;
  truncated: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function decodeEntities(s: string): string {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; }
    });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// Block loopback + RFC1918 private ranges + link-local + .local so the AI can't
// reach into the host's internal network. Hostname-level check (no DNS) — good
// enough to stop the obvious cases without adding a resolver dependency.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^fe80:/i.test(h) || /^fc00:/i.test(h) || /^fd/i.test(h)) return true; // IPv6 local
  return false;
}

function assertSafeUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${u.protocol} (only http/https allowed)`);
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error(`blocked host (loopback/private network not allowed): ${u.hostname}`);
  }
  return u;
}

// DuckDuckGo's HTML redirect links look like `//duckduckgo.com/l/?uddg=<enc>`.
// Unwrap to the real destination.
function unwrapDuckDuckGo(href: string): string {
  try {
    const full = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(full);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return full;
  } catch {
    return href;
  }
}

// ── webSearch ───────────────────────────────────────────────────────────────

export async function webSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number } = {},
): Promise<WebSearchResult[]> {
  const maxResults = Math.min(Math.max(opts.maxResults ?? 6, 1), 12);
  const timeoutMs = opts.timeoutMs ?? 12000;
  const q = (query || '').trim();
  if (!q) return [];

  const res = await fetchWithTimeout(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Accept': 'text/html',
      },
      body: new URLSearchParams({ q }).toString(),
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const html = await res.text();

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  // Result anchors: <a ... class="result__a" href="HREF">TITLE</a>
  const anchorRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  // Snippets: <a ... class="result__snippet" ...>SNIPPET</a>
  const snippetRe = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));

  let am: RegExpExecArray | null;
  let i = 0;
  while ((am = anchorRe.exec(html)) && results.length < maxResults) {
    const url = unwrapDuckDuckGo(am[1]);
    const title = stripTags(am[2]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) { i++; continue; }
    seen.add(url);
    results.push({ title: title || url, url, snippet: snippets[i] || undefined });
    i++;
  }

  return results;
}

// ── webFetch ────────────────────────────────────────────────────────────────

export async function webFetch(
  targetUrl: string,
  opts: { maxChars?: number; timeoutMs?: number } = {},
): Promise<WebFetchResult> {
  const maxChars = Math.min(Math.max(opts.maxChars ?? 8000, 500), 40000);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const u = assertSafeUrl(targetUrl);

  const res = await fetchWithTimeout(
    u.toString(),
    {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
      },
      redirect: 'follow',
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`fetch HTTP ${res.status}`);

  // Re-validate the FINAL url after redirects (defends against open-redirect
  // → internal-host SSRF).
  const finalUrl = res.url || u.toString();
  try { assertSafeUrl(finalUrl); } catch (e: any) { throw new Error(`redirected to ${e.message}`); }

  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();

  // Non-HTML (JSON, plain text, markdown) — return as-is (capped).
  if (!ctype.includes('html')) {
    const text = raw.replace(/\s+\n/g, '\n').trim();
    return {
      url: finalUrl,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    };
  }

  // HTML → title + readable body text.
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : undefined;

  const body = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    // turn block-level closers into newlines so paragraphs survive
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  const text = decodeEntities(body.replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    url: finalUrl,
    title,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
