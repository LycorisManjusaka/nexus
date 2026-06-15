import React, { useState, useEffect } from 'react';

interface VoiceSettings {
  engine: number;
  char_idx: number;
  style_idx: number;
  speed?: number;
}

interface VoiceSelectorProps {
  value: VoiceSettings;
  onChange: (val: VoiceSettings) => void;
}

export default function VoiceSelector({ value, onChange }: VoiceSelectorProps) {
  const [speakers, setSpeakers] = useState<{voicevox: any[], coeiroink: any[]}>({ voicevox: [], coeiroink: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/tts/speakers').then(r => r.json()).then(data => {
      setSpeakers(data);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-xs text-muted-foreground">Loading voices...</div>;

  const currentEngineData = value.engine === 0 ? speakers.voicevox : speakers.coeiroink;
  const currentChar = currentEngineData?.[value.char_idx];
  const styles = currentChar?.styles || [];

  return (
    <div className="space-y-3 bg-secondary/20 p-3 rounded-lg border border-border">
      <div>
        <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">TTS Engine</label>
        <select 
          value={value.engine}
          onChange={e => onChange({ ...value, engine: parseInt(e.target.value), char_idx: 0, style_idx: 0, speed: value.speed || 1.0 })}
          className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none"
        >
          <option value={0}>Voicevox</option>
          <option value={1}>Coeiroink</option>
        </select>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block">Speed ({(value.speed || 1.0).toFixed(1)}x)</label>
          <button 
            onClick={() => onChange({ ...value, speed: 1.0 })} 
            className="text-[9px] text-indigo-500 hover:text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded"
          >
            Reset
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
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Character</label>
            <select 
              value={value.char_idx}
              onChange={e => onChange({ ...value, char_idx: parseInt(e.target.value), style_idx: 0, speed: value.speed || 1.0 })}
              className="w-full px-2 py-1.5 bg-background border border-border rounded text-sm outline-none"
            >
              {currentEngineData.map((char: any, i: number) => (
                <option key={i} value={i}>{char.name || char.speakerName}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider block mb-1">Style</label>
            <select 
              value={value.style_idx}
              onChange={e => onChange({ ...value, style_idx: parseInt(e.target.value), speed: value.speed || 1.0 })}
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
