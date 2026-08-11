"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { X, Play, Square, RefreshCw, Plus, Trash2, Save, ChevronDown, ChevronRight, Loader2, Monitor, LayoutGrid, Speaker } from 'lucide-react';
import { useT, renderRich } from '@/lib/i18n';

// Control panel for the local helper processes that make up an audio session:
// the voice changer or logger, the ear logger, and the speech-recognition
// clients that feed them.
//
// Services are per-machine (keyed by hostname server-side), so the personal PC
// and the work PC keep separate setups inside one rclone-synced file. Each row
// can be started and stopped on its own — the common case is "everything", but
// running the voice changer WITHOUT the ear logger is a normal thing to want.

/** `--mic 1 --out "a b"` → ['--mic','1','--out','a b']. Quotes keep spaces. */
function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function joinArgs(args: string[] = []): string {
  return args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** Only recognize.exe accepts --mic; everything else manages its own devices. */
function takesMic(s: any): boolean {
  return /recognize(-gui)?\.exe$/i.test(String(s?.path || '')) || (s?.args || []).includes('--mic');
}

const BLANK = {
  id: '', label: '', kind: 'exe', path: '', args: [] as string[], cwd: '',
  probe: { type: 'tcp', port: 13000 }, enabled: true,
};

export default function AudioSessionModal({ onClose }: any) {
  const t = useT();
  const [host, setHost] = useState('');
  const [services, setServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  // Microphone list, fetched on demand from recognize.exe --print_mics. Shared
  // across rows: every recognizer enumerates the same devices.
  const [mics, setMics] = useState<any[]>([]);
  const [micsLoading, setMicsLoading] = useState(false);
  // Monitor the console windows get stacked on. Persisted per machine.
  const [monitors, setMonitors] = useState<any[]>([]);
  const [monitorIndex, setMonitorIndex] = useState(0);
  // Windows default output device to switch to when the session starts.
  const [outputDevices, setOutputDevices] = useState<any[]>([]);
  const [outputDeviceId, setOutputDeviceId] = useState('');

  // The device list belongs to the machine, not to a row — the server finds a
  // configured recognize.exe on its own, so this works from any row (and with
  // no row at all, on open).
  const loadMics = async (exePath?: string, quiet = false) => {
    setMicsLoading(true);
    try {
      const r = await fetch('/api/services', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mics', path: exePath || '' }),
      });
      const d = await r.json();
      setMics(d.mics || []);
      if (!d.mics?.length && !quiet) setLog([`✗ ${d.error || t('audio.noMics')}`]);
    } catch (e: any) {
      if (!quiet) setLog([`✗ ${e.message}`]);
    }
    setMicsLoading(false);
  };

  // Fold incoming server state into the list WITHOUT discarding edits in
  // progress. The status poll runs every 2s; replacing `services` wholesale meant
  // any change — a checkbox, a path, a mic — was silently reverted a moment
  // later. While there are unsaved changes, only the live status fields are
  // taken; once saved, the server's copy is authoritative again.
  const applyServices = useCallback((incoming: any[]) => {
    setServices(prev => {
      if (!dirty || prev.length === 0) return incoming;
      return prev.map(p => {
        const s = incoming.find((x: any) => x.id === p.id);
        return s ? { ...p, running: s.running, pid: s.pid, pathExists: s.pathExists } : p;
      });
    });
  }, [dirty]);

  const refresh = useCallback(async () => {
    try {
      const d = await (await fetch('/api/services')).json();
      setHost(d.host || '');
      applyServices(d.services || []);
      if (Array.isArray(d.monitors)) setMonitors(d.monitors);
      if (typeof d.monitorIndex === 'number') setMonitorIndex(d.monitorIndex);
      if (Array.isArray(d.outputDevices)) setOutputDevices(d.outputDevices);
      if (typeof d.outputDeviceId === 'string') setOutputDeviceId(d.outputDeviceId);
    } catch { /* panel just shows stale data */ }
    setLoading(false);
  }, [applyServices]);

  useEffect(() => { refresh(); }, [refresh]);

  // Populate the device list up front so the dropdowns are usable immediately.
  // Quiet: a machine with no recognizer configured shouldn't greet you with an
  // error just for opening the panel.
  useEffect(() => { loadMics(undefined, true); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Watch statuses for a while after a start. The server no longer waits for a
  // service to come up (that blocked the entire panel for 45s per service), so
  // readiness arrives here instead. Stops early once nothing changes.
  const watchRef = React.useRef<number | null>(null);
  const watchStatuses = useCallback((seconds = 60) => {
    if (watchRef.current) window.clearInterval(watchRef.current);
    const until = Date.now() + seconds * 1000;
    watchRef.current = window.setInterval(async () => {
      await refresh();
      if (Date.now() > until && watchRef.current) {
        window.clearInterval(watchRef.current);
        watchRef.current = null;
      }
    }, 2000) as unknown as number;
  }, [refresh]);

  useEffect(() => () => { if (watchRef.current) window.clearInterval(watchRef.current); }, []);

  const act = async (body: any, busyKey: string) => {
    setBusy(busyKey);
    setLog([]);
    try {
      // Start/stop act on what is ON DISK. Unsaved checkbox changes would
      // otherwise be ignored — unchecking a service and pressing Run would still
      // start it — so the list is committed first.
      if (dirty && ['start', 'stop', 'startAll', 'stopAll'].includes(body.action)) {
        await fetch('/api/services', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'save', services }),
        });
        setDirty(false);
      }
      const r = await fetch('/api/services', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.services) applyServices(d.services);
      if (d.results) setLog(d.results.map((x: any) => `${x.ok ? '✓' : '✗'} ${x.label}: ${x.message}`));
      if (d.error) setLog([`✗ ${d.error}`]);
      if (body.action === 'start' || body.action === 'startAll') {
        setLog(prev => [...prev, t('audio.watching')]);
        watchStatuses(60);
      }
      // After a whole session start, place the windows once the consoles have
      // had time to appear. Only for startAll — arranging after a single Start
      // would shuffle windows the user is already looking at.
      if (body.action === 'startAll' && monitors.length > 0) {
        window.setTimeout(async () => {
          try {
            const rr = await fetch('/api/services', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'arrange', monitorIndex }),
            }).then(x => x.json());
            if (rr.services) applyServices(rr.services);
            const placed = (rr.results || []).filter((x: any) => x.ok).length;
            setLog(prev => [...prev, t('audio.arranged').replace('{n}', String(placed)).replace('{m}', String(monitorIndex + 1))]);
          } catch { /* the button is still there */ }
        }, 8000);
      }
    } catch (e: any) {
      setLog([`✗ ${e.message}`]);
    }
    setBusy(null);
  };

  const patch = (idx: number, changes: any) => {
    setServices(prev => prev.map((s, i) => (i === idx ? { ...s, ...changes } : s)));
    setDirty(true);
  };

  const save = async () => {
    await act({ action: 'save', services }, 'save');
    setDirty(false);
  };

  const enabledCount = services.filter(s => s.enabled !== false).length;
  const runningCount = services.filter(s => s.running).length;

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">

        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-secondary/30 shrink-0">
          <div>
            <h2 className="text-lg font-bold">{t('audio.title')}</h2>
            <p className="text-[10px] text-muted-foreground">
              {t('audio.subtitle').replace('{running}', String(runningCount)).replace('{total}', String(services.length))}
              {host && <span className="font-mono"> ({host})</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
            <X size={20} />
          </button>
        </div>

        {/* Session-wide actions */}
        <div className="px-6 py-3 border-b border-border flex items-center gap-2 shrink-0 flex-wrap">
          <button
            onClick={() => act({ action: 'startAll' }, 'startAll')}
            disabled={!!busy || enabledCount === 0}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
          >
            {busy === 'startAll' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
            {t('audio.run')}
          </button>
          <button
            onClick={() => act({ action: 'stopAll' }, 'stopAll')}
            disabled={!!busy || enabledCount === 0}
            className="px-3 py-2 text-sm font-semibold rounded-lg bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
          >
            {busy === 'stopAll' ? <Loader2 size={15} className="animate-spin" /> : <Square size={15} />}
            {t('audio.stop')}
          </button>
          <span className="text-[10px] text-muted-foreground">
            {t('audio.actsOn').replace('{n}', String(enabledCount))}
          </span>
          <button
            onClick={refresh}
            disabled={!!busy}
            className="ml-auto p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40"
            title={t('audio.recheck')}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        {/* Window placement: stack the running console windows down one monitor.
            A portrait display is the natural fit — each service gets a full-width
            horizontal band. */}
        <div className="px-6 py-2 border-b border-border flex items-center gap-2 shrink-0 flex-wrap bg-muted/10">
          <Monitor size={14} className="text-muted-foreground shrink-0" />
          <select
            value={monitorIndex}
            onChange={e => setMonitorIndex(Number(e.target.value))}
            className="px-2 py-1 bg-background border border-border rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500 max-w-[22rem]"
          >
            {monitors.length === 0 && <option value={0}>{t('audio.noMonitors')}</option>}
            {monitors.map((m: any) => (
              <option key={m.index} value={m.index}>
                {m.index + 1}. {m.width}×{m.height}
                {m.height > m.width ? t('audio.portrait') : ''}
                {m.primary ? t('audio.primary') : ''}
                {t('audio.at').replace('{x}', String(m.x)).replace('{y}', String(m.y))}
              </option>
            ))}
          </select>
          <button
            onClick={() => act({ action: 'arrange', monitorIndex }, 'arrange')}
            disabled={!!busy || runningCount === 0}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
            title={t('audio.arrangeTitle')}
          >
            {busy === 'arrange' ? <Loader2 size={13} className="animate-spin" /> : <LayoutGrid size={13} />}
            {t('audio.arrange')}
          </button>
          <span className="text-[10px] text-muted-foreground">
            {runningCount > 0
              ? t('audio.bands').replace('{n}', String(runningCount))
              : t('audio.startFirst')}
          </span>
        </div>

        {/* Windows default output device. Applied at the START of Run Audio
            Session, before anything opens an audio device — apps choose their
            endpoint on launch, so switching afterwards would leave them on the
            old one. */}
        <div className="px-6 py-2 border-b border-border flex items-center gap-2 shrink-0 flex-wrap bg-muted/10">
          <Speaker size={14} className="text-muted-foreground shrink-0" />
          <span className="text-[11px] font-medium shrink-0">{t('audio.outputLabel')}</span>
          <select
            value={outputDeviceId}
            onChange={e => {
              setOutputDeviceId(e.target.value);
              fetch('/api/services', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'setOutputDevice', deviceId: e.target.value }),
              }).catch(() => {});
            }}
            className="px-2 py-1 bg-background border border-border rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500 max-w-[24rem] flex-1 min-w-[12rem]"
          >
            <option value="">{t('audio.noOutputChange')}</option>
            {outputDevices.map((d: any) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button
            onClick={() => act({ action: 'setOutputDevice', deviceId: outputDeviceId, applyNow: true }, 'output')}
            disabled={!!busy || !outputDeviceId}
            className="px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-muted hover:bg-muted/70 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 shrink-0"
            title={t('audio.applyNowTitle')}
          >
            {busy === 'output' ? <Loader2 size={13} className="animate-spin" /> : null}
            {t('audio.applyNow')}
          </button>
        </div>

        <div className="p-6 space-y-3 overflow-y-auto">
          {loading && <div className="text-sm text-muted-foreground">{t('audio.loading')}</div>}

          {!loading && services.length === 0 && (
            <div className="text-sm text-muted-foreground">{renderRich(t('audio.noServices'))}</div>
          )}

          {services.map((s, idx) => (
            <div key={s.id || idx} className="border border-border rounded-lg bg-muted/10">
              <div className="flex items-center gap-2 px-3 py-2">
                <input
                  type="checkbox"
                  checked={s.enabled !== false}
                  onChange={e => patch(idx, { enabled: e.target.checked })}
                  className="w-4 h-4 accent-indigo-500 shrink-0"
                  title={t('audio.includeTitle')}
                />
                <button
                  onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  {expanded === s.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>

                <span className="text-sm font-medium truncate flex-1" title={s.path}>{s.label || s.id}</span>

                {!s.pathExists && s.path && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold shrink-0">
                    {t('audio.pathMissing')}
                  </span>
                )}
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0 ${
                    s.running
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground'
                  }`}
                  title={s.pid ? `pid ${s.pid}` : undefined}
                >
                  {s.running ? t('audio.running') : t('audio.stopped')}
                </span>

                <button
                  onClick={() => act({ action: s.running ? 'stop' : 'start', id: s.id }, s.id)}
                  disabled={!!busy}
                  className={`px-2 py-1 text-[11px] font-semibold rounded shrink-0 disabled:opacity-40 transition-colors ${
                    s.running
                      ? 'bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/25'
                      : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25'
                  }`}
                >
                  {busy === s.id ? '…' : s.running ? t('audio.stopBtn') : t('audio.startBtn')}
                </button>
              </div>

              {expanded === s.id && (
                <div className="px-3 pb-3 pt-1 space-y-2 border-t border-border/60">
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t('audio.f.label')} value={s.label} onChange={v => patch(idx, { label: v })} />
                    <div>
                      <FieldLabel>{t('audio.f.type')}</FieldLabel>
                      <select
                        value={s.kind}
                        onChange={e => patch(idx, { kind: e.target.value })}
                        className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                      >
                        <option value="exe">.exe</option>
                        <option value="python">.py (via python)</option>
                        <option value="bat">.bat</option>
                      </select>
                    </div>
                  </div>
                  <Field label={t('audio.f.path')} mono value={s.path} onChange={v => patch(idx, { path: v })} />
                  <Field
                    label={t('audio.f.args')}
                    mono
                    value={joinArgs(s.args)}
                    onChange={v => patch(idx, { args: splitArgs(v) })}
                    hint={t('audio.f.argsHint')}
                  />
                  <Field label={t('audio.f.cwd')} mono value={s.cwd || ''} onChange={v => patch(idx, { cwd: v })} />

                  {/* Microphone BY NAME. Saving the index is unsafe — plugging
                      in any audio device renumbers the list, and the saved
                      number then silently points at a different input.

                      Shown only where it can actually take effect: --mic belongs
                      to recognize.exe. The voice changer picks its own devices
                      from device_settings.json, so offering the control there
                      would just be a lie. */}
                  {(takesMic(s) || s.micName) && (
                    <div>
                      <FieldLabel>{t('audio.mic.label')}</FieldLabel>
                      <div className="flex gap-1.5">
                        <select
                          value={s.micName || ''}
                          onChange={e => patch(idx, { micName: e.target.value })}
                          className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                        >
                          <option value="">{t('audio.mic.none')}</option>
                          {s.micName && !mics.some((m: any) => m.name === s.micName) && (
                            <option value={s.micName}>{t('audio.mic.notConnected').replace('{name}', s.micName)}</option>
                          )}
                          {mics.map((m: any) => (
                            <option key={m.index} value={m.name}>{m.index} : {m.name}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => loadMics(s.path)}
                          disabled={micsLoading}
                          className="px-2 py-1 text-[10px] font-semibold bg-muted rounded hover:bg-muted/70 disabled:opacity-40 shrink-0"
                          title={t('audio.mic.refreshTitle')}
                        >
                          {micsLoading ? '…' : t('audio.mic.refresh')}
                        </button>
                      </div>
                      {s.micName && (
                        <p className="text-[9px] text-muted-foreground mt-0.5">{renderRich(t('audio.mic.note'))}</p>
                      )}
                    </div>
                  )}

                  {!takesMic(s) && !s.micName && (
                    <p className="text-[9px] text-muted-foreground">{renderRich(t('audio.mic.na'))}</p>
                  )}

                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={s.showConsole !== false}
                      onChange={e => patch(idx, { showConsole: e.target.checked })}
                      className="w-3.5 h-3.5 accent-indigo-500"
                    />
                    <span className="text-[11px]">
                      {t('audio.console')}
                      <span className="text-muted-foreground">{t('audio.consoleHint')}</span>
                    </span>
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <FieldLabel>{t('audio.detectBy')}</FieldLabel>
                      <select
                        value={s.probe?.type || 'tcp'}
                        onChange={e => patch(idx, { probe: { ...s.probe, type: e.target.value } })}
                        className="w-full px-2 py-1.5 bg-background border border-border rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                      >
                        <option value="tcp">{t('audio.detect.tcp')}</option>
                        <option value="process">{t('audio.detect.process')}</option>
                      </select>
                    </div>
                    {(s.probe?.type || 'tcp') === 'tcp' ? (
                      <Field
                        label={t('audio.f.port')}
                        value={String(s.probe?.port ?? '')}
                        onChange={v => patch(idx, { probe: { ...s.probe, port: Number(v) || 0 } })}
                      />
                    ) : (
                      <Field
                        label={t('audio.f.match')}
                        mono
                        value={s.probe?.match || ''}
                        onChange={v => patch(idx, { probe: { ...s.probe, match: v } })}
                        hint={t('audio.f.matchHint')}
                      />
                    )}
                  </div>

                  <button
                    onClick={() => { setServices(prev => prev.filter((_, i) => i !== idx)); setDirty(true); }}
                    className="text-[11px] text-red-500 hover:text-red-400 flex items-center gap-1"
                  >
                    <Trash2 size={12} /> {t('audio.remove')}
                  </button>
                </div>
              )}
            </div>
          ))}

          <button
            onClick={() => {
              const id = `svc_${Date.now().toString(36)}`;
              setServices(prev => [...prev, { ...BLANK, id, label: t('audio.newService') }]);
              setExpanded(id);
              setDirty(true);
            }}
            className="text-xs text-indigo-500 hover:text-indigo-400 flex items-center gap-1"
          >
            <Plus size={14} /> {t('audio.add')}
          </button>

          {log.length > 0 && (
            <div className="mt-3 p-3 rounded-lg bg-muted/40 border border-border space-y-0.5">
              {log.map((l, i) => (
                <div
                  key={i}
                  className={`text-[11px] font-mono ${l.startsWith('✗') ? 'text-red-500' : 'text-muted-foreground'}`}
                >
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border bg-secondary/30 flex justify-between items-center gap-3 shrink-0">
          <span className="text-[10px] text-muted-foreground">
            {dirty ? t('audio.dirty') : t('audio.clean')}
          </span>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg hover:bg-muted transition-colors">
              {t('common.close')}
            </button>
            <button
              onClick={save}
              disabled={!!busy || !dirty}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Save size={16} /> {t('audio.saveList')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] font-medium text-muted-foreground mb-0.5 block">{children}</label>;
}

// Typed rather than `any` so the onChange callbacks at every call site get
// their parameter type inferred instead of falling back to implicit any.
function Field({
  label,
  value,
  onChange,
  mono,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`w-full px-2 py-1.5 bg-background border border-border rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500 ${mono ? 'font-mono' : ''}`}
      />
      {hint && <p className="text-[9px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}
