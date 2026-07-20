"use client";

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { compareConvoTitles } from '@/lib/convoSort';

// Full-text search across all conversations of the current entity. Opens from
// the 🔍 header button, matches message bodies via /api/search, groups hits by
// conversation (ordered by the shared "<name>_<number>-<index>" convention),
// and highlights the query inside each trimmed snippet.

interface Snippet { messageIndex: number; author: string; timestamp: number | null; text: string; }
interface Group { convoId: string; convoTitle: string; active: boolean; matches: Snippet[]; }
interface SearchPayload {
  query: string; folder: string; results: Group[];
  conversationsMatched: number; conversationsSearched: number; totalMatches: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Split `text` on case-insensitive occurrences of `query` and wrap matches in
// <mark>. Returns an array of React nodes.
function highlight(text: string, query: string): React.ReactNode[] {
  if (!query) return [text];
  const re = new RegExp(`(${escapeRegExp(query)})`, 'gi');
  const parts = text.split(re);
  return parts.map((part, i) =>
    i % 2 === 1
      ? <mark key={i} className="rounded-sm bg-amber-400/40 px-0.5 text-inherit">{part}</mark>
      : <React.Fragment key={i}>{part}</React.Fragment>
  );
}

export default function SearchModal({ open, onClose, folderName }: { open: boolean; onClose: () => void; folderName: string }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SearchPayload | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Clear stale results when the entity changes underneath us.
  useEffect(() => { setData(null); setError(null); }, [folderName]);

  const sortedResults = useMemo(() => {
    if (!data) return [];
    return [...data.results].sort((a, b) => compareConvoTitles(a.convoTitle, b.convoTitle));
  }, [data]);

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: folderName, query: q }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e: any) {
      setError(e?.message || 'Search failed');
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
            <Search size={18} /> Search · <span className="opacity-80">{folderName}</span>
          </div>
          <button onClick={onClose} className="p-1 opacity-70 hover:opacity-100"><X size={18} /></button>
        </div>

        {/* Query row */}
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border, #3f3f46)' }}>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder={`Search all conversations with ${folderName}…`}
              className="flex-1 rounded border px-3 py-2 text-sm"
              style={inputStyle}
            />
            <button
              onClick={runSearch}
              disabled={loading || !query.trim()}
              className="flex items-center gap-1.5 rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Search
            </button>
          </div>
          {data && !loading && (
            <p className="mt-2 text-xs opacity-60">
              {data.totalMatches.toLocaleString()} match{data.totalMatches === 1 ? '' : 'es'} in {data.conversationsMatched} conversation
              {data.conversationsMatched === 1 ? '' : 's'} (of {data.conversationsSearched} searched).
            </p>
          )}
        </div>

        {/* Results */}
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
          {loading && <div className="flex items-center gap-2 text-sm opacity-70"><Loader2 size={16} className="animate-spin" /> Searching…</div>}

          {data && !loading && data.totalMatches === 0 && (
            <div className="text-sm opacity-60">No matches for “{data.query}”.</div>
          )}

          {!loading && sortedResults.map((g) => (
            <div key={g.convoId} className="mb-4">
              <div className="mb-1.5 flex items-center gap-2 border-b pb-1 text-sm font-semibold" style={{ borderColor: 'var(--border, #27272a)' }}>
                <span>{g.convoTitle}</span>
                {!g.active && <span className="rounded bg-zinc-500/20 px-1.5 py-0.5 text-[10px] font-normal opacity-70">inactive</span>}
                <span className="ml-auto text-xs font-normal opacity-50">{g.matches.length} match{g.matches.length === 1 ? '' : 'es'}</span>
              </div>
              <div className="flex flex-col gap-2">
                {g.matches.map((m, i) => (
                  <div key={i} className="rounded border px-3 py-1.5" style={{ borderColor: 'var(--border, #27272a)' }}>
                    <div className="mb-0.5 flex items-center gap-2 text-[11px] opacity-55">
                      <span className="font-medium">{m.author}</span>
                      {m.timestamp != null && <span>· {format(new Date(m.timestamp), 'yyyy-MM-dd HH:mm')}</span>}
                    </div>
                    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{highlight(m.text, data?.query || query)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
