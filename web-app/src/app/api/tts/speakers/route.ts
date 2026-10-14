import { NextResponse } from 'next/server';
import fs from 'fs';
import { speakersJsonPath } from '@/lib/voicechangerPaths';
import { ENGINES } from '@/lib/ttsEngines';

// Probing an engine that isn't installed normally fails in milliseconds
// (ECONNREFUSED on a closed loopback port). But "refused" is not the only way a
// port can be absent — a filtered port, or an engine mid-start that accepted the
// socket and hasn't answered yet, leaves the fetch hanging with no default
// timeout in Node. This route is loaded on mount by the identity/voice editors,
// so a hang there is a panel that never finishes loading. An engine that can't
// answer in 5 s is, for the purpose of listing voices, not running.
const PROBE_TIMEOUT_MS = 5000;

export async function GET() {
  try {
    let voicevox = [];
    try {
      const vvData = fs.readFileSync(speakersJsonPath(), 'utf8');
      voicevox = JSON.parse(vvData);
    } catch(e) {
      console.error('Failed to read Voicevox speakers', e);
    }
    
    let coeiroink = [];
    try {
      const coeRes = await fetch('http://127.0.0.1:50032/v1/speakers', {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (coeRes.ok) {
        coeiroink = await coeRes.json();
      }
    } catch(e) {
      console.error('Failed to fetch Coeiroink speakers', e);
    }

    let aivisspeech = [];
    try {
      const base = process.env.NEXUS_AIVISSPEECH_URL || 'http://127.0.0.1:10101';
      const aRes = await fetch(`${base}/speakers`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (aRes.ok) {
        aivisspeech = await aRes.json();
      }
    } catch(e) {
      console.error('Failed to fetch AivisSpeech speakers', e);
    }

    // vosk-tts + RUAccent (Russian). Same treatment: an engine that isn't
    // installed, or is still loading its models, contributes an empty list
    // rather than failing the whole response — the picker then shows "not
    // running" and a Start button, exactly as for the two above.
    //
    // Its /speakers deliberately answers 503 until BOTH models are loaded, and
    // this is why: the voice picker treats "the list appeared" as "the engine
    // is ready" and stops waiting.
    let vosk_ra = [];
    try {
      const rRes = await fetch(`${ENGINES[3].base}/speakers`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (rRes.ok) {
        vosk_ra = await rRes.json();
      }
    } catch(e) {
      console.error('Failed to fetch vosk-tts + RUAccent speakers', e);
    }

    return NextResponse.json({ voicevox, coeiroink, aivisspeech, vosk_ra });
  } catch(e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
