import { NextResponse } from 'next/server';
import {
  listAllLetters,
  resolveAnyLetter,
  readLetterBody,
  setLetterFlags,
  updateLetter,
  deleteLetter,
  writeLetter,
  correspondentNames,
  knownIdentities,
  regenerateStatus,
} from '@/lib/letters';

// Human-facing Mail Manager API. Entities never touch this route — they reach
// letters only through their four tools, which are scoped to their own two
// directions. This route is deliberately unscoped: it exists so the whole store
// can be inspected and repaired from one window, including mail addressed to a
// name that has no folder and therefore nobody to read it.
//
// Everything here mirrors what you could do by hand in Explorer (create a
// sidecar, delete one, edit a .md). The sidecars remain the single source of
// truth; this is a convenience over them, never a second authority.

export const dynamic = 'force-dynamic';

/** GET → the whole store. `?id=` adds that one letter's body. */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');

    if (id) {
      const meta = await resolveAnyLetter(id);
      if (!meta) return NextResponse.json({ error: 'No letter with that id.' }, { status: 404 });
      const { file, ...safe } = meta; // absolute paths stay server-side
      return NextResponse.json({ letter: { ...safe, body: await readLetterBody(meta) } });
    }

    const [letters, names, identities] = await Promise.all([
      listAllLetters(),
      correspondentNames(),
      knownIdentities(),
    ]);
    return NextResponse.json({
      letters: letters.map(({ file, ...safe }) => safe),
      names,
      identities,
      unread: letters.filter((l) => !l.read && !l.archived).length,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'could not read the letters' }, { status: 500 });
  }
}

/** POST → one action. */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = String(body?.action || '');

    if (action === 'create') {
      // Composing as any sender, to any recipient — including names that exist
      // nowhere yet. Same delivery path the entities use, so a hand-written
      // letter is indistinguishable from one an entity wrote.
      const r = await writeLetter(
        String(body.from || '').trim(),
        String(body.to || '').trim(),
        String(body.title || '').trim(),
        String(body.text || ''),
      );
      return r.ok
        ? NextResponse.json({ ok: true, id: r.id })
        : NextResponse.json({ error: r.error }, { status: 400 });
    }

    const id = String(body?.id || '').trim();
    if (!id) return NextResponse.json({ error: 'A letter id is required.' }, { status: 400 });
    const meta = await resolveAnyLetter(id);
    if (!meta) return NextResponse.json({ error: 'No letter with that id.' }, { status: 404 });

    if (action === 'flags') {
      await setLetterFlags(meta, {
        read: typeof body.read === 'boolean' ? body.read : undefined,
        archived: typeof body.archived === 'boolean' ? body.archived : undefined,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === 'update') {
      const r = await updateLetter(meta, {
        title: typeof body.title === 'string' ? body.title : undefined,
        text: typeof body.text === 'string' ? body.text : undefined,
      });
      return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
    }

    if (action === 'delete') {
      const r = await deleteLetter(meta);
      return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 500 });
    }

    if (action === 'regenerate') {
      await regenerateStatus();
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'the operation failed' }, { status: 500 });
  }
}
