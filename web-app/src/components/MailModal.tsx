"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Mail, Loader2, Trash2, Save, RefreshCw, PenLine, Send,
  MailOpen, Archive, AlertTriangle, Check, Reply, FolderOpen,
} from 'lucide-react';
import EditableCombo from './EditableCombo';
import { useT } from '@/lib/i18n';

// ── Mail Manager ────────────────────────────────────────────────────────────
// Human-facing window over local_data/letters/. Opens from the ✉️ header button.
//
// It shows EVERY letter in the store, not one identity's mailbox — including
// mail addressed to a name that has no folder, which no entity will ever be
// told about. Those would otherwise be invisible, so they are flagged here.
//
// The .read / .archived sidecar files remain the single source of truth. This
// window creates and deletes them for you; it is a convenience over editing
// them in Explorer, never a second authority. _status.md stays generated-only.

interface Letter {
  id: string;
  from: string;
  to: string;
  title: string;
  sent: string;
  read: boolean;
  archived: boolean;
  readAt?: string;
  archivedAt?: string;
  body?: string;
}

type StateFilter = 'all' | 'unread' | 'read' | 'archived';

function when(sent: string): string {
  return (sent || '').replace('T', ' ').slice(0, 16);
}

// "Re: " once, not "Re: Re: Re: ". Matches the common prefixes an entity might
// already have written for itself, in either language.
function replyTitle(title: string): string {
  const t = (title || '').trim();
  return /^\s*(re|reply|返信)\s*[::]/i.test(t) ? t : `Re: ${t}`;
}

export default function MailModal({
  open,
  onClose,
  onUnreadChange,
}: {
  open: boolean;
  onClose: () => void;
  onUnreadChange?: (n: number) => void;
}) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [letters, setLetters] = useState<Letter[]>([]);
  const [names, setNames] = useState<string[]>([]);
  const [identities, setIdentities] = useState<string[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Letter | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftText, setDraftText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Filters
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [who, setWho] = useState('');
  const [q, setQ] = useState('');

  // Compose
  const [composing, setComposing] = useState(false);
  const [cFrom, setCFrom] = useState('');
  const [cTo, setCTo] = useState('');
  const [cTitle, setCTitle] = useState('');
  const [cText, setCText] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/letters');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || t('mail.loadFailed'));
      setLetters(data.letters || []);
      setNames(data.names || []);
      setIdentities(data.identities || []);
      onUnreadChange?.(data.unread || 0);
    } catch (e: any) {
      setError(e?.message || t('mail.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange, t]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // Reset transient state when the window closes so it never reopens mid-edit.
  useEffect(() => {
    if (open) return;
    setSelectedId(null); setDetail(null); setDirty(false);
    setComposing(false); setConfirmDelete(false); setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Load one letter's body on selection.
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/letters?id=${encodeURIComponent(selectedId)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data?.error || t('mail.openFailed'));
        setDetail(data.letter);
        setDraftTitle(data.letter.title || '');
        setDraftText(data.letter.body || '');
        setDirty(false);
        setConfirmDelete(false);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || t('mail.openFailed'));
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, t]);

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/letters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || t('mail.opFailed'));
      return data;
    } catch (e: any) {
      setError(e?.message || t('mail.opFailed'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const setFlag = async (l: Letter, patch: { read?: boolean; archived?: boolean }) => {
    // Optimistic: the list stays responsive, and load() re-reads the truth.
    setLetters((prev) => prev.map((x) => (x.id === l.id ? { ...x, ...patch } : x)));
    if (detail?.id === l.id) setDetail((d) => (d ? { ...d, ...patch } : d));
    if (await act({ action: 'flags', id: l.id, ...patch })) load();
  };

  const save = async () => {
    if (!detail) return;
    if (await act({ action: 'update', id: detail.id, title: draftTitle, text: draftText })) {
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
      load();
    }
  };

  const remove = async () => {
    if (!detail) return;
    if (await act({ action: 'delete', id: detail.id })) {
      setSelectedId(null);
      setConfirmDelete(false);
      load();
    }
  };

  // Show the letter's .md in the OS file manager, selected. Its .read and
  // .archived sidecars are sitting right next to it — this window creates and
  // deletes them, but they remain the truth, and sometimes you want the truth
  // in front of you rather than a rendering of it.
  const reveal = async () => {
    if (!detail) return;
    await act({ action: 'reveal', id: detail.id });
  };

  // Reply: swap the two ends, prefix the title, leave the body empty. The
  // letter being answered stays untouched — replying is not reading, and it is
  // not archiving; if it was unread it stays unread until you say otherwise.
  const startReply = (l: Letter) => {
    setCFrom(l.to);
    setCTo(l.from);
    setCTitle(replyTitle(l.title));
    setCText('');
    // selectedId is kept on purpose: composing takes precedence in the render,
    // so Cancel drops straight back to the letter being answered instead of an
    // empty pane.
    setComposing(true);
  };

  const send = async () => {
    const r = await act({ action: 'create', from: cFrom, to: cTo, title: cTitle, text: cText });
    if (r?.ok) {
      setComposing(false);
      setCTitle(''); setCText('');
      await load();
      setSelectedId(r.id);
    }
  };

  const identitySet = useMemo(() => new Set(identities), [identities]);
  const nameOptions = useMemo(() => names.map((n) => ({ value: n })), [names]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return letters.filter((l) => {
      if (stateFilter === 'unread' && (l.read || l.archived)) return false;
      if (stateFilter === 'read' && !l.read) return false;
      if (stateFilter === 'archived' && !l.archived) return false;
      if (who && l.from !== who && l.to !== who) return false;
      if (needle && !(`${l.title} ${l.from} ${l.to}`.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [letters, stateFilter, who, q]);

  // Mail nobody will ever be told about: the recipient has no folder, so the
  // arrival notice can never fire for it. Worth surfacing — this is exactly the
  // case that used to be invisible.
  const undeliverable = useMemo(
    () => letters.filter((l) => !identitySet.has(l.to) && !l.read && !l.archived).length,
    [letters, identitySet],
  );

  if (!open) return null;

  const stateChip = (l: Letter) => {
    if (l.archived) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400">{t('mail.chip.archived')}</span>;
    if (l.read) return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">{t('mail.chip.read')}</span>;
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/25 text-amber-400">{t('mail.chip.unread')}</span>;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          <Mail className="h-5 w-5 text-amber-500" />
          <h2 className="text-base font-semibold text-foreground">{t('mail.title')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('mail.count').replace('{n}', String(letters.length))}
            {letters.some((l) => !l.read && !l.archived) &&
              t('mail.unreadSuffix').replace('{n}', String(letters.filter((l) => !l.read && !l.archived).length))}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => { setComposing(true); setSelectedId(null); }}
              className="flex items-center gap-1.5 rounded-lg bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-500 hover:bg-amber-500/25"
            >
              <PenLine className="h-3.5 w-3.5" /> {t('mail.write')}
            </button>
            <button
              onClick={() => act({ action: 'regenerate' }).then(() => load())}
              title={t('mail.regenTitle')}
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-xs text-red-400">{error}</div>
        )}
        {undeliverable > 0 && (
          <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-xs text-amber-500">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {/* One sentence, one key: Japanese has no plural, so the English
                it/them branching could not survive translation. */}
            <span>{t('mail.undeliverable').replace('{n}', String(undeliverable))}</span>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* ── list ─────────────────────────────────────────────────────── */}
          <div className="flex w-[45%] min-w-0 flex-col border-r border-border">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              {(['all', 'unread', 'read', 'archived'] as StateFilter[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStateFilter(s)}
                  className={`rounded-md px-2 py-1 text-xs font-medium ${
                    stateFilter === s ? 'bg-amber-500/20 text-amber-500' : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {t(`mail.filter.${s}`)}
                </button>
              ))}
              <select
                value={who}
                onChange={(e) => setWho(e.target.value)}
                className="ml-auto max-w-[9rem] rounded-md border border-border bg-background px-2 py-1 text-xs outline-none"
              >
                <option value="">{t('mail.everyone')}</option>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('mail.filterPlaceholder')}
              className="border-b border-border bg-background px-3 py-2 text-xs outline-none"
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && letters.length === 0 && (
                <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t('mail.reading')}
                </div>
              )}
              {!loading && filtered.length === 0 && (
                <div className="p-6 text-center text-xs text-muted-foreground">{t('mail.noMatch')}</div>
              )}
              {filtered.map((l) => (
                <button
                  key={l.id}
                  onClick={() => { setComposing(false); setSelectedId(l.id); }}
                  className={`block w-full border-b border-border/60 px-3 py-2 text-left hover:bg-muted/50 ${
                    selectedId === l.id ? 'bg-muted' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-sm ${!l.read && !l.archived ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                      {l.title || t('mail.noTitle')}
                    </span>
                    <span className="ml-auto shrink-0">{stateChip(l)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="truncate">{l.from}</span>
                    <span>→</span>
                    <span className={`truncate ${identitySet.has(l.to) ? '' : 'text-amber-500'}`}>
                      {l.to}{identitySet.has(l.to) ? '' : t('mail.noFolder')}
                    </span>
                    <span className="ml-auto shrink-0 font-mono">{when(l.sent)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* ── detail / compose ─────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {composing ? (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
                <p className="text-xs leading-relaxed text-muted-foreground">{t('mail.compose.hint')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-foreground">{t('mail.from')}</label>
                    <EditableCombo value={cFrom} onChange={setCFrom} options={nameOptions} placeholder={t('mail.senderPlaceholder')} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-foreground">{t('mail.to')}</label>
                    <EditableCombo value={cTo} onChange={setCTo} options={nameOptions} placeholder={t('mail.recipientPlaceholder')} />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-foreground">{t('mail.titleField')}</label>
                  <input
                    value={cTitle}
                    onChange={(e) => setCTitle(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <label className="mb-1 block text-xs font-semibold text-foreground">{t('mail.letterField')}</label>
                  <textarea
                    value={cText}
                    onChange={(e) => setCText(e.target.value)}
                    className="min-h-[14rem] flex-1 resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-amber-500/40"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={send}
                    disabled={busy || !cFrom.trim() || !cTo.trim() || !cTitle.trim() || !cText.trim()}
                    className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" /> {t('mail.deliver')}
                  </button>
                  <button onClick={() => setComposing(false)} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted">
                    {t('mail.cancel')}
                  </button>
                </div>
              </div>
            ) : !detail ? (
              <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                {t('mail.selectHint')}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-b border-border px-4 py-3">
                  <input
                    value={draftTitle}
                    onChange={(e) => { setDraftTitle(e.target.value); setDirty(true); }}
                    className="w-full bg-transparent text-base font-semibold text-foreground outline-none"
                  />
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{detail.from}</span><span>→</span>
                    <span className={identitySet.has(detail.to) ? '' : 'text-amber-500'}>
                      {detail.to}{identitySet.has(detail.to) ? '' : t('mail.noFolderNotified')}
                    </span>
                    <span className="font-mono">{when(detail.sent)}</span>
                    <span className="font-mono opacity-60">{detail.id}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                  <button
                    onClick={() => startReply(detail)}
                    title={t('mail.replyTitle').replace('{to}', detail.to).replace('{from}', detail.from)}
                    className="flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-500 hover:bg-amber-500/25"
                  >
                    <Reply className="h-3.5 w-3.5" /> {t('mail.reply')}
                  </button>
                  <button
                    onClick={() => setFlag(detail, { read: !detail.read })}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
                      detail.read ? 'bg-emerald-500/20 text-emerald-400' : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <MailOpen className="h-3.5 w-3.5" /> {detail.read ? t('mail.isRead') : t('mail.markRead')}
                  </button>
                  <button
                    onClick={() => setFlag(detail, { archived: !detail.archived })}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
                      detail.archived ? 'bg-zinc-500/25 text-zinc-300' : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <Archive className="h-3.5 w-3.5" /> {detail.archived ? t('mail.isArchived') : t('mail.archive')}
                  </button>
                  <button
                    onClick={reveal}
                    disabled={busy}
                    title={t('mail.showFileTitle')}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
                  >
                    <FolderOpen className="h-3.5 w-3.5" /> {t('mail.showFile')}
                  </button>
                  {detail.readAt && <span className="text-[11px] text-muted-foreground">{t('mail.opened').replace('{when}', when(detail.readAt))}</span>}

                  <div className="ml-auto flex items-center gap-2">
                    {saved && <span className="flex items-center gap-1 text-[11px] text-emerald-400"><Check className="h-3 w-3" /> {t('mail.saved')}</span>}
                    <button
                      onClick={save}
                      disabled={!dirty || busy}
                      className="flex items-center gap-1.5 rounded-md bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-500 disabled:opacity-40"
                    >
                      <Save className="h-3.5 w-3.5" /> {t('mail.save')}
                    </button>
                    {confirmDelete ? (
                      <>
                        <span className="text-[11px] text-red-400">{t('mail.deleteConfirm')}</span>
                        <button onClick={remove} className="rounded-md bg-red-500 px-2.5 py-1 text-xs font-semibold text-white">{t('mail.yes')}</button>
                        <button onClick={() => setConfirmDelete(false)} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted">{t('mail.no')}</button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(true)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-red-500/15 hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                <textarea
                  value={draftText}
                  onChange={(e) => { setDraftText(e.target.value); setDirty(true); }}
                  className="min-h-0 flex-1 resize-none bg-background p-4 font-mono text-sm leading-relaxed outline-none"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
