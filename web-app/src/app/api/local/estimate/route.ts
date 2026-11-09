import { NextResponse } from 'next/server';
import { estimateLocalModel } from '@/lib/localModels';

/**
 * What would this local model cost in memory at this context length?
 *
 * GET, not POST, because it has no side effects: `lms --estimate-only` does
 * arithmetic and does not load the model (verified — VRAM stays flat). A GET
 * is also testable from a URL bar, which matters when the next person has to
 * check whether this still works.
 *
 * ⚠ It deliberately does NOT call `ensureLmStudioLaunched()`. The point of an
 * estimate is to decide BEFORE committing, so spending up to 15 seconds
 * booting LM Studio to answer "how much would this cost" inverts the purpose.
 * If the CLI can't answer, the body says so with the tool's own words.
 * (Whether `--estimate-only` works with the HTTP server down is UNMEASURED —
 * every measurement here was taken with it up.)
 *
 * The response always carries `raw`, because `lms` reports a bad model key as
 * "Model not found" on EXIT CODE 0 — so the caller cannot learn success from
 * the status code, only from `ok`.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const model = url.searchParams.get('model') || '';
    const ctx = Number(url.searchParams.get('ctx'));

    if (!model) {
      return NextResponse.json({ ok: false, error: 'Model identifier required.' }, { status: 400 });
    }
    if (!Number.isFinite(ctx) || ctx < 1) {
      return NextResponse.json({ ok: false, error: 'Context length required.' }, { status: 400 });
    }

    const est = await estimateLocalModel(model, ctx);
    // 200 even when ok:false — the request was served; the ESTIMATE failed.
    // Mapping a failed estimate to 5xx would make a wrong model key look like
    // a broken server.
    return NextResponse.json(est);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'Failed to estimate.', raw: '' },
      { status: 500 },
    );
  }
}
