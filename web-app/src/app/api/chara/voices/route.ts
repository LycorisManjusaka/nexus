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

    const characters = (map.rules || []).map((r: any) => {
      // `engine`/`charName` are optional on a rule (a name-only entry is
      // valid — e.g. registered purely as a letters recipient or display
      // name). Without both, there is no TTS voice to resolve. Return
      // voice: null so callers (MessageBubble's tag lookup) correctly fall
      // back to the default voice rather than speaking as someone else.
      if (!r.engine || !r.charName) {
        return { name: r.name, voice: null };
      }
      // A rule-configured style (set via Preferences → User Identity) is the
      // identity's own intended style and takes priority; otherwise fall back
      // to whatever the voicechanger's live runtime state currently has on
      // record for that character name. Leaving style_name undefined here is
      // deliberate when neither source has one — synthesis falls through to
      // the engine's own default style rather than a silently-assumed one.
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
    });

    return NextResponse.json({ characters });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, characters: [] }, { status: 500 });
  }
}
