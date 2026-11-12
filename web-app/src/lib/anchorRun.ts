// Drain one /api/chat response for the anchor: visible text, thinking, and the
// usage to bill. Separate from lib/anchor.ts only because it touches a stream.
//
// The same loop as runSpuAction's drainOneCall plus ONE thing that loop
// deliberately does not keep: `thought` frames. What the anchor reasoned is
// half of what the manual button shows.
//
// A provider error does NOT throw here. The SPU throws because a half-written
// soul must not be saved; an anchor report that says "the call failed after
// producing this much" is itself the useful result, so the error travels
// beside whatever text arrived.

import { createSseReader, isSseDone } from '@/lib/sseFrames';
import { normaliseCacheUsage, type TurnCacheUsage } from '@/lib/turnEvents';
import { addCacheUsage } from '@/lib/spuBilling';

export interface AnchorDrain {
  text: string;
  thought: string;
  usage: TurnCacheUsage | null;
  error: string;
}

export async function drainAnchorCall(res: Response): Promise<AnchorDrain> {
  const out: AnchorDrain = { text: '', thought: '', usage: null, error: '' };
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    out.error = errText || `HTTP ${res.status}`;
    return out;
  }
  // `Uint8Array | string`: called as a module nothing encodes the enqueued
  // strings — see the measurement at runTurnStream.
  const reader = (res.body as ReadableStream<Uint8Array | string>).getReader();
  const decoder = new TextDecoder('utf-8');
  const sse = createSseReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
    for (const payload of sse.push(chunk)) {
      if (isSseDone(payload)) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.type === 'text' && typeof d.content === 'string') out.text += d.content;
      else if (d.type === 'thought' && typeof d.content === 'string') out.thought += d.content;
      else if (d.type === 'cache_usage') out.usage = addCacheUsage(out.usage, normaliseCacheUsage(d));
      if (typeof d.error === 'string' && d.error && !out.error) out.error = d.error;
    }
  }
  return out;
}
