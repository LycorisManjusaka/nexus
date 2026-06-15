import { NextResponse } from 'next/server';
import { resolveCurrentChara } from '@/lib/charaResolver';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { name, humanLabel } = resolveCurrentChara();
    return NextResponse.json({ name, humanLabel });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
