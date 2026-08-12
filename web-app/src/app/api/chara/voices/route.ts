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
    const engines: Record<string, string> = map.engines || {};

    let settings: any = {};
    if (fs.existsSync(charaSettingsPath())) {
      try { settings = JSON.parse(fs.readFileSync(charaSettingsPath(), 'utf-8')); } catch {}
    }

    const characters = (map.rules || []).map((r: any) => {
      // New-format rule: engine name string + charName
      if (r.engine && r.charName) {
        let style_name: string | undefined = r.styleName;
        if (!style_name && settings?.[r.engine]?.character_styles) {
          const s = settings[r.engine].character_styles[r.charName];
          if (typeof s === 'string' && s) style_name = s;
        }
        return {
          name: r.name,
          voice: {
            engine: r.engine,
            char_name: r.charName,
            style_name,
            speed: 1.0,
          },
        };
      }

      // Old-format rule: numeric engine string + charId
      if (r.engine !== undefined && r.charId !== undefined) {
        // Reverse-lookup engine name from engines map
        let engineName: string | null = null;
        for (const [key, val] of Object.entries(engines)) {
          if (val === r.engine) { engineName = key; break; }
        }
        if (!engineName) return { name: r.name, voice: null };

        // We can't resolve charId to a character name without the live
        // speaker list, so style_name can only come from r.styleName or
        // the numeric character_styles lookup.
        let style_name: string | undefined = r.styleName;
        if (!style_name && settings?.[engineName]?.character_styles) {
          const s = settings[engineName].character_styles[String(r.charId)];
          if (typeof s === 'string' && s) style_name = s;
          // Also try numeric style index
          if (!style_name && typeof s === 'number') {
            // Can't resolve numeric style index to name without live speaker list.
            // Leave undefined — synthesis will use engine default.
          }
        }
        return {
          name: r.name,
          voice: {
            engine: engineName,
            char_id: r.charId,
            style_name,
            speed: 1.0,
          },
        };
      }

      // Name-only rule (no voice)
      return { name: r.name, voice: null };
    });

    return NextResponse.json({ characters });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, characters: [] }, { status: 500 });
  }
}
