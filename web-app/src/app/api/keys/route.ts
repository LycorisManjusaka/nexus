import { NextResponse } from 'next/server';
import { saveKeys, loadKeys } from '@/lib/fsStorage';

export async function GET() {
  const keys = await loadKeys();
  return NextResponse.json(keys || {});
}

export async function POST(req: Request) {
  const body = await req.json();
  await saveKeys(body);
  return NextResponse.json({ success: true });
}
