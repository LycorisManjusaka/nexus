import { subscribeTurn, liveTurnStatus } from '@/lib/turnBus';
import { RELAY_KEEPALIVE_MS } from '@/lib/relayWatch';

// ── Watch a turn that this tab is NOT running ───────────────────────────────
//
// GET /api/turn-events?convoId=... → text/event-stream
//
// The body is byte-identical to what `POST /api/chat` would have streamed:
// the relay stores raw SSE text, so this route concatenates rather than
// re-encodes, and the browser reads it with the same lib/turnStreamLoop it
// uses for a direct POST. One wire format, one parser, one place where
// "which stream errors are fatal" is decided.
//
// `X-Turn-Bus` names what the caller got, because an empty event stream and a
// finished one look the same from the outside:
//
//   live      a turn is running; replay was sent and more is coming
//   replay    the turn finished already; everything is in this response
//   idle      nothing is running for this conversation
//
// `X-Turn-Id` names the turn, so a watching tab can Stop it
// (/api/chat/active) and interject into it (/api/chat/inject). Both already
// work and neither was reachable from a tab that did not POST the turn
// itself -- without this, moving turns to the server would silently cost
// both, with the buttons still on screen.
//
// A tab that reads `idle` should reload the conversation rather than wait:
// either the turn never started, or it ended before anyone subscribed and the
// authoritative answer is already on disk.
//
// NO RULES HERE. The buffer, the ordering guarantee and the eviction policy
// are in lib/turnBus.ts.

/** Comment frame. lib/sseFrames skips frames with no `data:` field, so this
 *  reaches no reducer branch — it exists to keep a silent connection warm
 *  while a model thinks, which here can be minutes with nothing emitted. */
const KEEPALIVE = ': keepalive\n\n';
// The PERIOD lives in lib/relayWatch.ts, with the watcher's idle bound that is
// derived from it. Two copies would let this one be widened and leave every
// watcher declaring healthy connections dead.
const KEEPALIVE_MS = RELAY_KEEPALIVE_MS;

export async function GET(req: Request) {
  const convoId = new URL(req.url).searchParams.get('convoId')?.trim() || '';
  if (!convoId) {
    return new Response(JSON.stringify({ error: 'convoId is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const status = liveTurnStatus(convoId);
  if (!status) {
    return new Response('', {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Turn-Bus': 'idle',
      },
    });
  }

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<string>({
    start(controller) {
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        if (keepalive) { clearInterval(keepalive); keepalive = null; }
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
        try { controller.close(); } catch { /* already closed by the client leaving */ }
      };

      // Subscribe FIRST, then write the replay it handed back. Reversed, a
      // chunk emitted between the two would reach neither — the replay was
      // already taken and the subscription did not exist yet.
      const sub = subscribeTurn(convoId, (text) => {
        if (closed) return;
        if (text === null) { finish(); return; }
        try { controller.enqueue(text); } catch { finish(); }
      });

      if (!sub) { finish(); return; }
      unsubscribe = sub.unsubscribe;

      for (const frame of sub.replay) {
        if (closed) break;
        try { controller.enqueue(frame); } catch { finish(); break; }
      }
      if (sub.done) { finish(); return; }

      keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(KEEPALIVE); } catch { finish(); }
      }, KEEPALIVE_MS);

      // The watcher leaving must not keep a subscription (or a timer) alive.
      // Unlike /api/chat, this abort means only "nobody is looking" — the turn
      // itself belongs to the runner and is not affected.
      req.signal?.addEventListener('abort', finish);
    },
    cancel() {
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Turn-Bus': status.done ? 'replay' : 'live',
      'X-Turn-Id': status.turnId,
    },
  });
}
