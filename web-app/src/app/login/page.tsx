'use client';

import { useEffect, useState } from 'react';
import { renderRich, t, type UiLanguage } from '@/lib/i18n';

/**
 * The sign-in page. Reachable without a session (the middleware exempts it and
 * `/api/auth/*`), so it must not read anything from the server that the gate
 * protects.
 *
 * The UI language comes from localStorage, where the app already keeps it
 * (`nexus_globalSettings.language`). That is readable before sign-in, whereas
 * `/api/user` is behind the gate — so reaching for the server here would hand
 * the operator an English-only login screen on a Japanese install.
 */

/**
 * Only a same-origin path is honoured. A `next` of `//evil.example` or
 * `https://evil.example` parses as an absolute URL in a browser and would turn
 * this form into an open redirect: sign in here, get sent there. Anything that
 * is not a single-slash-rooted path is discarded in favour of `/`.
 */
function safeNext(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/';
  return raw;
}

export default function LoginPage() {
  const [lang, setLang] = useState<UiLanguage>('en');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('nexus_globalSettings');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.language === 'ja') setLang('ja');
      }
    } catch {
      // A corrupt settings blob must not stop someone signing in.
    }
  }, []);

  // If no gate is configured, standing on this page is a dead end — there is
  // nothing to sign in to and every other path is already open. Say so and
  // offer the way back rather than presenting a form that can only fail.
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.broken) setError('broken');
        else if (!d?.enabled) setNotConfigured(true);
        else if (d?.authenticated) {
          window.location.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
        return;
      }
      const d = await res.json().catch(() => ({}));
      setError(d?.error === 'notConfigured' ? 'notConfigured' : d?.error === 'broken' ? 'broken' : 'invalid');
    } catch {
      setError('network');
    } finally {
      setBusy(false);
    }
  }

  const tr = (k: string) => t(k, lang);
  // Prose, not labels: these strings carry `code` spans (a file path the person
  // is being told to delete). Rendered raw, the backticks print literally —
  // which is how this first shipped, caught by looking at the page rather than
  // by any test. `Tx` is the usual way, but it reads the language from a
  // context this page is deliberately outside of, so it gets the plain
  // renderer with the language we already resolved.
  const trRich = (k: string) => renderRich(t(k, lang));

  return (
    <div className="h-dvh w-full flex items-center justify-center bg-background text-foreground p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
        <h1 className="text-lg font-bold mb-1">{tr('login.title')}</h1>
        <p className="text-xs text-muted-foreground mb-4">{tr('login.subtitle')}</p>

        {notConfigured ? (
          <div className="space-y-3">
            <div className="text-sm rounded-lg border border-border bg-muted/40 p-3">
              {trRich('login.notConfigured')}
            </div>
            <a
              href="/"
              className="block text-center rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold py-2"
            >
              {tr('login.goHome')}
            </a>
          </div>
        ) : error === 'broken' ? (
          <div className="text-sm rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 p-3">
            {trRich('login.broken')}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="text-xs font-semibold block mb-1">{tr('login.username')}</label>
              <input
                type="text"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1">{tr('login.password')}</label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            {error && error !== 'broken' && (
              <div className="text-xs rounded-lg border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2">
                {trRich(error === 'network' ? 'login.err.network' : error === 'notConfigured' ? 'login.notConfigured' : 'login.err.invalid')}
              </div>
            )}

            <button
              type="submit"
              disabled={busy || !username || !password}
              className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold py-2"
            >
              {busy ? tr('login.signingIn') : tr('login.signIn')}
            </button>
          </form>
        )}

        <p className="text-[11px] text-muted-foreground mt-4 leading-relaxed">{trRich('login.recovery')}</p>
      </div>
    </div>
  );
}
