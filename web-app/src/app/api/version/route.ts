import { NextResponse } from 'next/server';
import { getBuildInfo } from '@/lib/buildInfo';

// GET /api/version → { commit, branch, checkoutUpdatedAt, label }
// Read-only. See lib/buildInfo.ts for why this is read from .git with fs
// rather than by running `git`.
export async function GET() {
  try {
    return NextResponse.json(await getBuildInfo());
  } catch (e: any) {
    // A version probe must never be the thing that breaks a screen.
    return NextResponse.json(
      { commit: null, branch: null, checkoutUpdatedAt: null, label: 'unknown build', error: e?.message },
      { status: 200 },
    );
  }
}
