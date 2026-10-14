"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Lock } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { fetchJsonSafe } from '@/lib/fetchJson';
import IdentityVoicePicker, { IdentityVoiceValue } from './IdentityVoicePicker';
import {
  type SpeakerCatalogs, emptyCatalogs, normalizeCatalogs, catalogFor, ttsEngineByNum,
} from '@/lib/ttsEngineCatalog';

interface Rule extends IdentityVoiceValue {
  name: string;
}

const ANONYMOUS = 'Anonymous';

// Engine identity comes from the shared catalog (see lib/ttsEngineCatalog.ts);
// this file used to restate both the catalogue shape and the engine labels.
const NO_SPEAKERS: SpeakerCatalogs = emptyCatalogs();

// What this editor shows when the identity map can't be read at all. Not an
// empty list: "Anonymous" is the one identity that must always exist, and the
// GET route guarantees it too — matching that here means a failed load and a
// fresh install look the same, which is what they are from the user's side.
const NO_MAP = { rules: [{ name: ANONYMOUS }] as Rule[], fallback: ANONYMOUS, humanLabel: '' };

export default function UserIdentityEditor() {
  const t = useT();
  const [rules, setRules] = useState<Rule[]>([]);
  const [fallback, setFallback] = useState('Anonymous');
  const [humanLabel, setHumanLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [speakers, setSpeakers] = useState<SpeakerCatalogs>(NO_SPEAKERS);
  const [starting, setStarting] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Never rejects. A missing/unreachable speaker route means "no voices to
  // choose from yet", which the picker already renders correctly (empty list +
  // a Start button). It is not a reason to withhold the identity list.
  const loadSpeakers = useCallback(async (): Promise<SpeakerCatalogs> => {
    const data = await fetchJsonSafe<any>('/api/tts/speakers', NO_SPEAKERS);
    const next = normalizeCatalogs(data);
    setSpeakers(next);
    return next;
  }, []);

  useEffect(() => {
    // The two loads are independent and BOTH are allowed to fail. Previously a
    // single Promise.all with no catch meant either failure left `loading` true
    // forever — the "Loading voices…" spinner that never resolves on a machine
    // with no TTS engines installed. The identity editor does not need voices to
    // work, so a voice failure must not be able to hide it.
    let cancelled = false;
    (async () => {
      try {
        const [map] = await Promise.all([
          fetchJsonSafe<typeof NO_MAP>('/api/character-map', NO_MAP),
          loadSpeakers(),
        ]);
        if (cancelled) return;
        setRules(map.rules?.length ? map.rules : NO_MAP.rules);
        setFallback(map.fallback || ANONYMOUS);
        setHumanLabel(map.humanLabel || '');
      } finally {
        // Unconditional: whatever happened above, the panel renders.
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadSpeakers]);

  const engineName = (n: number) => ttsEngineByNum(n)?.label ?? `engine ${n}`;
  const startEngineAndWait = useCallback(async (eng: number) => {
    setStarting(true);
    setStartMsg(t('voice.starting').replace('{engine}', engineName(eng)));
    try {
      // fetchJsonSafe, not raw .json(): a route that answers with an HTML error
      // page would otherwise surface as "Unexpected token '<'", which tells the
      // user nothing. The plain "couldn't start" message is more honest.
      const r = await fetchJsonSafe<any>('/api/tts/engines', null, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', engine: eng }),
      });
      if (!r?.ok) { setStartMsg(r?.message || t('voice.startFailed')); return; }
      setStartMsg(t('voice.startingLong').replace('{engine}', engineName(eng)));
      const deadline = Date.now() + 95000;
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 2500));
        const d = await loadSpeakers();
        const got = catalogFor(eng, d);
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
        // Tell the speaker dropdown above the composer that the registry moved.
        // It used to read character_map.json once on mount, so a newly added
        // identity could not be selected until the page was reloaded — the first
        // thing a new user does, appearing not to work. Fired HERE, next to the
        // write, rather than on modal close: a save that happened must announce
        // itself, and a save that was rejected above must not.
        window.dispatchEvent(new CustomEvent('nx-chara-map-changed'));
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

  // Always-current snapshot of all three state fields, updated on every render.
  // This is what makes rapid cross-field edits safe: when the user types in the
  // name field and then the humanLabel field within one debounce window, the
  // second queueSave() reads the LATEST rules from the ref instead of the stale
  // closure value, so neither edit clobbers the other.
  const stateRef = useRef({ rules, fallback, humanLabel });
  stateRef.current = { rules, fallback, humanLabel };

  // Flush any pending debounced save when the editor unmounts (modal closes
  // from anywhere — Cancel, X, backdrop click, parent save-trigger).
  useEffect(() => () => { void flushSave(); }, [flushSave]);

  const updateRule = (i: number, patch: Partial<Rule>) => {
    const next = stateRef.current.rules.map((r, idx) => idx === i ? { ...r, ...patch } : r);
    setRules(next);
    queueSave({ rules: next, fallback: stateRef.current.fallback, humanLabel: stateRef.current.humanLabel });
  };

  const addRule = () => {
    const next = [...stateRef.current.rules, { name: '' }];
    setRules(next);
    queueSave({ rules: next, fallback: stateRef.current.fallback, humanLabel: stateRef.current.humanLabel });
  };

  const removeRule = (i: number) => {
    const next = stateRef.current.rules.filter((_, idx) => idx !== i);
    setRules(next);
    queueSave({ rules: next, fallback: stateRef.current.fallback, humanLabel: stateRef.current.humanLabel });
  };

  const onFallbackChange = (v: string) => {
    setFallback(v);
    queueSave({ rules: stateRef.current.rules, fallback: v, humanLabel: stateRef.current.humanLabel });
  };

  const onHumanLabelChange = (v: string) => {
    setHumanLabel(v);
    queueSave({ rules: stateRef.current.rules, fallback: stateRef.current.fallback, humanLabel: v });
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