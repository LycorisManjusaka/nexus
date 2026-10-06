'use client';

import { useEffect, useState } from 'react';
import {
  classifyFromNavigator,
  collectClientSignals,
  type DeviceClass,
  type DeviceSignals,
} from '@/lib/deviceClass';

/**
 * /device — a read-only probe page.
 *
 * Open it from the device in question (phone, tablet, emulator, desktop) and
 * it reports what the SERVER concluded from request headers next to what the
 * CLIENT concluded from `navigator`, with every raw signal underneath. The two
 * can disagree, and when they do the point is to see *which signal* decided,
 * not to pick a winner here.
 *
 * Nothing on this page changes the app. It exists so the phone/desktop split
 * can be decided on measurements rather than on a guess about what a phone
 * "probably" sends.
 *
 * Styling is plain inline CSS on purpose: this page must render correctly even
 * if the theme system, the fonts, or a layout change is the thing being
 * investigated.
 */

interface ServerProbe {
  device: DeviceClass;
  signals: Record<string, string>;
  note?: string;
  error?: string;
}

const box: React.CSSProperties = {
  border: '1px solid #444',
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  background: '#1a1a1a',
};

const label: React.CSSProperties = {
  color: '#888',
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

function Row({ k, v, dim }: { k: string; v: React.ReactNode; dim?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', flexWrap: 'wrap' }}>
      <span style={{ color: dim ? '#666' : '#9aa', minWidth: 160, flexShrink: 0 }}>{k}</span>
      <span style={{ color: dim ? '#777' : '#eee', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

function Verdict({ title, d }: { title: string; d: DeviceClass | null }) {
  if (!d) return <div style={box}>{title}: …</div>;
  const colour = d.kind === 'phone' ? '#4ade80' : d.kind === 'tablet' ? '#fbbf24' : '#60a5fa';
  return (
    <div style={box}>
      <div style={label}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: colour, margin: '4px 0' }}>{d.kind}</div>
      <Row k="decided by" v={d.source} />
      {d.guessed && <Row k="⚠ guessed" v="no signal was present; this is the fallback" />}
    </div>
  );
}

export default function DevicePage() {
  const [server, setServer] = useState<ServerProbe | null>(null);
  const [client, setClient] = useState<DeviceClass | null>(null);
  const [signals, setSignals] = useState<DeviceSignals | null>(null);
  const [serverError, setServerError] = useState<string>('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setClient(classifyFromNavigator());
    setSignals(collectClientSignals());
    let alive = true;
    fetch('/api/device-probe')
      .then((r) => r.json())
      .then((j) => alive && setServer(j))
      .catch((e) => alive && setServerError(String(e?.message || e)));
    return () => {
      alive = false;
    };
  }, [tick]);

  // Re-read the client signals on resize/rotate: viewport and DPR are the only
  // values here that move, and seeing them move is part of the point.
  useEffect(() => {
    const onResize = () => setSignals(collectClientSignals());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  const agree = server && client && server.device.kind === client.kind;

  return (
    <div
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        background: '#0d0d0d',
        color: '#ddd',
        minHeight: '100vh',
        padding: 16,
        boxSizing: 'border-box',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <h1 style={{ fontSize: 18, margin: '0 0 4px' }}>NEXUS device probe</h1>
      <p style={{ color: '#888', margin: '0 0 16px' }}>
        Read-only. Nothing here changes the app. Open this page from the device you want to
        classify.
      </p>

      <Verdict title="server says (request headers)" d={server?.device || null} />
      <Verdict title="client says (navigator)" d={client} />

      {server && client && (
        <div style={{ ...box, borderColor: agree ? '#2d5a3d' : '#7a4a1a' }}>
          <div style={label}>agreement</div>
          <div style={{ color: agree ? '#4ade80' : '#fbbf24', fontSize: 15 }}>
            {agree ? '✓ both sides agree' : '⚠ sides disagree — read the signals below'}
          </div>
        </div>
      )}

      <div style={box}>
        <div style={{ ...label, marginBottom: 6 }}>signals used to decide</div>
        <Row k="UA (server)" v={server?.signals?.userAgent || (serverError ? `error: ${serverError}` : '…')} />
        <Row k="UA (client)" v={signals?.userAgent ?? '…'} />
        <Row
          k="sec-ch-ua-mobile (server)"
          v={server?.signals?.secChUaMobile || '(absent — plain HTTP)'}
        />
        <Row
          k="userAgentData.mobile"
          v={
            signals?.hasUserAgentData
              ? signals.secChUaMobile || '(present, no boolean)'
              : '(absent — not a secure context)'
          }
        />
        <Row k="sec-ch-ua-platform" v={server?.signals?.secChUaPlatform || '(absent)'} />
      </div>

      <div style={box}>
        <div style={{ ...label, marginBottom: 6 }}>context — NOT used to decide</div>
        <Row dim k="viewport" v={signals ? `${signals.viewportWidth} × ${signals.viewportHeight} css px` : '…'} />
        <Row dim k="devicePixelRatio" v={signals?.devicePixelRatio ?? '…'} />
        <Row dim k="maxTouchPoints" v={signals?.maxTouchPoints ?? '…'} />
        <Row dim k="pointer: coarse" v={String(signals?.pointerCoarse ?? '…')} />
        <Row dim k="isSecureContext" v={String(signals?.secureContext ?? '…')} />
        <Row dim k="host" v={server?.signals?.host || '…'} />
      </div>

      <p style={{ color: '#777', fontSize: 12 }}>
        Screen size is reported but never classified on: a narrow desktop window is still a
        desktop. {server?.note}
      </p>

      <button
        onClick={() => setTick((t) => t + 1)}
        style={{
          marginTop: 8,
          padding: '10px 16px',
          fontSize: 14,
          background: '#2a2a2a',
          color: '#ddd',
          border: '1px solid #555',
          borderRadius: 6,
        }}
      >
        re-probe
      </button>
    </div>
  );
}
