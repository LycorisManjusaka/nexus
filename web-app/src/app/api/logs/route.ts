import { NextResponse } from 'next/server';
import { listLogs, saveLog } from '@/lib/fsStorage';

export async function GET() {
  const logs = await listLogs();
  return NextResponse.json(logs);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { id, logData } = body;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  
  // ensure updatedAt is tracked
  logData.updatedAt = Date.now();
  await saveLog(id, logData);
  return NextResponse.json({ success: true });
}
