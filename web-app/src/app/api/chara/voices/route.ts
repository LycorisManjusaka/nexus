import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { charaSettingsPath } from '@/lib/voicechangerPaths';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

export const dynamic = 'force-dynamic';

/**
 * Returns ready-to-use TTS voice configs for every character in
 * character_map.json. Style index is pulled from chara_settings.json's
 * per-engine `character_styles` map when available, falling back to 0.
 *
 * Used by MessageBubble's "Read Aloud" feature so [name] tags inside a user
 * message can be matched against character_map.json (in addition to the
 * existing folder-name match), letting user characters speak in their own
 * voice without a dedicated dummy folder.
 */
export async function GET() {
  try {
    if (!fs.existsSync(CHAR_MAP_PATH)) {
      return NextResponse.json({ characters: [] });
    }
    const map = JSON.parse(fs.readFileSync(CHAR_MAP_PATH, 'utf-8'));

    let settings: any = {};
    if (fs.existsSync(charaSettingsPath())) {
      try { settings = JSON.parse(fs.readFileSync(charaSettingsPath(), 'utf-8')); } catch {}
    }

    // engine number → engine key (e.g., "0" → "voicevox")
    const engineByNum: Record<string, string> = {};
    for (const [key, num] of Object.entries(map.engines || {})) {
      engineByNum[num as string] = key;
    }

    const characters = (map.rules || []).map((r: any) => {
      // `engine`/`charId` are optional on a rule (a name-only entry is valid —
      // e.g. registered purely as a letters recipient or display name). Without
      // both, there is no TTS voice to resolve: previously this fell through to
      // parseInt(undefined) === NaN, and `NaN || 0` downstream silently picked
      // engine 0 / character 0 — the wrong voice, not "no voice". Return
      // voice: null instead so callers (MessageBubble's tag lookup) correctly
      // fall back to the default voice rather than speaking as someone else.
      if (r.engine === undefined || r.engine === null || r.charId === undefined || r.charId === null) {
        return { name: r.name, voice: null };
      }
      const engineKey = engineByNum[r.engine];
      let style_idx = 0;
      if (engineKey && settings?.[engineKey]?.character_styles) {
        const s = settings[engineKey].character_styles[String(r.charId)];
        if (typeof s === 'number') style_idx = s;
      }
      return {
        name: r.name,
        voice: {
          engine: parseInt(String(r.engine), 10),
          char_idx: parseInt(String(r.charId), 10),
          style_idx,
          speed: 1.0,
        },
      };
    });

    return NextResponse.json({ characters });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, characters: [] }, { status: 500 });
  }
}
