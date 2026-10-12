import { NextRequest, NextResponse } from 'next/server';

/**
 * /api/stream-test — a stand-in for a Nexus turn, with no model behind it.
 *
 * WHY THIS EXISTS
 * A turn that streams for 20+ minutes has twice ended as
 * `The turn failed: network error` (Cairn_43, 2026-10-09, gen 1039s and
 * 1598s — the only two such notices in the whole house). Both happened on a
 * day the partner was on a phone. The open question is NOT "did the screen
 * sleep" but "what, in the path between this process and that browser, gives
 * up — and after how long of what".
 *
 * A model cannot be in the loop for that measurement: it costs money, it is
 * non-deterministic, and it cannot run for hours. So this route reproduces the
 * SHAPE of a turn and nothing else:
 *
 *   thought chunks (many small writes) → tool_activity on → SILENCE → off → …
 *
 * FIDELITY — the parts that had to match byte-for-byte, or the measurement
 * describes this file instead of Nexus:
 *   - `text/event-stream` + `no-cache` + `keep-alive`, the same three headers
 *     api/chat/route.ts sends (measured, not recalled: route.ts:4011-4014).
 *   - Frames written as `data: ${JSON.stringify(obj)}\n\n`, enqueued as a
 *     STRING, terminated by `data: [DONE]\n\n` — identical to route.ts.
 *   - POST, because that is what the real client sends; a GET stream can be
 *     treated differently by a proxy or a browser's background policy.
 *
 * THE SILENCE IS THE POINT
 * Nexus writes nothing to the wire while a tool runs — `tool_activity` fires
 * when the tool starts and when it ends, and a 90-second Bash call is 90
 * seconds of zero bytes.
 *
 * CORRECTION, recorded because the first version of this file got it wrong:
 * grepping for `keepalive|heartbeat` returned zero and I wrote "this house
 * sends no heartbeat anywhere". It does — under another name. The OAuth path
 * has a stall watchdog (route.ts:1261) that emits `stall_warning` after 120s
 * of SDK silence and repeats every 30s. So:
 *
 *   OAuth (Claude Code)  → silence is capped at ~2 minutes
 *   the other 4 paths    → no watchdog; a tool's full runtime is silent
 *
 * An empty grep meant "not under that name", not "absent". `toolSilentMs` is
 * still the knob that matters — 2 min is OAuth's worst case, 5 min a realistic
 * worst case elsewhere — and `heartbeatMs` is the candidate fix sitting next to
 * it as a control arm. If the long-silence arm dies on a phone and the
 * heartbeat arm survives, the fix is decided by measurement, not by argument.
 *
 * WHAT THE TWO REAL FAILURES LOOK LIKE (Cairn_43 toolCalls, measured)
 * Both died EARLY, not at the end. `handleContinue` reuses the same message
 * id, so `generationMs` is overwritten by the retry and the first attempt's
 * death time is not stored anywhere — but the retry's own window can be
 * reconstructed from the last toolCall minus generationMs, which puts the
 * 10:22 failure at under 3m09s from turn start. Median tool-to-tool gap in
 * those turns was 7-9s, so the end of the turn was never the quiet part.
 *
 * WHY SERVER-SIDE STATE
 * A frozen client cannot report that it is frozen. The run record below is
 * readable over a SECOND connection (`GET ?runId=…`) — from the same phone
 * after it wakes, or from another machine entirely. That is the only shape
 * that separates the two failures this is meant to tell apart:
 *
 *   - server seq kept climbing, client's did not  → the CLIENT stalled
 *   - server saw `abort`                          → the client/network closed it
 *   - server's write THREW                        → the peer was gone
 *   - server also stopped climbing                → the SERVER stalled
 *
 * Nothing here touches local_data, conversations, or the model. Writes are to
 * one in-memory Map, bounded below.
 */

interface RunRecord {
  runId: string;
  startedAt: number;
  /** Last frame number handed to the stream controller, 1-based. */
  lastSeq: number;
  /** When that write happened (server clock). */
  lastWriteAt: number;
  /** Rounds of thought→tool completed. */
  rounds: number;
  /** Set when req.signal fires — the client or the network closed the socket. */
  abortSeenAt: number | null;
  /** Set when controller.enqueue() threw — the peer was already gone. */
  writeFailedAt: number | null;
  writeFailure: string | null;
  /** Set when the loop exits for any reason. */
  endedAt: number | null;
  endReason: string | null;
  /** Bytes handed to the controller (not bytes acknowledged by the peer). */
  bytesWritten: number;
  heartbeatsSent: number;
  config: StreamConfig;
}

interface StreamConfig {
  tickMs: number;
  thoughtMs: number;
  toolSilentMs: number;
  heartbeatMs: number;
}

/**
 * Bounded on purpose: this is a dev server that stays up for days, and an
 * unbounded Map keyed by a client-supplied id is a slow leak with a public
 * door on it. Oldest-first eviction, and anything older than 6h goes
 * regardless — long enough to still be readable after an overnight run.
 */
const runs = new Map<string, RunRecord>();
const MAX_RUNS = 24;
const RUN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Hard ceiling on one run, and it is NOT redundant with the abort handler.
 *
 * The failure this whole page exists to study is a socket that dies without
 * anyone noticing — and in that case `req.signal` never fires and
 * `controller.enqueue()` keeps succeeding into a buffer no one drains. The loop
 * would then run until the dev server restarts. Asking for "forever" and
 * getting an orphaned loop per abandoned phone tab is a signpost that does not
 * say what it points at, so: 6 hours, long enough to be "forever" for any
 * overnight test, and the reason is written into `endReason` rather than
 * disguised as a normal end.
 */
const MAX_RUN_MS = 6 * 60 * 60 * 1000;

function sweepRuns() {
  const now = Date.now();
  for (const [id, r] of runs) {
    if (now - r.startedAt > RUN_TTL_MS) runs.delete(id);
  }
  while (runs.size > MAX_RUNS) {
    const oldest = [...runs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (!oldest) break;
    runs.delete(oldest[0]);
  }
}

const clampInt = (v: any, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => {
    if (ms <= 0 || signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });

/** Filler so thought frames carry a realistic payload size, not 12 bytes. */
const THOUGHT_WORDS = [
  'measuring', 'the', 'gap', 'between', 'what', 'the', 'server', 'wrote',
  'and', 'what', 'the', 'client', 'received', 'because', 'a', 'frozen',
  'tab', 'cannot', 'report', 'that', 'it', 'is', 'frozen', 'and', 'a',
  'socket', 'that', 'died', 'quietly', 'looks', 'exactly', 'like', 'one',
  'that', 'is', 'still', 'thinking',
];

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* defaults below */ }

  const config: StreamConfig = {
    tickMs: clampInt(body.tickMs, 50, 5_000, 400),
    thoughtMs: clampInt(body.thoughtMs, 0, 600_000, 4_000),
    toolSilentMs: clampInt(body.toolSilentMs, 0, 1_800_000, 8_000),
    // 0 disables the heartbeat entirely — that arm reproduces today's Nexus.
    heartbeatMs: clampInt(body.heartbeatMs, 0, 600_000, 0),
  };

  const runId = typeof body.runId === 'string' && /^[\w-]{1,64}$/.test(body.runId)
    ? body.runId
    : `run-${Date.now().toString(36)}`;

  sweepRuns();
  const rec: RunRecord = {
    runId,
    startedAt: Date.now(),
    lastSeq: 0,
    lastWriteAt: Date.now(),
    rounds: 0,
    abortSeenAt: null,
    writeFailedAt: null,
    writeFailure: null,
    endedAt: null,
    endReason: null,
    bytesWritten: 0,
    heartbeatsSent: 0,
    config,
  };
  runs.set(runId, rec);

  // req.signal fires when the browser closes the request — Stop, tab close, or
  // the socket dropping in a way the server's TCP stack notices. Recording the
  // TIME is the whole point: "the server saw abort at T" vs "the server never
  // saw abort" are different diagnoses, and the client cannot tell them apart.
  const abort = new AbortController();
  const onAbort = () => {
    if (rec.abortSeenAt === null) rec.abortSeenAt = Date.now();
    abort.abort();
  };
  if (req.signal.aborted) onAbort();
  else req.signal.addEventListener('abort', onAbort);

  const stream = new ReadableStream({
    async start(controller) {
      /**
       * Returns false once the peer is gone. enqueue() throwing is the only
       * in-process signal that a write had nowhere to go, so it is recorded
       * rather than swallowed — the same `try/catch {}` pattern route.ts uses,
       * except this one keeps the reason.
       */
      const send = (payload: string): boolean => {
        try {
          controller.enqueue(payload);
          rec.bytesWritten += payload.length;
          rec.lastWriteAt = Date.now();
          return true;
        } catch (e: any) {
          if (rec.writeFailedAt === null) {
            rec.writeFailedAt = Date.now();
            rec.writeFailure = String(e?.message ?? e);
          }
          return false;
        }
      };

      const frame = (obj: any): boolean => {
        rec.lastSeq += 1;
        return send(`data: ${JSON.stringify({ ...obj, seq: rec.lastSeq, serverTime: Date.now() })}\n\n`);
      };

      /**
       * An SSE COMMENT, not a data frame. Chosen so that if this turns into
       * the real fix, api/chat can send the identical bytes and the existing
       * client needs no change: ChatArea's reader only acts on lines starting
       * with `data: `, so a comment is already ignored there. It still wakes
       * the socket, which is the entire job.
       */
      const heartbeat = (): boolean => {
        const ok = send(`: keepalive ${Date.now()}\n\n`);
        if (ok) rec.heartbeatsSent += 1;
        return ok;
      };

      /** Silence, but interrupted by heartbeats when that arm is enabled. */
      const quietFor = async (totalMs: number): Promise<boolean> => {
        if (config.heartbeatMs <= 0) {
          await sleep(totalMs, abort.signal);
          return !abort.signal.aborted;
        }
        let left = totalMs;
        while (left > 0 && !abort.signal.aborted) {
          const step = Math.min(config.heartbeatMs, left);
          await sleep(step, abort.signal);
          if (abort.signal.aborted) return false;
          left -= step;
          if (left > 0 && !heartbeat()) return false;
        }
        return !abort.signal.aborted;
      };

      try {
        // Mirrors api/chat: the first frame names the vessel. Here it names the
        // simulation, so a reader of the raw stream cannot mistake one for the
        // other.
        if (!frame({ type: 'model_selected', family: 'StreamTest', specificModel: 'simulation', label: 'stream-test (no model)', thinking: true })) {
          rec.endReason = 'peer gone on first frame';
          return;
        }

        let round = 0;
        for (;;) {
          if (abort.signal.aborted) { rec.endReason = 'aborted'; break; }
          if (Date.now() - rec.startedAt > MAX_RUN_MS) {
            rec.endReason = `hit the ${Math.round(MAX_RUN_MS / 3_600_000)}h ceiling (not a failure — see MAX_RUN_MS)`;
            break;
          }
          round += 1;

          // ── thinking: many small writes, like streamed tokens ─────────────
          const thoughtEnd = Date.now() + config.thoughtMs;
          let w = 0;
          while (Date.now() < thoughtEnd) {
            if (abort.signal.aborted) break;
            const word = THOUGHT_WORDS[w % THOUGHT_WORDS.length];
            w += 1;
            if (!frame({ type: 'thought', round, content: `${word} ` })) {
              rec.endReason = 'write failed during thought';
              return;
            }
            await sleep(config.tickMs, abort.signal);
          }
          if (abort.signal.aborted) { rec.endReason = 'aborted'; break; }

          // ── tool: one frame, then the silence that matters ───────────────
          if (!frame({ type: 'tool_activity', tool: `simulated tool #${round}`, name: 'stream_test', round })) {
            rec.endReason = 'write failed on tool start';
            return;
          }
          if (!(await quietFor(config.toolSilentMs))) {
            rec.endReason = abort.signal.aborted ? 'aborted during tool silence' : 'write failed during tool silence';
            break;
          }
          if (!frame({ type: 'tool_activity', tool: null, name: null, round })) {
            rec.endReason = 'write failed on tool end';
            return;
          }

          rec.rounds = round;
        }
      } catch (e: any) {
        rec.endReason = `threw: ${String(e?.message ?? e)}`;
        try { controller.enqueue(`data: ${JSON.stringify({ error: e?.message || 'unknown error' })}\n\n`); } catch { }
      } finally {
        rec.endedAt = Date.now();
        if (!rec.endReason) rec.endReason = 'loop exited';
        try { controller.enqueue(`data: [DONE]\n\n`); } catch { }
        try { controller.close(); } catch { }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * GET /api/stream-test?runId=…  → what the SERVER believes about that run.
 * GET /api/stream-test          → the list of runs it still remembers.
 *
 * Deliberately a separate connection. Called from a client that just unfroze,
 * the difference between its own last seq and `lastSeq` here is the size of
 * the stall, and `abortSeenAt` says whether the socket was closed or merely
 * ignored.
 *
 * `no-store` because a cached answer here is a lie with a timestamp on it.
 */
export async function GET(req: NextRequest) {
  const runId = req.nextUrl.searchParams.get('runId');
  const now = Date.now();
  const hdr = { 'Cache-Control': 'no-store' };

  if (!runId) {
    return NextResponse.json({
      now,
      pid: process.pid,
      instance: process.env.NEXUS_INSTANCE || 'main',
      runs: [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(r => ({ runId: r.runId, startedAt: r.startedAt, lastSeq: r.lastSeq, rounds: r.rounds, endedAt: r.endedAt, endReason: r.endReason })),
    }, { headers: hdr });
  }

  const rec = runs.get(runId);
  if (!rec) {
    // A dev-server restart (or HMR reloading this module) empties the Map, so
    // "unknown" genuinely means "cannot say", not "never existed". Saying so
    // beats inventing a zero.
    return NextResponse.json({
      now,
      pid: process.pid,
      runId,
      known: false,
      note: 'No record. Either the id is wrong, or this module was reloaded / the server restarted since the run began — in-memory only, by design.',
    }, { headers: hdr });
  }

  return NextResponse.json({
    now,
    pid: process.pid,
    instance: process.env.NEXUS_INSTANCE || 'main',
    known: true,
    ...rec,
    /** Convenience, computed here so client and server agree on the arithmetic. */
    ageMs: now - rec.startedAt,
    sinceLastWriteMs: now - rec.lastWriteAt,
    alive: rec.endedAt === null,
  }, { headers: hdr });
}
