import { NextResponse } from 'next/server';
import fs from 'fs';
import { speakersJsonPath, coeiroinkSpeakersJsonPath } from '@/lib/voicechangerPaths';
import { readCharacterMap, findIdentity } from '@/lib/characterMap';
import { resolveUserIdentity } from '@/lib/userIdentity';
import { ENGINES } from '@/lib/ttsEngines';

export const dynamic = 'force-dynamic';

/**
 * The speaking styles available to an identity.
 *
 * Style names are asked of the engine LIVE (falling back to the on-disk catalog
 * when the engine isn't running), because that is the only source that is
 * definitely current — the whole reason indices were removed is that this list
 * changes underneath us.
 *
 * `?name=` (+ optional `?style=`) asks about a SPECIFIC identity — this is what
 * the chat input uses, since "who's speaking" is now a per-browser choice, not
 * necessarily whoever is named in local_data/user_identity.json (that file only
 * mirrors whichever browser changed it most recently, for the voice changer's
 * benefit). Omitting `name` falls back to that shared file, for the VRChat/Live
 * voice pipeline, which has exactly one physical speaker and so has no browser
 * to be per-.
 *
 * Returns an empty list, not an error, when the identity has no voice: an
 * identity without a voice is normal, and the caller just shows nothing.
 */
async function loadCatalog(engine: string): Promise<any[]> {
  const readCache = (p: string) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
  };
  if (engine === 'voicevox') {
    try {
      const res = await fetch('http://127.0.0.1:50021/speakers');
      if (res.ok) return await res.json();
    } catch { /* engine down — fall through to the cached catalog */ }
    return readCache(speakersJsonPath());
  }
  if (engine === 'coeiroink') {
    try {
      const res = await fetch('http://127.0.0.1:50032/v1/speakers');
      if (res.ok) return await res.json();
    } catch { /* engine down */ }
    return readCache(coeiroinkSpeakersJsonPath());
  }
  if (engine === 'aivisspeech') {
    try {
      const base = process.env.NEXUS_AIVISSPEECH_URL || 'http://127.0.0.1:10101';
      const res = await fetch(`${base}/speakers`);
      if (res.ok) return await res.json();
    } catch { /* engine down; no disk cache exists for AivisSpeech */ }
    return [];
  }
  if (engine === 'vosk_ra') {
    try {
      const res = await fetch(`${ENGINES[3].base}/speakers`);
      if (res.ok) return await res.json();
    } catch { /* engine down; no disk cache exists for this one either */ }
    return [];
  }
  return [];
}

export async function GET(req: Request) {
  try {
    const map = readCharacterMap();
    const { searchParams } = new URL(req.url);
    const nameParam = searchParams.get('name');

    let resolved: { name: string; style?: string; styleIsOverride: boolean; rule?: ReturnType<typeof findIdentity> };
    if (nameParam) {
      const rule = findIdentity(map, nameParam);
      const styleParam = searchParams.get('style') || undefined;
      const override = styleParam && rule && styleParam !== rule.defaultStyle ? styleParam : undefined;
      resolved = {
        name: rule?.name || nameParam,
        style: override || rule?.defaultStyle,
        styleIsOverride: !!override,
        rule,
      };
    } else {
      resolved = resolveUserIdentity(map);
    }
    const rule = resolved.rule;

    if (!rule?.engine || !rule.character) {
      return NextResponse.json({
        name: resolved.name,
        styles: [],
        defaultStyle: undefined,
        style: undefined,
        hasVoice: false,
      });
    }

    const catalog = await loadCatalog(rule.engine);
    const char = (catalog || []).find((c: any) => (c?.name || c?.speakerName) === rule.character);
    const styles: string[] = (char?.styles || [])
      .map((s: any) => s?.name || s?.styleName)
      .filter((s: any): s is string => typeof s === 'string' && !!s);

    return NextResponse.json({
      name: resolved.name,
      engine: rule.engine,
      character: rule.character,
      defaultStyle: rule.defaultStyle,
      style: resolved.style,
      styleIsOverride: resolved.styleIsOverride,
      styles,
      hasVoice: true,
      // The character is configured but the engine can't confirm it right now
      // (engine down and no cached catalog, or the character was renamed).
      characterFound: !!char,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, styles: [] }, { status: 500 });
  }
}
