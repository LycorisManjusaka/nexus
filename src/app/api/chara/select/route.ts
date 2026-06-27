import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { charaSettingsPath, VOICECHANGER_DIR } from '@/lib/voicechangerPaths';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

export async function POST(req: Request) {
  try {
    const { name } = await req.json();
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    // Voice switching writes into the external voicechanger project. The folder
    // may not exist on machines that sync only the repo + local_data (e.g. a
    // work laptop without the Python voicechanger). Previously we no-op'd there,
    // which made "Active Character" silently unchangeable — it always reverted
    // to the fallback. Instead, CREATE the voicechanger directory so the
    // chara_settings.json written below persists. That single file is all the
    // web-app needs to read the selection back; the full Python service isn't
    // required just to choose a character.
    try {
      fs.mkdirSync(VOICECHANGER_DIR, { recursive: true });
    } catch (e: any) {
      return NextResponse.json(
        { error: `Could not create voicechanger directory at "${VOICECHANGER_DIR}": ${e.message}` },
        { status: 500 },
      );
    }

    if (!fs.existsSync(CHAR_MAP_PATH)) {
      return NextResponse.json({ error: 'character_map.json not found' }, { status: 500 });
    }
    const map = JSON.parse(fs.readFileSync(CHAR_MAP_PATH, 'utf-8'));
    const rule = (map.rules || []).find((r: any) => r.name === name);
    if (!rule) {
      return NextResponse.json({ error: `Character "${name}" not found in character_map.json` }, { status: 404 });
    }

    // Reverse-lookup engine number → engine key (e.g., "0" → "voicevox")
    const engines: Record<string, string> = map.engines || {};
    let engineName: string | null = null;
    for (const [key, val] of Object.entries(engines)) {
      if (val === rule.engine) { engineName = key; break; }
    }
    if (!engineName) {
      return NextResponse.json({
        error: `Engine number "${rule.engine}" has no entry in character_map.json engines map`,
      }, { status: 500 });
    }

    // Read existing chara_settings.json or initialize
    let settings: any = {};
    if (fs.existsSync(charaSettingsPath())) {
      try { settings = JSON.parse(fs.readFileSync(charaSettingsPath(), 'utf-8')); } catch { settings = {}; }
    }

    settings.current_engine = engineName;
    if (!settings[engineName] || typeof settings[engineName] !== 'object') {
      settings[engineName] = { current_character: 0, character_styles: {} };
    }
    if (!settings[engineName].character_styles) settings[engineName].character_styles = {};
    settings[engineName].current_character = parseInt(String(rule.charId), 10);
    // Make sure the character has a style entry; default 0 if new.
    if (!(String(rule.charId) in settings[engineName].character_styles)) {
      settings[engineName].character_styles[String(rule.charId)] = 0;
    }

    fs.writeFileSync(charaSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');

    return NextResponse.json({
      ok: true,
      name,
      engine: engineName,
      charId: rule.charId,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
