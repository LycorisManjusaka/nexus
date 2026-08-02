import { NextResponse } from 'next/server';
import { readEntityFooter, writeEntityFooter } from '@/lib/fsStorage';

// An entity's FOOTER.md — its self-authored Layer 5.
//
// The file lives in the entity's workspace and is injected into the system
// prompt at SEND TIME, never stored in the conversation. That is why it was
// invisible to the System Prompt Updater: the updater reads the STORED prompt,
// so it could see a footer that had been baked in, but had no idea a FOOTER.md
// existed alongside it. This route is what makes it visible and editable there.

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const folder = new URL(req.url).searchParams.get('folder') || '';
    if (!folder) return NextResponse.json({ error: 'Missing folder' }, { status: 400 });
    const body = await readEntityFooter(folder);
    // `exists` is distinct from an empty body: "no FOOTER.md at all" and "a
    // FOOTER.md the entity deliberately emptied" are different states, and the
    // UI says so rather than showing an identical blank box for both.
    return NextResponse.json({ exists: body !== null, body: body ?? '' });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'could not read FOOTER.md' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { folder, body } = await req.json();
    if (!folder) return NextResponse.json({ error: 'Missing folder' }, { status: 400 });
    if (typeof body !== 'string') return NextResponse.json({ error: 'Missing body' }, { status: 400 });
    const r = await writeEntityFooter(String(folder), body);
    return r.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: r.error }, { status: 500 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'could not write FOOTER.md' }, { status: 500 });
  }
}
