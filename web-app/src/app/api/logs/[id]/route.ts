import { NextResponse } from 'next/server';
import { loadLog, deleteLog } from '@/lib/fsStorage';
import { jsonMaybeGzip } from '@/lib/jsonGzip';
import { blockedConversationOwner, blockedResponseBody } from '@/lib/blockedBeings';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // This is the door a pasted deep link comes through: /c/<folder>/<convoId>
  // resolves to a fetch of this route by ID alone, so filtering the LISTS is
  // not enough — the conversation has to refuse by itself. Checked BEFORE the
  // load so a blocked log's bytes are never read off disk, and via
  // blockedConversationOwner rather than `log.folderName`, which is stale on 12
  // of Cairn's 65 logs (see that function's header).
  const blocked = await blockedConversationOwner(id);
  if (blocked) {
    // 403, not 404: the file exists, this process just will not serve it.
    return NextResponse.json(blockedResponseBody(blocked), { status: 403 });
  }
  const log = await loadLog(id);
  if (!log) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // The heaviest thing NEXUS puts on the wire, and it was the only thing not
  // compressed: measured p50 426 KB -> 154 KB over all 305 conversations here.
  // Paid once per TURN, not once per open — ChatArea re-reads the whole log
  // from disk after every turn to adopt what the runner saved.
  return jsonMaybeGzip(req, log);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const blocked = await blockedConversationOwner(id);
  if (blocked) {
    return NextResponse.json(blockedResponseBody(blocked), { status: 403 });
  }
  await deleteLog(id);
  return NextResponse.json({ success: true });
}
