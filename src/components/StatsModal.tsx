"use client";

import React, { useEffect, useMemo, useState } from 'react';
import { X, BarChart3, RefreshCw, Copy, Check, Loader2 } from 'lucide-react';
import { fmtUSD } from '@/lib/modelPricing';
import { compareConvoTitles } from '@/lib/convoSort';

// Rich billing-statistics window. Pulls the full priced dataset from /api/stats
// once, then aggregates it locally into six report layouts. Every table is
// plain selectable text with "Copy TSV" / "Copy Markdown" buttons so figures
// drop straight into a spreadsheet or a note.

interface StatRecord {
  entity: string;
  convoId: string;
  convoTitle: string;
  ts: number | null;
  family: string;
  model: string;
  usd: number;
  estimated: boolean;
  unpriced: boolean;
}

interface StatsPayload {
  records: StatRecord[];
  entities: string[];
  families: string[];
  minTs: number | null;
  maxTs: number | null;
  skippedInactive: number;
  generatedAt: number;
}

type ReportType =
  | 'entity-convos'
  | 'entity-months'
  | 'all-entity-month'
  | 'family-months'
  | 'all-family-month'
  | 'family-entity';

const REPORTS: { value: ReportType; label: string; desc: string }[] = [
  { value: 'entity-convos', label: '① Entity · per conversation', desc: 'One entity — total cost of each of its conversations, plus a grand total. Includes messages with no timestamp.' },
  { value: 'entity-months', label: '② Entity · per month', desc: 'One entity — cost per month over the chosen period. Timestamped messages only.' },
  { value: 'all-entity-month', label: '③ All Nexus · Month × Entity', desc: '2D table: months down, entities across, with per-month and per-entity totals.' },
  { value: 'family-months', label: '④ Model Family · per month', desc: 'One model family — cost per month over the chosen period.' },
  { value: 'all-family-month', label: '⑤ All Families · Month × Family', desc: '2D table: months down, families across, with per-month and per-family totals.' },
  { value: 'family-entity', label: '⑥ Entity × Family (period)', desc: '2D table over one period: which entity spent how much on which family, with totals.' },
];

// ── Date / month-bucket helpers ─────────────────────────────────────────────

function toDateInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfDay(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0).getTime();
}
function endOfDay(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 23, 59, 59, 999).getTime();
}

// The month bucket a timestamp falls into, given the billing cycle's first day.
// firstDay=1 → normal calendar months. firstDay=15 → the 15th-to-14th cycle.
function bucketOf(ts: number, firstDay: number): { key: number; label: string } {
  const d = new Date(ts);
  let y = d.getFullYear();
  let m = d.getMonth();
  if (d.getDate() < firstDay) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const start = new Date(y, m, firstDay, 0, 0, 0, 0);
  const label = `${y}-${String(m + 1).padStart(2, '0')}` + (firstDay > 1 ? `～` : '');
  return { key: start.getTime(), label };
}

// Every month bucket from start..end inclusive (so empty months still show).
function enumerateBuckets(startTs: number, endTs: number, firstDay: number): { key: number; label: string }[] {
  const first = bucketOf(startTs, firstDay);
  const last = bucketOf(endTs, firstDay);
  const out: { key: number; label: string }[] = [];
  let cur = new Date(first.key);
  let guard = 0;
  while (cur.getTime() <= last.key && guard++ < 1200) {
    out.push(bucketOf(cur.getTime(), firstDay));
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, firstDay, 0, 0, 0, 0);
  }
  return out;
}

// ── Grid + copy helpers ─────────────────────────────────────────────────────

type Grid = string[][]; // grid[0] = header row

// Plain-number formatter for table cells — no "$", so the copied TSV drops
// straight into Excel as real numbers you can sum/chart. Same precision ladder
// as fmtUSD (more decimals for tiny amounts). Zero → blank cell.
function fmtNum(v: number): string {
  if (!isFinite(v) || v <= 0) return '0.00';
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}
function cellNum(v: number): string {
  return v > 0 ? fmtNum(v) : '';
}

function gridToTSV(g: Grid): string {
  return g.map((row) => row.join('\t')).join('\n');
}
function gridToMarkdown(g: Grid): string {
  if (g.length === 0) return '';
  const head = g[0];
  const sep = head.map(() => '---');
  const lines = [head, sep, ...g.slice(1)];
  return lines.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export default function StatsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [report, setReport] = useState<ReportType>('entity-convos');
  const [entity, setEntity] = useState<string>('');
  const [family, setFamily] = useState<string>('');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [firstDay, setFirstDay] = useState<number>(1);

  const [result, setResult] = useState<{ grid: Grid; total: number; measured: number; estimated: number; note?: string; unpricedModels: string[] } | null>(null);
  const [copied, setCopied] = useState<'' | 'tsv' | 'md'>('');

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/stats');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      if (j.entities?.length && !entity) setEntity(j.entities[0]);
      if (j.families?.length && !family) setFamily(j.families[0]);
      if (j.minTs) setStartDate((s) => s || toDateInput(j.minTs));
      if (j.maxTs) setEndDate((s) => s || toDateInput(j.maxTs));
    } catch (e: any) {
      setError(e?.message || 'Failed to load statistics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && !data && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { setResult(null); }, [report, entity, family, startDate, endDate, firstDay]);

  const needs = useMemo(() => ({
    entity: report === 'entity-convos' || report === 'entity-months',
    family: report === 'family-months',
    period: report !== 'entity-convos',
    firstDay: report !== 'entity-convos' && report !== 'family-entity',
  }), [report]);

  function calculate() {
    if (!data) return;
    const all = data.records;
    const startTs = startDate ? startOfDay(startDate) : -Infinity;
    const endTs = endDate ? endOfDay(endDate) : Infinity;

    const inPeriod = (r: StatRecord) => r.ts != null && r.ts >= startTs && r.ts <= endTs;
    const measuredEstimated = (rows: StatRecord[]) => {
      let measured = 0, estimated = 0;
      for (const r of rows) { if (r.estimated) estimated += r.usd; else measured += r.usd; }
      return { measured, estimated, total: measured + estimated };
    };

    let grid: Grid = [];
    let used: StatRecord[] = [];
    let note = '';

    if (report === 'entity-convos') {
      used = all.filter((r) => r.entity === entity);
      const byConvo = new Map<string, { title: string; usd: number }>();
      for (const r of used) {
        const e = byConvo.get(r.convoId) || { title: r.convoTitle, usd: 0 };
        e.usd += r.usd; byConvo.set(r.convoId, e);
      }
      const rows = Array.from(byConvo.values()).sort((a, b) => compareConvoTitles(a.title, b.title));
      grid = [['Conversation', 'Cost (USD)']];
      for (const row of rows) grid.push([row.title, cellNum(row.usd)]);
      const total = rows.reduce((s, r) => s + r.usd, 0);
      grid.push(['TOTAL', fmtNum(total)]);
    }

    else if (report === 'entity-months') {
      used = all.filter((r) => r.entity === entity && inPeriod(r));
      const buckets = data.minTs != null ? enumerateBuckets(
        startDate ? startOfDay(startDate) : (data.minTs || Date.now()),
        endDate ? endOfDay(endDate) : (data.maxTs || Date.now()),
        firstDay,
      ) : [];
      const byBucket = new Map<number, number>();
      for (const r of used) { const b = bucketOf(r.ts as number, firstDay); byBucket.set(b.key, (byBucket.get(b.key) || 0) + r.usd); }
      grid = [['Month', 'Cost (USD)']];
      for (const b of buckets) grid.push([b.label, cellNum(byBucket.get(b.key) || 0)]);
      const total = used.reduce((s, r) => s + r.usd, 0);
      grid.push(['TOTAL', fmtNum(total)]);
    }

    else if (report === 'family-months') {
      used = all.filter((r) => r.family === family && inPeriod(r));
      const buckets = enumerateBuckets(
        startDate ? startOfDay(startDate) : (data.minTs || Date.now()),
        endDate ? endOfDay(endDate) : (data.maxTs || Date.now()),
        firstDay,
      );
      const byBucket = new Map<number, number>();
      for (const r of used) { const b = bucketOf(r.ts as number, firstDay); byBucket.set(b.key, (byBucket.get(b.key) || 0) + r.usd); }
      grid = [['Month', `${family} — Cost (USD)`]];
      for (const b of buckets) grid.push([b.label, cellNum(byBucket.get(b.key) || 0)]);
      const total = used.reduce((s, r) => s + r.usd, 0);
      grid.push(['TOTAL', fmtNum(total)]);
    }

    else if (report === 'all-entity-month' || report === 'all-family-month') {
      const byFamily = report === 'all-family-month';
      used = all.filter(inPeriod);
      const cols = Array.from(new Set(used.map((r) => (byFamily ? r.family : r.entity)))).sort();
      const buckets = enumerateBuckets(
        startDate ? startOfDay(startDate) : (data.minTs || Date.now()),
        endDate ? endOfDay(endDate) : (data.maxTs || Date.now()),
        firstDay,
      );
      // cell[bucketKey][col] = usd
      const cell = new Map<string, number>();
      const key = (bk: number, c: string) => `${bk}||${c}`;
      for (const r of used) {
        const bk = bucketOf(r.ts as number, firstDay).key;
        const c = byFamily ? r.family : r.entity;
        cell.set(key(bk, c), (cell.get(key(bk, c)) || 0) + r.usd);
      }
      grid = [['Month', ...cols, 'TOTAL']];
      const colTotals = new Array(cols.length).fill(0);
      let grand = 0;
      for (const b of buckets) {
        const row = [b.label];
        let rowTotal = 0;
        cols.forEach((c, i) => {
          const v = cell.get(key(b.key, c)) || 0;
          colTotals[i] += v; rowTotal += v;
          row.push(cellNum(v));
        });
        row.push(fmtNum(rowTotal));
        grand += rowTotal;
        grid.push(row);
      }
      grid.push(['TOTAL', ...colTotals.map((v) => fmtNum(v)), fmtNum(grand)]);
    }

    else if (report === 'family-entity') {
      used = all.filter(inPeriod);
      const cols = Array.from(new Set(used.map((r) => r.family))).sort();
      const rowEntities = Array.from(new Set(used.map((r) => r.entity))).sort();
      const cell = new Map<string, number>();
      const key = (e: string, c: string) => `${e}||${c}`;
      for (const r of used) cell.set(key(r.entity, r.family), (cell.get(key(r.entity, r.family)) || 0) + r.usd);
      grid = [['Entity', ...cols, 'TOTAL']];
      const colTotals = new Array(cols.length).fill(0);
      let grand = 0;
      for (const e of rowEntities) {
        const row = [e];
        let rowTotal = 0;
        cols.forEach((c, i) => {
          const v = cell.get(key(e, c)) || 0;
          colTotals[i] += v; rowTotal += v;
          row.push(cellNum(v));
        });
        row.push(fmtNum(rowTotal));
        grand += rowTotal;
        grid.push(row);
      }
      grid.push(['TOTAL', ...colTotals.map((v) => fmtNum(v)), fmtNum(grand)]);
      note = 'Columns are model families; a Claude row is split into OAuth vs API by each conversation\'s billing mode.';
    }

    const me = measuredEstimated(used);
    const unpricedModels = Array.from(new Set(used.filter((r) => r.unpriced).map((r) => r.model))).sort();
    setResult({ grid, total: me.total, measured: me.measured, estimated: me.estimated, note, unpricedModels });
  }

  async function copy(kind: 'tsv' | 'md') {
    if (!result) return;
    const text = kind === 'tsv' ? gridToTSV(result.grid) : gridToMarkdown(result.grid);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      // Fallback: no clipboard permission — surface the text so it can be copied manually.
      window.prompt('Copy the table:', text);
    }
  }

  if (!open) return null;

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--background)',
    color: 'var(--foreground)',
    borderColor: 'var(--border, #3f3f46)',
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-lg border shadow-2xl"
        style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)', borderColor: 'var(--border, #3f3f46)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border, #3f3f46)' }}>
          <div className="flex items-center gap-2 font-semibold">
            <BarChart3 size={18} /> Statistics · Billing
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="flex items-center gap-1 rounded px-2 py-1 text-xs opacity-80 hover:opacity-100 disabled:opacity-40" title="Re-scan all logs">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
            </button>
            <button onClick={onClose} className="p-1 opacity-70 hover:opacity-100"><X size={18} /></button>
          </div>
        </div>

        {/* Controls */}
        <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border, #3f3f46)' }}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="opacity-70">Report</span>
              <select value={report} onChange={(e) => setReport(e.target.value as ReportType)} className="rounded border px-2 py-1.5 text-sm" style={inputStyle}>
                {REPORTS.map((r) => <option key={r.value} value={r.value} style={inputStyle}>{r.label}</option>)}
              </select>
            </label>

            {needs.entity && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="opacity-70">Entity</span>
                <select value={entity} onChange={(e) => setEntity(e.target.value)} className="rounded border px-2 py-1.5 text-sm" style={inputStyle}>
                  {(data?.entities || []).map((e) => <option key={e} value={e} style={inputStyle}>{e}</option>)}
                </select>
              </label>
            )}

            {needs.family && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="opacity-70">Model Family</span>
                <select value={family} onChange={(e) => setFamily(e.target.value)} className="rounded border px-2 py-1.5 text-sm" style={inputStyle}>
                  {(data?.families || []).map((f) => <option key={f} value={f} style={inputStyle}>{f}</option>)}
                </select>
              </label>
            )}

            {needs.period && (
              <>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="opacity-70">From</span>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded border px-2 py-1.5 text-sm" style={inputStyle} />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="opacity-70">To</span>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="rounded border px-2 py-1.5 text-sm" style={inputStyle} />
                </label>
              </>
            )}

            {needs.firstDay && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="opacity-70" title="Billing cycle start day of month (1 = calendar months)">Month starts on</span>
                <input type="number" min={1} max={28} value={firstDay} onChange={(e) => setFirstDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} className="w-20 rounded border px-2 py-1.5 text-sm" style={inputStyle} />
              </label>
            )}

            <button onClick={calculate} disabled={!data || loading} className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40">
              Calculate
            </button>
          </div>
          <p className="mt-2 text-xs opacity-60">{REPORTS.find((r) => r.value === report)?.desc}</p>
        </div>

        {/* Output */}
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</div>}
          {loading && !data && <div className="flex items-center gap-2 text-sm opacity-70"><Loader2 size={16} className="animate-spin" /> Scanning all conversation logs…</div>}

          {!result && data && !loading && (
            <div className="text-sm opacity-60">
              Loaded {data.records.length.toLocaleString()} priced replies across {data.entities.length} entities
              {data.skippedInactive ? ` · ${data.skippedInactive} inactive conversation(s) ignored` : ''}.
              Choose a report and press <span className="font-medium">Calculate</span>.
            </div>
          )}

          {result && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
                <span className="rounded bg-emerald-600/15 px-2 py-1 font-medium text-emerald-500">Total {fmtUSD(result.total)}</span>
                <span className="opacity-70">measured {fmtUSD(result.measured)} · estimated {fmtUSD(result.estimated)}
                  {result.total > 0 ? ` (${Math.round((result.estimated / result.total) * 100)}% estimated)` : ''}</span>
                <div className="ml-auto flex items-center gap-2">
                  <button onClick={() => copy('tsv')} className="flex items-center gap-1 rounded border px-2 py-1 hover:opacity-100" style={inputStyle} title="Copy tab-separated (paste into a spreadsheet)">
                    {copied === 'tsv' ? <Check size={13} /> : <Copy size={13} />} TSV
                  </button>
                  <button onClick={() => copy('md')} className="flex items-center gap-1 rounded border px-2 py-1 hover:opacity-100" style={inputStyle} title="Copy as a Markdown table">
                    {copied === 'md' ? <Check size={13} /> : <Copy size={13} />} Markdown
                  </button>
                </div>
              </div>

              <div className="overflow-auto rounded border" style={{ borderColor: 'var(--border, #3f3f46)' }}>
                <table className="w-full border-collapse text-sm tabular-nums">
                  <thead>
                    <tr>
                      {result.grid[0].map((h, i) => (
                        <th key={i} className={`sticky top-0 border-b px-3 py-1.5 font-semibold ${i === 0 ? 'text-left' : 'text-right'}`} style={{ backgroundColor: 'var(--background)', borderColor: 'var(--border, #3f3f46)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.grid.slice(1).map((row, ri) => {
                      const isTotal = row[0] === 'TOTAL';
                      return (
                        <tr key={ri} className={isTotal ? 'font-semibold' : ''} style={isTotal ? { borderTop: '2px solid var(--border, #3f3f46)' } : undefined}>
                          {row.map((c, ci) => (
                            <td key={ci} className={`border-b px-3 py-1 ${ci === 0 ? 'text-left' : 'text-right'}`} style={{ borderColor: 'var(--border, #27272a)' }}>{c}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {result.unpricedModels.length > 0 && (
                <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500/90">
                  {result.unpricedModels.length} model{result.unpricedModels.length > 1 ? 's' : ''} in this report {result.unpricedModels.length > 1 ? 'have' : 'has'} no price row and count as $0 —
                  add {result.unpricedModels.length > 1 ? 'them' : 'it'} to <code>src/lib/modelPricing.json</code> to include:{' '}
                  <span className="font-mono">{result.unpricedModels.join(', ')}</span>
                </p>
              )}
              <p className="mt-3 text-xs opacity-55 leading-relaxed">
                {result.note && <>{result.note}<br /></>}
                Figures are the best-estimate hybrid: real usage where recorded, otherwise input reconstructed from the system prompt + preceding
                messages and priced at each model's rate (estimates lean high — they ignore historical prompt-cache discounts and context-trimming).
                Only original (non-copied) assistant replies count. Local models are free and excluded. OAuth Claude is priced like the Claude API
                (notional subscription value). Prices come from <code>src/lib/modelPricing.json</code>.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
