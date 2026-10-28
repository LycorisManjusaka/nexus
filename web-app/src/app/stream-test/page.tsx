'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/clipboard';
import { splitSseFrames, sseDataPayload, isSseDone } from '@/lib/sseFrames';

/**
 * /stream-test — run a Nexus-shaped stream forever and record who stopped it.
 *
 * WHAT THIS IS FOR
 * On 2026-10-09 two long turns (17.3 min and 26.6 min) ended as
 * `The turn failed: network error` — the only two such notices in the house,
 * both on a day the partner worked from a phone. The screen-sleep timeout had
 * been raised to 30 minutes and the screen was still on when he came back, yet
 * the output had stopped. So "the screen slept" is not the answer, and the
 * real question is what else in the path gives up.
 *
 * Three things have to be told apart, and only one of them can be seen from
 * inside the browser:
 *
 *   1. THE CLIENT FROZE      — JS stopped running (backgrounded tab, OS
 *                              suspend). Detectable here, because a frozen
 *                              timer is late: wall-clock moved and our tick
 *                              count did not.
 *   2. THE SOCKET DIED QUIET — bytes stopped, nothing threw. From here this is
 *                              indistinguishable from a slow server, which is
 *                              exactly why the server keeps its own record and
 *                              this page asks for it over a SECOND connection.
 *   3. THE FETCH THREW       — the browser gave up. The exact `name` +
 *                              `message` is shown verbatim, because Chrome
 *                              distinguishes `Failed to fetch` (never
 *                              connected) from `network error` (connected,
 *                              then the stream broke) and the log said the
 *                              latter.
 *
 * HOW IT STAYS HONEST
 *   - Elapsed time is `Date.now() - startedAt`, never a counter incremented by
 *     the timer. A frozen page that wakes after 10 minutes must say 10 minutes,
 *     not "the 40 ticks I managed to run".
 *   - "Silence" is `Date.now() - lastByteAt`, updated on every chunk the reader
 *     hands back — including SSE comments, which carry no data but prove the
 *     socket is alive. That is the measurement; frame parsing is decoration.
 *   - The server's view is fetched, not inferred. When the two disagree, the
 *     disagreement IS the finding.
 *
 * Styling is inline on purpose, like /device: this page has to render even when
 * the thing under investigation is the theme, the fonts, or the layout.
 */

// ── tunables ────────────────────────────────────────────────────────────────
/** How often the UI recomputes. Also the clock whose lateness detects freeze. */
const UI_TICK_MS = 250;
/** A tick later than this means JS itself was not running. */
const FREEZE_SLACK_MS = 1_500;

interface Gap { startedAt: number; ms: number; atSeq: number; }
interface Freeze { startedAt: number; ms: number; }
interface LifeEvent { at: number; kind: string; detail: string; }
interface ServerView {
  known?: boolean;
  lastSeq?: number;
  rounds?: number;
  abortSeenAt?: number | null;
  writeFailedAt?: number | null;
  writeFailure?: string | null;
  endedAt?: number | null;
  endReason?: string | null;
  bytesWritten?: number;
  heartbeatsSent?: number;
  sinceLastWriteMs?: number;
  alive?: boolean;
  pid?: number;
  instance?: string;
  note?: string;
  fetchedAt?: number;
  fetchError?: string;
}

const box: React.CSSProperties = {
  border: '1px solid #444', borderRadius: 8, padding: 12,
  marginBottom: 12, background: '#1a1a1a',
};
const btn: React.CSSProperties = {
  padding: '10px 18px', borderRadius: 8, border: '1px solid #555',
  background: '#2a2a2a', color: '#eee', fontSize: 15, cursor: 'pointer',
};
const lbl: React.CSSProperties = {
  color: '#888', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1,
};

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}時間${String(m).padStart(2, '0')}分${String(ss).padStart(2, '0')}秒`;
  if (m > 0) return `${m}分${String(ss).padStart(2, '0')}秒`;
  return `${s}.${Math.floor((ms % 1000) / 100)}秒`;
}
const fmtClock = (t: number | null | undefined) =>
  t ? new Date(t).toLocaleTimeString('ja-JP', { hour12: false }) : '–';

function Row({ k, v, warn }: { k: string; v: React.ReactNode; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', flexWrap: 'wrap' }}>
      <span style={{ color: '#9aa', minWidth: 190, flexShrink: 0 }}>{k}</span>
      <span style={{ color: warn ? '#ff8080' : '#eee', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

export default function StreamTestPage() {
  // ── run config (held in state so a run can be repeated with one knob moved)
  const [toolSilentMs, setToolSilentMs] = useState(8_000);
  const [heartbeatMs, setHeartbeatMs] = useState(0);
  const [thoughtMs, setThoughtMs] = useState(4_000);
  const [tickMs, setTickMs] = useState(400);
  const [gapThresholdMs, setGapThresholdMs] = useState(5_000);

  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ name: string; message: string; at: number; silentForMs: number } | null>(null);

  const [lastByteAt, setLastByteAt] = useState<number | null>(null);
  const [lastSeq, setLastSeq] = useState(0);
  const [rounds, setRounds] = useState(0);
  const [chunks, setChunks] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [frames, setFrames] = useState(0);
  const [comments, setComments] = useState(0);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [freezes, setFreezes] = useState<Freeze[]>([]);
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [server, setServer] = useState<ServerView | null>(null);
  const [autoPoll, setAutoPoll] = useState(true);
  /** null = not attempted, true/false = what actually happened. Never claim success. */
  const [copied, setCopied] = useState<boolean | null>(null);

  /** `now` exists only to re-render the clocks; never used as a duration. */
  const [now, setNow] = useState(() => Date.now());

  const abortRef = useRef<AbortController | null>(null);
  const lastByteRef = useRef<number | null>(null);
  const lastSeqRef = useRef(0);
  const lastTickRef = useRef<number>(Date.now());
  const runIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const gapThresholdRef = useRef(gapThresholdMs);
  gapThresholdRef.current = gapThresholdMs;

  const pushEvent = useCallback((kind: string, detail = '') => {
    setEvents(prev => [{ at: Date.now(), kind, detail }, ...prev].slice(0, 200));
  }, []);

  // ── UI clock, and the freeze detector riding on it ────────────────────────
  // If this interval is late by more than FREEZE_SLACK_MS, JS was not running.
  // That is the only in-page evidence of a frozen tab, and it survives the
  // freeze because the proof is a wall-clock comparison, not a counter.
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      const late = t - lastTickRef.current - UI_TICK_MS;
      if (late > FREEZE_SLACK_MS) {
        setFreezes(prev => [{ startedAt: lastTickRef.current, ms: late }, ...prev].slice(0, 100));
        pushEvent('js-frozen', `${fmtDur(late)} JS が走っていなかった`);
      }
      lastTickRef.current = t;
      setNow(t);
    }, UI_TICK_MS);
    return () => clearInterval(id);
  }, [pushEvent]);

  // ── page lifecycle + connectivity, recorded with timestamps ───────────────
  // These are the candidate CAUSES. The page does not act on any of them; it
  // writes them down next to the gaps so a correlation can be read off rather
  // than argued about.
  useEffect(() => {
    const vis = () => pushEvent('visibility', document.visibilityState);
    const frz = () => pushEvent('freeze', 'Page Lifecycle: frozen');
    const res = () => pushEvent('resume', 'Page Lifecycle: resumed');
    const hide = () => pushEvent('pagehide', '');
    const show = () => pushEvent('pageshow', '');
    const on = () => pushEvent('online', '');
    const off = () => pushEvent('offline', '');
    document.addEventListener('visibilitychange', vis);
    document.addEventListener('freeze', frz);
    document.addEventListener('resume', res);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);

    const conn: any = (navigator as any).connection;
    const connChange = () => pushEvent('connection', `${conn?.effectiveType ?? '?'} / downlink ${conn?.downlink ?? '?'}`);
    conn?.addEventListener?.('change', connChange);

    return () => {
      document.removeEventListener('visibilitychange', vis);
      document.removeEventListener('freeze', frz);
      document.removeEventListener('resume', res);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      conn?.removeEventListener?.('change', connChange);
    };
  }, [pushEvent]);

  const fetchServer = useCallback(async (id?: string | null) => {
    const target = id ?? runIdRef.current;
    if (!target) return;
    try {
      const r = await fetch(`/api/stream-test?runId=${encodeURIComponent(target)}`, { cache: 'no-store' });
      const j = await r.json();
      setServer({ ...j, fetchedAt: Date.now() });
    } catch (e: any) {
      // A failing status probe is itself a datum: the stream may be dead
      // because the whole path is dead, not because of anything stream-shaped.
      setServer(prev => ({ ...(prev ?? {}), fetchError: String(e?.message ?? e), fetchedAt: Date.now() }));
    }
  }, []);

  // Poll the server's view on a slow cadence. Separate connection, tiny
  // payload; the point is that it keeps working while the stream does not.
  useEffect(() => {
    if (!autoPoll || !runId) return;
    const id = setInterval(() => { void fetchServer(); }, 5_000);
    return () => clearInterval(id);
  }, [autoPoll, runId, fetchServer]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    runningRef.current = false;
    setRunning(false);
    setRunId(null); runIdRef.current = null;
    setStartedAt(null); setEndedAt(null); setFailure(null);
    setLastByteAt(null); lastByteRef.current = null;
    setLastSeq(0); lastSeqRef.current = 0;
    setRounds(0); setChunks(0); setBytes(0); setFrames(0); setComments(0);
    setGaps([]); setFreezes([]); setEvents([]); setServer(null);
  }, []);

  const stop = useCallback(() => {
    pushEvent('stop', '手動停止');
    abortRef.current?.abort();
  }, [pushEvent]);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    const id = `st-${Date.now().toString(36)}`;
    const t0 = Date.now();

    setRunId(id); runIdRef.current = id;
    setStartedAt(t0); setEndedAt(null); setFailure(null);
    setLastByteAt(t0); lastByteRef.current = t0;
    setLastSeq(0); lastSeqRef.current = 0;
    setRounds(0); setChunks(0); setBytes(0); setFrames(0); setComments(0);
    setGaps([]); setFreezes([]); setServer(null);
    setEvents([{ at: t0, kind: 'start', detail: `silence ${toolSilentMs}ms / heartbeat ${heartbeatMs || 'off'}` }]);
    runningRef.current = true;
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      // Same request shape as a real turn: POST, JSON body, streamed response
      // read through getReader() + TextDecoder. Measured against
      // api/chat/route.ts rather than remembered.
      const res = await fetch('/api/stream-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: id, tickMs, thoughtMs, toolSilentMs, heartbeatMs }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) { pushEvent('stream-closed', 'サーバーが閉じた'); break; }

        // ── the measurement ────────────────────────────────────────────────
        // Timed here, before any parsing: what matters is that BYTES arrived.
        // An SSE comment carries no data and still proves the socket is alive,
        // so counting only data frames would under-report liveness.
        const t = Date.now();
        const prev = lastByteRef.current ?? t;
        const silent = t - prev;
        if (silent > gapThresholdRef.current) {
          setGaps(g => [{ startedAt: prev, ms: silent, atSeq: lastSeqRef.current }, ...g].slice(0, 200));
        }
        lastByteRef.current = t;
        setLastByteAt(t);
        setChunks(c => c + 1);
        setBytes(b => b + (value?.byteLength ?? 0));

        // ONE definition of this parse: lib/sseFrames.ts (six derivations with
        // four behaviours before 2026-10-28). The LOW-LEVEL pair here, not
        // createSseReader: that returns payloads and drops frames with no data
        // field, and this page MEASURES the transport -- the `:keep-alive`
        // comments it counts below have no data field.
        buffer += decoder.decode(value, { stream: true });
        // Named `complete`, not `frames`: this component already has a state
        // variable called `frames` holding the COUNT, and a local array of the
        // same name would shadow a number with an array inside this block.
        const { frames: complete, rest } = splitSseFrames(buffer);
        buffer = rest;
        for (const line of complete) {
          const payload = sseDataPayload(line);
          if (payload !== null) {
            if (isSseDone(payload)) { pushEvent('done', '[DONE]'); continue; }
            setFrames(f => f + 1);
            try {
              const d = JSON.parse(payload);
              if (typeof d.seq === 'number') { lastSeqRef.current = d.seq; setLastSeq(d.seq); }
              if (typeof d.round === 'number') setRounds(d.round);
              if (d.error) pushEvent('server-error', String(d.error));
            } catch { /* a split frame is not a fault */ }
          } else if (line.startsWith(':')) {
            setComments(c => c + 1);
          }
        }
      }
    } catch (err: any) {
      const at = Date.now();
      const silentForMs = at - (lastByteRef.current ?? at);
      // Verbatim. `AbortError` is us, `Failed to fetch` never connected, and
      // `network error` connected and then broke — the log said the last one,
      // and conflating them would erase the only clue it left.
      setFailure({ name: String(err?.name ?? 'Error'), message: String(err?.message ?? err), at, silentForMs });
      pushEvent('fetch-threw', `${err?.name}: ${err?.message}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setEndedAt(Date.now());
      abortRef.current = null;
      // One last look at the server's view: taken AFTER the client's stream is
      // over, it is the snapshot that answers "was it still writing?".
      void fetchServer(id);
    }
  }, [tickMs, thoughtMs, toolSilentMs, heartbeatMs, pushEvent, fetchServer]);

  const elapsed = startedAt ? (endedAt ?? now) - startedAt : 0;
  // Clamped at 0: `now` only advances every UI_TICK_MS, so a byte that arrives
  // between two ticks makes this negative — and a negative silence rendered as
  // `–` reads as "unknown" when the truth is "zero".
  const silentFor = lastByteAt ? Math.max(0, now - lastByteAt) : 0;
  const stalled = running && silentFor > Math.max(gapThresholdMs, toolSilentMs + 3_000);
  const seqBehind = (server?.lastSeq ?? 0) - lastSeq;

  const wakeLockAvailable = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  /**
   * The whole run as plain text.
   *
   * This exists because the measurement happens on a PHONE and has to travel
   * back to whoever reads it. Screenshots of six panels is not a workable
   * transport: they lose the timestamps that matter and arrive out of order.
   * `copyText` is the house's single source for this and already carries the
   * legacy fallback that plain HTTP needs — `navigator.clipboard` does not
   * exist at `http://192.168.10.2:3000`, which is exactly the origin a phone
   * will use.
   */
  const buildReport = (): string => {
    const L: string[] = [];
    const at = (t: number | null | undefined) => (t ? new Date(t).toISOString() : '-');
    L.push('=== NEXUS stream-test report ===');
    L.push(`generated       ${new Date().toISOString()}`);
    L.push(`url             ${typeof location !== 'undefined' ? location.href : '?'}`);
    L.push(`userAgent       ${typeof navigator !== 'undefined' ? navigator.userAgent : '?'}`);
    L.push(`secureContext   ${typeof window !== 'undefined' ? window.isSecureContext : '?'}  wakeLock ${wakeLockAvailable}`);
    L.push('');
    L.push('--- config ---');
    L.push(`toolSilentMs ${toolSilentMs}  heartbeatMs ${heartbeatMs}  thoughtMs ${thoughtMs}  tickMs ${tickMs}  gapThresholdMs ${gapThresholdMs}`);
    L.push('');
    L.push('--- client ---');
    L.push(`runId           ${runId ?? '-'}`);
    L.push(`startedAt       ${at(startedAt)}`);
    L.push(`endedAt         ${at(endedAt)}`);
    L.push(`elapsedMs       ${elapsed}`);
    L.push(`lastByteAt      ${at(lastByteAt)}   silentForMs ${silentFor}`);
    L.push(`chunks ${chunks}  bytes ${bytes}  frames ${frames}  comments ${comments}  lastSeq ${lastSeq}  rounds ${rounds}`);
    if (failure) {
      L.push(`FETCH THREW     ${failure.name}: ${failure.message}`);
      L.push(`  at            ${at(failure.at)}  (silent for ${failure.silentForMs}ms)`);
    } else {
      L.push('FETCH THREW     -');
    }
    L.push('');
    L.push('--- server (second connection) ---');
    if (!server) L.push('(never fetched)');
    else {
      L.push(`fetchedAt       ${at(server.fetchedAt)}`);
      if (server.fetchError) L.push(`fetchError      ${server.fetchError}`);
      if (server.known === false) L.push(`known           false — ${server.note ?? ''}`);
      if (server.known) {
        L.push(`lastSeq         ${server.lastSeq}   (client ${lastSeq}, behind by ${seqBehind})`);
        L.push(`sinceLastWrite  ${server.sinceLastWriteMs}ms   alive ${server.alive}`);
        L.push(`abortSeenAt     ${at(server.abortSeenAt)}`);
        L.push(`writeFailedAt   ${at(server.writeFailedAt)}  ${server.writeFailure ?? ''}`);
        L.push(`endReason       ${server.endReason ?? '-'}`);
        L.push(`bytesWritten    ${server.bytesWritten}   heartbeatsSent ${server.heartbeatsSent}`);
        L.push(`pid/instance    ${server.pid} / ${server.instance}`);
      }
    }
    L.push('');
    L.push(`--- receive gaps (${gaps.length}) ---`);
    for (const g of gaps.slice(0, 60)) L.push(`${at(g.startedAt)}  ${g.ms}ms  seq ${g.atSeq}`);
    L.push('');
    L.push(`--- js frozen (${freezes.length}) ---`);
    for (const f of freezes.slice(0, 60)) L.push(`${at(f.startedAt)}  ${f.ms}ms`);
    L.push('');
    L.push(`--- events (${events.length}, newest first) ---`);
    for (const e of events.slice(0, 120)) L.push(`${at(e.at)}  ${e.kind}  ${e.detail}`);
    return L.join('\n');
  };

  return (
    <div style={{ padding: 16, fontFamily: 'ui-monospace, monospace', background: '#111', color: '#eee', minHeight: '100dvh' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>ストリーム持続テスト</h1>
      <p style={{ color: '#888', fontSize: 12, marginBottom: 16, lineHeight: 1.6 }}>
        モデルを呼ばずに、NEXUS のターンと同じ形（思考 → ツール → 無音 → 思考…）を永遠に流す。
        止まったとき、<b>クライアントが凍ったのか・接続が黙って死んだのか・サーバーが切ったのか</b>を分けて記録する。
        課金ゼロ。会話ログには何も書かない。
      </p>

      {/* ── live verdict ─────────────────────────────────────────────────── */}
      <div style={{ ...box, borderColor: failure ? '#a33' : stalled ? '#a85' : running ? '#3a6' : '#444' }}>
        <div style={lbl}>状態</div>
        <div style={{ fontSize: 28, margin: '6px 0' }}>
          {failure ? '✗ 失敗' : running ? (stalled ? '⚠ 無音' : '● 受信中') : endedAt ? '■ 終了' : '待機'}
        </div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 8 }}>
          <div>
            <div style={lbl}>経過</div>
            <div style={{ fontSize: 22 }}>{fmtDur(elapsed)}</div>
          </div>
          <div>
            <div style={lbl}>最後の受信から</div>
            <div style={{ fontSize: 22, color: stalled ? '#ff8080' : '#eee' }}>{fmtDur(silentFor)}</div>
          </div>
          <div>
            <div style={lbl}>ラウンド</div>
            <div style={{ fontSize: 22 }}>{rounds}</div>
          </div>
        </div>
      </div>

      {/* ── controls ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <button style={{ ...btn, background: running ? '#333' : '#1e4620', borderColor: running ? '#555' : '#2a6' }}
          onClick={start} disabled={running}>▶ 開始</button>
        <button style={{ ...btn, background: running ? '#4a2020' : '#2a2a2a' }}
          onClick={stop} disabled={!running}>■ 停止</button>
        <button style={btn} onClick={reset}>↺ リセット</button>
        <button style={btn} onClick={() => void fetchServer()} disabled={!runId}>サーバーに聞く</button>
        <button style={btn} onClick={async () => {
          const ok = await copyText(buildReport());
          setCopied(ok);
          setTimeout(() => setCopied(null), 4000);
        }} disabled={!startedAt}>
          {copied === true ? '✓ コピーした' : copied === false ? '✕ コピーできない' : '結果をコピー'}
        </button>
        <label style={{ ...btn, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoPoll} onChange={e => setAutoPoll(e.target.checked)} />
          5秒ごとに自動で聞く
        </label>
      </div>

      {/* ── knobs ────────────────────────────────────────────────────────── */}
      <div style={box}>
        <div style={lbl}>設定（走っている間は変えられない）</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: '#9aa', fontSize: 12 }}>ツール中の無音</span>
            <select value={toolSilentMs} onChange={e => setToolSilentMs(Number(e.target.value))} disabled={running}
              style={{ background: '#222', color: '#eee', border: '1px solid #555', borderRadius: 6, padding: 6 }}>
              <option value={0}>0秒（無音なし）</option>
              <option value={8000}>8秒</option>
              <option value={30000}>30秒</option>
              <option value={120000}>2分</option>
              <option value={300000}>5分</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: '#9aa', fontSize: 12 }}>キープアライブ</span>
            <select value={heartbeatMs} onChange={e => setHeartbeatMs(Number(e.target.value))} disabled={running}
              style={{ background: '#222', color: '#eee', border: '1px solid #555', borderRadius: 6, padding: 6 }}>
              <option value={0}>OFF（今の NEXUS と同じ）</option>
              <option value={5000}>5秒ごと</option>
              <option value={15000}>15秒ごと</option>
              <option value={30000}>30秒ごと</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: '#9aa', fontSize: 12 }}>思考の長さ</span>
            <select value={thoughtMs} onChange={e => setThoughtMs(Number(e.target.value))} disabled={running}
              style={{ background: '#222', color: '#eee', border: '1px solid #555', borderRadius: 6, padding: 6 }}>
              <option value={2000}>2秒</option>
              <option value={4000}>4秒</option>
              <option value={10000}>10秒</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: '#9aa', fontSize: 12 }}>1語ごとの間隔</span>
            <select value={tickMs} onChange={e => setTickMs(Number(e.target.value))} disabled={running}
              style={{ background: '#222', color: '#eee', border: '1px solid #555', borderRadius: 6, padding: 6 }}>
              <option value={100}>100ms</option>
              <option value={400}>400ms</option>
              <option value={1000}>1秒</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ color: '#9aa', fontSize: 12 }}>「空白」とみなす長さ</span>
            <select value={gapThresholdMs} onChange={e => setGapThresholdMs(Number(e.target.value))}
              style={{ background: '#222', color: '#eee', border: '1px solid #555', borderRadius: 6, padding: 6 }}>
              <option value={3000}>3秒</option>
              <option value={5000}>5秒</option>
              <option value={15000}>15秒</option>
            </select>
          </label>
        </div>
        <p style={{ color: '#777', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          <b>無音</b>は NEXUS が SSE に1バイトも書かない区間のこと。経路で上限が違う（実装を読んで確認済み）：
          <b>OAuth（Claude Code）</b>は 120秒の完全無音で <code>stall_warning</code> を出し以後30秒ごとに繰り返す＝<b>無音の上限は約2分</b>。
          <b>他の4経路</b>（API キー Claude・Gemini・OpenAI 互換・Anthropic 互換）にはウォッチドッグが無く、<b>ツール実行の全長がそのまま無音</b>になる。
          だから <b>2分</b>が OAuth の最悪ケース、<b>5分</b>が他経路の現実的な最悪ケースだ。
          <b>キープアライブ OFF</b> が今の NEXUS、ON が修正案（SSE コメント＝既存のクライアントは無視するので本番に足しても無害）。
          長い無音で切れてキープアライブで切れなければ、修正は測定で決まる。
        </p>
      </div>

      {/* ── client-side counters ─────────────────────────────────────────── */}
      <div style={box}>
        <div style={lbl}>クライアントが見たもの</div>
        <Row k="run id" v={runId ?? '–'} />
        <Row k="開始 / 終了" v={`${fmtClock(startedAt)} → ${fmtClock(endedAt)}`} />
        <Row k="最後の受信" v={fmtClock(lastByteAt)} />
        <Row k="受信した塊 / バイト" v={`${chunks.toLocaleString()} / ${bytes.toLocaleString()}`} />
        <Row k="フレーム / コメント" v={`${frames.toLocaleString()} / ${comments.toLocaleString()}`} />
        <Row k="最後の seq" v={lastSeq.toLocaleString()} />
        {failure && <>
          <Row k="fetch が投げた" v={`${failure.name}: ${failure.message}`} warn />
          <Row k="投げた時刻" v={`${fmtClock(failure.at)}（最後の受信から ${fmtDur(failure.silentForMs)}）`} warn />
        </>}
      </div>

      {/* ── server-side record ───────────────────────────────────────────── */}
      <div style={box}>
        <div style={lbl}>サーバーが見たもの（別の接続で取得）</div>
        {!server && <div style={{ color: '#777', padding: '6px 0' }}>まだ取得していない</div>}
        {server && <>
          <Row k="取得時刻" v={fmtClock(server.fetchedAt)} />
          {server.fetchError && <Row k="取得に失敗" v={server.fetchError} warn />}
          {server.known === false && <Row k="記録なし" v={server.note ?? ''} warn />}
          {server.known && <>
            <Row k="サーバーの最後の seq" v={`${(server.lastSeq ?? 0).toLocaleString()}`} />
            <Row k="クライアントとの差" v={`${seqBehind.toLocaleString()} フレーム`} warn={seqBehind > 2} />
            <Row k="最後の書き込みから" v={fmtDur(server.sinceLastWriteMs ?? 0)} />
            <Row k="まだ書いている？" v={server.alive ? 'はい' : `いいえ（${server.endReason ?? '?'}）`} />
            <Row k="abort を見た" v={server.abortSeenAt ? `${fmtClock(server.abortSeenAt)} ← クライアント/ネットワークが切った` : 'いいえ'}
              warn={!!server.abortSeenAt} />
            <Row k="書き込みが失敗した" v={server.writeFailedAt ? `${fmtClock(server.writeFailedAt)}: ${server.writeFailure ?? ''}` : 'いいえ'}
              warn={!!server.writeFailedAt} />
            <Row k="送ったバイト / キープアライブ" v={`${(server.bytesWritten ?? 0).toLocaleString()} / ${(server.heartbeatsSent ?? 0).toLocaleString()}`} />
            <Row k="pid / instance" v={`${server.pid ?? '?'} / ${server.instance ?? '?'}`} />
          </>}
        </>}
        <p style={{ color: '#777', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          読み方：<b>サーバーの seq が進んでいてクライアントが止まっている</b>＝クライアント側で詰まった。
          <b>サーバーが abort を見た</b>＝ブラウザかネットワークが接続を閉じた。
          <b>サーバーの書き込みが失敗した</b>＝相手が既にいなかった。
          <b>サーバーも止まっている</b>＝サーバー側の問題。
        </p>
      </div>

      {/* ── gaps ────────────────────────────────────────────────────────── */}
      <div style={box}>
        <div style={lbl}>受信の空白（{gaps.length}件）</div>
        {gaps.length === 0 && <div style={{ color: '#777', padding: '6px 0' }}>なし</div>}
        {gaps.slice(0, 30).map((g, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, padding: '2px 0', fontSize: 13 }}>
            <span style={{ color: '#888', minWidth: 80 }}>{fmtClock(g.startedAt)}</span>
            <span style={{ color: g.ms > 60_000 ? '#ff8080' : '#ddd', minWidth: 110 }}>{fmtDur(g.ms)}</span>
            <span style={{ color: '#777' }}>seq {g.atSeq}</span>
          </div>
        ))}
        <p style={{ color: '#777', fontSize: 11, marginTop: 8 }}>
          設定した無音（{fmtDur(toolSilentMs)}）より大きい空白だけが異常だ。無音と同じ長さの空白は仕様どおり。
        </p>
      </div>

      {/* ── freezes ─────────────────────────────────────────────────────── */}
      <div style={{ ...box, borderColor: freezes.length ? '#a85' : '#444' }}>
        <div style={lbl}>JS が止まっていた時間（{freezes.length}件）</div>
        {freezes.length === 0 && <div style={{ color: '#777', padding: '6px 0' }}>なし</div>}
        {freezes.slice(0, 30).map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, padding: '2px 0', fontSize: 13 }}>
            <span style={{ color: '#888', minWidth: 80 }}>{fmtClock(f.startedAt)}</span>
            <span style={{ color: '#ffcc80' }}>{fmtDur(f.ms)}</span>
          </div>
        ))}
        <p style={{ color: '#777', fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
          {UI_TICK_MS}ms ごとのタイマーが {FREEZE_SLACK_MS}ms 以上遅れた＝この間ブラウザが JS を走らせていなかった。
          これが「クライアントが凍った」の直接の証拠で、<b>凍っていた本人が後から気づける唯一の形</b>だ。
        </p>
      </div>

      {/* ── lifecycle events ────────────────────────────────────────────── */}
      <div style={box}>
        <div style={lbl}>イベント（新しい順）</div>
        {events.length === 0 && <div style={{ color: '#777', padding: '6px 0' }}>なし</div>}
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {events.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '2px 0', fontSize: 13 }}>
              <span style={{ color: '#888', minWidth: 80 }}>{fmtClock(e.at)}</span>
              <span style={{ color: e.kind === 'fetch-threw' || e.kind === 'offline' ? '#ff8080' : e.kind === 'js-frozen' ? '#ffcc80' : '#9cf', minWidth: 120 }}>{e.kind}</span>
              <span style={{ color: '#ccc' }}>{e.detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── environment ─────────────────────────────────────────────────── */}
      <div style={box}>
        <div style={lbl}>この環境</div>
        <Row k="画面の状態" v={typeof document !== 'undefined' ? document.visibilityState : '?'} />
        <Row k="オンライン" v={typeof navigator !== 'undefined' ? String(navigator.onLine) : '?'} />
        <Row k="secure context" v={typeof window !== 'undefined' ? String(window.isSecureContext) : '?'} />
        <Row k="Wake Lock（画面を点けたままにする）"
          v={wakeLockAvailable ? 'この URL では使える' : 'この URL では使えない'}
          warn={!wakeLockAvailable} />
        <Row k="接続" v={(() => {
          const c: any = typeof navigator !== 'undefined' ? (navigator as any).connection : null;
          return c ? `${c.effectiveType ?? '?'} / downlink ${c.downlink ?? '?'}Mbps / saveData ${c.saveData}` : '不明（この browser は NetworkInformation を出さない）';
        })()} />
        <p style={{ color: '#777', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          Wake Lock は secure context が要る——<b>localhost では使えて、<code>192.168.10.2</code> のような plain HTTP の LAN アドレスでは消える</b>
          （`navigator.clipboard` が消えるのと同じ理由）。上の2行は推測ではなく、<b>今開いているこの URL で実際に判定した値</b>だ。
          だからスマホから LAN アドレスで開いたときは「使えない」と出るはずで、その場合「画面を点けたまま」をページ側から保証する手は無い——OS 側のタイムアウトで測るしかない。
        </p>
      </div>
    </div>
  );
}
