import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

export interface CharacterMapRule {
  name: string;
  // All voice fields are optional — a rule can be a bare display name with no
  // TTS voice behind it (e.g. a letters-only recipient). `engine` is the
  // engine's own NAME string ("voicevox" / "coeiroink" / "aivisspeech" / any
  // future engine — nothing here is hardcoded to a fixed list, so a new
  // engine needs no schema change). `charName`/`styleName` are the character
  // and style's real names as reported by that engine's own speaker list —
  // never numeric slot indices. A TTS engine's speaker-list index for a given
  // character shifts whenever a new voice is installed (confirmed on
  // Coeiroink and AivisSpeech), so only names are stable enough to persist
  // here; every identity's saved voice must keep pointing at the same
  // character/style even after the engine's speaker list is reordered.
  // `styleName` is left absent until a style is explicitly chosen — an unset
  // style is never silently written as if the engine's first/default style
  // had been picked.
  engine?: string;
  charName?: string;
  styleName?: string;
}

interface CharacterMapFile {
  _comment?: string;
  rules: CharacterMapRule[];
  fallback: string;
  humanLabel: string;
}

const EMPTY_MAP: CharacterMapFile = {
  _comment:
    'Maps voice-changer / partner identities to display names. Used everywhere Nexus needs a human participant\'s identity (Live Session prefixes, message author labels, letters, etc.). Edit via Preferences → User Identity, or by hand.',
  rules: [{ name: 'Anonymous' }],
  fallback: 'Anonymous',
  humanLabel: 'Human',
};

async function readMap(): Promise<CharacterMapFile> {
  try {
    const raw = await fs.readFile(CHAR_MAP_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      _comment: parsed._comment,
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      fallback: parsed.fallback || 'Anonymous',
      humanLabel: parsed.humanLabel || 'Human',
    };
  } catch {
    return EMPTY_MAP;
  }
}

export async function GET() {
  const map = await readMap();
  // Defensive: guarantee "Anonymous" is always present so the editor always
  // has the one entry it can never lose, even if a prior hand-edit dropped
  // it. This does not touch disk — only the write path (POST) persists.
  if (!map.rules.some(r => r.name === 'Anonymous')) {
    map.rules = [{ name: 'Anonymous' }, ...map.rules];
  }
  return NextResponse.json(map);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const rules: CharacterMapRule[] = Array.isArray(body.rules) ? body.rules : [];
    const fallback: string = typeof body.fallback === 'string' ? body.fallback : 'Anonymous';
    const humanLabel: string = typeof body.humanLabel === 'string' ? body.humanLabel : 'Human';

    // ── Validation ──────────────────────────────────────────────────────────
    const names = rules.map(r => (r.name || '').trim());
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
      // "Anonymous" cannot be deleted — enforced in the UI, and re-checked
      // here so a stray client bug or hand-crafted request can't remove it.
      return NextResponse.json({ error: '"Anonymous" cannot be removed.' }, { status: 400 });
    }
    if (!names.includes(fallback)) {
      return NextResponse.json({ error: `Fallback identity "${fallback}" is not in the list.` }, { status: 400 });
    }

    // Strip empty-string voice fields down to "absent" so a rule that was
    // cleared back to no-voice doesn't persist as engine:"" / charName:"".
    const cleanRules: CharacterMapRule[] = rules.map(r => {
      const out: CharacterMapRule = { name: r.name.trim() };
      if (r.engine) out.engine = String(r.engine);
      if (r.charName) out.charName = r.charName;
      if (r.styleName) out.styleName = r.styleName;
      return out;
    });

    const existing = await readMap();
    const next: CharacterMapFile = {
      _comment: existing._comment || EMPTY_MAP._comment,
      rules: cleanRules,
      fallback,
      humanLabel: humanLabel.trim() || 'Human',
    };

    // Atomic write: temp file in the same directory, then rename. Config
    // corruption here would break every identity in Nexus, so this gets the
    // same same-volume-rename-is-atomic treatment as fsStorage.ts uses for
    // logs, inlined here since that helper isn't exported.
    const dir = path.dirname(CHAR_MAP_PATH);
    const tmp = path.join(dir, `.character_map.json.tmp-${process.pid}-${Date.now()}`);
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
    await fs.rename(tmp, CHAR_MAP_PATH);

    return NextResponse.json({ ok: true, map: next });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
