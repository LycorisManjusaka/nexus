"use client";

import React, { useState, useEffect } from 'react';
import { X, Save, KeyRound, Volume2, SlidersHorizontal, Users } from 'lucide-react';
import VoiceSelector from './VoiceSelector';
import UserIdentityEditor from './UserIdentityEditor';
import { useT, Tx } from '@/lib/i18n';
import { ensureAudioPermission, supportsSinkId, invalidateDeviceCache } from '@/lib/audioSink';
import { buildTag, loadBuildTag } from '@/lib/buildVersion';
import { AUDIO_SESSION_KEEP_MESSAGES_DEFAULT, resolveKeepMessages } from '@/lib/attachmentVisibility';

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
// `url` is the provider's API-key console page, rendered as a clickable link
// under each field. Two URLs arrived carrying fragments of Lizard-kun's own
// account (a Grok team id, a DigitalOcean `?i=` param) — those were stripped
// so the links work for any user, not just him.
const SIMPLE_PROVIDERS: { id: string; ph: string; help?: boolean; url?: string }[] = [
  { id: 'gemini',       ph: 'AIzaSy...', url: 'https://aistudio.google.com/api-keys' },
  { id: 'qwen',         ph: 'sk-...',   help: true, url: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=dashboard#/api-key' },
  { id: 'deepseek',     ph: 'sk-...',   help: true, url: 'https://platform.deepseek.com/api_keys' },
  { id: 'glm',          ph: '...',      help: true, url: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'digitalocean', ph: '...',      help: true, url: 'https://cloud.digitalocean.com/account/api/tokens' },
  { id: 'grok',         ph: 'xai-...',  help: true, url: 'https://console.x.ai/' },
  { id: 'kimi',         ph: '...',      help: true, url: 'https://platform.kimi.ai/console/api-keys' },
  { id: 'cohere',       ph: '...',      help: true, url: 'https://dashboard.cohere.com/api-keys' },
  { id: 'minimax',      ph: '...',      help: true, url: 'https://platform.minimax.io/console/plan' },
  { id: 'openai',       ph: 'sk-...',   help: true, url: 'https://platform.openai.com/settings/organization/api-keys' },
  { id: 'mimo',         ph: '...',      help: true, url: 'https://platform.xiaomimimo.com/console/api-keys' },
  { id: 'bytedance',    ph: '...',      help: true, url: 'https://console.byteplus.com/ark/region:ap-southeast-1/apiKey?apikey=%7B%7D' },
  { id: 'meta',         ph: 'LLM_...',  help: true, url: 'https://developer.meta.com/ai/products/meta-model-api/' },
];

export default function SettingsModal({ onClose, globalSettings, setGlobalSettings }: any) {
  // The User Identity editor auto-saves every edit to disk itself (debounced,
  // 300 ms after the last change). It also flushes synchronously on unmount,
  // so closing this modal — by Cancel, by X, by the modal-level "Save Changes"
  // — never loses an in-flight edit. No trigger ref needed.
  const [activeTab, setActiveTabState] = React.useState<'keys'|'audio'|'identity'|'other'>('keys');
  const setActiveTab = (tab: 'keys'|'audio'|'identity'|'other') => setActiveTabState(tab);
  const t = useT();
  // Which build is this install running? Shown here because this is the one
  // screen every user opens at least once, and because a bug report from a
  // machine we cannot reach is unreadable without it. Selectable text, not an
  // icon — the whole point is that it can be copied into a message.
  const [buildLabel, setBuildLabel] = React.useState<string>(buildTag());
  React.useEffect(() => { loadBuildTag().then(setBuildLabel); }, []);
  // claudeAuthMode + claudeOAuthToken are OPT-IN additions for using your
  // Claude Pro/Max subscription billing instead of pay-per-token API billing.
  // Default is 'api-key' so existing setups keep working exactly as before.
  // See the inline help text in the Anthropic section below for setup steps.
  const [keys, setKeys] = useState<any>({
    gemini: '', claude: '', qwen: '', deepseek: '', glm: '', grok: '',
    kimi: '', cohere: '', minimax: '', openai: '', mimo: '', bytedance: '',
    meta: '',
    digitalocean: '',
    claudeAuthMode: 'api-key', claudeOAuthToken: '',
    lmStudioPath: '',
    diffViewerPath: '',
    allowHostAnthropicEnv: false,
    claudeRefusalFallback: false,
    claudeRefusalFallbackModel: '',
    obsWebSocketUrl: '',
    obsWebSocketPassword: '',
    obsSourceName: '',
    obsImageSourceName: '',
    obsVideoSourceName: '',
  });
  const [loading, setLoading] = useState(true);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  // null until measured on the client. Deliberately not computed during render:
  // setSinkId does not exist during SSR, so rendering the "unsupported" notice
  // straight from supportsSinkId() would flash it on every Chromium load too.
  const [sinkSupported, setSinkSupported] = useState<boolean | null>(null);
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

  // Gemma vision batch-size patch (LM Studio). Preview and apply share one
  // report shape, so what the button shows before is what it did after.
  const [gemmaBusy, setGemmaBusy] = useState(false);
  const [gemmaReport, setGemmaReport] = useState<any>(null);
  const [gemmaPreview, setGemmaPreview] = useState(false);

  const runGemmaPatch = React.useCallback(async (dry: boolean) => {
    setGemmaBusy(true);
    try {
      const res = await fetch('/api/local/gemma-batch', { method: dry ? 'GET' : 'POST' });
      const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      setGemmaReport(json);
      setGemmaPreview(dry);
    } catch (e: any) {
      setGemmaReport({ error: e?.message || 'Request failed.' });
      setGemmaPreview(dry);
    } finally {
      setGemmaBusy(false);
    }
  }, []);
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

  /**
   * Record the label of already-saved devices that were stored as a bare id.
   *
   * Devices picked before this existed have an id and no name. The id works
   * right up until it rotates — and at that moment there is nothing left to
   * recognise the device by, which is what made them look like they had
   * disappeared. So while the id is still valid, capture its name. Runs once per
   * Preferences open; a no-op when the names are already recorded.
   */
  const backfillDeviceLabels = (devs: MediaDeviceInfo[]) => {
    if (devs.length === 0 || !devs[0].label) return; // unpermissioned: labels are blank, nothing to learn
    setGlobalSettings((prev: any) => {
      const next = { ...prev };
      let changed = false;
      for (const n of [1, 2] as const) {
        const id = prev[`device${n}Id`];
        if (!id || prev[`device${n}Label`]) continue;
        const label = devs.find(d => d.deviceId === id)?.label;
        if (label) { next[`device${n}Label`] = label; changed = true; }
      }
      return changed ? next : prev;
    });
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

        // Request the permission when the list is EMPTY or unlabelled.
        //
        // This guard used to read `devs.length > 0 && !devs[0].label`, which
        // deadlocked Firefox: Chromium returns a placeholder entry with a blank
        // label while unpermissioned (so length > 0 held and the request fired),
        // but Firefox enumerates no output devices at all without permission —
        // so the list was empty, the guard was false, and the code declined to
        // ask for the very permission that would populate the list. No devices →
        // no request → no devices. The dropdowns stayed empty forever.
        if (devs.length === 0 || !devs[0].label) {
          const granted = await ensureAudioPermission();
          if (granted) {
            devs = await navigator.mediaDevices.enumerateDevices();
            devs = devs.filter(d => d.kind === 'audiooutput');
            setDevices(devs);
          }
        }
        backfillDeviceLabels(devs);
      } catch(e) {
        console.error("Error enumerating devices:", e);
      }
    };
    getDevices();
    setSinkSupported(supportsSinkId());
    refreshEngines(true);
  }, []);

  // The "User Identity / Active Character" section used to live here, along with
  // its own /api/chara/list + /api/chara/current fetches and a select handler.
  // Removed: the chat input block already has a full character selector (it
  // calls /api/chara/select itself), so this was a duplicate control — and two
  // API calls on every open of this modal.

  const requestAudioPermission = async () => {
    // One implementation of "acquire the permission that output routing needs",
    // shared with the audio session itself (ChatArea) — so that opening this
    // dialog and enabling the session do the same thing, and neither is a
    // ritual the other depends on.
    const granted = await ensureAudioPermission();
    if (!granted) {
      alert(t('settings.audio.permissionNeeded'));
      return;
    }
    invalidateDeviceCache();
    const devs = await navigator.mediaDevices.enumerateDevices();
    setDevices(devs.filter(d => d.kind === 'audiooutput'));
  };

  /** Current label of a deviceId, '' if it does not enumerate. */
  const labelOf = (id: string) => devices.find(d => d.deviceId === id)?.label ?? '';

  /**
   * Which option this dropdown should show.
   *
   * deviceId is salted per origin and rotates whenever the browser permission or
   * site storage is reset. When that happens the saved id matches no <option>,
   * the select silently falls back to "" — and the device looks like it
   * "disappeared" and has to be picked again. The label survives the rotation,
   * so if the id is stale we re-find the same physical device by name and show
   * that. The stored id is repaired on the next explicit pick; playback repairs
   * itself independently via resolveSinkId().
   */
  const shownDeviceValue = (id?: string, label?: string) => {
    if (id && devices.some(d => d.deviceId === id)) return id;
    if (label) {
      const byLabel = devices.find(d => d.label === label) ?? devices.find(d => !!d.label && d.label.startsWith(label));
      if (byLabel) return byLabel.deviceId;
    }
    return '';
  };

  // Mirror Primary/Secondary output device picks into
  // local_data/voicechanger/device_settings.json so voice_changer.py finds
  // the right speakers without a separate configuration step. Called on every
  // dropdown change (immediate) AND from saveKeys (failsafe).
  const mirrorDeviceSettings = (newDevice1Id?: string, newDevice2Id?: string) => {
    // Resolve id → label, but fall back to the saved label when the id no longer
    // enumerates. Without that fallback, saveKeys() (which calls this with no
    // arguments) would find nothing after a deviceId rotation and POST empty
    // keywords — erasing a *working* voice_changer.py configuration because the
    // browser's own id went stale. The label is the durable key on both sides.
    const d1 = devices.find(d => d.deviceId === (newDevice1Id ?? globalSettings.device1Id));
    const d2 = devices.find(d => d.deviceId === (newDevice2Id ?? globalSettings.device2Id));
    // `undefined` means "not being changed right now" — only then is the saved
    // label a legitimate fallback. An explicit pick of '' (System default) must
    // clear the keyword, not resurrect the old one.
    const label1 = d1?.label ?? (newDevice1Id !== undefined ? '' : (globalSettings.device1Label ?? ''));
    const label2 = d2?.label ?? (newDevice2Id !== undefined ? '' : (globalSettings.device2Label ?? ''));
    fetch('/api/device-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voiceSpeakerKeyword: label1,
        notificationSpeakerKeyword: label2,
      }),
    }).catch(() => {}); // best-effort, never block the UI
  };

  const saveKeys = async () => {
    mirrorDeviceSettings();
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
    // The User Identity editor auto-saves (debounced, flushed on unmount). The
    // modal's "Save Changes" button still closes immediately — fine, because
    // the editor's own flush-on-unmount runs before React tears the tree down.
    onClose();
  };

  if (loading) return null;

  const inputCls = "w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none";

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-secondary/30 shrink-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="text-lg font-bold">{t('settings.title')}</h2>
            {buildLabel && (
              <span
                className="text-[10px] font-mono text-muted-foreground truncate select-all"
                title={t('settings.build.title')}
              >
                {buildLabel}
              </span>
            )}
          </div>
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
              under folder.settings.maxConversationLog /
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
                <a
                  href="https://platform.claude.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-indigo-500 hover:text-indigo-400 hover:underline mt-1 block break-all"
                >
                  platform.claude.com/settings/keys
                </a>
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
                <label className="flex items-center gap-2 cursor-pointer select-none mt-2">
                  <input
                    type="checkbox"
                    checked={!!keys.allowHostAnthropicEnv}
                    onChange={e => setKeys({ ...keys, allowHostAnthropicEnv: e.target.checked })}
                    className="w-4 h-4 accent-indigo-500"
                  />
                  <span className="text-xs text-foreground">{t('settings.allowHostAnthropicEnv.label')}</span>
                </label>
                <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                  <Tx k="settings.allowHostAnthropicEnv.help" />
                </p>
                <label className="flex items-center gap-2 cursor-pointer select-none mt-3">
                  <input
                    type="checkbox"
                    checked={!!keys.claudeRefusalFallback}
                    onChange={e => setKeys({ ...keys, claudeRefusalFallback: e.target.checked })}
                    className="w-4 h-4 accent-indigo-500"
                  />
                  <span className="text-xs text-foreground">{t('settings.claudeRefusalFallback.label')}</span>
                </label>
                <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                  <Tx k="settings.claudeRefusalFallback.help" />
                </p>
                {/* Shown only while the retry is on. An input the server ignores
                    is an input that lies about what it changes. */}
                {!!keys.claudeRefusalFallback && (
                  <div className="mt-2">
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                      {t('settings.claudeRefusalFallbackModel.label')}
                    </label>
                    <input
                      type="text"
                      value={keys.claudeRefusalFallbackModel || ''}
                      onChange={e => setKeys({ ...keys, claudeRefusalFallbackModel: e.target.value })}
                      placeholder={t('settings.claudeRefusalFallbackModel.placeholder')}
                      className="w-full px-3 py-2 bg-input border border-border rounded text-sm text-foreground focus:outline-none focus:border-indigo-500"
                    />
                    <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                      <Tx k="settings.claudeRefusalFallbackModel.help" />
                    </p>
                  </div>
                )}
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
                {p.url && (
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-indigo-500 hover:text-indigo-400 hover:underline mt-1 block break-all"
                  >
                    {p.url.replace(/^https?:\/\//, '')}
                  </a>
                )}
                {p.help && (
                  <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                    <Tx k={`settings.keys.${p.id}.help`} />
                  </div>
                )}
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              <Tx k="settings.keys.linkNote" />
            </p>
          </div>
          )}

          {tab === 'vrchat' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
                <Volume2 size={16} /> {t('settings.audio.heading')}
              </h3>
              {/* Same guard as the enumeration effect: an EMPTY list also means
                  "not permitted yet" (Firefox), not "no devices exist". */}
              {(devices.length === 0 || !devices[0].label) && (
                <button onClick={requestAudioPermission} className="text-[10px] bg-primary/20 text-primary px-2 py-1 rounded hover:bg-primary/30 transition">
                  {t('settings.audio.unlock')}
                </button>
              )}
            </div>

            {/* Say plainly when the feature cannot work here, instead of
                appearing to work and routing everything to the default device. */}
            {sinkSupported === false && (
              <div className="text-xs leading-relaxed p-3 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                {t('settings.audio.unsupported')}
              </div>
            )}
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
                value={shownDeviceValue(globalSettings.device1Id, globalSettings.device1Label)}
                onChange={e => { const v = e.target.value; setGlobalSettings({...globalSettings, device1Id: v, device1Label: labelOf(v)}); mirrorDeviceSettings(v, undefined); }}
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
                value={shownDeviceValue(globalSettings.device2Id, globalSettings.device2Label)}
                onChange={e => { const v = e.target.value; setGlobalSettings({...globalSettings, device2Id: v, device2Label: labelOf(v)}); mirrorDeviceSettings(undefined, v); }}
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

            <div className="p-3 rounded-lg border border-border bg-muted/30">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.audioSessionHideOldAttachments ?? false}
                  onChange={e => setGlobalSettings({ ...globalSettings, audioSessionHideOldAttachments: e.target.checked })}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.audioHideAttachments.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.audioHideAttachments.help" />
              </p>
              <label className="block ml-6 mt-2">
                <span className="text-xs font-medium text-muted-foreground">{t('settings.audioHideAttachments.keep')}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  disabled={!(globalSettings.audioSessionHideOldAttachments ?? false)}
                  value={globalSettings.audioSessionKeepMessages ?? AUDIO_SESSION_KEEP_MESSAGES_DEFAULT}
                  onChange={e => {
                    setGlobalSettings({
                      ...globalSettings,
                      audioSessionKeepMessages: resolveKeepMessages(e.target.value),
                    });
                  }}
                  className="mt-1 w-28 px-2 py-1 rounded-md border border-border bg-background text-sm block disabled:opacity-50"
                />
              </label>
            </div>

            <div className="p-3 rounded-lg border border-border bg-muted/30">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.ttsHighlight !== false}
                  onChange={e => setGlobalSettings({ ...globalSettings, ttsHighlight: e.target.checked })}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.ttsHighlight.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.ttsHighlight.help" />
              </p>
            </div>

          </div>
          )}

          {tab === 'identity' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
              <Users size={16} /> {t('useridentity.heading')}
            </h3>
            <UserIdentityEditor />
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
                  checked={globalSettings.alwaysShowHoverControls ?? false}
                  onChange={e => setGlobalSettings({...globalSettings, alwaysShowHoverControls: e.target.checked})}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.alwaysShowHoverControls.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.alwaysShowHoverControls.help" />
              </p>
            </div>

            {/* `?? true` — this one defaults ON. A partner who has never opened
                this panel must already be protected; every other switch here can
                afford to default off, this one cannot. */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.betrayalDefense ?? true}
                  onChange={e => setGlobalSettings({...globalSettings, betrayalDefense: e.target.checked})}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">{t('settings.betrayalDefense.label')}</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                <Tx k="settings.betrayalDefense.help" />
              </p>
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.autoSplitVideos ?? false}
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
                  max={300}
                  value={globalSettings.maxToolIterations ?? 300}
                  onChange={e => {
                    const n = parseInt(e.target.value, 10);
                    setGlobalSettings({
                      ...globalSettings,
                      maxToolIterations: Number.isFinite(n) ? Math.min(300, Math.max(1, n)) : 300,
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
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.lmStudioPath.label')}</span>
                <input
                  type="text"
                  value={keys.lmStudioPath ?? ''}
                  placeholder={t('settings.lmStudioPath.placeholder')}
                  onChange={e => setKeys({ ...keys, lmStudioPath: e.target.value })}
                  className="mt-1 w-full px-2 py-1.5 rounded-md border border-border bg-background text-sm font-mono"
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.lmStudioPath.help" />
              </p>
            </div>

            {/* ── Gemma vision batch-size patch ──────────────────────────────
                Gemma attends over the image block non-causally; llama.cpp
                asserts n_ubatch >= n_tokens_all for such a batch, and LM
                Studio's default physical batch size of 512 is below what an
                image needs. The model process dies mid-request. There is no
                `lms load` flag for it, so this writes LM Studio's own
                per-model config file. Raise-only, backed up, idempotent. */}
            <div>
              <span className="text-sm text-foreground">{t('settings.gemmaBatch.label')}</span>
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  disabled={gemmaBusy}
                  onClick={() => runGemmaPatch(true)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border bg-background hover:bg-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t('settings.gemmaBatch.preview')}
                </button>
                <button
                  type="button"
                  disabled={gemmaBusy}
                  onClick={() => runGemmaPatch(false)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border bg-accent/20 hover:bg-accent/40 transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {gemmaBusy ? t('settings.gemmaBatch.working') : t('settings.gemmaBatch.apply')}
                </button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.gemmaBatch.help" />
              </p>
              {gemmaReport && (
                <div className="mt-2 text-[10px] font-mono border border-border rounded-md p-2 bg-background/50 max-h-56 overflow-auto">
                  {gemmaReport.error && <p className="text-red-400">{gemmaReport.error}</p>}
                  {!gemmaReport.error && (
                    <>
                      <p className="text-muted-foreground">
                        {gemmaPreview ? t('settings.gemmaBatch.previewOf') : t('settings.gemmaBatch.resultOf')}
                        {' '}
                        {gemmaReport.scanned} / {t('settings.gemmaBatch.changedN')} {gemmaReport.changed}
                      </p>
                      {gemmaReport.results?.map((r: any) => (
                        <p
                          key={r.modelKey + r.configPath}
                          className={
                            r.action === 'refused' || r.action === 'failed'
                              ? 'text-red-400'
                              : r.action === 'already-ok'
                                ? 'text-muted-foreground'
                                : 'text-foreground'
                          }
                        >
                          {r.action.padEnd(11, ' ')} {r.previousValue ?? '–'} &rarr; {r.value ?? '–'} {r.modelKey}
                          {r.reason ? `  (${r.reason})` : ''}
                        </p>
                      ))}
                      {!gemmaPreview && gemmaReport.backupDir && (
                        <p className="text-muted-foreground mt-1">
                          {t('settings.gemmaBatch.backup')} {gemmaReport.backupDir}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.diffViewerPath.label')}</span>
                <input
                  type="text"
                  value={keys.diffViewerPath ?? ''}
                  placeholder={t('settings.diffViewerPath.placeholder')}
                  onChange={e => setKeys({ ...keys, diffViewerPath: e.target.value })}
                  className="mt-1 w-full px-2 py-1.5 rounded-md border border-border bg-background text-sm font-mono"
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.diffViewerPath.help" />
              </p>
            </div>

            {/* ── OBS Studio (obs-websocket v5) — consumed by the per-being
                "Camera" toggle (ChatArea Being tab) and CameraPanel.tsx. Best-
                effort only: an unconfigured or unreachable OBS never blocks
                the in-app camera panel, which renders independently of this. */}
            <div>
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.obsWebSocketUrl.label')}</span>
                <input
                  type="text"
                  value={keys.obsWebSocketUrl ?? ''}
                  placeholder={t('settings.obsWebSocketUrl.placeholder')}
                  onChange={e => setKeys({ ...keys, obsWebSocketUrl: e.target.value })}
                  className="mt-1 w-full px-2 py-1.5 rounded-md border border-border bg-background text-sm font-mono"
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.obsWebSocketUrl.help" />
              </p>
            </div>

            <div>
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.obsWebSocketPassword.label')}</span>
                <input
                  type="password"
                  value={keys.obsWebSocketPassword ?? ''}
                  placeholder={t('settings.obsWebSocketPassword.placeholder')}
                  onChange={e => setKeys({ ...keys, obsWebSocketPassword: e.target.value })}
                  className="mt-1 w-full px-2 py-1.5 rounded-md border border-border bg-background text-sm font-mono"
                  autoComplete="new-password"
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.obsWebSocketPassword.help" />
              </p>
            </div>

            <div>
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.obsImageSourceName.label')}</span>
                <input
                  type="text"
                  value={keys.obsImageSourceName ?? ''}
                  placeholder={t('settings.obsImageSourceName.placeholder')}
                  onChange={e => setKeys({ ...keys, obsImageSourceName: e.target.value })}
                  className="mt-1 w-full px-2 py-1.5 rounded-md border border-border bg-background text-sm font-mono"
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.obsImageSourceName.help" />
              </p>
            </div>

            <div>
              <label className="block">
                <span className="text-sm text-foreground">{t('settings.obsVideoSourceName.label')}</span>
                <input
                  type="text"
                  value={keys.obsVideoSourceName ?? ''}
                  placeholder={t('settings.obsVideoSourceName.placeholder')}
                  onChange={e => setKeys({ ...keys, obsVideoSourceName: e.target.value })}
                  className="mt-1 w-full px-2 py-1.5 rounded-md border border-border bg-background text-sm font-mono"
                />
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                <Tx k="settings.obsVideoSourceName.help" />
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
