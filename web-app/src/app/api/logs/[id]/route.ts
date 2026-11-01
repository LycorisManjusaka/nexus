import { NextResponse } from 'next/server';
import { loadLog, deleteLog } from '@/lib/fsStorage';
import { jsonMaybeGzip } from '@/lib/jsonGzip';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
  await deleteLog(id);
  return NextResponse.json({ success: true });
}
