// GET → the last Claude subscription usage snapshot recorded from an OAuth
// turn, or {} when none has been seen yet. See lib/claudeUsage.ts for where
// the numbers come from and why they only refresh during OAuth turns.
import { NextResponse } from 'next/server';
import { readClaudeUsage } from '@/lib/claudeUsageStore';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(readClaudeUsage() || {}, { headers: { 'Cache-Control': 'no-store' } });
}
