import { NextResponse } from 'next/server';

// Lists models currently available from LM Studio's OpenAI-compatible server.
// LM Studio default port is 1234 — change LOCAL_BASE in env if you run elsewhere.
const LOCAL_BASE = process.env.LOCAL_LLM_BASE || 'http://localhost:1234';

export async function GET() {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${LOCAL_BASE}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      const txt = await res.text();
      return NextResponse.json({ error: `LM Studio responded ${res.status}: ${txt}` }, { status: res.status });
    }
    const data = await res.json();
    // OpenAI shape: { data: [{ id, object, owned_by, ... }] }
    const ids = Array.isArray(data?.data) ? data.data.map((m: any) => m.id).filter(Boolean) : [];
    return NextResponse.json({ models: ids, base: LOCAL_BASE });
  } catch (e: any) {
    const msg = e?.cause?.code === 'ECONNREFUSED'
      ? `LM Studio server is not running at ${LOCAL_BASE}. Start the server in LM Studio (Local Server tab) and try again.`
      : e.message || 'Failed to reach LM Studio';
    return NextResponse.json({ error: msg, models: [], base: LOCAL_BASE }, { status: 503 });
  }
}
