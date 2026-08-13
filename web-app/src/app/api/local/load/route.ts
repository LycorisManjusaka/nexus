import { NextResponse } from 'next/server';
import { loadLocalModel, ensureLmStudioLaunched } from '@/lib/localModels';

export async function POST(req: Request) {
  try {
    const { model, contextLength } = await req.json();
    if (!model) {
      return NextResponse.json({ error: 'Model identifier required.' }, { status: 400 });
    }

    await ensureLmStudioLaunched();
    const res = await loadLocalModel(model, Number(contextLength) || 80000);

    if (!res.ok) {
      return NextResponse.json({ error: res.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, message: res.message });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Failed to load model.' }, { status: 500 });
  }
}
