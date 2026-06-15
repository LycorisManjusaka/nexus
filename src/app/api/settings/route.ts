import { NextResponse } from 'next/server';
import { saveSettings, loadSettings } from '@/lib/fsStorage';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const aiName = searchParams.get('aiName') || 'default';
  const settings = await loadSettings(aiName);
  return NextResponse.json(settings || {});
}

export async function POST(req: Request) {
  const body = await req.json();
  const { aiName, settings } = body;
  if (!aiName) return NextResponse.json({ error: 'Missing aiName' }, { status: 400 });
  await saveSettings(aiName, settings);
  return NextResponse.json({ success: true });
}
