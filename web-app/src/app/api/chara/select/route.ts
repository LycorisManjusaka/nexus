import { NextResponse } from 'next/server';
import { readCharacterMap, findIdentity } from '@/lib/characterMap';
import { writeUserIdentitySelection, readUserIdentitySelection, resolveUserIdentity } from '@/lib/userIdentity';

export const dynamic = 'force-dynamic';

/**
 * Selects the identity (and optionally the speaking style) that is "me" right
 * now, by writing local_data/user_identity.json.
 *
 * Body: { name?: string, style?: string | null }
 *   - name   — an identity from character_map.json. Omit to keep the current
 *              one and change only the style.
 *   - style  — a style NAME for this session. null/"" clears the override, so
 *              the identity's own defaultStyle applies again.
 *
 * Switching identity clears any style override: a style belongs to one specific
 * character, so carrying it across would name a style the new character has
 * never heard of.
 *
 * An identity with no voice at all is selectable — that is the point of the
 * voice being optional. It simply won't be spoken.
 *
 * This is the ONLY writer of the selection. The voice changer re-reads the same
 * file on every utterance, so a pick made in any conversation window takes
 * effect everywhere at once, including in the spoken voice.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const map = readCharacterMap();

    const current = readUserIdentitySelection();
    const requestedName: string | undefined =
      typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
    const identityName = requestedName || current?.identity || map.fallback;

    const rule = findIdentity(map, identityName);
    if (!rule) {
      return NextResponse.json({ error: `Unknown identity: "${identityName}"` }, { status: 404 });
    }

    const identityChanged = !current || current.identity !== rule.name;
    let style: string | undefined;
    if (body && Object.prototype.hasOwnProperty.call(body, 'style')) {
      style = typeof body.style === 'string' && body.style.trim() ? body.style.trim() : undefined;
    } else if (!identityChanged) {
      style = current?.style;
    }
    // An explicit pick that merely names the identity's own default is stored as
    // "no override" — absent already means exactly that.
    if (style && style === rule.defaultStyle) style = undefined;

    writeUserIdentitySelection({ identity: rule.name, style });

    const resolved = resolveUserIdentity(map);
    return NextResponse.json({
      ok: true,
      name: resolved.name,
      style: resolved.style,
      styleIsOverride: resolved.styleIsOverride,
      engine: rule.engine,
      character: rule.character,
      defaultStyle: rule.defaultStyle,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
