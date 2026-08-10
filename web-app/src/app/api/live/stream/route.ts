import { getSession, flushBuffered } from '@/lib/liveSession';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: 'No active session — call /api/live/start first.' }), { status: 404 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      session.controller = controller;
      // Initial heartbeat
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'connected' })}\n\n`));
      // Flush anything that arrived before the SSE was attached
      flushBuffered();
    },
    cancel() {
      // Browser closed the connection — leave the session state alive in case it reconnects
      // (the explicit /stop endpoint is what tears down resources).
      const s = getSession();
      if (s) s.controller = null;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
