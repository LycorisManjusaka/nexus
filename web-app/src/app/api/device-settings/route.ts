import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { VOICECHANGER_DATA_DIR } from '@/lib/voicechangerPaths';

const SETTINGS_PATH = path.join(VOICECHANGER_DATA_DIR, 'device_settings.json');

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const voiceSpeakerKeyword = typeof body.voiceSpeakerKeyword === 'string' ? body.voiceSpeakerKeyword : '';
    const notificationSpeakerKeyword = typeof body.notificationSpeakerKeyword === 'string' ? body.notificationSpeakerKeyword : '';

    // Read existing settings so we preserve other fields (e.g. mic_keyword).
    // If the file doesn't exist yet, start from an empty object.
    let existing: Record<string, any> = {};
    try {
      const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
      existing = JSON.parse(raw);
    } catch {
      // File doesn't exist yet — that's fine, we'll create it.
    }

    const updated = {
      ...existing,
      voice_speaker_keyword: voiceSpeakerKeyword,
      notification_speaker_keyword: notificationSpeakerKeyword,
    };

    // Atomic write: temp file + rename, same pattern as the rest of Nexus.
    const tmpPath = SETTINGS_PATH + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(updated, null, 4), 'utf-8');
    await fs.rename(tmpPath, SETTINGS_PATH);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unknown error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({});
  }
}
