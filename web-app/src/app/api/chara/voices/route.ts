import { NextResponse } from 'next/server';
import { readCharacterMap } from '@/lib/characterMap';
import { resolveUserIdentity } from '@/lib/userIdentity';

export const dynamic = 'force-dynamic';

/**
 * Ready-to-use TTS voice configs for every identity in character_map.json.
 *
 * Used by MessageBubble's "Read Aloud" so a `[name]` tag inside a message can be
 * matched against character_map.json (in addition to the folder-name match),
 * letting a user identity speak in its own voice without a dummy folder.
 *
 * The voice is entirely name-based now — engine name, character name, style
 * name — which is exactly what /api/tts/synthesize already accepts. There is no
 * longer a second file to consult: an identity's default style lives on the
 * identity itself, so chara_settings.json's per-engine `character_styles` map
 * has nothing left to add.
 *
 * The one live piece is the style override in user_identity.json: it belongs to
 * whichever identity is selected right now, so it is applied to that identity
 * only. Everyone else speaks in their own default style.
 *
 * `voice: null` means "this identity has no voice", which is a normal state, not
 * an error — the caller simply doesn't speak that tag.
 */
export async function GET() {
  try {
    const map = readCharacterMap();
    const active = resolveUserIdentity(map);
    const characters = map.rules.map((r) => {
      // An identity with an engine but no resolved character is a real case:
      // the engine's speaker catalog hasn't been cached yet (engine has never
      // been run on this machine). The voice IS on that engine — we just don't
      // know which character yet. Passing engine alone lets the TTS route use
      // the engine's first available character; without this, the identity
      // silently falls back to a completely different engine, which is actively
      // wrong. A character-less voice config carries no char_name/style_name,
      // so synthesizeSegment resolves them at char_idx 0 / style_idx 0.
      const voice = r.engine
        ? {
            engine: r.engine,
            char_name: r.character || undefined,
            style_name: r.name === active.name
              ? active.style
              : r.defaultStyle,
            speed: 1.0,
          }
        : null;
      return { name: r.name, voice };
    });
    return NextResponse.json({ characters });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, characters: [] }, { status: 500 });
  }
}
