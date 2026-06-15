import { NextResponse } from 'next/server';
import {
  listAgentTypes,
  readAllAgentFiles,
  readSummaryAgent,
  extractAgentSystemPrompt,
} from '@/lib/systemPromptStorage';

// GET /api/system-prompt-agents
//   (no params)      → { types: string[] }  — list of subfolders under
//                       local_data/system_prompt_agents/
//   ?type=<name>     → { standard, compression } — both agents from that
//                       subfolder. Each is { raw, systemPrompt } or null.
//
// The client first calls without params to populate the agent-type ComboBox,
// then re-calls with `?type=` whenever the selection changes.
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type');

    if (!type) {
      const types = await listAgentTypes();
      return NextResponse.json({ types });
    }

    const [allFiles, summaryRaw] = await Promise.all([
      readAllAgentFiles(type),
      readSummaryAgent(type),
    ]);
    return NextResponse.json({
      type,
      // Every .md updater agent in this type subfolder. The client lists them in
      // a ComboBox and runs whichever one the user selects.
      files: allFiles.map((f) => ({
        name: f.name,
        systemPrompt: extractAgentSystemPrompt(f.content),
      })),
      summary: summaryRaw
        ? { raw: summaryRaw, systemPrompt: extractAgentSystemPrompt(summaryRaw) }
        : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
