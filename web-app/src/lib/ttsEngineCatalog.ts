/**
 * The TTS engines this build knows — one definition, many readers.
 *
 * WHY THIS FILE EXISTS
 * The engine list used to be restated in nine places: a numeric map in
 * ttsEngines.ts, a SECOND numeric map in the synthesize route, a third in
 * characterMap's legacy bridge, `{0:'Voicevox',1:'Coeiroink',2:'AivisSpeech'}`
 * in three components, a `<select>`'s options, and — the dangerous one — a
 * chain of ternaries picking a speaker catalogue:
 *
 *   eng === 0 ? speakers.voicevox : eng === 2 ? speakers.aivisspeech
 *                                             : speakers.coeiroink
 *
 * That chain has no "unknown" branch. Adding a fourth engine made it read
 * COEIROINK's voice list — silently, with a green typecheck. The failure form
 * this house keeps hitting: written, but one wire missing.
 *
 * So: engine identity (number, storage key, label, which field of
 * /api/tts/speakers holds its catalogue) lives here, and here only.
 *
 * MUST STAY CLIENT-SAFE. ttsEngines.ts owns ports, health endpoints and process
 * launching, and imports `fs` and `child_process` — a React component cannot
 * import it. This file imports nothing.
 */

export interface TtsEngineMeta {
  /** Legacy numeric id. Still the wire format for folder voice settings and
   *  the /api/tts/engines lifecycle actions, so it is identity, not a detail. */
  num: number;
  /** Name used in character_map.json, tts_engines.json and identity records. */
  key: string;
  /** Display label when no translation is needed. */
  label: string;
  /** i18n key, when the label carries a translated qualifier. */
  labelKey?: string;
  /** Field of the GET /api/tts/speakers response holding this engine's voices. */
  catalog: string;
  /**
   * Which text pre-processing this engine's input needs.
   *
   * `japanese` is the OpenJTalk-shaped pipeline the first three engines share:
   * English→Katakana conversion, a leading-pause strip, and a "speakable"
   * check whose character class is Hiragana/Katakana/Han/ASCII-alnum.
   *
   * `cyrillic` must NOT go through it. Measured on the unmodified pipeline:
   *   "Привет, как дела?" → not speakable → segment silently dropped
   *   "Версия NEXUS 1.0"  → leading-strip deletes "Версия" → "NEXUS 1.0"
   * Silence and word loss, with no error at any layer.
   */
  textPipeline: 'japanese' | 'cyrillic';
  /**
   * True when the voice list can only be read from the running engine — the
   * picker then offers a Start button. VOICEVOX is false: its catalogue is a
   * JSON file on disk written by voice_changer.py, readable while the engine
   * is down.
   */
  needsProcess: boolean;
}

export const TTS_ENGINES: readonly TtsEngineMeta[] = [
  { num: 0, key: 'voicevox', label: 'Voicevox', catalog: 'voicevox', needsProcess: false, textPipeline: 'japanese' },
  { num: 1, key: 'coeiroink', label: 'Coeiroink', catalog: 'coeiroink', needsProcess: true, textPipeline: 'japanese' },
  {
    num: 2, key: 'aivisspeech', label: 'AivisSpeech',
    labelKey: 'voice.engine.aivis', catalog: 'aivisspeech', needsProcess: true,
    textPipeline: 'japanese',
  },
  {
    // Russian. Not bundled: an external HTTP service (vosk-tts + RUAccent,
    // both Apache-2.0) pointed at by absolute path in Preferences, exactly as
    // the other three are.
    num: 3, key: 'vosk_ra', label: 'vosk-tts + RUAccent',
    labelKey: 'voice.engine.voskra', catalog: 'vosk_ra', needsProcess: true,
    textPipeline: 'cyrillic',
  },
];

/** Speaker lists keyed by engine `catalog` field. */
export type SpeakerCatalogs = Record<string, any[]>;

/** Every engine's catalogue, empty. Used as the initial state and as the
 *  fallback for a failed /api/tts/speakers fetch. */
export function emptyCatalogs(): SpeakerCatalogs {
  const out: SpeakerCatalogs = {};
  for (const e of TTS_ENGINES) out[e.catalog] = [];
  return out;
}

export function ttsEngineByNum(num: number): TtsEngineMeta | undefined {
  return TTS_ENGINES.find(e => e.num === num);
}

export function ttsEngineByKey(key: string): TtsEngineMeta | undefined {
  const k = String(key || '').toLowerCase();
  return TTS_ENGINES.find(e => e.key === k);
}

/** Accept an engine reference in either form. `undefined` for unknown — the
 *  caller decides whether that is an error, rather than defaulting to engine 0
 *  and speaking in the wrong voice. */
export function ttsEngine(ref: number | string | undefined | null): TtsEngineMeta | undefined {
  if (ref === undefined || ref === null) return undefined;
  return typeof ref === 'number' ? ttsEngineByNum(ref) : ttsEngineByKey(ref);
}

/**
 * This engine's voice list out of a /api/tts/speakers response.
 *
 * Returns [] for an engine this build does not know — NOT another engine's
 * list. An empty dropdown says "nothing here"; a populated one belonging to a
 * different engine says something false.
 */
export function catalogFor(ref: number | string | undefined | null, catalogs: SpeakerCatalogs | undefined): any[] {
  const meta = ttsEngine(ref);
  if (!meta || !catalogs) return [];
  return catalogs[meta.catalog] || [];
}

/** Normalise a /api/tts/speakers payload into the catalogue shape, so a route
 *  that gains a field (or loses one while an engine is down) can't produce
 *  `undefined` where the pickers expect an array. */
export function normalizeCatalogs(data: any): SpeakerCatalogs {
  const out = emptyCatalogs();
  for (const e of TTS_ENGINES) {
    const v = data?.[e.catalog];
    if (Array.isArray(v)) out[e.catalog] = v;
  }
  return out;
}
