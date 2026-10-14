import React from 'react';
import { useT } from '@/lib/i18n';
import {
  TTS_ENGINES, type SpeakerCatalogs, catalogFor, ttsEngineByKey,
} from '@/lib/ttsEngineCatalog';

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
// The style picked here is the identity's DEFAULT style — what it speaks in
// when nothing else is chosen. A different style can be picked per session in
// the conversation window (that pick lives in user_identity.json and never
// touches this map). It is left unset until explicitly picked: selecting a
// character never silently writes the engine's first style as though it had
// been chosen. Synthesis (and the voice changer's own runtime) falls through to
// the engine's own default when none is saved here.

export interface IdentityVoiceValue {
  engine?: string; // engine's own NAME string — the `key` field of TTS_ENGINES
  character?: string;
  defaultStyle?: string;
}

interface Props {
  value: IdentityVoiceValue;
  onChange: (val: IdentityVoiceValue) => void;
  speakers: SpeakerCatalogs;
  onStartEngine: (engine: number) => void;
  starting: boolean;
  startMsg: string | null;
}

// The TTS engine SOFTWARE processes Nexus can launch/poll are a small, fixed
// set (unlike character/style, which live inside each engine's own
// ever-changing speaker list) — but they were restated here, in VoiceSelector,
// in UserIdentityEditor and in two server routes. They now come from the one
// catalog, which is also what decides whether an engine has a process to
// start at all.

export default function IdentityVoicePicker({ value, onChange, speakers, onStartEngine, starting, startMsg }: Props) {
  const t = useT();
  const hasVoice = !!value.engine;
  const engineKey = value.engine || 'voicevox';
  const engineMeta = ttsEngineByKey(engineKey);
  const engineLabel = engineMeta
    ? (engineMeta.labelKey ? t(engineMeta.labelKey) : engineMeta.label)
    : engineKey;
  const needsProcess = !!engineMeta?.needsProcess;

  const currentEngineData = catalogFor(engineKey, speakers);
  const resolvedCharIdx = value.character
    ? (currentEngineData || []).findIndex((c: any) => (c.name || c.speakerName) === value.character)
    : -1;
  const currentChar = resolvedCharIdx >= 0 ? currentEngineData?.[resolvedCharIdx] : undefined;
  const styles = currentChar?.styles || [];
  const resolvedStyleIdx = value.defaultStyle
    ? styles.findIndex((s: any) => (s.name || s.styleName) === value.defaultStyle)
    : -1;

  const toggleHasVoice = (on: boolean) => {
    // Explicitly overwrite every voice field to undefined — the parent's
    // updateRule() shallow-merges the patch onto the existing rule
    // ({ ...r, ...patch }), so an empty object here would leave the
    // previously-set `engine` untouched and the checkbox would appear to
    // snap back on.
    if (!on) { onChange({ engine: undefined, character: undefined, defaultStyle: undefined }); return; }
    onChange({ engine: 'voicevox' });
  };

  const handleEngineChange = (eng: string) => {
    onChange({ engine: eng });
    const meta = ttsEngineByKey(eng);
    if (!meta?.needsProcess) return;   // catalog is a file on disk
    if (catalogFor(eng, speakers).length === 0 && !starting) onStartEngine(meta.num);
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
            {TTS_ENGINES.map(e => (
              <option key={e.key} value={e.key}>{e.labelKey ? t(e.labelKey) : e.label}</option>
            ))}
          </select>

          {/* Voicevox has no process to start from here — its catalog is a file
              on disk written by the voice changer. With no file, the character
              dropdown below simply doesn't render, which used to leave a blank
              gap with no explanation. Say what's missing instead of offering a
              Start button that wouldn't do anything for this engine. */}
          {!needsProcess && currentEngineData.length === 0 && (
            <p className="text-[10px] text-amber-500">{t('voice.noVoicevox')}</p>
          )}

          {needsProcess && currentEngineData.length === 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[10px] text-amber-500 flex-1 min-w-[10rem]">
                {startMsg || t('voice.notRunning').replace('{engine}', engineLabel)}
              </p>
              <button
                onClick={() => { if (engineMeta) onStartEngine(engineMeta.num); }}
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
                    character: c?.name || c?.speakerName,
                    defaultStyle: undefined,
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
                      character: currentChar?.name || currentChar?.speakerName,
                      defaultStyle: s?.name || s?.styleName,
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
