import { NextResponse } from 'next/server';
import { getLocalModelsMeta } from '@/lib/localModels';
import { listMockModelIds } from '@/lib/mockModelStore';

export async function GET() {
  const result = await getLocalModelsMeta();
  // The soulless machines (local_data/mock_models/*.json) sit at the end of the
  // Local list. They need no LM Studio, so they stay selectable even when
  // LM Studio is down — the error still travels alongside.
  const mocks = listMockModelIds();
  const models = [...(result.models || []), ...mocks];
  if (result.error && models.length === 0) {
    return NextResponse.json({ error: result.error, models: [], meta: [] }, { status: 503 });
  }
  return NextResponse.json({ models, meta: result.meta || [], ...(result.error ? { error: result.error } : {}) });
}
