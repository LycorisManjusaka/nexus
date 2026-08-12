import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { charaSettingsPath, VOICECHANGER_DATA_DIR, ensureVoicechangerDataDir } from '@/lib/voicechangerPaths';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

export async function POST(req: Request) {
  try {
    const { name } = await req.json();
    if (typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    // Voice switching writes into local_data/voicechanger (the data half of the
    // voicechanger integration). It may not exist yet on a fresh machine.
    // Previously we no-op'd there, which made "Active Character" silently
    // unchangeable — it always reverted to the fallback. Instead, CREATE the
    // directory so the chara_settings.json written below persists. That single
    // file is all the web-app needs to read the selection back; the full
    // Python service isn't required just to choose a character.
    try {
      ensureVoicechangerDataDir();
    } catch (e: any) {
      return NextResponse.json(
        { error: `Could not create voicechanger data directory at "${VOICECHANGER_DATA_DIR}": ${e.message}` },
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

    // `engine`/`charName` are optional on a rule — a name-only entry is valid
    // for display/letters purposes, but there is no TTS voice to switch to.
    // Refuse this specific action (voice-changer character switch), not the
    // rule itself: the name still resolves everywhere that doesn't need a
    // voice. `engine` is already the engine's own name string here — no
    // reverse lookup through a numeric map needed.
    if (!rule.engine || !rule.charName) {
      return NextResponse.json({
        error: `"${name}" has no engine/character set in character_map.json — it has a display name but no TTS voice to switch to.`,
      }, { status: 400 });
    }
    const engineName: string = rule.engine;

    // Read existing chara_settings.json or initialize
    let settings: any = {};
    if (fs.existsSync(charaSettingsPath())) {
      try { settings = JSON.parse(fs.readFileSync(charaSettingsPath(), 'utf-8')); } catch { settings = {}; }
    }

    settings.current_engine = engineName;
    if (!settings[engineName] || typeof settings[engineName] !== 'object') {
      settings[engineName] = { current_character_name: null, character_styles: {} };
    }
    if (!settings[engineName].character_styles) settings[engineName].character_styles = {};
    settings[engineName].current_character_name = rule.charName;
    // If this identity has a style configured (Preferences → User Identity),
    // apply it every time the identity is selected — the pairing of voice +
    // style is what the user configured for this person, not a one-time
    // default. Otherwise leave whatever style is already on record for this
    // character alone (per-character last-used style, or nothing — resolved
    // to the engine's own default at synthesis time) rather than inventing
    // one; an unset style must never be silently written as though it were a
    // deliberate choice.
    if (rule.styleName) {
      settings[engineName].character_styles[rule.charName] = rule.styleName;
    }

    fs.writeFileSync(charaSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');

    return NextResponse.json({
      ok: true,
      name,
      engine: engineName,
      charName: rule.charName,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
