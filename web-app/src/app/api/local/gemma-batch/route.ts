import { NextResponse } from 'next/server';
import { patchGemmaBatchSize } from '@/lib/lmStudioBatchPatch';

/**
 * GET  = dry run. Reports what would change, writes nothing.
 * POST = apply.
 *
 * Both go through the same code path, so the preview cannot drift from the
 * action it previews. A non-ok report is still returned with HTTP 200 when it
 * carries per-model detail — the caller needs to SEE which model refused, not
 * just that something went wrong. Only a whole-run failure (no `lms`, no
 * config directory) is a 500.
 */
export async function GET() {
  try {
    const report = await patchGemmaBatchSize(true);
    if (report.error) return NextResponse.json(report, { status: 500 });
    return NextResponse.json(report);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Dry run failed.' }, { status: 500 });
  }
}

export async function POST() {
  try {
    const report = await patchGemmaBatchSize(false);
    if (report.error) return NextResponse.json(report, { status: 500 });
    return NextResponse.json(report);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Patch failed.' }, { status: 500 });
  }
}
