import React from 'react';
import { useT } from '@/lib/i18n';

// The voice half of a Preferences → User Identity row: engine + character +
// style, all optional (an identity can be a bare name with no TTS voice at
// all). This is a trimmed sibling of VoiceSelector.tsx — same engine list,
// same name-based resolution so a saved pick keeps pointing at the same
// character/style even if the engine's speaker list is later reordered (a
// numeric slot index is NOT stable — Coeiroink and AivisSpeech both shift
// their speaker order whenever a new voice is installed) — minus the
// speed/contextChunks fields, which are an entity-AI-voice concept that
// doesn't apply to a human/voice-changer identity. Engine start/poll state is
// owned by the parent (one identity editor, potentially several rows
// targeting the same engine) rather than duplicated per row.
//
// Style is left unset until the human explicitly picks one in the style
// dropdown below — selecting a character never silently writes the engine's
// first/default style as though it had been chosen. Synthesis (and the
// voice-changer's own runtime) falls through to the engine's own default
// style when none is saved here.

export interface IdentityVoiceValue {
  engine?: string; // engine's own NAME string: "voicevox" | "coeiroink" | "aivisspeech" | future engines
  charName?: string;
  styleName?: string;
}

interface Props {
  value: IdentityVoiceValue;
  onChange: (val: IdentityVoiceValue) => void;
  speakers: { voicevox: any[]; coeiroink: any[]; aivisspeech: any[] };
  onStartEngine: (engine: number) => void;
  starting: boolean;
  startMsg: string | null;
}

// The TTS engine SOFTWARE processes Nexus can launch/poll are a small, fixed,
// hardcoded set (unlike character/style, which live inside each engine's own
// ever-changing speaker list) — this mapping only grows when a genuinely new
// engine is integrated into Nexus, which already requires code changes
// elsewhere. It never drifts on its own the way a speaker index does.
const ENGINE_TO_NUM: Record<string, number> = { voicevox: 0, coeiroink: 1, aivisspeech: 2 };
const ENGINE_LABEL_KEY: Record<string, string> = { voicevox: 'Voicevox', coeiroink: 'Coeiroink', aivisspeech: 'voice.engine.aivis' };

export default function IdentityVoicePicker({ value, onChange, speakers, onStartEngine, starting, startMsg }: Props) {
  const t = useT();
  const hasVoice = !!value.engine;
  const engineKey = value.engine || 'voicevox';
  const engineLabel = engineKey === 'aivisspeech' ? t('voice.engine.aivis') : (ENGINE_LABEL_KEY[engineKey] || engineKey);

  const currentEngineData = engineKey === 'voicevox' ? speakers.voicevox : engineKey === 'aivisspeech' ? speakers.aivisspeech : speakers.coeiroink;
  const resolvedCharIdx = value.charName
    ? (currentEngineData || []).findIndex((c: any) => (c.name || c.speakerName) === value.charName)
    : -1;
  const currentChar = resolvedCharIdx >= 0 ? currentEngineData?.[resolvedCharIdx] : undefined;
  const styles = currentChar?.styles || [];
  const resolvedStyleIdx = value.styleName
    ? styles.findIndex((s: any) => (s.name || s.styleName) === value.styleName)
    : -1;

  const toggleHasVoice = (on: boolean) => {
    // Explicitly overwrite every voice field to undefined — the parent's
    // updateRule() shallow-merges the patch onto the existing rule
    // ({ ...r, ...patch }), so an empty object here would leave the
    // previously-set `engine` untouched and the checkbox would appear to
    // snap back on.
    if (!on) { onChange({ engine: undefined, charName: undefined, styleName: undefined }); return; }
    onChange({ engine: 'voicevox' });
  };

  const handleEngineChange = (eng: string) => {
    onChange({ engine: eng });
    if (eng === 'voicevox') return;
    const list = eng === 'aivisspeech' ? speakers.aivisspeech : speakers.coeiroink;
    if (list.length === 0 && !starting) onStartEngine(ENGINE_TO_NUM[eng] ?? 0);
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={hasVoice}
          onChange={e => toggleHasVoice(e.target.checked)}
          className="w-3.5 h-3.5 accent-indigo-500"
        />
        <span className="text-[11px] text-muted-foreground">{t('useridentity.hasVoice')}</span>
      </label>

      {hasVoice && (
        <div className="ml-5 space-y-2">
          <select
            value={engineKey}
            onChange={e => handleEngineChange(e.target.value)}
            className="w-full px-2 py-1 bg-background border border-border rounded text-xs outline-none"
          >
            <option value="voicevox">Voicevox</option>
            <option value="coeiroink">Coeiroink</option>
            <option value="aivisspeech">{t('voice.engine.aivis')}</option>
          </select>

          {engineKey !== 'voicevox' && currentEngineData.length === 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[10px] text-amber-500 flex-1 min-w-[10rem]">
                {startMsg || t('voice.notRunning').replace('{engine}', engineLabel)}
              </p>
              <button
                onClick={() => onStartEngine(ENGINE_TO_NUM[engineKey] ?? 0)}
                disabled={starting}
                className="text-[10px] px-2 py-1 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/25 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {starting ? t('voice.startingBtn') : t('voice.startBtn')}
              </button>
            </div>
          )}

          {currentEngineData && currentEngineData.length > 0 && (
            <>
              <select
                value={resolvedCharIdx >= 0 ? resolvedCharIdx : ''}
                onChange={e => {
                  const i = parseInt(e.target.value, 10);
                  const c = currentEngineData[i];
                  // Selecting a character never carries over — nor invents — a
                  // style. Style stays unset until the dropdown below is used.
                  onChange({
                    engine: engineKey,
                    charName: c?.name || c?.speakerName,
                    styleName: undefined,
                  });
                }}
                className="w-full px-2 py-1 bg-background border border-border rounded text-xs outline-none"
              >
                <option value="" disabled>{t('useridentity.pickCharacter')}</option>
                {currentEngineData.map((char: any, i: number) => (
                  <option key={i} value={i}>{char.name || char.speakerName}</option>
                ))}
              </select>

              {resolvedCharIdx >= 0 && styles.length > 0 && (
                <select
                  value={resolvedStyleIdx >= 0 ? resolvedStyleIdx : ''}
                  onChange={e => {
                    const i = parseInt(e.target.value, 10);
                    const s = styles[i];
                    onChange({
                      engine: engineKey,
                      charName: currentChar?.name || currentChar?.speakerName,
                      styleName: s?.name || s?.styleName,
                    });
                  }}
                  className="w-full px-2 py-1 bg-background border border-border rounded text-xs outline-none"
                >
                  <option value="" disabled>{t('useridentity.pickStyle')}</option>
                  {styles.map((style: any, i: number) => (
                    <option key={i} value={i}>{style.name || style.styleName}</option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
