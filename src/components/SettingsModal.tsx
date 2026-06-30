"use client";

import React, { useState, useEffect } from 'react';
import { X, Save, KeyRound, Volume2, User } from 'lucide-react';
import VoiceSelector from './VoiceSelector';

export default function SettingsModal({ onClose, globalSettings, setGlobalSettings }: any) {
  // claudeAuthMode + claudeOAuthToken are OPT-IN additions for using your
  // Claude Pro/Max subscription billing instead of pay-per-token API billing.
  // Default is 'api-key' so existing setups keep working exactly as before.
  // See the inline help text in the Anthropic section below for setup steps.
  const [keys, setKeys] = useState<any>({
    gemini: '', claude: '', qwen: '', deepseek: '', glm: '', grok: '',
    kimi: '', cohere: '', minimax: '', openai: '', mimo: '',
    claudeAuthMode: 'api-key', claudeOAuthToken: '',
  });
  const [loading, setLoading] = useState(true);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [charaList, setCharaList] = useState<{ name: string; engine: string; charId: string }[]>([]);
  const [currentChara, setCurrentChara] = useState<string>('');
  const [charaError, setCharaError] = useState<string | null>(null);

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
  }, []);

  // Load the list of characters from character_map.json + the currently active one
  useEffect(() => {
    Promise.all([
      fetch('/api/chara/list').then(r => r.json()).catch(() => ({ characters: [] })),
      fetch('/api/chara/current').then(r => r.json()).catch(() => ({})),
    ]).then(([list, current]) => {
      setCharaList(list?.characters || []);
      if (current?.name) setCurrentChara(current.name);
      if (list?.error) setCharaError(list.error);
    });
  }, []);

  const handleCharaSelect = async (newName: string) => {
    if (!newName) return;
    setCurrentChara(newName);  // optimistic
    setCharaError(null);
    try {
      const r = await fetch('/api/chara/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // Tell the rest of the app (specifically InputArea) to refresh now
      // instead of waiting for its 30-second poll cycle.
      window.dispatchEvent(new CustomEvent('nx-chara-changed', { detail: { name: newName } }));
    } catch (e: any) {
      setCharaError(e.message || 'Failed to switch character');
    }
  };

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
    await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keys)
    });
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

        <div className="p-6 space-y-6 overflow-y-auto">

          <div className="space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2 text-indigo-500">
              <User size={16} /> User Identity
            </h3>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Active Character</label>
              <select
                value={currentChara}
                onChange={(e) => handleCharaSelect(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                {charaList.length === 0 && (
                  <option value="">— no characters in character_map.json —</option>
                )}
                {/* Allow keeping a selection that no longer exists in the map */}
                {currentChara && !charaList.some(c => c.name === currentChara) && (
                  <option value={currentChara}>{currentChara} (not in map)</option>
                )}
                {charaList.map(c => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.engine === '0' ? 'voicevox' : c.engine === '1' ? 'coeiroink' : `eng=${c.engine}`}/{c.charId})
                  </option>
                ))}
              </select>
              {charaError && (
                <div className="text-[10px] text-red-500 mt-1">{charaError}</div>
              )}
              <div className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Switching here writes to <span className="font-mono">voicechanger/chara_settings.json</span> immediately.
                The display name above the chat input updates within a moment.
                Edit <span className="font-mono">local_data/character_map.json</span> to add more characters.
              </div>
            </div>
          </div>

          {/* The "Context Management" section was moved per-folder (Folder
              Settings → Context Management) so each AI entity can have its
              own context window size, auto-trim policy, and identity-layer
              compression threshold. The fields now live in Sidebar.tsx
              under folder.settings.maxRecommendedContext /
              autoTrimCopiedMessages / maxTokensPerLayer. */}

          {/* The Appearance/Theme block used to live here. Removed because
              themes are now driven per-folder via Folder Settings → Theme
              (custom CSS), which makes a global light/dark toggle meaningless. */}

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
                Get one at <span className="font-mono">platform.openai.com</span>. Required for the ChatGPT (GPT-5) family — GPT-5.5, GPT-5.4, GPT-5.4 Mini.
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
          </div>

          <div className="space-y-4 pt-4 border-t border-border">
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
