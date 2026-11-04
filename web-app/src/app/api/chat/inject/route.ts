import { NextResponse } from 'next/server';
import { pushInjection, type InjectedMedia } from '@/lib/injectMessage';
import { putDataUrl, readAttachmentText, isValidRef } from '@/lib/attachmentStore';

// POST { turnId, text, attachments? } — queue a "partner interjection" into a
// running turn. The active /api/chat request drains it at its next model-call
// boundary (see injectMessage.ts). Returns { ok } — ok:false means empty input;
// a 200 with ok:true does NOT guarantee the turn is still running (it may have
// just finished), only that the content was queued.
//
// `attachments` are the same objects the composer hands to handleSend, slimmed
// to what the server needs. The browser already externalized each payload into
// the content-addressed store at attach time, so the normal case carries a
// `ref` and no bytes cross the wire twice. `dataUrl` is the fallback for an
// attachment whose upload failed, and is externalized HERE so that every queued
// attachment has a ref — which is what makes the OAuth hand-off (the entity
// opening it with read_attachment) possible at all.
//
// Text attachments are not queued as media: they are inlined into the
// interjection text, because text arrives on every wire and inlining is exactly
// what the normal send path does with them.
interface IncomingAttachment {
  name?: string;
  type?: string;
  size?: number;
  ref?: string;
  dataUrl?: string;
  textData?: string;
  isText?: boolean;
}

function kindOf(mime: string): 'image' | 'audio' | 'video' | null {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return null;
}

export async function POST(req: Request) {
  try {
    const { turnId, text, attachments } = await req.json();
    if (!turnId || typeof turnId !== 'string') {
      return NextResponse.json({ error: 'turnId is required' }, { status: 400 });
    }

    const incoming: IncomingAttachment[] = Array.isArray(attachments) ? attachments : [];
    const media: InjectedMedia[] = [];
    const inlineTexts: string[] = [];
    // Attachments that are neither text nor a recognized media kind (PDF and
    // friends). The OpenAI/Anthropic multimodal specs have no block for them,
    // and the normal send path only ever inlines them as text — so say so
    // instead of queueing bytes nothing will read.
    const unsupported: string[] = [];

    for (const a of incoming) {
      if (!a || typeof a !== 'object') continue;
      const name = String(a.name || 'attachment');
      const mime = String(a.type || '');
      const isTextAtt = a.isText === true || mime.startsWith('text/');

      if (isTextAtt) {
        let body = typeof a.textData === 'string' ? a.textData : '';
        if (!body && isValidRef(a.ref)) {
          body = (await readAttachmentText(a.ref)) || '';
        }
        if (body) {
          inlineTexts.push(`<attached_file name="${name.replace(/["<>]/g, '')}" type="${mime || 'text/plain'}">\n${body}\n</attached_file>`);
        }
        continue;
      }

      const kind = kindOf(mime);
      if (!kind) { unsupported.push(name); continue; }

      let ref = isValidRef(a.ref) ? a.ref : '';
      let size = Number(a.size) || 0;
      if (!ref && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:')) {
        const stored = await putDataUrl(a.dataUrl);
        if (stored) { ref = stored.ref; size = stored.size || size; }
      }
      // No ref and no payload — there is nothing to deliver and nothing to
      // hand off. Name it rather than pretending it was sent.
      if (!ref) { unsupported.push(name); continue; }

      media.push({ ref, name, mimeType: mime, size, kind });
    }

    const body = typeof text === 'string' ? text : '';
    const pieces = [body.trim(), ...inlineTexts].filter(Boolean);
    if (unsupported.length) {
      pieces.push(
        `<attached_file_not_delivered names="${unsupported.map((n) => n.replace(/["<>]/g, '')).join(', ')}" ` +
        `reason="this file type cannot be attached to a message mid-turn" />`,
      );
    }
    const finalText = pieces.join('\n\n');

    if (!finalText && media.length === 0) {
      return NextResponse.json({ error: 'text or attachments are required' }, { status: 400 });
    }

    const ok = pushInjection(turnId, finalText, media);
    return NextResponse.json({ ok, queuedMedia: media.length });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed to queue interjection' }, { status: 500 });
  }
}

// NO GET here on purpose. An "ask whether my note was delivered" endpoint was
// written and then removed: the runner already attaches the report to the reply
// it saves (runTurnForQueue → withUndelivered), so every provider path and
// every ending — finished, stopped, failed — is covered by one site, and the
// notice survives a reload because it is on the message. A second way to learn
// the same fact would be a second source of truth, and an endpoint nobody calls
// reads to the next person as if something somewhere calls it.
