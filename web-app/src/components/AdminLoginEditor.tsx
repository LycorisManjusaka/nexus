'use client';

import React from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { useT, Tx } from '@/lib/i18n';

/**
 * The sign-in section of Preferences → Other.
 *
 * Its own component, following `UserIdentityEditor`, because its state does not
 * live in `globalSettings` (which is localStorage, per browser) — the gate is a
 * file on the machine serving NEXUS, so it is read from and written to the
 * server and is the same for every browser that connects.
 *
 * Ticking the checkbox does NOT turn the gate on. It reveals the fields,
 * because turning it on needs a name and a password that the operator has not
 * typed yet; committing on tick would either save an empty password or need a
 * second confirmation step anyway.
 */

type Status = { enabled: boolean; authenticated: boolean; broken?: boolean; username?: string };

const MIN_LENGTH_FALLBACK = 8;

export default function AdminLoginEditor() {
  const t = useT();
  const [status, setStatus] = React.useState<Status | null>(null);
  const [wantGate, setWantGate] = React.useState(false);
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch('/api/auth/status');
      const d = (await res.json()) as Status;
      setStatus(d);
      setWantGate(d.enabled);
    } catch {
      // Leaving `status` null renders nothing but the heading, which is honest:
      // we do not know the state, so we claim nothing about it.
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  function clearFields() {
    setPassword('');
    setConfirm('');
  }

  async function save(isChange: boolean) {
    setError(null);
    setNotice(null);
    if (!username.trim()) { setError(t('settings.login.err.noUsername')); return; }
    if (password.length < MIN_LENGTH_FALLBACK) {
      setError(t('settings.login.err.tooShort').replace('{n}', String(MIN_LENGTH_FALLBACK)));
      return;
    }
    if (password !== confirm) { setError(t('settings.login.err.mismatch')); return; }
    if (isChange && !window.confirm(t('settings.login.change.confirm'))) return;

    setBusy(true);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, confirm }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) setError(t('settings.login.err.unauthorized'));
        else if (d?.error === 'tooShort') setError(t('settings.login.err.tooShort').replace('{n}', String(d?.minLength ?? MIN_LENGTH_FALLBACK)));
        else if (d?.error === 'mismatch') setError(t('settings.login.err.mismatch'));
        else if (d?.error === 'noUsername') setError(t('settings.login.err.noUsername'));
        else setError(t('settings.login.err.failed').replace('{msg}', String(d?.error ?? res.status)));
        return;
      }
      clearFields();
      setNotice(t('settings.login.savedOn'));
      await refresh();
    } catch (e: any) {
      setError(t('settings.login.err.failed').replace('{msg}', String(e?.message ?? e)));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setError(null);
    setNotice(null);
    if (!window.confirm(t('settings.login.disable.confirm'))) return;
    setBusy(true);
    try {
      const res = await fetch('/api/auth/setup', { method: 'DELETE' });
      if (!res.ok) {
        setError(res.status === 401 ? t('settings.login.err.unauthorized') : t('settings.login.err.failed').replace('{msg}', String(res.status)));
        return;
      }
      setUsername('');
      clearFields();
      setNotice(t('settings.login.savedOff'));
      await refresh();
    } catch (e: any) {
      setError(t('settings.login.err.failed').replace('{msg}', String(e?.message ?? e)));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.replace('/login');
  }

  const enabled = !!status?.enabled;
  const broken = !!status?.broken;
  const showFields = wantGate && !broken;

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="flex items-center gap-2">
        {enabled ? <Lock size={14} className="text-emerald-500" /> : <LockOpen size={14} className="text-muted-foreground" />}
        <span className="text-sm font-semibold text-foreground">{t('settings.login.heading')}</span>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        <Tx k="settings.login.intro" />
      </p>

      {broken ? (
        <div className="text-xs rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 px-3 py-2 leading-relaxed">
          <Tx k="settings.login.broken" />
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={wantGate}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.checked;
                setError(null);
                setNotice(null);
                // Unticking while the gate is live is a destructive act, so it
                // runs through the same confirm as the button and only moves
                // the checkbox if the operator agrees.
                if (!next && enabled) { void disable(); return; }
                setWantGate(next);
                if (!next) clearFields();
                if (next && !username && status?.username) setUsername(status.username);
              }}
              className="w-4 h-4 accent-indigo-500"
            />
            <span className="text-sm text-foreground">{t('settings.login.require')}</span>
          </label>
          <p className="text-xs text-muted-foreground ml-6 leading-relaxed">
            <Tx k="settings.login.require.help" />
          </p>

          {enabled && (
            <div className="text-xs rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-3 py-2">
              {status?.username
                ? <Tx k="settings.login.enabledAs" />
                : <Tx k="settings.login.enabled" />}
              {status?.username && (
                <span className="font-mono"> {status.username}</span>
              )}
            </div>
          )}

          {showFields && (
            <div className="space-y-2 ml-6">
              <div>
                <label className="text-xs font-semibold block mb-1">{t('settings.login.username')}</label>
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-semibold block mb-1">{t('settings.login.password')}</label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold block mb-1">{t('settings.login.confirm')}</label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(enabled)}
                  className="rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5"
                >
                  {busy ? t('settings.login.saving') : enabled ? t('settings.login.change') : t('settings.login.save')}
                </button>
                {enabled && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void disable()}
                      className="rounded-lg border border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50 text-xs font-semibold px-3 py-1.5"
                    >
                      {t('settings.login.disable')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void signOut()}
                      className="rounded-lg border border-border hover:bg-muted text-xs font-semibold px-3 py-1.5"
                    >
                      {t('settings.login.signOut')}
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs rounded-lg border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2">
              {error}
            </div>
          )}
          {notice && (
            <div className="text-xs rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-3 py-2">
              {notice}
            </div>
          )}

          {/* Both halves of the truth, always visible — not folded behind the
              checkbox. Someone deciding whether to turn this on needs to know
              what it covers AND what it does not, before they decide. */}
          <p className="text-xs text-muted-foreground leading-relaxed">
            <Tx k="settings.login.scope" />
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-400 leading-relaxed">
            <Tx k="settings.login.transport" />
          </p>
        </>
      )}
    </div>
  );
}
