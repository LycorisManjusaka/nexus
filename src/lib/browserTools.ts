// ─────────────────────────────────────────────────────────────────────────────
// Browser control for NEXUS entities.
//
// An entity gets a real Chromium window it can drive: navigate, look at what is
// on the page, click, type, read. The window is HEADED on purpose — when
// something goes wrong the fastest diagnosis is looking at the screen, and a
// visible window also means the machine's owner can always see what is being
// done in their name.
//
// WHAT THE ENTITY SEES IS THE ACCESSIBILITY TREE, NOT PIXELS.
// `browser_snapshot` returns a short text listing of the interactive elements
// with stable refs, and actions address those refs. This is chosen over
// screenshot-and-click-coordinates for three reasons:
//   • it costs a few hundred tokens instead of an image per step, which is what
//     makes an unattended loop on a local model affordable at all;
//   • it does not require a vision-capable model, so every family can use it;
//   • a ref is exact. Coordinates drift with layout, scroll, and DPI.
// Pixel/computer-use is a separate future feature, not a replacement for this.
//
// SECURITY BOUNDARY.
// Navigation is checked against a per-Entity host allowlist that defaults to
// localhost only. The check runs on the requested URL, on the URL actually
// landed on after redirects, and as a route filter on every navigation request
// the page makes. Sub-resources (images, scripts, fonts) are NOT filtered — an
// allowed page is allowed to load its own assets. That means an allowed page
// could embed a disallowed one in an iframe; this is documented rather than
// blocked, because filtering sub-resources breaks ordinary pages and the
// allowlist is under the machine owner's control.
//
// PROFILES ARE LOCAL AND NEVER SYNC.
// Each entity has its own persistent profile at
// `local_data/browser_profiles/<Entity>/`, so logins survive between sessions.
// Those directories hold live session cookies and are excluded from the rclone
// sync in `push_local_data.ps1` / `pull_local_data.ps1`, exactly like keys.json.
// If that exclusion is ever removed, one machine's logged-in sessions would be
// copied to every other machine.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';
import fs from 'fs/promises';
import type { BrowserContext, Page } from 'playwright';
import { putBytes } from './attachmentStore';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const PROFILES_DIR = path.join(DATA_DIR, 'browser_profiles');
const WORKSPACES_DIR = path.join(DATA_DIR, 'agent_workspaces');

export const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_read',
  'browser_screenshot',
] as const;

export interface BrowserToolCtx {
  /** The entity making the call — resolved from the conversation's folder. */
  me: string;
  /** Hostnames this entity may navigate to. Empty/absent ⇒ localhost only. */
  allowedHosts?: string[];
  /** Per-Entity opt-in to the open internet. Overrides the allowlist entirely. */
  allowAnyHost?: boolean;
  /** Trim snapshots hard — for models with a small context window. */
  compact?: boolean;
  /** Resolved (per-Entity overridable) instruction strings. */
  instructions?: Record<string, string>;
}

// ── tool schemas ─────────────────────────────────────────────────────────────
//
// Declared once, provider-neutral, and reshaped at each of the three JSON-schema
// call sites (Claude API, Gemini, OpenAI-compatible). The OAuth path builds its
// own with zod because the SDK requires it.
//
// Six tools cost 1,439 tokens on Anthropic's counter. That sits in the CACHED
// prefix — tools come before the system prompt in Anthropic's cache order — so a
// cached turn pays about a tenth of it. The corollary matters more than the
// number: changing which tools are present invalidates the whole prompt cache,
// so this must be a per-Entity setting that holds still for a conversation, not
// something flipped mid-thread.

export interface BrowserToolSpec {
  name: string;
  description: string;
  properties: Record<string, { type: 'string' | 'boolean'; description: string }>;
  required: string[];
}

export function browserToolSpecs(I: Record<string, string>): BrowserToolSpec[] {
  return [
    {
      name: 'browser_navigate',
      description: I.toolBrowserNavigateDesc,
      properties: { url: { type: 'string', description: I.browserNavigateUrlParam } },
      required: ['url'],
    },
    {
      name: 'browser_snapshot',
      description: I.toolBrowserSnapshotDesc,
      properties: {},
      required: [],
    },
    {
      name: 'browser_click',
      description: I.toolBrowserClickDesc,
      properties: { ref: { type: 'string', description: I.browserClickRefParam } },
      required: ['ref'],
    },
    {
      name: 'browser_type',
      description: I.toolBrowserTypeDesc,
      properties: {
        ref: { type: 'string', description: I.browserTypeRefParam },
        text: { type: 'string', description: I.browserTypeTextParam },
        submit: { type: 'boolean', description: I.browserTypeSubmitParam },
      },
      required: ['ref', 'text'],
    },
    {
      name: 'browser_read',
      description: I.toolBrowserReadDesc,
      properties: {},
      required: [],
    },
    {
      name: 'browser_screenshot',
      description: I.toolBrowserScreenshotDesc,
      properties: { full_page: { type: 'boolean', description: I.browserScreenshotFullPageParam } },
      required: [],
    },
  ];
}

/** Claude API shape. */
export function browserToolsClaude(I: Record<string, string>) {
  return browserToolSpecs(I).map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: {
      type: 'object',
      properties: s.properties,
      ...(s.required.length ? { required: s.required } : {}),
    },
  }));
}

/** OpenAI-compatible shape (GLM, Kimi, DeepSeek, Qwen, ChatGPT, MiMo, …). */
export function browserToolsOpenAI(I: Record<string, string>) {
  return browserToolSpecs(I).map((s) => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description,
      parameters: {
        type: 'object',
        properties: s.properties,
        ...(s.required.length ? { required: s.required } : {}),
      },
    },
  }));
}

/**
 * Gemini shape. Types are UPPERCASE, and a tool with no parameters still needs
 * an object with an empty `properties` — Gemini rejects a bare `{}` and, worse,
 * rejects the whole tools array with it, which takes every other tool down too.
 */
export function browserToolsGemini(I: Record<string, string>) {
  return browserToolSpecs(I).map((s) => ({
    name: s.name,
    description: s.description,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: v.description }]),
      ),
      ...(s.required.length ? { required: s.required } : {}),
    },
  }));
}

// ── session store ────────────────────────────────────────────────────────────
//
// One browser per entity, kept alive between turns so a login or a multi-step
// form survives. Held on globalThis because Next.js hot-reload re-evaluates
// this module and a module-level Map would leak a whole Chromium per edit.

interface Session {
  ctx: BrowserContext;
  page: Page;
  last: number;
  /** Set by the route filter when it blocks a navigation, read after goto. */
  lastBlocked?: string;
}

const g = globalThis as any;
const sessions: Map<string, Session> = g.__nexusBrowserSessions ||= new Map();
const launching: Map<string, Promise<Session>> = g.__nexusBrowserLaunching ||= new Map();

/** Close a browser that has sat unused this long. */
const IDLE_MS = 30 * 60 * 1000;

function startSweeper() {
  if (g.__nexusBrowserSweeper) return;
  g.__nexusBrowserSweeper = setInterval(() => {
    const now = Date.now();
    for (const [name, s] of sessions) {
      if (now - s.last < IDLE_MS) continue;
      sessions.delete(name);
      s.ctx.close().catch(() => {});
      console.log(`[browser] closed ${name}'s browser after ${Math.round(IDLE_MS / 60000)} min idle`);
    }
  }, 60_000);
  // Never hold the process open for this.
  (g.__nexusBrowserSweeper as NodeJS.Timeout).unref?.();
}

// ── host allowlist ───────────────────────────────────────────────────────────

const LOCAL_DEFAULT = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Does `hostname` match one of `allowed`?
 *
 * A bare name matches itself and its subdomains, so `example.com` covers
 * `www.example.com`. A leading dot or `*.` is accepted and means the same
 * thing, because that is how people write it and a rejected allowlist entry
 * fails silently in the direction of "blocked", which is confusing to debug.
 */
export function hostAllowed(hostname: string, allowed: string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return allowed.some((raw) => {
    const pat = String(raw || '').trim().toLowerCase().replace(/^\*?\./, '');
    if (!pat) return false;
    return h === pat || h.endsWith(`.${pat}`);
  });
}

function allowlistFor(ctx: BrowserToolCtx): string[] {
  const extra = (ctx.allowedHosts || []).map((s) => String(s).trim()).filter(Boolean);
  return [...LOCAL_DEFAULT, ...extra];
}

/** null when fine, otherwise the message to hand back to the entity. */
function checkUrl(raw: string, ctx: BrowserToolCtx): string | null {
  if (ctx.allowAnyHost) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `Error: "${raw}" is not a valid URL. Include the scheme, e.g. http://localhost:3000/`;
  }
  if (u.protocol === 'about:' || u.protocol === 'data:') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `Error: only http and https can be opened (got "${u.protocol}").`;
  }
  const list = allowlistFor(ctx);
  if (hostAllowed(u.hostname, list)) return null;
  return (
    `Error: ${u.hostname} is not on this identity's allowed-hosts list.\n` +
    `Currently allowed: ${list.join(', ')}\n` +
    `Nexus blocked the request rather than opening it. Ask the machine's owner to add the host ` +
    `in Identity settings if it is genuinely needed — do not try to route around this.`
  );
}

// ── launching ────────────────────────────────────────────────────────────────

async function launch(entity: string, ctx: BrowserToolCtx): Promise<Session> {
  // Imported lazily so that installing Nexus without Playwright still boots and
  // every other tool keeps working; only the browser tools fail, with a message
  // saying what to install.
  const { chromium } = await import('playwright');

  const dir = path.join(PROFILES_DIR, safeName(entity));
  await fs.mkdir(dir, { recursive: true });

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const session: Session = {
    ctx: context,
    page: context.pages()[0] || (await context.newPage()),
    last: Date.now(),
  };

  // The allowlist as a route filter. `checkUrl` already runs before goto, but a
  // page can navigate itself — a meta refresh, a JS redirect, a form post — and
  // that path never goes through the tool. This closes it.
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (!req.isNavigationRequest()) return route.continue();
    const bad = checkUrl(req.url(), ctx);
    if (!bad) return route.continue();
    session.lastBlocked = req.url();
    return route.abort('blockedbyclient');
  });

  // A click that opens a new tab should move the entity's attention to it —
  // that is what happened on screen, and pretending otherwise means the next
  // snapshot describes a page nobody is looking at.
  context.on('page', (p) => {
    session.page = p;
    p.on('close', () => {
      if (session.page !== p) return;
      const open = context.pages().filter((x) => !x.isClosed());
      if (open.length) session.page = open[open.length - 1];
    });
  });

  // If the human closes the window, forget the session instead of handing back
  // "Target closed" on every later call.
  context.on('close', () => {
    if (sessions.get(entity) === session) sessions.delete(entity);
  });

  startSweeper();
  return session;
}

function safeName(entity: string): string {
  // Entity names are Japanese as often as not; keep them, drop only what
  // Windows refuses in a path component.
  return String(entity || 'Default').replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'Default';
}

/**
 * Get this entity's browser, starting one if needed.
 *
 * Lazy on purpose: there is no switch to turn browsing on. If the entity calls
 * a browser tool, a browser appears. Requiring a click first is the trap the
 * letters feature fell into — a capability that exists but is off by default in
 * every conversation is a capability nobody has.
 */
export async function ensureBrowser(ctx: BrowserToolCtx): Promise<Session> {
  const key = ctx.me || 'Default';
  const live = sessions.get(key);
  if (live && !live.ctx.pages().every((p) => p.isClosed())) {
    live.last = Date.now();
    return live;
  }
  const pending = launching.get(key);
  if (pending) return pending;

  const p = launch(key, ctx)
    .then((s) => {
      sessions.set(key, s);
      launching.delete(key);
      return s;
    })
    .catch((e) => {
      launching.delete(key);
      throw e;
    });
  launching.set(key, p);
  return p;
}

/** Close one entity's browser, or every browser when called with no name. */
export async function closeBrowser(entity?: string): Promise<number> {
  const targets = entity ? [entity] : [...sessions.keys()];
  let n = 0;
  for (const key of targets) {
    const s = sessions.get(key);
    if (!s) continue;
    sessions.delete(key);
    await s.ctx.close().catch(() => {});
    n++;
  }
  return n;
}

export function browserSessionInfo(): { entity: string; url: string; idleMs: number }[] {
  const now = Date.now();
  return [...sessions.entries()].map(([entity, s]) => ({
    entity,
    url: (() => { try { return s.page.url(); } catch { return '(unknown)'; } })(),
    idleMs: now - s.last,
  }));
}

// ── snapshot ─────────────────────────────────────────────────────────────────
//
// Walks the DOM in the page and stamps `data-nexus-ref="e12"` on every
// interactive element that is actually visible, then returns one line each.
// Actions locate by that attribute, so a ref is exact rather than a guess at
// what "the Send button" meant. Refs are regenerated on every snapshot, and
// every action returns a fresh snapshot, so the entity is never working from a
// stale list for more than the action it just took.

const SNAPSHOT_JS = `(opts) => {
  const SEL = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=textbox]', '[role=searchbox]',
    '[role=checkbox]', '[role=radio]', '[role=switch]', '[role=tab]',
    '[role=menuitem]', '[role=combobox]', '[role=option]', '[role=slider]',
    '[onclick]', '[contenteditable=""]', '[contenteditable="true"]'
  ].join(',');

  const MAXN = opts.compact ? 60 : 250;
  const MAXLEN = opts.compact ? 40 : 120;

  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const clip = (s) => (s.length > MAXLEN ? s.slice(0, MAXLEN - 1) + '…' : s);

  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return false;
    if (el.disabled) return true;   // disabled but present is worth reporting
    return true;
  };

  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'file') return 'filepicker';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };

  const nameOf = (el) => {
    const byId = el.getAttribute('aria-labelledby');
    if (byId) {
      const parts = byId.split(/\\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? clean(n.innerText || n.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const lab = el.labels && el.labels[0];
      if (lab) { const t = clean(lab.innerText || lab.textContent); if (t) return t; }
    }
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return ph;
    const txt = clean(el.innerText || el.textContent);
    if (txt) return txt;
    const img = el.querySelector('img[alt]');
    if (img) { const a = clean(img.getAttribute('alt')); if (a) return a; }
    const t = clean(el.getAttribute('title'));
    if (t) return t;
    const v = clean(el.value);
    if (v) return v;
    return '';
  };

  // Clear refs from the previous snapshot so a stale one can never resolve.
  document.querySelectorAll('[data-nexus-ref]').forEach((el) => el.removeAttribute('data-nexus-ref'));

  const out = [];
  let n = 0, truncated = false;
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    if (n >= MAXN) { truncated = true; break; }
    const ref = 'e' + (++n);
    el.setAttribute('data-nexus-ref', ref);

    const role = roleOf(el);
    const name = clip(nameOf(el));
    let line = '- ' + role + (name ? ' "' + name + '"' : '') + ' [ref=' + ref + ']';

    if (el.disabled) line += ' disabled';
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      line += el.checked ? ' checked' : ' unchecked';
    } else if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) {
      line += ' value="' + clip(clean(el.value)) + '"';
    } else if (el.tagName === 'SELECT') {
      const sel = el.options[el.selectedIndex];
      if (sel) line += ' selected="' + clip(clean(sel.text)) + '"';
      const opts2 = [...el.options].slice(0, 20).map((o) => clean(o.text)).filter(Boolean);
      if (opts2.length) line += ' options=[' + opts2.join(' | ') + ']';
    } else if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('#')) line += ' href="' + clip(href) + '"';
    }
    out.push(line);
  }

  return {
    title: document.title,
    url: location.href,
    elements: out,
    truncated,
    total: document.querySelectorAll(SEL).length,
  };
}`;

async function snapshot(page: Page, ctx: BrowserToolCtx): Promise<string> {
  let snap: any;
  try {
    // Playwright evaluates a STRING as an expression, not as a callable: it
    // will not apply the second argument to it. Passing SNAPSHOT_JS plus an
    // options object therefore evaluated to a bare function object, which is
    // not serializable, and came back as undefined. Self-invoke instead and
    // bake the options in — the same shape browser_read already uses.
    const expr = `(${SNAPSHOT_JS})(${JSON.stringify({ compact: !!ctx.compact })})`;
    snap = await page.evaluate(expr as any);
  } catch (e: any) {
    return `Page: ${page.url()}\n(could not read the page: ${e?.message || e})`;
  }
  if (!snap || !Array.isArray(snap.elements)) {
    return `Page: ${page.url()}\n(the page returned no description — it may still be loading)`;
  }
  const head = `Page: ${snap.title || '(untitled)'}\nURL: ${snap.url}`;
  if (!snap.elements.length) {
    return `${head}\n\nNo interactive elements found. Use browser_read to see the text.`;
  }
  const tail = snap.truncated
    ? `\n(showing the first ${snap.elements.length} of ${snap.total} interactive elements)`
    : '';
  return `${head}\n\n${snap.elements.join('\n')}${tail}`;
}

async function locate(page: Page, ref: string) {
  const clean = String(ref || '').trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
  if (!/^e\d+$/.test(clean)) {
    throw new Error(
      `"${ref}" is not a ref. Refs look like e12 and come from the [ref=…] on a browser_snapshot line. ` +
      `Take a snapshot first and use one of the refs it lists.`,
    );
  }
  const loc = page.locator(`[data-nexus-ref="${clean}"]`);
  if ((await loc.count()) === 0) {
    throw new Error(
      `Ref ${clean} is not on the page any more — it probably changed after the last action. ` +
      `Call browser_snapshot and use a fresh ref.`,
    );
  }
  return loc.first();
}

/** Let a click's consequences land before describing the result. */
async function settle(page: Page) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
  } catch { /* a long-polling page never reaches it; that is fine */ }
  await page.waitForTimeout(350);
}

// ── the executor ─────────────────────────────────────────────────────────────
//
// NEXUS registers these tools four times (OAuth MCP, Claude API, Gemini,
// OpenAI-compatible) but must EXECUTE them identically everywhere. One
// executor, four thin call sites, so a fix can never land on three paths out of
// four — the same shape as runLetterTool.
//
// Returns a string on every path, including failure. A thrown error would
// dead-end the tool loop on paths that wait for a result block, and the entity
// can act on a sentence far more usefully than the caller can on an exception.

export async function runBrowserTool(name: string, args: any, ctx: BrowserToolCtx): Promise<string> {
  try {
    let session: Session;
    try {
      session = await ensureBrowser(ctx);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/Cannot find module 'playwright'|Executable doesn't exist/i.test(msg)) {
        return (
          'Error: the browser is not installed on this machine.\n' +
          'Run `npm install` and then `npx playwright install chromium` in web-app/, then try again.\n' +
          `(${msg.split('\n')[0]})`
        );
      }
      return `Error: could not start the browser — ${msg.split('\n')[0]}`;
    }
    const page = session.page;
    session.last = Date.now();

    switch (name) {
      // ── navigate ──────────────────────────────────────────────────────────
      case 'browser_navigate': {
        const raw = String(args?.url ?? args?.href ?? args?.address ?? '').trim();
        if (!raw) return 'Error: a url is required (or "back", "forward", "reload").';

        if (/^(back|forward|reload|refresh)$/i.test(raw)) {
          if (/^back$/i.test(raw)) await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
          else if (/^forward$/i.test(raw)) await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
          else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await settle(page);
          return await snapshot(page, ctx);
        }

        // Bare hostnames are what a model types when it is thinking about the
        // site rather than the URL. Assume http:// so it works instead of
        // failing on a technicality.
        //
        // "Has a scheme" cannot be just [a-z]+: — that also matches the host of
        // "localhost:3000", which is the single most likely thing to be typed
        // here, and it then failed with "only http and https can be opened (got
        // localhost:)". A colon followed by digits is a port, not a scheme.
        const hasScheme =
          /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||          // http://…, file://…
          /^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(raw);        // mailto:…, about:…
        const url = hasScheme ? raw : `http://${raw}`;
        const blocked = checkUrl(url, ctx);
        if (blocked) return blocked;

        session.lastBlocked = undefined;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e: any) {
          if (session.lastBlocked) {
            return checkUrl(session.lastBlocked, ctx) ||
              `Error: navigation to ${session.lastBlocked} was blocked.`;
          }
          return `Error: could not open ${url} — ${String(e?.message || e).split('\n')[0]}`;
        }

        // Redirects. The route filter catches most of them, but check the URL
        // actually landed on too: belt and braces, and it costs nothing.
        const landed = checkUrl(page.url(), ctx);
        if (landed) {
          await page.goto('about:blank').catch(() => {});
          return `Error: ${url} redirected off the allowed-hosts list.\n${landed}`;
        }

        await settle(page);
        return await snapshot(page, ctx);
      }

      // ── snapshot ──────────────────────────────────────────────────────────
      case 'browser_snapshot':
        return await snapshot(page, ctx);

      // ── click ─────────────────────────────────────────────────────────────
      case 'browser_click': {
        const ref = String(args?.ref ?? args?.element ?? args?.selector ?? '').trim();
        if (!ref) return 'Error: a ref is required. Take a browser_snapshot to get one.';
        const loc = await locate(page, ref);
        const label = (await loc.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim().slice(0, 60) || ref;
        try {
          await loc.click({ timeout: 10000 });
        } catch (e: any) {
          return `Error: could not click ${ref} — ${String(e?.message || e).split('\n')[0]}\n\n` +
            (await snapshot(session.page, ctx));
        }
        await settle(session.page);
        return `Clicked ${ref}${label && label !== ref ? ` ("${label}")` : ''}.\n\n` +
          (await snapshot(session.page, ctx));
      }

      // ── type ──────────────────────────────────────────────────────────────
      case 'browser_type': {
        const ref = String(args?.ref ?? args?.element ?? '').trim();
        const text = String(args?.text ?? args?.value ?? args?.content ?? '');
        if (!ref) return 'Error: a ref is required. Take a browser_snapshot to get one.';
        const submit = args?.submit === true || args?.submit === 'true' || args?.press_enter === true;
        const loc = await locate(page, ref);
        try {
          // fill() clears first, which is what "type this into the box" means
          // nearly every time; append would need its own tool.
          await loc.fill(text, { timeout: 10000 });
        } catch {
          // Rich editors and contenteditable often refuse fill(); fall back to
          // real keystrokes rather than reporting failure.
          try {
            await loc.click({ timeout: 5000 });
            await page.keyboard.type(text, { delay: 10 });
          } catch (e: any) {
            return `Error: could not type into ${ref} — ${String(e?.message || e).split('\n')[0]}`;
          }
        }
        if (submit) {
          await loc.press('Enter').catch(() => {});
          await settle(session.page);
        }
        return `Typed into ${ref}${submit ? ' and pressed Enter' : ''}.\n\n` +
          (await snapshot(session.page, ctx));
      }

      // ── read ──────────────────────────────────────────────────────────────
      case 'browser_read': {
        const max = ctx.compact ? 6000 : 20000;
        let body: string;
        try {
          // innerText already reflects rendered text only, so script/style
          // contents never appear — no need to strip them by hand.
          body = await page.evaluate(`(() => {
            const t = document.body ? document.body.innerText : '';
            return String(t || '').replace(/\\n{3,}/g, '\\n\\n').trim();
          })()` as any);
        } catch (e: any) {
          return `Error: could not read the page — ${String(e?.message || e).split('\n')[0]}`;
        }
        const head = `Page: ${await page.title().catch(() => '')}\nURL: ${page.url()}\n\n`;
        if (body.length <= max) return head + (body || '(the page has no visible text)');
        return `${head}${body.slice(0, max)}\n\n[… ${body.length - max} more characters. ` +
          `Scroll or navigate to a narrower page to see the rest.]`;
      }

      // ── screenshot ────────────────────────────────────────────────────────
      case 'browser_screenshot': {
        const full = args?.full_page === true || args?.fullPage === true;
        let png: Buffer;
        try {
          png = await page.screenshot({ fullPage: full, type: 'png' });
        } catch (e: any) {
          return `Error: could not take the screenshot — ${String(e?.message || e).split('\n')[0]}`;
        }
        const { ref } = await putBytes(png, 'image/png');
        const dir = path.join(WORKSPACES_DIR, safeName(ctx.me), 'screenshots');
        await fs.mkdir(dir, { recursive: true });
        const file = `${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        await fs.writeFile(path.join(dir, file), png);
        return (
          `Saved a screenshot of ${page.url()}\n` +
          `  workspace: screenshots/${file}\n` +
          `  url: /api/attachments/${ref}\n` +
          `Note: this is saved for the human to look at — you cannot see it yourself. ` +
          `Use browser_snapshot or browser_read to find out what is on the page.`
        );
      }

      default:
        return `Error: unknown browser tool "${name}".`;
    }
  } catch (e: any) {
    return `Error: ${String(e?.message || e).split('\n')[0]}`;
  }
}
