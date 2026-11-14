import { NextResponse } from 'next/server';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
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
  letterAttachmentPath,
} from '@/lib/letters';
import { mimeForRef } from '@/lib/attachmentStore';

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
      // `?id=&file=<name>` → that attachment's bytes. The name must be one the
      // letter actually carries (letterAttachmentPath checks), so this cannot
      // be steered at any other file.
      const fileName = url.searchParams.get('file');
      if (fileName) {
        const abs = await letterAttachmentPath(meta, fileName);
        if (!abs) return NextResponse.json({ error: 'No such attachment.' }, { status: 404 });
        const data = await fs.readFile(abs);
        const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        const disp = url.searchParams.get('download') ? 'attachment' : 'inline';
        return new Response(new Uint8Array(data), {
          headers: {
            'Content-Type': mimeForRef(fileName),
            'Content-Length': String(data.length),
            'Content-Disposition': `${disp}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          },
        });
      }
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

    // Regenerating the overview is about the WHOLE store, so it must be handled
    // before the per-letter id guard below. It used to sit after it (further
    // down, next to 'reveal'), which made the branch unreachable: the Mail
    // Manager's own button — MailModal.tsx, "regenerate" — has been answering
    // 400 "A letter id is required." for every press, and the error named a
    // field the caller was right not to send. Found 2026-10-26 while measuring
    // something else. letters.ts says it best, a few hundred lines away:
    // unreachable code that describes a behaviour is worse than no code,
    // because the next reader believes it.
    if (action === 'regenerate') {
      await regenerateStatus();
      return NextResponse.json({ ok: true });
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

    if (action === 'reveal') {
      // Open the OS file manager with this letter's .md selected. The point is
      // the neighbours: the .read / .archived sidecars sit right beside it, and
      // they are the truth this window is only a convenience over. Sometimes
      // you want to look at — or fix — them directly.
      //
      // The path is resolved server-side from the id and never crosses the
      // wire, which keeps this route's rule that absolute paths stay here. It
      // is always inside local_data/letters/, so there is nothing to inject.
      try {
        await fs.access(meta.file);
      } catch {
        return NextResponse.json(
          { error: 'That letter is no longer on disk. Refresh the list.' },
          { status: 404 },
        );
      }

      try {
        if (process.platform === 'win32') {
          // explorer.exe parses its own command line and wants exactly
          // /select,"<path>" with no space after the comma. Without
          // windowsVerbatimArguments, Node re-quotes the whole token into a
          // form explorer misreads once the path contains a space (entity
          // names may). Its exit code is deliberately not checked: explorer
          // returns 1 even when it succeeds.
          spawn('explorer.exe', [`/select,"${meta.file}"`], {
            windowsVerbatimArguments: true, detached: true, stdio: 'ignore',
          }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', ['-R', meta.file], { detached: true, stdio: 'ignore' }).unref();
        } else {
          // Linux has no portable "select this file", so the containing folder
          // is the honest best — the sidecars are still visible next to it.
          spawn('xdg-open', [path.dirname(meta.file)], { detached: true, stdio: 'ignore' }).unref();
        }
      } catch (e: any) {
        return NextResponse.json(
          { error: `Could not open the file manager: ${e?.message || e}` },
          { status: 500 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'the operation failed' }, { status: 500 });
  }
}
