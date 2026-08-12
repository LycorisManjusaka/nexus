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

    // `engine`/`charName` (new format) or `engine`/`charId` (old numeric
    // format) — at least one of these pairs must exist for a voice switch.
    // A name-only rule (neither charName NOR charId) is valid for display/
    // letters but can't drive a voice-changer selection.
    const hasNewFmt = rule.engine && rule.charName;
    const hasOldFmt = rule.engine !== undefined && rule.charId !== undefined;

    if (!hasNewFmt && !hasOldFmt) {
      return NextResponse.json({
        error: `"${name}" has no engine/character set in character_map.json — it has a display name but no TTS voice to switch to.`,
      }, { status: 400 });
    }

    // Resolve engine name. New-format rules carry the name directly
    // ("voicevox" / "coeiroink" / "aivisspeech"); old-format rules carry a
    // numeric string ("0" / "1" / "2") that we reverse-lookup through the
    // engines map.
    const engines: Record<string, string> = map.engines || {};
    let engineName: string;
    if (hasNewFmt) {
      engineName = rule.engine;
    } else {
      // Reverse lookup: "1" → "coeiroink"
      let found: string | null = null;
      for (const [key, val] of Object.entries(engines)) {
        if (val === rule.engine) { found = key; break; }
      }
      if (!found) {
        return NextResponse.json({
          error: `Engine "${rule.engine}" (from "${name}") has no entry in character_map.json engines map`,
        }, { status: 500 });
      }
      engineName = found;
    }

    // Read existing chara_settings.json or initialize
    let settings: any = {};
    if (fs.existsSync(charaSettingsPath())) {
      try { settings = JSON.parse(fs.readFileSync(charaSettingsPath(), 'utf-8')); } catch { settings = {}; }
    }

    settings.current_engine = engineName;
    if (!settings[engineName] || typeof settings[engineName] !== 'object') {
      settings[engineName] = {};
    }
    if (!settings[engineName].character_styles) settings[engineName].character_styles = {};

    if (hasNewFmt) {
      // New format: write name-based fields
      settings[engineName].current_character_name = rule.charName;
      if (rule.styleName) {
        settings[engineName].character_styles[rule.charName] = rule.styleName;
      }
    } else {
      // Old format: write numeric fields (Python voice_changer.py still
      // reads current_character, not current_character_name). Also write
      // the name-based field as null so readers know it was deliberately
      // cleared — prevents a stale name from a previous selection from
      // being treated as current.
      settings[engineName].current_character = parseInt(String(rule.charId), 10);
      settings[engineName].current_character_name = null;
      // Apply style as a numeric index if present
      if (rule.styleId !== undefined) {
        settings[engineName].character_styles[String(rule.charId)] = parseInt(String(rule.styleId), 10);
      }
    }

    fs.writeFileSync(charaSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');

    return NextResponse.json({
      ok: true,
      name,
      engine: engineName,
      ...(hasNewFmt
        ? { charName: rule.charName }
        : { charId: rule.charId }),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
