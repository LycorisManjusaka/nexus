import { NextResponse } from 'next/server';
import { readCharacterMap } from '@/lib/characterMap';

export const dynamic = 'force-dynamic';

/**
 * Every identity in character_map.json, in file order.
 *
 * File order is meaningful: it is the order the identity dropdown shows, and the
 * order the spoken command "〇番目の人格に切り替えてください" counts through. That
 * index is never stored anywhere — it is resolved to a name the moment the
 * command is heard.
 *
 * `engines` is gone from the response: engine is now a name on each rule, so
 * there is no number-to-engine table left to hand out.
 */
export async function GET() {
  try {
    const map = readCharacterMap();
    const characters = map.rules.map((r) => ({
      name: r.name,
      engine: r.engine,
      character: r.character,
      defaultStyle: r.defaultStyle,
      hasVoice: !!(r.engine && r.character),
    }));
    return NextResponse.json({ characters, fallback: map.fallback, humanLabel: map.humanLabel });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, characters: [] }, { status: 500 });
  }
}
