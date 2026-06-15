import { NextResponse } from 'next/server';
import { loadLog, deleteLog } from '@/lib/fsStorage';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const log = await loadLog(id);
  if (!log) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(log);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteLog(id);
  return NextResponse.json({ success: true });
}
