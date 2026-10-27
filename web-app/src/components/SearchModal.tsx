"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Loader2, Calendar, Copy, Check } from 'lucide-react';
import { format } from 'date-fns';
import { compareConvoTitles } from '@/lib/convoSort';
import { buildDeepLink, absoluteDeepLink } from '@/lib/deepLink';
import { useT } from '@/lib/i18n';
import { copyText } from '@/lib/clipboard';
import { escapeForRegExp } from '@/lib/convoNaming';

// Full-text search across all conversations of the current entity. Opens from
// the 🔍 header button, matches message bodies via /api/search, groups hits by
// conversation (ordered by the shared "<name>_<number>-<index>" convention),
// and highlights the query inside each trimmed snippet.

interface Snippet { messageIndex: number; messageId: string | null; author: string; timestamp: number | null; text: string; }
interface Group { folder: string; convoId: string; convoTitle: string; active: boolean; matches: Snippet[]; }
interface SearchPayload {
  query: string; folder: string; folders: string[]; results: Group[];
  conversationsMatched: number; conversationsSearched: number;
  conversationsSkippedByDate: number; messagesSkippedNoTimestamp: number;
  totalMatches: number;
}

/** Local midnight → epoch ms. The browser knows the timezone; the server doesn't. */
function dayStart(isoDate: string): number | null {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00`);
  return isNaN(d.getTime()) ? null : d.getTime();
}
/** Local end-of-day, so a TO date includes everything that happened that day. */
function dayEnd(isoDate: string): number | null {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T23:59:59.999`);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// Split `text` on case-insensitive occurrences of `query` and wrap matches in
// <mark>. Returns an array of React nodes.
function highlight(text: string, query: string): React.ReactNode[] {
  if (!query) return [text];
  const re = new RegExp(`(${escapeForRegExp(query)})`, 'gi');
  const parts = text.split(re);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <mark key={i} className="rounded-sm bg-amber-400/40 px-0.5 text-inherit">{part}</mark>
      : <React.Fragment key={i}>{part}</React.Fragment>
  );
}

export default function SearchModal({ open, onClose, folderName }: { open: boolean; onClose: () => void; folderName: string }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SearchPayload | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Advanced options ─────────────────────────────────────────────────────
  // All default to the previous behavior, so the panel opens exactly as before
  // until the checkbox is ticked.
  const [advanced, setAdvanced] = useState(false);
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [dateFilter, setDateFilter] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  // Opens the browser's own calendar popup. `<input type="date">` has had one
  // all along — it was just easy to miss, because the calendar glyph Chrome
  // draws inside the field was invisible against the dark theme (fixed with
  // `color-scheme` in globals.css). This makes it explicit: the whole field and
  // a dedicated button both summon it.
  //
  // showPicker() throws when the call isn't user-initiated or the browser is
  // too old, so a failure quietly leaves normal typing as the fallback.
  const openPicker = (ref: React.RefObject<HTMLInputElement | null>) => {
    const el = ref.current;
    if (!el || el.disabled) return;
    try { el.showPicker(); } catch { el.focus(); }
  };

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Clear stale results when the entity changes underneath us.
  useEffect(() => { setData(null); setError(null); }, [folderName]);

  const [copied, setCopied] = useState<false | true | 'failed'>(false);

  const sortedResults = useMemo(() => {
    if (!data) return [];
    // An all-entities result is already grouped by folder server-side; re-sorting
    // by title alone here would interleave entities.
    if (data.folder === '*') return data.results;
    return [...data.results].sort((a, b) => compareConvoTitles(a.convoTitle, b.convoTitle));
  }, [data]);

  /**
   * The whole result set as Markdown, links included.
   *
   * Uses ABSOLUTE urls rather than the /c/… paths the list renders: this text
   * is meant to leave Nexus (notes, a document, a message), where a bare path
   * resolves against the wrong origin and is useless.
   */
  function buildMarkdown(): string {
    if (!data) return '';
    // No English plural machinery here: Japanese has none, and a ternary
    // baked into the sentence could not be translated. The keys carry "(s)".
    const out: string[] = [];

    out.push(t('search.md.title').replace('{q}', data.query));
    out.push('');
    out.push(
      t('search.md.summary')
        .replace('{matches}', data.totalMatches.toLocaleString())
        .replace('{convos}', String(data.conversationsMatched))
        .replace('{searched}', String(data.conversationsSearched))
        .replace('{scope}', data.folder === '*'
          ? t('search.md.allEntities').replace('{n}', String(data.folders.length))
          : data.folder)
    );
    if (dateFilter && (fromDate || toDate)) {
      out.push(t('search.md.dateRange')
        .replace('{from}', fromDate || t('search.md.any'))
        .replace('{to}', toDate || t('search.md.any')));
    }
    // The same caveats the panel shows. A pasted report that quietly omitted
    // them would look more complete than the search actually was.
    if (data.conversationsSkippedByDate > 0) {
      out.push(t('search.md.skipped').replace('{n}', String(data.conversationsSkippedByDate)));
    }
    if (data.messagesSkippedNoTimestamp > 0) {
      out.push(t('search.md.hidden').replace('{n}', String(data.messagesSkippedNoTimestamp)));
    }
    out.push('');

    for (const g of sortedResults) {
      const tags: string[] = [];
      if (data.folder === '*') tags.push(g.folder);
      if (!g.active) tags.push(t('search.inactive'));
      out.push(`## [${g.convoTitle}](${absoluteDeepLink(g.folder, g.convoId)})${tags.length ? ` — ${tags.join(', ')}` : ''}`);
      out.push('');
      for (const m of g.matches) {
        const url = absoluteDeepLink(g.folder, g.convoId, m.messageId || undefined);
        const ts = m.timestamp != null ? format(new Date(m.timestamp), 'yyyy-MM-dd HH:mm') : '';
        const meta = ts ? `${m.author} · ${ts}` : m.author;
        // Snippets are already single-line from the search lib, but collapse
        // defensively — a stray newline would break the list item.
        out.push(`- [${meta}](${url}) — ${m.text.replace(/\s+/g, ' ').trim()}`);
      }
      out.push('');
    }
    return out.join('\n').trimEnd() + '\n';
  }

  async function copyResults() {
    const md = buildMarkdown();
    if (!md) return;
    // This used to carry its own copy of the selection trick AND claim
    // "copied" unconditionally, including when execCommand had failed. Both
    // now live in lib/clipboard.ts, which reports whether it actually landed.
    setCopied((await copyText(md)) ? true : 'failed');
    setTimeout(() => setCopied(false), 1600);
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) return;

    const from = advanced && dateFilter ? dayStart(fromDate) : null;
    const to = advanced && dateFilter ? dayEnd(toDate) : null;
    if (from != null && to != null && from > to) {
      setDateError(t('search.fromAfterTo'));
      return;
    }
    setDateError(null);

    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder: folderName,
          query: q,
          scope: advanced ? scope : 'current',
          from, to,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e: any) {
      setError(e?.message || t('search.failed'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    borderColor: 'var(--border, #3f3f46)',
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center bg-black/60 p-4 pt-[6vh]" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg border shadow-2xl"
        style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)', borderColor: 'var(--border, #3f3f46)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border, #3f3f46)' }}>
          <div className="flex items-center gap-2 font-semibold">
            <Search size={18} /> {t('search.title')} · <span className="opacity-80">{advanced && scope === 'all' ? t('search.scopeAll') : folderName}</span>
          </div>
          <div className="flex items-center gap-1">
            {/* Whole result set as Markdown, with absolute links. Disabled until
                there is something to copy. */}
            <button
              onClick={copyResults}
              disabled={!data || data.totalMatches === 0 || loading}
              title={t('search.copyAll')}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs opacity-70 hover:opacity-100 hover:bg-white/5 disabled:opacity-25 disabled:cursor-not-allowed"
            >
              {copied === true ? <Check size={14} /> : copied === 'failed' ? <X size={14} /> : <Copy size={14} />}
              {copied === true ? t('common.copied') : copied === 'failed' ? t('common.copyFailed') : t('common.copy')}
            </button>
            <button onClick={onClose} className="p-1 opacity-70 hover:opacity-100"><X size={18} /></button>
          </div>
        </div>

        {/* Query row */}
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border, #3f3f46)' }}>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder={t('search.placeholder').replace('{name}', folderName)}
              className="flex-1 rounded border px-3 py-2 text-sm"
              style={inputStyle}
            />
            <button
              onClick={runSearch}
              disabled={loading || !query.trim()}
              className="flex items-center gap-1.5 rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} {t('search.button')}
            </button>
          </div>
          {/* Advanced toggle + panel */}
          <label className="mt-2 flex cursor-pointer select-none items-center gap-2 text-xs opacity-80">
            <input
              type="checkbox"
              checked={advanced}
              onChange={(e) => setAdvanced(e.target.checked)}
              className="accent-emerald-600"
            />
            {t('search.advanced')}
          </label>

          {advanced && (
            <div className="mt-2 flex flex-col gap-2 rounded border px-3 py-2" style={{ borderColor: 'var(--border, #27272a)' }}>
              {/* Scope */}
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <span className="opacity-60">{t('search.searchIn')}</span>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="scope" checked={scope === 'current'} onChange={() => setScope('current')} className="accent-emerald-600" />
                  {t('search.currentEntity')} (<span className="opacity-70">{folderName}</span>)
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} className="accent-emerald-600" />
                  {t('search.allEntities')}
                </label>
              </div>

              {/* Date range */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={dateFilter} onChange={(e) => setDateFilter(e.target.checked)} className="accent-emerald-600" />
                  {t('search.dateRange')}
                </label>
                {/* `max`/`min` cross-bound the two fields, so the calendar
                    itself greys out impossible days and an invalid range can't
                    be picked in the first place. */}
                <div className="flex items-center gap-1">
                  <input
                    ref={fromRef}
                    type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                    max={toDate || undefined}
                    onClick={() => openPicker(fromRef)}
                    disabled={!dateFilter} aria-label={t('search.fromDate')}
                    className="rounded border px-2 py-1 text-xs disabled:opacity-40" style={inputStyle}
                  />
                  <button
                    type="button" onClick={() => openPicker(fromRef)} disabled={!dateFilter}
                    title={t('search.pickFrom')} aria-label={t('search.openFrom')}
                    className="rounded p-1 opacity-60 hover:opacity-100 disabled:opacity-25"
                  ><Calendar size={13} /></button>
                </div>
                <span className="opacity-50">→</span>
                <div className="flex items-center gap-1">
                  <input
                    ref={toRef}
                    type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                    min={fromDate || undefined}
                    onClick={() => openPicker(toRef)}
                    disabled={!dateFilter} aria-label={t('search.toDate')}
                    className="rounded border px-2 py-1 text-xs disabled:opacity-40" style={inputStyle}
                  />
                  <button
                    type="button" onClick={() => openPicker(toRef)} disabled={!dateFilter}
                    title={t('search.pickTo')} aria-label={t('search.openTo')}
                    className="rounded p-1 opacity-60 hover:opacity-100 disabled:opacity-25"
                  ><Calendar size={13} /></button>
                </div>
                {(fromDate || toDate) && dateFilter && (
                  <button
                    type="button"
                    onClick={() => { setFromDate(''); setToDate(''); setDateError(null); }}
                    className="rounded px-1.5 py-0.5 text-[11px] opacity-55 hover:opacity-100"
                    title={t('search.clearDates')}
                  >{t('search.clear')}</button>
                )}
                <span className="opacity-45">{t('search.bothOptional')}</span>
              </div>
              {dateError && <div className="text-xs text-red-400">{dateError}</div>}
              {scope === 'all' && (
                <p className="text-[11px] opacity-50">
                  {t('search.allScopeWarn')}
                </p>
              )}
            </div>
          )}

          {data && !loading && (
            <p className="mt-2 text-xs opacity-60">
              {t('search.resultLine')
                .replace('{matches}', data.totalMatches.toLocaleString())
                .replace('{convos}', String(data.conversationsMatched))
                .replace('{searched}', String(data.conversationsSearched))
                .replace('{across}', data.folder === '*'
                  ? t('search.across').replace('{n}', String(data.folders.length))
                  : '')}
              {data.conversationsSkippedByDate > 0 &&
                t('search.skippedLine').replace('{n}', String(data.conversationsSkippedByDate))}
              {/* Never hide undated matches silently: a date-filtered search
                  would otherwise look complete when it isn't. */}
              {data.messagesSkippedNoTimestamp > 0 && (
                <span className="text-amber-500">
                  {t('search.hiddenLine').replace('{n}', String(data.messagesSkippedNoTimestamp))}
                </span>
              )}
            </p>
          )}
        </div>

        {/* Results */}
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
          {loading && <div className="flex items-center gap-2 text-sm opacity-70"><Loader2 size={16} className="animate-spin" /> {t('search.searching')}</div>}

          {data && !loading && data.totalMatches === 0 && (
            <div className="text-sm opacity-60">{t('search.noMatches').replace('{q}', data.query)}</div>
          )}

          {!loading && sortedResults.map((g) => (
            <div key={`${g.folder}/${g.convoId}`} className="mb-4">
              <div className="mb-1.5 flex items-center gap-2 border-b pb-1 text-sm font-semibold" style={{ borderColor: 'var(--border, #27272a)' }}>
                {/* Conversation title links to /c/<folder>/<convoId>. */}
                <a
                  href={buildDeepLink(g.folder, g.convoId)}
                  className="hover:underline"
                  title={t('search.openConvo')}
                >
                  {g.convoTitle}
                </a>
                {/* Only worth showing which entity when results span several. */}
                {data?.folder === '*' && (
                  <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-normal text-indigo-500">{g.folder}</span>
                )}
                {!g.active && <span className="rounded bg-zinc-500/20 px-1.5 py-0.5 text-[10px] font-normal opacity-70">{t('search.inactive')}</span>}
                <span className="ml-auto text-xs font-normal opacity-50">{t('search.matchCount').replace('{n}', String(g.matches.length))}</span>
              </div>
              <div className="flex flex-col gap-2">
                {g.matches.map((m, i) => {
                  // Very old logs may predate per-message ids; those snippets
                  // still link to the conversation, just not to the exact spot.
                  const href = buildDeepLink(g.folder, g.convoId, m.messageId || undefined);
                  return (
                    <a
                      key={i}
                      href={href}
                      title={m.messageId ? t('search.jumpTo') : t('search.openNoJump')}
                      className="block rounded border px-3 py-1.5 transition hover:border-emerald-500/60 hover:bg-emerald-500/5"
                      style={{ borderColor: 'var(--border, #27272a)' }}
                    >
                      <div className="mb-0.5 flex items-center gap-2 text-[11px] opacity-55">
                        <span className="font-medium">{m.author}</span>
                        {m.timestamp != null && <span>· {format(new Date(m.timestamp), 'yyyy-MM-dd HH:mm')}</span>}
                      </div>
                      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{highlight(m.text, data?.query || query)}</div>
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
