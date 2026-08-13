import React, { useState, useEffect } from 'react';
import { useT } from '@/lib/i18n';
import { fetchJsonSafe } from '@/lib/fetchJson';

type SpeakerCatalogs = { voicevox: any[]; coeiroink: any[]; aivisspeech: any[] };
const NO_SPEAKERS: SpeakerCatalogs = { voicevox: [], coeiroink: [], aivisspeech: [] };

interface VoiceSettings {
  engine: number;
  char_idx: number;
  style_idx: number;
  // Persisted alongside the indices so a character list that gets reordered
  // (a new voice added ahead of this one) doesn't silently switch who speaks.
  // The synthesize route resolves these against the LIVE speaker list first;
  // the indices are only a fallback for data saved before this field existed.
  char_name?: string;
  style_name?: string;
  speed?: number;
  // When true, the streaming-TTS pipeline synthesizes larger blocks (whole
  // message / paragraph) instead of sentence-by-sentence, so context-aware
  // engines (AivisSpeech / Style-Bert-VITS2) can infer emotion from the full
  // text. Slightly higher latency, much more natural delivery.
  contextChunks?: boolean;
}

interface VoiceSelectorProps {
  value: VoiceSettings;
  onChange: (val: VoiceSettings) => void;
}

export default function VoiceSelector({ value, onChange }: VoiceSelectorProps) {
  const t = useT();
  const [speakers, setSpeakers] = useState<SpeakerCatalogs>(NO_SPEAKERS);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);

  const ENGINE_NAMES: Record<number, string> = { 0: 'Voicevox', 1: 'Coeiroink', 2: 'AivisSpeech' };

  // Never rejects — see lib/fetchJson.ts. With no engine installed (or the
  // route unreachable) this resolves to empty catalogs, which is exactly what
  // the dropdowns below already handle: empty character list, "not running"
  // notice, Start button. A throw here used to escape the .finally() below as an
  // unhandled rejection.
  const loadSpeakers = React.useCallback(async (): Promise<SpeakerCatalogs> => {
    const data = await fetchJsonSafe<any>('/api/tts/speakers', NO_SPEAKERS);
    const next: SpeakerCatalogs = {
      voicevox: data.voicevox || [],
      coeiroink: data.coeiroink || [],
      aivisspeech: data.aivisspeech || [],
    };
    setSpeakers(next);
    return next;
  }, []);

  useEffect(() => {
    loadSpeakers().finally(() => setLoading(false));
  }, [loadSpeakers]);

  /**
   * Launch an engine so its character list can be read.
   *
   * Coeiroink and AivisSpeech serve their speaker list from the running process,
   * so with the engine down the Character dropdown is simply empty — previously
   * the only way to fill it was to start the engine indirectly by playing TTS in
   * a conversation. Voicevox (engine 0) reads a JSON file from disk instead and
   * never needs this.
   *
   * Deliberately triggered ONLY by an explicit engine pick or button press —
   * never on mount or on opening the dropdown, which would boot all three.
   */
  const startEngineAndWait = React.useCallback(async (eng: number) => {
    setStarting(true);
    setStartMsg(t('voice.starting').replace('{engine}', ENGINE_NAMES[eng]));
    try {
      const r = await fetchJsonSafe<any>('/api/tts/engines', null, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', engine: eng }),
      });

      if (!r?.ok) {
        setStartMsg(r?.message || t('voice.startFailed'));
        return;
      }
      setStartMsg(t('voice.startingLong').replace('{engine}', ENGINE_NAMES[eng]));

      // Poll the speaker list rather than a health endpoint: the list appearing
      // is the thing we actually need, and these engines answer /speakers only
      // after their voice models are loaded.
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
  }, [loadSpeakers]);

  const handleEngineChange = (eng: number) => {
    onChange({ ...value, engine: eng, char_idx: 0, style_idx: 0, char_name: undefined, style_name: undefined, speed: value.speed || 1.0 });
    setStartMsg(null);
    if (eng === 0) return;                       // reads from disk, no engine needed
    const list = eng === 2 ? speakers.aivisspeech : speakers.coeiroink;
    if (list.length === 0 && !starting) startEngineAndWait(eng);
  };

  if (loading) return <div className="text-xs text-muted-foreground">{t('voice.loading')}</div>;

  const currentEngineData = value.engine === 0 ? speakers.voicevox : value.engine === 2 ? speakers.aivisspeech : speakers.coeiroink;
  // Resolve by NAME first, so a saved selection keeps pointing at the same
  // character/style even if the engine's list order changed since last save
  // (e.g. a new voice model added ahead of this one). Falls back to the saved
  // index for older data that predates char_name/style_name.
  const nameCharIdx = value.char_name
    ? (currentEngineData || []).findIndex((c: any) => (c.name || c.speakerName) === value.char_name)
    : -1;
  const resolvedCharIdx = nameCharIdx >= 0 ? nameCharIdx : value.char_idx;
  const currentChar = currentEngineData?.[resolvedCharIdx];
  const styles = currentChar?.styles || [];
  const nameStyleIdx = value.style_name
    ? styles.findIndex((s: any) => (s.name || s.styleName) === value.style_name)
    : -1;
  const resolvedStyleIdx = nameStyleIdx >= 0 ? nameStyleIdx : value.style_idx;

  return (
    <div className="space-y-3 bg-secondary/20 p-3 rounded-lg border border-border">
      <div>
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">{t('voice.engine')}</label>
        <select
          value={value.engine}
          onChange={e => handleEngineChange(parseInt(e.target.value))}
          className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none"
        >
          <option value={0}>Voicevox</option>
          <option value={1}>Coeiroink</option>
          <option value={2}>{t('voice.engine.aivis')}</option>
        </select>
        {/* Voicevox's catalog is a file on disk, not a running process — there
            is nothing to start from here, so say what's missing rather than
            leaving an empty Character dropdown with no explanation. */}
        {value.engine === 0 && currentEngineData.length === 0 && (
          <p className="text-[10px] text-amber-500 mt-1">{t('voice.noVoicevox')}</p>
        )}
        {/* Engines 1 and 2 serve their character list from the running process.
            Rather than the old "go start the app yourself, then reopen this
            panel", offer the launch right here. */}
        {value.engine !== 0 && currentEngineData.length === 0 && (
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <p className="text-[10px] text-amber-500 flex-1 min-w-[12rem]">
              {startMsg || t('voice.notRunning').replace('{engine}', ENGINE_NAMES[value.engine])}
            </p>
            <button
              onClick={() => startEngineAndWait(value.engine)}
              disabled={starting}
              className="text-[10px] px-2 py-1 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {starting ? t('voice.startingBtn') : t('voice.startBtn')}
            </button>
          </div>
        )}
        {/* Loaded, but a start/restart message is still worth showing. */}
        {value.engine !== 0 && currentEngineData.length > 0 && startMsg && (
          <p className="text-[10px] text-muted-foreground mt-1">{startMsg}</p>
        )}
      </div>

      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={value.contextChunks ?? (value.engine === 2)}
          onChange={e => onChange({ ...value, contextChunks: e.target.checked })}
          className="w-3.5 h-3.5 accent-indigo-500"
        />
        <span className="text-[11px] text-muted-foreground">{t('voice.contextMode')}</span>
      </label>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">{t('voice.speed').replace('{v}', (value.speed || 1.0).toFixed(1))}</label>
          <button 
            onClick={() => onChange({ ...value, speed: 1.0 })} 
            className="text-[9px] text-indigo-500 hover:text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded"
          >
            {t('voice.reset')}
          </button>
        </div>
        <input 
          type="range" 
          min="0.5" 
          max="2.0" 
          step="0.1" 
          value={value.speed || 1.0} 
          onChange={e => onChange({ ...value, speed: parseFloat(e.target.value) })}
          className="w-full"
        />
      </div>

      {currentEngineData && currentEngineData.length > 0 && (
        <>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">{t('voice.character')}</label>
            <select
              value={resolvedCharIdx}
              onChange={e => {
                const i = parseInt(e.target.value);
                const c = currentEngineData[i];
                onChange({ ...value, char_idx: i, char_name: c?.name || c?.speakerName, style_idx: 0, style_name: (c?.styles?.[0]?.name || c?.styles?.[0]?.styleName), speed: value.speed || 1.0 });
              }}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none"
            >
              {currentEngineData.map((char: any, i: number) => (
                <option key={i} value={i}>{char.name || char.speakerName}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">{t('voice.style')}</label>
            <select
              value={resolvedStyleIdx}
              onChange={e => {
                const i = parseInt(e.target.value);
                const s = styles[i];
                onChange({ ...value, style_idx: i, style_name: s?.name || s?.styleName, speed: value.speed || 1.0 });
              }}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none"
            >
              {styles.map((style: any, i: number) => (
                <option key={i} value={i}>{style.name || style.styleName}</option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );
}
