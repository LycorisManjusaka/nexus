import { NextResponse } from 'next/server';
import { getLocalModelsMeta } from '@/lib/localModels';

export async function GET() {
  const result = await getLocalModelsMeta();
  if (result.error && (!result.models || result.models.length === 0)) {
    return NextResponse.json({ error: result.error, models: [], meta: [] }, { status: 503 });
  }
  return NextResponse.json({ models: result.models, meta: result.meta || [] });
}
