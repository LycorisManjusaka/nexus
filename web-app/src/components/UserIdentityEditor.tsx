"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Lock } from 'lucide-react';
import { useT } from '@/lib/i18n';
import IdentityVoicePicker, { IdentityVoiceValue } from './IdentityVoicePicker';

interface Rule extends IdentityVoiceValue {
  name: string;
}

const ANONYMOUS = 'Anonymous';

export default function UserIdentityEditor() {
  const t = useT();
  const [rules, setRules] = useState<Rule[]>([]);
  const [fallback, setFallback] = useState('Anonymous');
  const [humanLabel, setHumanLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [speakers, setSpeakers] = useState<{ voicevox: any[]; coeiroink: any[]; aivisspeech: any[] }>({ voicevox: [], coeiroink: [], aivisspeech: [] });
  const [starting, setStarting] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSpeakers = useCallback(async () => {
    const data = await fetch('/api/tts/speakers').then(r => r.json());
    setSpeakers({ voicevox: data.voicevox || [], coeiroink: data.coeiroink || [], aivisspeech: data.aivisspeech || [] });
    return data;
  }, []);

  useEffect(() => {
    (async () => {
      const [map] = await Promise.all([
        fetch('/api/character-map').then(r => r.json()),
        loadSpeakers(),
      ]);
      setRules(map.rules || []);
      setFallback(map.fallback || 'Anonymous');
      setHumanLabel(map.humanLabel || '');
      setLoading(false);
    })();
  }, [loadSpeakers]);

  const ENGINE_NAMES: Record<number, string> = { 0: 'Voicevox', 1: 'Coeiroink', 2: 'AivisSpeech' };
  const startEngineAndWait = useCallback(async (eng: number) => {
    setStarting(true);
    setStartMsg(t('voice.starting').replace('{engine}', ENGINE_NAMES[eng]));
    try {
      const r = await fetch('/api/tts/engines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', engine: eng }),
      }).then(res => res.json());
      if (!r?.ok) { setStartMsg(r?.message || t('voice.startFailed')); return; }
      setStartMsg(t('voice.startingLong').replace('{engine}', ENGINE_NAMES[eng]));
      const deadline = Date.now() + 95000;
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 2500));
        const d = await loadSpeakers();
        const got = eng === 2 ? (d.aivisspeech || []) : (d.coeiroink || []);
        if (got.length > 0) { setStartMsg(null); return; }
      }
      setStartMsg(t('voice.startTimeout'));
    } catch (e: any) {
      setStartMsg(e?.message || t('voice.startFailed2'));
    } finally {
      setStarting(false);
    }
  }, [loadSpeakers, t]);

  // ─── Auto-save ────────────────────────────────────────────────────────
  // Every state-mutating setter (updateRule, addRule, removeRule, setFallback,
  // setHumanLabel) calls queueSave(). queueSave() schedules a debounced POST
  // to /api/character-map; the in-flight timer is the single point of
  // cancellation. Three rules:
  //
  //   • latest write wins — successive edits before the debounce fires
  //     collapse into one POST, so the file never sees an intermediate state.
  //   • live errors surface immediately and stay visible (no fade-out).
  //     success messages fade out after 1.5 s so they don't pile up.
  //   • on modal close (or Save Changes), the pending debounce is cancelled
  //     and the latest state is flushed synchronously. No partial save, no
  //     "did it actually go through?" mystery.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestStateRef = useRef<{ rules: Rule[]; fallback: string; humanLabel: string } | null>(null);

  const flashStatus = useCallback((s: { ok: boolean; text: string } | null) => {
    if (statusTimerRef.current) { clearTimeout(statusTimerRef.current); statusTimerRef.current = null; }
    setStatus(s);
    if (s?.ok) {
      statusTimerRef.current = setTimeout(() => {
        setStatus(prev => (prev === s ? null : prev));
      }, 1500);
    }
  }, []);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const state = latestStateRef.current;
    if (!state) return;
    latestStateRef.current = null;
    const trimmed = state.rules.map(r => ({ ...r, name: r.name.trim() }));
    if (trimmed.some(r => !r.name)) {
      flashStatus({ ok: false, text: t('useridentity.err.emptyName') });
      return;
    }
    const seen = new Set<string>();
    for (const r of trimmed) {
      if (seen.has(r.name)) {
        flashStatus({ ok: false, text: t('useridentity.err.duplicate').replace('{name}', r.name) });
        return;
      }
      seen.add(r.name);
    }
    try {
      const res = await fetch('/api/character-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: trimmed, fallback: state.fallback, humanLabel: state.humanLabel }),
      }).then(r => r.json());
      if (res.error) {
        flashStatus({ ok: false, text: res.error });
      } else {
        flashStatus({ ok: true, text: t('useridentity.saved') });
      }
    } catch (e: any) {
      flashStatus({ ok: false, text: e?.message || t('useridentity.err.saveFailed') });
    }
  }, [flashStatus, t]);

  const queueSave = useCallback((next: { rules: Rule[]; fallback: string; humanLabel: string }) => {
    latestStateRef.current = next;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { void flushSave(); }, 300);
  }, [flushSave]);

  // Flush any pending debounced save when the editor unmounts (modal closes
  // from anywhere — Cancel, X, backdrop click, parent save-trigger).
  useEffect(() => () => { void flushSave(); }, [flushSave]);

  const updateRule = (i: number, patch: Partial<Rule>) => {
    const next = rules.map((r, idx) => idx === i ? { ...r, ...patch } : r);
    setRules(next);
    queueSave({ rules: next, fallback, humanLabel });
  };

  const addRule = () => {
    const next = [...rules, { name: '' }];
    setRules(next);
    queueSave({ rules: next, fallback, humanLabel });
  };

  const removeRule = (i: number) => {
    const next = rules.filter((_, idx) => idx !== i);
    setRules(next);
    queueSave({ rules: next, fallback, humanLabel });
  };

  const onFallbackChange = (v: string) => {
    setFallback(v);
    queueSave({ rules, fallback: v, humanLabel });
  };

  const onHumanLabelChange = (v: string) => {
    setHumanLabel(v);
    queueSave({ rules, fallback, humanLabel });
  };

  if (loading) return <div className="text-xs text-muted-foreground">{t('voice.loading')}</div>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t('useridentity.intro')}
      </p>

      <div className="space-y-3">
        {rules.map((rule, i) => {
          const isAnonymous = rule.name === ANONYMOUS;
          return (
            <div key={i} className="p-3 rounded-lg border border-border bg-secondary/20 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={rule.name}
                  disabled={isAnonymous}
                  onChange={e => updateRule(i, { name: e.target.value })}
                  placeholder={t('useridentity.namePh')}
                  className="flex-1 px-2 py-1.5 bg-background border border-border rounded text-sm outline-none disabled:opacity-70"
                />
                {isAnonymous ? (
                  <span title={t('useridentity.anonymousProtected')} className="p-1.5 text-muted-foreground shrink-0">
                    <Lock size={14} />
                  </span>
                ) : (
                  <button
                    onClick={() => removeRule(i)}
                    title={t('useridentity.remove')}
                    className="p-1.5 rounded hover:bg-red-500/10 text-red-500 shrink-0"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
              {isAnonymous && (
                <p className="text-[10px] text-muted-foreground">{t('useridentity.anonymousNote')}</p>
              )}
              <IdentityVoicePicker
                value={rule}
                onChange={v => updateRule(i, v)}
                speakers={speakers}
                onStartEngine={startEngineAndWait}
                starting={starting}
                startMsg={startMsg}
              />
            </div>
          );
        })}
      </div>

      <button
        onClick={addRule}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-indigo-500 transition-colors"
      >
        <Plus size={14} /> {t('useridentity.add')}
      </button>

      <div>
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
          {t('useridentity.fallback.label')}
        </label>
        <select
          value={fallback}
          onChange={e => onFallbackChange(e.target.value)}
          className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none"
        >
          {rules.filter(r => r.name.trim()).map((r, i) => (
            <option key={i} value={r.name}>{r.name}</option>
          ))}
        </select>
        <p className="text-[10px] text-muted-foreground mt-1">
          {t('useridentity.fallback.help')}
        </p>
      </div>

      <div>
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">
          {t('useridentity.others.label')}
        </label>
        <input
          type="text"
          value={humanLabel}
          onChange={e => onHumanLabelChange(e.target.value)}
          className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          {t('useridentity.others.help')}
        </p>
      </div>

      {status && (
        <p className={`text-xs ${status.ok ? 'text-emerald-500' : 'text-red-500'}`} role="status">{status.text}</p>
      )}
    </div>
  );
}