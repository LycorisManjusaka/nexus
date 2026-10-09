import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { CHAR_MAP_PATH, DEFAULT_COMMENT, DEFAULT_OTHERS_LABEL, IdentityRule, CharacterMap, readCharacterMap } from '@/lib/characterMap';

/**
 * The identity map editor's backing store (Preferences → User Identity).
 *
 * Reading goes through lib/characterMap.ts so the editor sees ONE schema no
 * matter which generation is on disk: a legacy numeric rule
 * (`engine: "0", charId: "21"`) is translated to names on the way out. That
 * translation needs the engine's cached speaker catalog; where the catalog is
 * missing, the numbers cannot be turned into a name and the rule arrives here
 * as a bare display name with no voice. That is visible in the editor — the
 * "has a voice" box is simply unchecked — and re-picking the character fixes it
 * permanently. Nothing is rewritten on read; only POST touches disk.
 *
 * Writing always produces the current schema: `{ name, engine?, character?,
 * defaultStyle? }`. The old top-level `engines` number table is not carried
 * forward — engine is a name on each rule now, so there is nothing left to look
 * up in it.
 */
export type CharacterMapRule = IdentityRule;

export async function GET() {
  const map = readCharacterMap();
  // Defensive: guarantee "Anonymous" is always present so the editor always has
  // the one entry it can never lose, even if a hand-edit dropped it. This does
  // not touch disk — only POST persists.
  if (!map.rules.some(r => r.name === 'Anonymous')) {
    map.rules = [{ name: 'Anonymous' }, ...map.rules];
  }
  return NextResponse.json({ ...map, _comment: map._comment || DEFAULT_COMMENT });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rules: any[] = Array.isArray(body.rules) ? body.rules : [];
    const fallback: string = typeof body.fallback === 'string' ? body.fallback : 'Anonymous';
    const humanLabel: string = typeof body.humanLabel === 'string' ? body.humanLabel : DEFAULT_OTHERS_LABEL;

    // ── Validation ──────────────────────────────────────────────────────────
    const names = rules.map(r => (r?.name || '').trim());
    if (names.some(n => !n)) {
      return NextResponse.json({ error: 'Every identity needs a name.' }, { status: 400 });
    }
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) {
        return NextResponse.json({ error: `Duplicate identity name: "${n}"` }, { status: 400 });
      }
      seen.add(n);
    }
    if (!names.includes('Anonymous')) {
      // "Anonymous" cannot be deleted — enforced in the UI, and re-checked here
      // so a stray client bug or hand-crafted request can't remove it.
      return NextResponse.json({ error: '"Anonymous" cannot be removed.' }, { status: 400 });
    }
    if (!names.includes(fallback)) {
      return NextResponse.json({ error: `Fallback identity "${fallback}" is not in the list.` }, { status: 400 });
    }

    // Strip empty-string voice fields down to "absent" so a rule cleared back to
    // no-voice doesn't persist as engine:"" / character:"". A character without
    // an engine (or the reverse) is not a usable voice, so a half-filled pair is
    // dropped rather than stored — it would only fail later, further from here.
    const cleanRules: IdentityRule[] = rules.map(r => {
      const out: IdentityRule = { name: String(r.name).trim() };
      const engine = r.engine ? String(r.engine).trim() : '';
      // Preserve the engine even when the character hasn't been picked yet.
      // An identity with an engine but no character is a valid intermediate
      // state: "this person has a Coeiroink voice but I haven't selected which
      // character yet." The UI shows the engine dropdown and the character
      // picker empty, and the next save (after picking a character) completes
      // the pair. Dropping engine here would silently erase the choice.
      if (engine) {
        out.engine = engine;
        const character = r.character ? String(r.character).trim() : '';
        if (character) out.character = character;
        const defaultStyle = r.defaultStyle ? String(r.defaultStyle).trim() : '';
        if (defaultStyle) out.defaultStyle = defaultStyle;
      }
      return out;
    });

    const existing = readCharacterMap();
    const next: CharacterMap = {
      _comment: existing._comment || DEFAULT_COMMENT,
      rules: cleanRules,
      fallback,
      humanLabel: humanLabel.trim() || DEFAULT_OTHERS_LABEL,
    };

    // Atomic write: temp file in the same directory, then rename. Config
    // corruption here would break every identity in Nexus, so this gets the same
    // same-volume-rename-is-atomic treatment fsStorage.ts uses for logs, inlined
    // here since that helper isn't exported.
    const dir = path.dirname(CHAR_MAP_PATH);
    const tmp = path.join(dir, `.character_map.json.tmp-${process.pid}-${Date.now()}`);
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
    await fs.rename(tmp, CHAR_MAP_PATH);

    return NextResponse.json({ ok: true, map: next });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
