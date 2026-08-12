"use client";

import React, { useState, useEffect } from 'react';
import { X, Save, KeyRound, Volume2, SlidersHorizontal, Users } from 'lucide-react';
import VoiceSelector from './VoiceSelector';
import UserIdentityEditor from './UserIdentityEditor';
import { useT, Tx } from '@/lib/i18n';

// Preferences is split into tabs because the three groups have nothing to do
// with each other and the API-key list alone is twelve providers long. Add a
// new tab by extending this list and adding a matching `{tab === '...' && (…)}`
// block in the body. Labels come from i18n under `settings.tab.<id>`.
const TABS = [
  { id: 'keys',     icon: KeyRound },
  { id: 'vrchat',   icon: Volume2 },
  { id: 'identity', icon: Users },
  { id: 'other',    icon: SlidersHorizontal },
] as const;

type TabId = (typeof TABS)[number]['id'];

// The single-field providers all render identically, so they're a list rather
// than twelve copies of the same block. Anthropic stays hand-written below —
// it has two fields and a long warning panel.
const SIMPLE_PROVIDERS: { id: string; ph: string; help?: boolean }[] = [
  { id: 'gemini',       ph: 'AIzaSy...' },
  { id: 'qwen',         ph: 'sk-...',   help: true },
  { id: 'deepseek',     ph: 'sk-...',   help: true },
  { id: 'glm',          ph: '...',      help: true },
  { id: 'digitalocean', ph: '...',      help: true },
  { id: 'grok',         ph: 'xai-...',  help: true },
  { id: 'kimi',         ph: '...',      help: true },
  { id: 'cohere',       ph: '...',      help: true },
  { id: 'minimax',      ph: '...',      help: true },
  { id: 'openai',       ph: 'sk-...',   help: true },
  { id: 'mimo',         ph: '...',      help: true },
  { id: 'bytedance',    ph: '...',      help: true },
];

export default function SettingsModal({ onClose, globalSettings, setGlobalSettings }: any) {
  // Counter the User Identity editor watches to run its own save. We bump it
  // whenever the modal's "Save Changes" button is pressed and the User
  // Identity tab is active — otherwise the editor's per-tab save button looks
  // like it does nothing, because the modal Save Changes closes the window
  // without persisting the identity list.
  const userIdentitySaveTrigger = React.useRef(0);
  const [activeTab, setActiveTabState] = React.useState<'keys'|'audio'|'identity'|'other'>('keys');
  const setActiveTab = (tab: 'keys'|'audio'|'identity'|'other') => setActiveTabState(tab);
  const t = useT();
  // claudeAuthMode + claudeOAuthToken are OPT-IN additions for using your
  // Claude Pro/Max subscription billing instead of pay-per-token API billing.
  // Default is 'api-key' so existing setups keep working exactly as before.
  // See the inline help text in the Anthropic section below for setup steps.
  const [keys, setKeys] = useState<any>({
    gemini: '', claude: '', qwen: '', deepseek: '', glm: '', grok: '',
    kimi: '', cohere: '', minimax: '', openai: '', mimo: '', bytedance: '',
    digitalocean: '',
    claudeAuthMode: 'api-key', claudeOAuthToken: '',
  });
  const [loading, setLoading] = useState(true);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [tab, setTab] = useState<TabId>('keys');

  // TTS engine executables. Stored SERVER-SIDE (local_data/tts_engines.json),
  // not in globalSettings, because the auto-start happens on the server — see
  // src/lib/ttsEngines.ts. `engineStatus` is a live up/down probe so you can see
  // at a glance whether an engine is currently running.
  const [enginePaths, setEnginePaths] = useState<Record<string, string>>({});
  const [engineStatus, setEngineStatus] = useState<any[]>([]);
  // Which engine row has an action in flight, and the last message from it.
  const [engineBusy, setEngineBusy] = useState<string | null>(null);
  const [engineMsg, setEngineMsg] = useState<Record<string, string>>({});
  const enginePollRef = React.useRef<any>(null);

  const refreshEngines = React.useCallback((withPaths = false) => {
    fetch('/api/tts/engines')
      .then(r => r.json())
      .then(d => {
        // Stored paths are adopted ONLY on the initial load. A status refresh —
        // manual or polled — must never overwrite a path the user has typed but
        // not saved yet. Same trap the Audio Session panel hit with its 2s poll.
        if (withPaths) setEnginePaths(d.paths || {});
        setEngineStatus(d.status || []);
      })
      .catch(() => {});
  }, []);

  // Start is fire-and-forget on the server (loading voice models can take ~90s),
  // so the panel polls instead of blocking. Self-cancels once the window passes.
  const pollEngines = React.useCallback(() => {
    if (enginePollRef.current) clearInterval(enginePollRef.current);
    const until = Date.now() + 95000;
    enginePollRef.current = setInterval(() => {
      if (Date.now() > until) {
        clearInterval(enginePollRef.current);
        enginePollRef.current = null;
        return;
      }
      refreshEngines();
    }, 2500);
  }, [refreshEngines]);

  useEffect(() => () => {
    if (enginePollRef.current) clearInterval(enginePollRef.current);
  }, []);

  const engineAction = async (engine: number, key: string, action: 'start' | 'stop' | 'restart') => {
    setEngineBusy(key);
    setEngineMsg(prev => ({
      ...prev,
      [key]: action === 'stop' ? t('settings.engines.msg.stopping') : t('settings.engines.msg.starting'),
    }));
    try {
      const d = await fetch('/api/tts/engines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, engine }),
      }).then(r => r.json());
      setEngineMsg(prev => ({
        ...prev,
        [key]: d?.message || (d?.ok ? t('settings.engines.msg.done') : t('settings.engines.msg.failed')),
      }));
      // Only a launch needs the boot poll; a stop has already been confirmed.
      if (d?.ok && action !== 'stop') pollEngines();
    } catch (e: any) {
      setEngineMsg(prev => ({ ...prev, [key]: e?.message || t('settings.engines.msg.requestFailed') }));
    } finally {
      setEngineBusy(null);
      refreshEngines();
    }
  };

  useEffect(() => {
    fetch('/api/keys').then(r => r.json()).then(data => {
      setKeys(data);
      setLoading(false);
    });

    const getDevices = async () => {
      try {
        let devs = await navigator.mediaDevices.enumerateDevices();
        devs = devs.filter(d => d.kind === 'audiooutput');
        setDevices(devs);

        // Auto-request for chromium (works without user gesture sometimes, but not in Firefox)
        if (devs.length > 0 && !devs[0].label) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            devs = await navigator.mediaDevices.enumerateDevices();
            devs = devs.filter(d => d.kind === 'audiooutput');
            setDevices(devs);
          } catch(e) {}
        }
      } catch(e) {
        console.error("Error enumerating devices:", e);
      }
    };
    getDevices();
    refreshEngines(true);
  }, []);

  // The "User Identity / Active Character" section used to live here, along with
  // its own /api/chara/list + /api/chara/current fetches and a select handler.
  // Removed: the chat input block already has a full character selector (it
  // calls /api/chara/select itself), so this was a duplicate control — and two
  // API calls on every open of this modal.

  const requestAudioPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(tr => tr.stop());
      let devs = await navigator.mediaDevices.enumerateDevices();
      setDevices(devs.filter(d => d.kind === 'audiooutput'));
    } catch(e) {
      alert(t('settings.audio.permissionDenied') + e);
    }
  };

  const saveKeys = async () => {
    // Engine paths save alongside the keys so "Save Changes" means one thing.
    await Promise.all([
      fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keys)
      }),
      fetch('/api/tts/engines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: enginePaths })
      }),
    ]);
    // The User Identity editor is the one tab with its own validation — name
    // uniqueness, the "Anonymous" lock, fallback consistency — so it persists
    // itself rather than being part of this Promise.all. Bump the trigger so
    // it runs now, before the modal closes.
    userIdentitySaveTrigger.current += 1;
    onClose();
  };

  if (loading) return null;

  const inputCls = "w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none";

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-secondary/30 shrink-0">
          <h2 className="text-lg font-bold">{t('settings.title')}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
            <X size={20} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="px-6 pt-3 border-b border-border bg-secondary/10 shrink-0 flex gap-1">
          {TABS.map(tb => {
            const Icon = tb.icon;
            const active = tab === tb.id;
            return (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`px-3 py-2 text-xs font-semibold rounded-t-md flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
                  active
                    ? 'border-indigo-500 text-indigo-500 bg-background'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                <Icon size={14} /> {t(`settings.tab.${tb.id}`)}
              </button>
            );
          })}
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">

          {/* The "Context Management" section was moved per-folder (Folder
              Settings → Context Management) so each AI entity can have its
              own context window size, auto-trim policy, and identity-layer
              compression threshold. The fields now live in Sidebar.tsx
              under folder.settings.maxRecommendedContext /
              autoTrimCopiedMessages / maxTokensPerLayer. */}

          {/* The Appearance/Theme block used to live here. Removed because
              themes are now driven per-folder via Folder Settings → Theme
              (custom CSS), which makes a global light/dark toggle meaningless. */}

          {tab === 'keys' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
              <KeyRound size={16} /> {t('settings.keys.heading')}
            </h3>
            <div className="text-xs text-muted-foreground mb-2 leading-relaxed">
              <Tx k="settings.keys.intro" />
            </div>
            <div className="border border-border rounded-lg p-3 space-y-3 bg-muted/10">
              <label className="text-xs font-semibold text-foreground">{t('settings.keys.anthropic')}</label>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {t('settings.keys.claudeApi.label')}
                </label>
                <input
                  type="password"
                  placeholder="sk-ant-..."
                  value={keys.claude || ''}
                  onChange={e => setKeys({...keys, claude: e.target.value})}
                  className={inputCls}
                />
                <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                  <Tx k="settings.keys.claudeApi.help" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {t('settings.keys.claudeOauth.label')}
                </label>
                <input
                  type="password"
                  placeholder="sk-ant-oat01-..."
                  value={keys.claudeOAuthToken || ''}
                  onChange={e => setKeys({...keys, claudeOAuthToken: e.target.value})}
                  className={inputCls}
                />
                <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed space-y-1 bg-amber-500/5 border border-amber-500/30 rounded p-2">
                  <div className="font-semibold text-amber-600 dark:text-amber-400">{t('settings.keys.oauth.warn')}</div>
                  <div><Tx k="settings.keys.oauth.setup" /></div>
                  <div><Tx k="settings.keys.oauth.billing" /></div>
                  <div><Tx k="settings.keys.oauth.how" /></div>
                  <div><Tx k="settings.keys.oauth.risk" /></div>
                  <div><Tx k="settings.keys.oauth.tools" /></div>
                  <div><Tx k="settings.keys.oauth.other" /></div>
                </div>
              </div>
            </div>

            {SIMPLE_PROVIDERS.map(p => (
              <div key={p.id}>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  {t(`settings.keys.${p.id}.label`)}
                </label>
                <input
                  type="password"
                  placeholder={p.ph}
                  value={keys[p.id] || ''}
                  onChange={e => setKeys({ ...keys, [p.id]: e.target.value })}
                  className={inputCls}
                />
                {p.help && (
                  <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                    <Tx k={`settings.keys.${p.id}.help`} />
                  </div>
                )}
              </div>
            ))}
          </div>
          )}

          {tab === 'vrchat' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
                <Volume2 size={16} /> {t('settings.audio.heading')}
              </h3>
              {devices.length > 0 && !devices[0].label && (
                <button onClick={requestAudioPermission} className="text-[10px] bg-primary/20 text-primary px-2 py-1 rounded hover:bg-primary/30 transition">
                  {t('settings.audio.unlock')}
                </button>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('settings.audio.vrchatPath')}</label>
              <input
                type="text"
                placeholder="C:\Users\user\Pictures\VRChat"
                value={globalSettings.vrchatPath ?? 'C:\\Users\\user\\Pictures\\VRChat'}
                onChange={e => setGlobalSettings({...globalSettings, vrchatPath: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('settings.audio.device1')}</label>
              <select
                value={globalSettings.device1Id || ''}
                onChange={e => setGlobalSettings({...globalSettings, device1Id: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="">{t('settings.audio.device.system')}</option>
                {devices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.substring(0, 8)}`}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('settings.audio.device2')}</label>
              <select
                value={globalSettings.device2Id || ''}
                onChange={e => setGlobalSettings({...globalSettings, device2Id: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="">{t('settings.audio.device.none')}</option>
                {devices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.substring(0, 8)}`}</option>
                ))}
              </select>
            </div>

            <div className="pt-2 border-t border-border space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-foreground">{t('settings.engines.heading')}</h4>
                <button
                  onClick={() => refreshEngines()}
                  className="text-[10px] bg-muted px-2 py-1 rounded hover:bg-muted/70 transition text-muted-foreground"
                  title={t('settings.engines.refresh.title')}
                >
                  {t('settings.engines.refresh')}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                <Tx k="settings.engines.help" />
              </p>

              {[
                { key: 'voicevox',    label: 'VOICEVOX',    port: '50021', ph: 'C:\\path\\to\\VOICEVOX\\VOICEVOX.exe' },
                { key: 'coeiroink',   label: 'COEIROINK',   port: '50032', ph: 'C:\\path\\to\\COEIROINK\\COEIROINK.exe' },
                { key: 'aivisspeech', label: 'AivisSpeech', port: '10101', ph: 'C:\\path\\to\\AivisSpeech\\AivisSpeech.exe' },
              ].map(eng => {
                const st = engineStatus.find((s: any) => s.key === eng.key);
                const busy = engineBusy === eng.key;
                const running = !!st?.running;
                const configured = !!(enginePaths[eng.key] || '').trim();
                const btn = 'text-[10px] px-2 py-1 rounded transition disabled:opacity-35 disabled:cursor-not-allowed';
                return (
                  <div key={eng.key}>
                    <label className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-2 flex-wrap">
                      {eng.label}
                      <span className="font-mono text-[10px] opacity-60">:{eng.port}</span>
                      {st && (
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                            running
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {running ? t('settings.engines.running') : t('settings.engines.stopped')}
                        </span>
                      )}
                      <span className="flex-1" />
                      {/* Start needs a configured path; Stop finds the process by
                          port, so it works even for an engine Nexus didn't start.
                          Stop is withheld for a non-loopback engine — see
                          isLocalEngine in src/lib/ttsEngines.ts. */}
                      <button
                        onClick={() => engineAction(st?.engine ?? 0, eng.key, 'start')}
                        disabled={busy || running || !configured}
                        title={!configured
                          ? t('settings.engines.start.needPath')
                          : running
                            ? t('settings.engines.start.already')
                            : t('settings.engines.start.title')}
                        className={`${btn} bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25`}
                      >{t('settings.engines.start')}</button>
                      <button
                        onClick={() => engineAction(st?.engine ?? 0, eng.key, 'stop')}
                        disabled={busy || !running || (st && st.local === false)}
                        title={st && st.local === false
                          ? `${t('settings.engines.stop.remote')}${st.base}`
                          : t('settings.engines.stop.title')}
                        className={`${btn} bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25`}
                      >{t('settings.engines.stop')}</button>
                      <button
                        onClick={() => engineAction(st?.engine ?? 0, eng.key, 'restart')}
                        disabled={busy || !configured}
                        title={t('settings.engines.restart.title')}
                        className={`${btn} bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25`}
                      >{t('settings.engines.restart')}</button>
                    </label>
                    <input
                      type="text"
                      value={enginePaths[eng.key] ?? ''}
                      onChange={e => setEnginePaths({ ...enginePaths, [eng.key]: e.target.value })}
                      placeholder={eng.ph}
                      className={inputCls}
                    />
                    {engineMsg[eng.key] && (
                      <p className="text-[10px] text-muted-foreground mt-1 font-mono">{engineMsg[eng.key]}</p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── Add further VRChat / audio-routing settings below this line ── */}

          </div>
          )}

          {tab === 'identity' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
              <Users size={16} /> {t('useridentity.heading')}
            </h3>
            <UserIdentityEditor saveTrigger={userIdentitySaveTrigger} />
          </div>
          )}

          {tab === 'other' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
              <SlidersHorizontal size={16} /> {t('settings.other.heading')}
            </h3>
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.removeTimestamps ?? true}
                  onChange={e => setGlobalSettings({...globalSettings, removeTimestamps: e.target.checked})}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.removeTimestamps.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.removeTimestamps.help" />
              </p>
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.autoSplitVideos ?? true}
                  onChange={e => setGlobalSettings({...globalSettings, autoSplitVideos: e.target.checked})}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.autoSplitVideos.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.autoSplitVideos.help" />
              </p>
            </div>

            <div>
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.toolLimit.label')}</span>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={globalSettings.maxToolIterations ?? 40}
                  onChange={e => {
                    const n = parseInt(e.target.value, 10);
                    setGlobalSettings({
                      ...globalSettings,
                      maxToolIterations: Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 40,
                    });
                  }}
                  className="mt-1 w-28 px-2 py-1 rounded-md border border-border bg-background text-sm"
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.toolLimit.help" />
              </p>
            </div>

            <div>
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.language.label')}</span>
                <select
                  value={globalSettings.language ?? 'en'}
                  onChange={e => setGlobalSettings({ ...globalSettings, language: e.target.value })}
                  className="mt-1 w-40 px-2 py-1 rounded-md border border-border bg-background text-sm block"
                >
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.language.help" />
              </p>
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.saveTimestampsToMd ?? false}
                  onChange={e => setGlobalSettings({...globalSettings, saveTimestampsToMd: e.target.checked})}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.saveTimestampsToMd.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.saveTimestampsToMd.help" />
              </p>
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.customFilterEnabled ?? false}
                  onChange={e => setGlobalSettings({...globalSettings, customFilterEnabled: e.target.checked})}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.customFilter.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.customFilter.help" />
              </p>
              <div className="ml-6 mt-2 space-y-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('settings.customFilter.pattern')}</label>
                  <input
                    type="text"
                    value={globalSettings.customFilterPattern ?? ''}
                    onChange={e => setGlobalSettings({...globalSettings, customFilterPattern: e.target.value})}
                    placeholder={"e.g. \\[🔥[^\\]]*\\]"}
                    className={`${inputCls} disabled:opacity-50`}
                    disabled={!globalSettings.customFilterEnabled}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('settings.customFilter.replacement')}</label>
                  <input
                    type="text"
                    value={globalSettings.customFilterReplacement ?? ''}
                    onChange={e => setGlobalSettings({...globalSettings, customFilterReplacement: e.target.value})}
                    placeholder={t('settings.customFilter.replacement.ph')}
                    className={`${inputCls} disabled:opacity-50`}
                    disabled={!globalSettings.customFilterEnabled}
                  />
                </div>
              </div>
            </div>
          </div>
          )}

        </div>

        <div className="px-6 py-4 border-t border-border bg-secondary/30 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium rounded-lg hover:bg-muted transition-colors">
            {t('settings.cancel')}
          </button>
          <button onClick={saveKeys} className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center gap-2">
            <Save size={16} /> {t('settings.saveChanges')}
          </button>
        </div>
      </div>
    </div>
  );
}
