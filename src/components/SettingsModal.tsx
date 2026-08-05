"use client";

import React, { useState, useEffect } from 'react';
import { X, Save, KeyRound, Volume2, SlidersHorizontal } from 'lucide-react';
import VoiceSelector from './VoiceSelector';

// Preferences is split into tabs because the three groups have nothing to do
// with each other and the API-key list alone is twelve providers long. Add a
// new tab by extending this list and adding a matching `{tab === '...' && (…)}`
// block in the body.
const TABS = [
  { id: 'keys',   label: 'API Keys',       icon: KeyRound },
  { id: 'vrchat', label: 'VRChat & Audio', icon: Volume2 },
  { id: 'other',  label: 'Other',          icon: SlidersHorizontal },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function SettingsModal({ onClose, globalSettings, setGlobalSettings }: any) {
  // claudeAuthMode + claudeOAuthToken are OPT-IN additions for using your
  // Claude Pro/Max subscription billing instead of pay-per-token API billing.
  // Default is 'api-key' so existing setups keep working exactly as before.
  // See the inline help text in the Anthropic section below for setup steps.
  const [keys, setKeys] = useState<any>({
    gemini: '', claude: '', qwen: '', deepseek: '', glm: '', grok: '',
    kimi: '', cohere: '', minimax: '', openai: '', mimo: '', bytedance: '',
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
    setEngineMsg(prev => ({ ...prev, [key]: action === 'stop' ? 'stopping…' : 'starting…' }));
    try {
      const d = await fetch('/api/tts/engines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, engine }),
      }).then(r => r.json());
      setEngineMsg(prev => ({ ...prev, [key]: d?.message || (d?.ok ? 'done' : 'failed') }));
      // Only a launch needs the boot poll; a stop has already been confirmed.
      if (d?.ok && action !== 'stop') pollEngines();
    } catch (e: any) {
      setEngineMsg(prev => ({ ...prev, [key]: e?.message || 'request failed' }));
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
      stream.getTracks().forEach(t => t.stop());
      let devs = await navigator.mediaDevices.enumerateDevices();
      setDevices(devs.filter(d => d.kind === 'audiooutput'));
    } catch(e) {
      alert("Permission denied or error: " + e);
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
    onClose();
  };

  if (loading) return null;

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-secondary/30 shrink-0">
          <h2 className="text-lg font-bold">Preferences</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
            <X size={20} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="px-6 pt-3 border-b border-border bg-secondary/10 shrink-0 flex gap-1">
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-xs font-semibold rounded-t-md flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${
                  active
                    ? 'border-indigo-500 text-indigo-500 bg-background'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                <Icon size={14} /> {t.label}
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
              <KeyRound size={16} /> API Keys
            </h3>
            <div className="text-xs text-muted-foreground mb-2 leading-relaxed">
              Keys are saved locally in the <code className="bg-muted px-1 rounded">local_data</code> folder and never sent anywhere except the official APIs.
            </div>
            <div className="border border-border rounded-lg p-3 space-y-3 bg-muted/10">
              <label className="text-xs font-semibold text-foreground">Anthropic (Claude)</label>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Token-paid API Key <span className="font-normal">(pay per token)</span>
                </label>
                <input
                  type="password"
                  placeholder="sk-ant-..."
                  value={keys.claude || ''}
                  onChange={e => setKeys({...keys, claude: e.target.value})}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                  From <span className="font-mono">console.anthropic.com</span> → API Keys. Charged per token sent/received. Billing mode per conversation is chosen in System Instructions → Model tab.
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Monthly-paid OAuth Token <span className="font-normal">(Pro / Max subscription)</span>
                </label>
                <input
                  type="password"
                  placeholder="sk-ant-oat01-..."
                  value={keys.claudeOAuthToken || ''}
                  onChange={e => setKeys({...keys, claudeOAuthToken: e.target.value})}
                  className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed space-y-1 bg-amber-500/5 border border-amber-500/30 rounded p-2">
                  <div className="font-semibold text-amber-600 dark:text-amber-400">⚠️ Experimental — read carefully</div>
                  <div><strong>Setup:</strong> Run <code className="font-mono bg-muted px-1 rounded">npm install -g @anthropic-ai/claude-code</code> then <code className="font-mono bg-muted px-1 rounded">claude setup-token</code>. Paste the resulting <code>sk-ant-oat01-…</code> token here. Token is valid 1 year.</div>
                  <div><strong>Billing:</strong> Uses your Pro/Max subscription credit, NOT pay-per-token API. Pro = $20/mo credit, Max 5x = $100, Max 20x = $200.</div>
                  <div><strong>How it works:</strong> NEXUS uses the Claude Agent SDK, which spawns the official Claude Code binary under the hood. Conversations use Anthropic-side session resume to preserve role semantics.</div>
                  <div><strong>Risk:</strong> Account ban is possible (gray-zone use of OAuth tokens). Probability low for solo use; not zero.</div>
                  <div><strong>Workspace tools (when Tool Use is ON):</strong> Claude Code's <code>Read</code> / <code>Write</code> / <code>Edit</code> / <code>Glob</code> / <code>Grep</code> are sandboxed to <code className="font-mono">local_data/agent_workspaces/&lt;folder&gt;/</code>. Shell/network/subagent tools always disabled.</div>
                  <div><strong>Other limitations:</strong> creativity-control disabled; extended thinking uses adaptive mode by default.</div>
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Google (Gemini) API Key</label>
              <input
                type="password"
                placeholder="AIzaSy..."
                value={keys.gemini || ''}
                onChange={e => setKeys({...keys, gemini: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Alibaba (Qwen / DashScope) API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                value={keys.qwen || ''}
                onChange={e => setKeys({...keys, qwen: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at Alibaba Cloud Model Studio. Used for Qwen 3.6 Plus / 3.6 Max / 3.7 Max and DeepSeek V3.2 via the OpenAI-compatible DashScope endpoint.
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">DeepSeek API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                value={keys.deepseek || ''}
                onChange={e => setKeys({...keys, deepseek: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">platform.deepseek.com</span>. Required for DeepSeek V4 Pro / V4 Flash and the legacy <span className="font-mono">deepseek-chat</span> / <span className="font-mono">deepseek-reasoner</span> aliases. Globally accessible — no regional restrictions.
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Z.AI (GLM) API Key</label>
              <input
                type="password"
                placeholder="..."
                value={keys.glm || ''}
                onChange={e => setKeys({...keys, glm: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">z.ai</span> → API Console. Required for the GLM family (GLM-5.2 / GLM-5.1 / GLM-5 / GLM-4.7 / GLM-4.6 / GLM-4.6V / GLM-4.5 Air).
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">xAI (Grok) API Key</label>
              <input
                type="password"
                placeholder="xai-..."
                value={keys.grok || ''}
                onChange={e => setKeys({...keys, grok: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">console.x.ai</span>. Required for the Grok family (Grok 4.3, Grok 4.20 reasoning / non-reasoning, Grok Code Fast 1, etc.).
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Kimi (Moonshot) API Key</label>
              <input
                type="password"
                placeholder="..."
                value={keys.kimi || ''}
                onChange={e => setKeys({...keys, kimi: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Moonshot's first-party Kimi API (<span className="font-mono">platform.kimi.ai</span> → Console → API Keys; endpoint <span className="font-mono">api.moonshot.ai/v1</span>). Use the international platform, not the <span className="font-mono">.cn</span> one.
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Cohere API Key</label>
              <input
                type="password"
                placeholder="..."
                value={keys.cohere || ''}
                onChange={e => setKeys({...keys, cohere: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">dashboard.cohere.com</span>. Required for the Command A family (Command A Plus, Command A Reasoning, Command A Vision).
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">MiniMax API Key</label>
              <input
                type="password"
                placeholder="..."
                value={keys.minimax || ''}
                onChange={e => setKeys({...keys, minimax: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">platform.minimax.io</span>. Required for the MiniMax M2.7 model.
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">OpenAI API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                value={keys.openai || ''}
                onChange={e => setKeys({...keys, openai: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">platform.openai.com</span>. Required for the ChatGPT (GPT-5) family — GPT-5.6 Sol / Terra / Luna, GPT-5.5, GPT-5.4, GPT-5.4 Mini.
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">MiMo (Xiaomi) API Key</label>
              <input
                type="password"
                placeholder="..."
                value={keys.mimo || ''}
                onChange={e => setKeys({...keys, mimo: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">api.xiaomimimo.com</span>. Required for the Xiaomi MiMo family — MiMo V2.5 Pro, MiMo V2.5.
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">ByteDance / BytePlus API Key</label>
              <input
                type="password"
                placeholder="..."
                value={keys.bytedance || ''}
                onChange={e => setKeys({...keys, bytedance: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
              />
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Get one at <span className="font-mono">console.byteplus.com</span> (BytePlus ModelArk). Required for the ByteDance Seed family — Seed 2.0 Pro / Lite / Mini / Code.
              </div>
            </div>
          </div>
          )}

          {tab === 'vrchat' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
                <Volume2 size={16} /> VRChat & Audio Routing
              </h3>
              {devices.length > 0 && !devices[0].label && (
                <button onClick={requestAudioPermission} className="text-[10px] bg-primary/20 text-primary px-2 py-1 rounded hover:bg-primary/30 transition">
                  Unlock Devices (Firefox)
                </button>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">VRChat Pictures Folder Path</label>
              <input 
                type="text" 
                placeholder="C:\Users\user\Pictures\VRChat"
                value={globalSettings.vrchatPath ?? 'C:\\Users\\user\\Pictures\\VRChat'}
                onChange={e => setGlobalSettings({...globalSettings, vrchatPath: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Primary Audio Output Device</label>
              <select 
                value={globalSettings.device1Id || ''}
                onChange={e => setGlobalSettings({...globalSettings, device1Id: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="">Default System Device</option>
                {devices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.substring(0, 8)}`}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Secondary Audio Output Device</label>
              <select 
                value={globalSettings.device2Id || ''}
                onChange={e => setGlobalSettings({...globalSettings, device2Id: e.target.value})}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="">None</option>
                {devices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || `Device ${d.deviceId.substring(0, 8)}`}</option>
                ))}
              </select>
            </div>

            <div className="pt-2 border-t border-border space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-foreground">TTS Engine Executables</h4>
                <button
                  onClick={() => refreshEngines()}
                  className="text-[10px] bg-muted px-2 py-1 rounded hover:bg-muted/70 transition text-muted-foreground"
                  title="Re-check which engines are currently running"
                >
                  Refresh status
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Full path to each engine&apos;s <code>.exe</code>. When TTS needs an engine that isn&apos;t
                running, Nexus starts it automatically and waits for it to finish loading.
                Leave a field empty to disable auto-start for that engine.
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
                          {running ? 'running' : 'stopped'}
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
                        title={!configured ? 'Set the executable path first' : running ? 'Already running' : 'Launch this engine'}
                        className={`${btn} bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25`}
                      >Start</button>
                      <button
                        onClick={() => engineAction(st?.engine ?? 0, eng.key, 'stop')}
                        disabled={busy || !running || (st && st.local === false)}
                        title={st && st.local === false
                          ? `Configured at ${st.base} — Nexus only stops engines on this machine`
                          : 'Kill whatever is listening on this port'}
                        className={`${btn} bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25`}
                      >Stop</button>
                      <button
                        onClick={() => engineAction(st?.engine ?? 0, eng.key, 'restart')}
                        disabled={busy || !configured}
                        title="Stop, wait for the port to be released, then start again — use this after installing new voices"
                        className={`${btn} bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25`}
                      >Restart</button>
                    </label>
                    <input
                      type="text"
                      value={enginePaths[eng.key] ?? ''}
                      onChange={e => setEnginePaths({ ...enginePaths, [eng.key]: e.target.value })}
                      placeholder={eng.ph}
                      className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
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

          {tab === 'other' && (
          <div className="space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
              <SlidersHorizontal size={16} /> Other
            </h3>
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={globalSettings.removeTimestamps ?? true}
                  onChange={e => setGlobalSettings({...globalSettings, removeTimestamps: e.target.checked})}
                  className="w-4 h-4 accent-indigo-500"
                />
                <span className="text-sm text-foreground">Remove timestamps from new AI messages</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Automatically strips leading <code>[YYYY-MM-DD HH:MM:SS]</code> stacks that models echo at the start of a reply.
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
                <span className="text-sm text-foreground">Auto-split large videos</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Videos whose base64 size exceeds 20&nbsp;MiB are re-encoded server-side at <code>-crf 28</code>; if still oversize they&apos;re split into <code>&lt;name&gt;_part1.mp4</code>, <code>_part2.mp4</code>, … each under the provider cap. Requires <code>ffmpeg</code> on the machine.
              </p>
            </div>

            <div>
              <label className="block">
                <span className="text-sm text-foreground">Tool-call limit per turn</span>
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
                How many rounds of tool use one turn may take before NEXUS stops it. Each round is one
                model call, so a task that reads a file, edits it, then runs a test uses three. Real work
                often needs 20 or more; the old fixed limit of 8 cut those off silently. Raise it if long
                tasks stop early, lower it to cap spending. A separate guard stops a model that repeats the
                same call over and over, so this number does not have to be tight to be safe. Does not apply
                to Claude OAuth — Claude Code runs its own loop.
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
                <span className="text-sm text-foreground">Save timestamps to .md</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                When exporting a conversation to Markdown, writes each message&apos;s <code>[YYYY-MM-DD HH:MM:SS]</code> time under its <code>## Name</code> header. Importing always reads a timestamp back into the message (independent of this toggle) and strips it from the text.
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
                <span className="text-sm text-foreground">Custom regex filter on new AI messages</span>
              </label>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                When enabled, every match of the pattern below is replaced (deleted if the replacement is empty) in AI output as it streams — same mechanism as timestamp removal, so it also never reaches TTS.
              </p>
              <div className="ml-6 mt-2 space-y-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Pattern (regex — what to replace)</label>
                  <input
                    type="text"
                    value={globalSettings.customFilterPattern ?? ''}
                    onChange={e => setGlobalSettings({...globalSettings, customFilterPattern: e.target.value})}
                    placeholder={"e.g. \\[🔥[^\\]]*\\]"}
                    className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50"
                    disabled={!globalSettings.customFilterEnabled}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Replacement (target — leave empty to delete)</label>
                  <input
                    type="text"
                    value={globalSettings.customFilterReplacement ?? ''}
                    onChange={e => setGlobalSettings({...globalSettings, customFilterReplacement: e.target.value})}
                    placeholder="(empty)"
                    className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50"
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
            Cancel
          </button>
          <button onClick={saveKeys} className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center gap-2">
            <Save size={16} /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
