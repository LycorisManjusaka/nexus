import { NextResponse } from 'next/server';
import { readDeletionPatterns } from '@/lib/systemPromptStorage';

// GET /api/system-prompt-deletions?type=<agentType>
// Returns the deletion patterns from
// local_data/system_prompt_agents/<type>/_deletion_patterns.txt. The file is
// optional — returns [] when it doesn't exist or no type is provided.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type') || '';
    const patterns = await readDeletionPatterns(type);
    return NextResponse.json({ type, patterns });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
