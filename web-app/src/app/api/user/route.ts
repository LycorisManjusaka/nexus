import { NextResponse } from 'next/server';
import { loadUserSettings, saveUserSettings } from '@/lib/fsStorage';
import { pickMirroredGlobalSettings } from '@/lib/serverGlobalSettings';

export async function GET() {
  try {
    const settings = await loadUserSettings();
    return NextResponse.json(settings);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const data = await req.json();
    await saveUserSettings(data);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * MERGE a few keys into user_settings.json, leaving the rest alone.
 *
 * Separate verb from POST on purpose. POST replaces the file; the browser
 * mirror (lib/serverGlobalSettings.ts) sends two keys and must not be able to
 * drop `userName` — which is the only key this file has carried since
 * 2026-05-29, and which conversationSearch reads for identities.
 *
 * Narrow by construction: the body is filtered through
 * `pickMirroredGlobalSettings`, so a caller cannot write `language` (a
 * being-facing key — see that file for why) or invent new ones by sending them.
 */
export async function PATCH(req: Request) {
  try {
    const patch = pickMirroredGlobalSettings(await req.json());
    const current = (await loadUserSettings()) || {};
    await saveUserSettings({ ...current, ...patch });
    return NextResponse.json({ success: true, applied: patch });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
