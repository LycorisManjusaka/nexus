import { NextResponse } from 'next/server';
import fs from 'fs';
import { speakersJsonPath } from '@/lib/voicechangerPaths';

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
      const coeRes = await fetch('http://127.0.0.1:50032/v1/speakers');
      if (coeRes.ok) {
        coeiroink = await coeRes.json();
      }
    } catch(e) {
      console.error('Failed to fetch Coeiroink speakers', e);
    }

    let aivisspeech = [];
    try {
      const base = process.env.NEXUS_AIVISSPEECH_URL || 'http://127.0.0.1:10101';
      const aRes = await fetch(`${base}/speakers`);
      if (aRes.ok) {
        aivisspeech = await aRes.json();
      }
    } catch(e) {
      console.error('Failed to fetch AivisSpeech speakers', e);
    }

    return NextResponse.json({ voicevox, coeiroink, aivisspeech });
  } catch(e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
