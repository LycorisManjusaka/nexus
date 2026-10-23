import { NextResponse } from 'next/server';
import fs from 'fs';
import { convertEnglishToKatakana } from '@/lib/ttsEnToKatakana';
import { speakersJsonPath } from '@/lib/voicechangerPaths';
import { loadTtsDictPairs, applyTtsDict } from '@/lib/ttsDictionary';
import { ensureEngineRunning, ENGINES } from '@/lib/ttsEngines';
import { TTS_ENGINES, ttsEngineByKey, ttsEngineByNum } from '@/lib/ttsEngineCatalog';

// A segment produces ZERO phonemes — and crashes the OpenJTalk-based engines —
// when it contains no kana, kanji, or alphanumeric characters. Coeiroink fails
// with "JPCommonLabel_make(): No phoneme", and then its VITS text encoder dies
// on a conv1d whose kernel (size 3) is larger than the empty phoneme sequence:
//   RuntimeError: Calculated padded input size per channel: (2).
//                 Kernel size: (3). Kernel size can't be greater than ...
// Punctuation / symbol / emoji-only chunks (e.g. "！！！", "……", "♡", "🎵",
// a lone "）") come out of sentence-splitting and must be skipped, not sent.
//
// Speakable = at least one Hiragana / Katakana (incl. half-width) / Han (kanji)
// character, or an ASCII/full-width letter or digit (the engine can read those).
const SPEAKABLE_RE =
  /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9０-９Ａ-Ｚａ-ｚｦ-ﾝ]/u;
function hasSpeakableContent(text: string): boolean {
  return SPEAKABLE_RE.test(text || '');
}

// OpenJTalk (used by both Voicevox and Coeiroink) warns and stalls ~1-2s when a
// segment BEGINS with a pause-inducing character:
//   "JPCommonLabel_insert_pause(): First mora should not be short pause."
// This happens whenever the text starts with leading punctuation / whitespace /
// dashes / brackets / symbols (e.g. "、はい", "…そうだね", "（笑）", " あの"),
// because the engine tries to make the very first mora a short pause, which is
// illegal. A leading non-speakable run can't be voiced anyway, so we strip it.
// Trailing punctuation is left alone (a pause at the end is valid). If nothing
// speakable remains after trimming, hasSpeakableContent() drops the segment.
const LEADING_NONSPEAKABLE_RE =
  /^[^\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9０-９Ａ-Ｚａ-ｚｦ-ﾝ]+/u;
function stripLeadingPause(text: string): string {
  return (text || '').replace(LEADING_NONSPEAKABLE_RE, '');
}

// Both predicates above are OpenJTalk-shaped on purpose, and Cyrillic is absent
// from their character class because none of the Japanese engines can read it.
// For a Russian engine that absence is not a no-op — MEASURED on the unmodified
// pipeline:
//   "Привет, как дела?"  hasSpeakableContent === false  -> segment dropped
//   "Версия NEXUS 1.0"   stripLeadingPause()            -> "NEXUS 1.0"
// Silence, or a sentence with its Russian words deleted, reported as success at
// every layer.
//
// The Japanese class is deliberately NOT widened to include Cyrillic: that
// would change what VOICEVOX/COEIROINK/AivisSpeech receive (they would start
// being handed Russian-only chunks they cannot voice), which is a different
// change and an unmeasured one. The engine declares its own pipeline in
// ttsEngineCatalog.ts instead.
//
// There is no Cyrillic equivalent of stripLeadingPause: that strip exists for
// OpenJTalk's "First mora should not be short pause" stall, which is specific
// to those engines. The Russian service does its own character handling
// (guillemets, dashes, digits, Latin) before synthesis.
const RU_SPEAKABLE_RE = /[\p{Script=Cyrillic}A-Za-z0-9]/u;
function hasCyrillicSpeakableContent(text: string): boolean {
  return RU_SPEAKABLE_RE.test(text || '');
}

/**
 * Turn a failed engine response into an error that actually says what happened.
 *
 * These engines answer a rejection with a status AND a body explaining it —
 * unknown speaker, model not loaded yet, text it can't read, request too long.
 * Throwing a bare "audio_query failed" discarded every bit of that, which is
 * precisely why an AivisSpeech failure during streaming could not be diagnosed
 * from the log. Now the status, the body, and the request shape travel with it.
 */
async function engineError(label: string, res: Response, extra?: Record<string, unknown>): Promise<Error> {
  let body = '';
  try { body = (await res.text()).slice(0, 400).replace(/\s+/g, ' ').trim(); } catch { /* body already consumed or empty */ }
  const bits = Object.entries(extra || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  return new Error(
    `${label} → HTTP ${res.status} ${res.statusText || ''}`.trim() +
    (bits ? ` · ${bits}` : '') +
    (body ? ` · ${body}` : '')
  );
}

// `audio_query` carries the text in the QUERY STRING, and Japanese costs 9
// characters per character once percent-encoded (3 UTF-8 bytes × "%XX"). The
// engines are Python/uvicorn, which caps the request line — so a long enough
// chunk is rejected by the HTTP layer before synthesis is even attempted. This
// is a prime suspect whenever "context mode" feeds whole paragraphs to
// AivisSpeech, so log it rather than let it fail silently.
const LONG_QUERY_WARN_BYTES = 6000;

// Diagnostics filled in per segment and returned to the browser as response
// headers, so the conversation window can show what the engine is actually
// doing. Everything here was already known server-side — it was going to
// console.warn, where an unstable engine is invisible during a VRChat session.
export interface SynthMeta {
  engine: number;
  engineState: 'running' | 'launched' | 'failed' | 'unknown';
  engineError?: string;
  chars: number;
  skipped: boolean;
}

// Resolves a character/style INDEX from a saved NAME first, falling back to
// the saved index only when no name was supplied or nothing matches. Engine
// speaker lists are not stable across restarts — adding a new voice model
// ahead of an existing one shifts every index after it, so an index alone can
// silently point at a different character than the one the user picked.
// `name`/`speakerName` and `name`/`styleName` cover Voicevox/AivisSpeech vs
// Coeiroink's field naming (mirrors the lookup in VoiceSelector.tsx).
function resolveByName(list: any[], idx: number, name?: string): any {
  if (name) {
    const found = list.find((item) => (item?.name || item?.speakerName || item?.styleName) === name);
    if (found) return found;
  }
  return list[idx];
}

// Engine name → numeric id used to be restated here as a second literal map.
// It is now read from the shared catalog: this file and ttsEngines.ts dispatch
// on the same identity, and adding an engine in one place cannot leave the
// other throwing "Invalid engine" for a voice the picker happily offers.

async function synthesizeSegment(text: string, engine: number | string, char_idx: number, style_idx: number, speed: number = 1.0, pitch: number = 0.0, dictPairs: [string, string][] = [], meta?: SynthMeta, char_name?: string, style_name?: string): Promise<ArrayBuffer | null> {
    // Resolve engine names to numeric ids so the `if (engine === N)` branches
    // below still discriminate correctly. The caller (MessageBubble → TTS context)
    // passes whatever the identity system hands it, which is now always a name.
    if (typeof engine === 'string') {
      const resolved = ttsEngineByKey(engine);
      if (!resolved) {
        throw new Error(
          `Invalid engine: "${engine}". Expected one of: ${TTS_ENGINES.map(e => e.key).join(', ')}.`
        );
      }
      engine = resolved.num;
    }

    // Which text pre-processing this engine's input needs — data, not a special
    // case bolted on here. See the comment on RU_SPEAKABLE_RE above for what
    // running Russian through the Japanese pipeline actually did.
    const pipeline = ttsEngineByNum(engine)?.textPipeline ?? 'japanese';

    // Per-entity pronunciation dictionary (local_data/tts_dict/<folder>.json):
    // literal CJK-friendly substring replacement, applied FIRST so an entity can
    // override any reading (names, jargon) before the generic passes below.
    text = applyTtsDict(text, dictPairs);

    if (pipeline === 'japanese') {
      // Replace English words/phrases with Katakana equivalents before synthesis
      // so Voicevox / Coeiroink pronounce them correctly instead of spelling them.
      // Dictionary: local_data/en_katakana_dict.json (user-editable).
      text = convertEnglishToKatakana(text);

      // Trim any leading pause-inducing characters so OpenJTalk doesn't try to
      // make the first mora a short pause (the "First mora should not be short
      // pause" warning + 1-2s stall). Done before the speakable check so a chunk
      // that was ALL leading punctuation correctly drops out as empty.
      text = stripLeadingPause(text);
    }

    // Skip unspeakable (phoneme-less) chunks. Returning null tells the caller to
    // drop this segment instead of pushing a buffer — prevents the 500 above.
    if (meta) { meta.engine = engine; meta.chars = text.length; }
    const speakable = pipeline === 'cyrillic'
      ? hasCyrillicSpeakableContent(text)
      : hasSpeakableContent(text);
    if (!speakable) { if (meta) meta.skipped = true; return null; }

    // Start the engine if it isn't running and the user configured its path in
    // Preferences → VRChat & Audio. Deliberately placed AFTER the speakable
    // check so a punctuation-only chunk never boots an engine.
    //
    // Never throws and never blocks the no-configuration case: if the engine is
    // already up this is a cached no-op, and if there's no path we fall through
    // and let the normal connection error surface exactly as before.
    const ensured = await ensureEngineRunning(engine);
    if (!ensured.ok && ensured.error) console.warn(`[tts] ${ensured.error}`);
    if (meta) {
      meta.engineState = ensured.ok ? (ensured.launched ? 'launched' : 'running') : 'failed';
      if (ensured.error) meta.engineError = ensured.error;
    }

    if (engine === 0) {
      const vvData = JSON.parse(fs.readFileSync(speakersJsonPath(), 'utf8'));
      const char = resolveByName(vvData, char_idx, char_name);
      if (!char) throw new Error('Voicevox character not found');
      const style = resolveByName(char.styles, style_idx, style_name) || char.styles[0];
      const speakerId = style.id;

      const vvQueryUrl = `http://127.0.0.1:50021/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`;
      if (vvQueryUrl.length > LONG_QUERY_WARN_BYTES) {
        console.warn(`[tts] Voicevox audio_query URL is ${vvQueryUrl.length} bytes for ${text.length} chars.`);
      }
      const queryRes = await fetch(vvQueryUrl, { method: 'POST' });
      if (!queryRes.ok) {
        throw await engineError('Voicevox audio_query', queryRes, {
          speaker: speakerId, textChars: text.length, urlBytes: vvQueryUrl.length,
        });
      }
      const queryJson = await queryRes.json();

      queryJson.speedScale = speed;
      queryJson.pitchScale = pitch;

      const synthRes = await fetch(`http://127.0.0.1:50021/synthesis?speaker=${speakerId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(queryJson)
      });
      if (!synthRes.ok) {
        throw await engineError('Voicevox synthesis', synthRes, { speaker: speakerId, textChars: text.length });
      }

      return await synthRes.arrayBuffer();
    }
    else if (engine === 1) {
      const coeRes = await fetch('http://127.0.0.1:50032/v1/speakers');
      if (!coeRes.ok) throw new Error('Failed to fetch Coeiroink speakers');
      const coeData = await coeRes.json();
      const char = resolveByName(coeData, char_idx, char_name);
      if (!char) throw new Error('Coeiroink character not found');
      const style = resolveByName(char.styles, style_idx, style_name) || char.styles[0];

      const payload = {
        speakerUuid: char.speakerUuid, styleId: style.styleId, text,
        speedScale: speed, volumeScale: 1.0, pitchScale: pitch,
        intonationScale: 1.0, prePhonemeLength: 0.1, postPhonemeLength: 0.1, outputSamplingRate: 24000
      };
      
      const synthRes = await fetch('http://127.0.0.1:50032/v1/synthesis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (!synthRes.ok) {
        throw await engineError('Coeiroink synthesis', synthRes, {
          styleId: style?.styleId, textChars: text.length,
        });
      }
      
      return await synthRes.arrayBuffer();
    }
    else if (engine === 2) {
      // AivisSpeech (Style-Bert-VITS2). VOICEVOX-compatible HTTP API on :10101.
      // Same audio_query → synthesis flow as Voicevox, but speakers come from the
      // engine's /speakers endpoint. Expressiveness/emotion is INFERRED from the
      // text by Style-Bert-VITS2's BERT analysis (no instruction needed) — which
      // is why larger, whole-message chunks read more naturally (see the
      // "context mode" chunking in MessageBubble).
      const base = process.env.NEXUS_AIVISSPEECH_URL || 'http://127.0.0.1:10101';
      const spkRes = await fetch(`${base}/speakers`);
      if (!spkRes.ok) throw new Error('Failed to fetch AivisSpeech speakers');
      const spkData = await spkRes.json();
      const char = resolveByName(spkData, char_idx, char_name);
      if (!char) throw new Error('AivisSpeech character not found');
      const style = resolveByName(char.styles, style_idx, style_name) || char.styles[0];
      const speakerId = style.id;

      const queryUrl = `${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`;
      if (queryUrl.length > LONG_QUERY_WARN_BYTES) {
        console.warn(`[tts] AivisSpeech audio_query URL is ${queryUrl.length} bytes for ${text.length} chars — long enough to be rejected by the engine's HTTP layer. Consider turning Context mode off for this entity, or shortening the chunk.`);
      }
      const queryRes = await fetch(queryUrl, { method: 'POST' });
      if (!queryRes.ok) {
        throw await engineError('AivisSpeech audio_query', queryRes, {
          speaker: speakerId, textChars: text.length, urlBytes: queryUrl.length,
          styleName: style?.name ?? '?', charName: char?.name ?? '?',
        });
      }
      const queryJson = await queryRes.json();

      queryJson.speedScale = speed;
      queryJson.pitchScale = pitch;

      const synthRes = await fetch(`${base}/synthesis?speaker=${speakerId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(queryJson)
      });
      if (!synthRes.ok) {
        throw await engineError('AivisSpeech synthesis', synthRes, {
          speaker: speakerId, textChars: text.length,
        });
      }

      return await synthRes.arrayBuffer();
    }
    else if (engine === 3) {
      // vosk-tts + RUAccent (Russian). An external HTTP service, not a bundled
      // binary — see workspace/ru_tts_lab/server.py and the engine row in
      // Preferences → VRChat & Audio.
      //
      // Deliberately NOT VOICEVOX-API-shaped. audio_query exists to hand back
      // OpenJTalk accent phrases for editing; faking one so this engine could
      // reuse the flow above would mean inventing a Japanese-prosody object for
      // Russian text and reading it back unchanged. One POST that says what it
      // does is the smaller lie-free option.
      //
      // Text travels in the BODY, not the query string: the two branches above
      // both have to warn about audio_query URLs blowing past uvicorn's request
      // line, because Japanese costs 9 bytes per character once percent-encoded
      // (Cyrillic costs 6). A body has no such ceiling, so that whole failure
      // mode does not exist here.
      const base = ENGINES[3].base;
      const spkRes = await fetch(`${base}/speakers`);
      if (!spkRes.ok) throw await engineError('vosk-tts + RUAccent /speakers', spkRes);
      const spkData = await spkRes.json();
      const char = resolveByName(spkData, char_idx, char_name);
      if (!char) throw new Error('vosk-tts + RUAccent voice not found');
      // Style here is the accent frontend: "RUAccent" (neural homograph
      // resolution) or "Dictionary only" (bare vosk). styles[0] is RUAccent.
      const style = resolveByName(char.styles, style_idx, style_name) || char.styles[0];
      const speakerId = style.id;

      const synthRes = await fetch(`${base}/synthesis?speaker=${speakerId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text, speedScale: speed, pitchScale: pitch }),
      });
      if (!synthRes.ok) {
        throw await engineError('vosk-tts + RUAccent synthesis', synthRes, {
          speaker: speakerId, textChars: text.length,
          styleName: style?.name ?? '?', charName: char?.name ?? '?',
        });
      }
      // vosk-tts has no pitch parameter of its own — its synth() takes
      // speech_rate, noise_level, duration_noise_level and scale, and `scale`
      // is a plain output gain (measured by introspection, and again from the
      // ONNX input list: scales = [noise_level, 1/speech_rate,
      // duration_noise_level]). Since 2026-10-23 the lab service produces
      // pitch from the finished waveform instead (WSOLA time-stretch by k,
      // then resample by k — ru_tts_lab/pitchshift.py).
      //
      // This reads the RESPONSE rather than deciding from a version number,
      // so neither side has to know which version the other is. An old
      // service answers Ignored=1 and gets the old warning; a new one answers
      // Ignored=0 with the multiplier it actually applied.
      if (Math.abs(pitch) > 1e-9) {
        if (synthRes.headers.get('X-Ru-Pitch-Ignored') === '1') {
          console.warn(`[tts] this vosk-tts service discards pitch; voicePitch=${pitch} had no effect. Restart the Russian TTS service to pick up pitch support.`);
        } else if (synthRes.headers.get('X-Ru-Pitch-Clamped') === '1') {
          console.warn(`[tts] voicePitch=${pitch} is past this engine's range; applied ×${synthRes.headers.get('X-Ru-Pitch-Applied')} (${synthRes.headers.get('X-Ru-Pitch-Semitones')} semitones). Moving the slider further will not change it.`);
        }
      }

      return await synthRes.arrayBuffer();
    } else {
        throw new Error(`Invalid engine: ${engine}`);
    }
}

function concatenateWavs(buffers: ArrayBuffer[]): Buffer {
    if (buffers.length === 0) return Buffer.alloc(0);
    if (buffers.length === 1) return Buffer.from(buffers[0]);
    
    const headerSize = 44;
    let totalDataSize = 0;
    
    for (const buf of buffers) {
        totalDataSize += (buf.byteLength - headerSize);
    }
    
    const finalBuffer = Buffer.alloc(headerSize + totalDataSize);
    
    const firstBuf = Buffer.from(buffers[0]);
    firstBuf.copy(finalBuffer, 0, 0, headerSize);
    
    finalBuffer.writeUInt32LE(finalBuffer.length - 8, 4);
    finalBuffer.writeUInt32LE(totalDataSize, 40);
    
    let offset = headerSize;
    for (const buf of buffers) {
        const nodeBuf = Buffer.from(buf);
        const dataSize = nodeBuf.length - headerSize;
        nodeBuf.copy(finalBuffer, offset, headerSize, nodeBuf.length);
        offset += dataSize;
    }
    
    return finalBuffer;
}

// Headers must be latin-1; engine errors carry Japanese and box characters.
function headerSafe(s: string): string {
  return encodeURIComponent(String(s || '').slice(0, 500));
}

export async function POST(req: Request) {
  const started = Date.now();
  const meta: SynthMeta = { engine: -1, engineState: 'unknown', chars: 0, skipped: false };
  try {
    const data = await req.json();
    let buffers: ArrayBuffer[] = [];

    // Load the per-entity pronunciation dictionary once per request (cached by
    // mtime in the lib). `folderName` is sent by the TTS callers.
    const dictPairs = loadTtsDictPairs(data.folderName || '');

    if (data.segments && Array.isArray(data.segments)) {
      for (const seg of data.segments) {
        const buf = await synthesizeSegment(seg.text, seg.engine, seg.char_idx, seg.style_idx, seg.speed || 1.0, seg.pitch ?? 0.0, dictPairs, meta, seg.char_name, seg.style_name);
        if (buf) buffers.push(buf);
      }
    } else {
       const buf = await synthesizeSegment(data.text, data.engine, data.char_idx, data.style_idx, data.speed || 1.0, data.pitch ?? 0.0, dictPairs, meta, data.char_name, data.style_name);
       if (buf) buffers.push(buf);
    }

    const finalWav = concatenateWavs(buffers);

    // Diagnostics ride along with the audio. The browser reads them to drive the
    // live TTS indicator; nothing here changes the audio itself.
    return new NextResponse(finalWav, {
      headers: {
        'Content-Type': 'audio/wav',
        'X-Tts-Engine': String(meta.engine),
        'X-Tts-Engine-State': meta.engineState,
        'X-Tts-Chars': String(meta.chars),
        'X-Tts-Skipped': meta.skipped ? '1' : '0',
        'X-Tts-Ms': String(Date.now() - started),
        ...(meta.engineError ? { 'X-Tts-Engine-Error': headerSafe(meta.engineError) } : {}),
      },
    });

  } catch (e: any) {
    console.error('TTS Error:', e);
    // The failure reason travels in the body AND in a header, because the
    // streaming client used to discard the body entirely — which is exactly why
    // an unstable AivisSpeech could not be diagnosed from the UI.
    return NextResponse.json(
      { error: e.message, engine: meta.engine, engineState: meta.engineState, chars: meta.chars },
      {
        status: 500,
        headers: {
          'X-Tts-Engine': String(meta.engine),
          'X-Tts-Engine-State': meta.engineState,
          'X-Tts-Chars': String(meta.chars),
          'X-Tts-Ms': String(Date.now() - started),
          'X-Tts-Error': headerSafe(e?.message || 'synthesis failed'),
        },
      },
    );
  }
}
