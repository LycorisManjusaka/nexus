// ───────────────────────────────────────────────────────────────────────────
// One SPU action, run to completion on the server and recorded on disk.
//
// This is to the System Prompt Updater what runTurnForQueue is to a chat turn:
// the browser kicks it and then merely WATCHES. Closing the tab costs a view,
// not a soul update.
//
// The panel still assembles the user message (spuScaffold's build*UserMsg) and
// still does the post-processing (strip the sentinel, split off the changelog
// and the logs). Only the expensive, tab-fragile middle — up to seven provider
// calls across minutes — moved here. The split is deliberate: assembly needs
// panel state, post-processing is pure and idempotent and can happen whenever
// the tab comes back, and the generation is the only part that cannot be
// redone for free.
//
// All five actions share this file. Measured 2026-10-31: update, redistribute,
// index and genesis each carried a byte-identical copy of the continuation
// loop, and the summary writer is the same loop with the budget set to zero.
// What actually differs between them — which agent file, which user message,
// what happens to the result — is entirely the caller's.
// ───────────────────────────────────────────────────────────────────────────

import { createSseReader, isSseDone } from '@/lib/sseFrames';
import { buildSpuChatBody } from '@/lib/spuChatBody';
import { runSpuLoop, type SpuRunRecord, type SpuRunOutcome } from '@/lib/spuRun';
import { END_SENTINEL, type ScaffoldLang } from '@/lib/spuScaffold';

export interface RunSpuArgs {
  folder: string;
  label: string;
  action: string;
  convoId: string;
  /** Already assembled by the panel - see the note at the top of this file. */
  userMsg: string;
  /** The agent's .md instruction file. */
  agentSystemPrompt: string;
  lang: ScaffoldLang;
  resumeText: string;
  aiName: string;
  specificModel: string;
  authMode?: 'oauth' | 'api-key';
  modelParams: Record<string, unknown>;
  /** 0 means "one call, no continuations" - the summary writer's shape. */
  maxContinuations?: number;
  /**
   * Passed through to the chat route so Stop can abort the in-flight call
   * rather than waiting for the next round boundary. See SpuChatBodyArgs.
   */
  relayKey?: string;
  turnId?: string;
}

export interface RunSpuDeps {
  /**
   * Injected for the reason runTurnForQueue gives: importing the chat route
   * drags in next/server, which cannot load outside Next's runtime, so a
   * module that imports it is untestable. The route passes the real one.
   */
  chatPost: (req: Request) => Promise<Response>;
  writeRecord: (folder: string, label: string, record: SpuRunRecord) => Promise<unknown>;
  /** Raw SSE text, forwarded byte-for-byte to whoever is watching. */
  onRawText?: (text: string) => void;
  /** Checked between rounds. See SpuRunDeps.isAborted. */
  isAborted?: () => boolean;
  nowMs: () => number;
  newId: () => string;
  /**
   * Only used to give the synthetic Request a URL. A failing call then names
   * the port it was aimed at instead of one this file invented.
   */
  origin: string;
  /** Which installation ran it, so a stuck record can name who left it. */
  host: string;
}

export type RunSpuResult =
  | { ok: true; record: SpuRunRecord }
  | { ok: false; stage: 'stream' | 'record'; reason: string; record: SpuRunRecord };

/**
 * Drain one /api/chat response into its visible text.
 *
 * Returns the text of THIS call only. Forwards every raw frame to `onRawText`
 * BEFORE interpreting it, so a watcher sees what killed a run as well as what
 * a run produced.
 */
async function drainOneCall(
  res: Response,
  onRawText: ((text: string) => void) | undefined,
): Promise<string> {
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(errText || `HTTP ${res.status}`);
  }
  // `Uint8Array | string` because both really arrive - see the measurement at
  // runTurnStream. Over HTTP the server encodes the enqueued string; called as
  // a module nothing does, and `decode()` throws TypeError on a string.
  const reader = (res.body as ReadableStream<Uint8Array | string>).getReader();
  const decoder = new TextDecoder('utf-8');
  const sse = createSseReader();
  let accum = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = typeof value === 'string'
      ? value
      : decoder.decode(value, { stream: true });
    onRawText?.(text);
    for (const payload of sse.push(text)) {
      if (isSseDone(payload)) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(payload);
      } catch {
        // A frame we cannot parse is swallowed; a frame we CAN parse that
        // carries an error is re-thrown below. Those are different things, and
        // the panel's version of this loop conflated them behind a
        // `startsWith('Unexpected')` check on the message text.
        continue;
      }
      if (d.type === 'text' && typeof d.content === 'string') accum += d.content;
      if (typeof d.error === 'string' && d.error) throw new Error(d.error);
    }
  }
  return accum;
}

export async function runSpuAction(
  args: RunSpuArgs,
  deps: RunSpuDeps,
): Promise<RunSpuResult> {
  const startedAt = deps.nowMs();
  const runId = deps.newId();

  const baseRecord = (over: Partial<SpuRunRecord>): SpuRunRecord => ({
    runId,
    label: args.label,
    action: args.action,
    convoId: args.convoId,
    startedAt,
    updatedAt: deps.nowMs(),
    status: 'running',
    accum: '',
    sawSentinel: false,
    attempts: 0,
    vessel: { aiName: args.aiName, specificModel: args.specificModel },
    host: deps.host,
    ...over,
  });

  // Written BEFORE the first provider call. Without this a crashed run and a
  // run that was never started look identical on disk, and the panel cannot
  // tell "nothing happened" from "something happened and died".
  await deps.writeRecord(args.folder, args.label, baseRecord({}));

  // The last accumulation a checkpoint saw. The catch below needs it: `outcome`
  // does not exist on the failing path, and without this an error on round 6
  // of 7 would record `accum: ''` — discarding five rounds of a soul update
  // that only the provider's last call went wrong in. (Written first with the
  // comment claiming the text was kept and the code defaulting it to empty.)
  //
  // Mid-round text is NOT here, and cannot be: a round's text only exists once
  // its call returns. That matches what the panel's loop always did; a watcher
  // still saw the lost part go past on the relay.
  let lastCheckpoint = args.resumeText ? args.resumeText + '\n' : '';
  let lastAttempts = 0;

  let outcome: SpuRunOutcome;
  try {
    outcome = await runSpuLoop(
      {
        userMsg: args.userMsg,
        lang: args.lang,
        resumeText: args.resumeText,
        maxContinuations: args.maxContinuations,
      },
      {
        streamOnce: async (messages) => {
          const body = buildSpuChatBody({
            messages,
            systemPrompt: args.agentSystemPrompt,
            folderName: args.folder,
            aiName: args.aiName,
            specificModel: args.specificModel,
            modelParams: args.modelParams,
            authMode: args.authMode,
            convoId: args.relayKey,
            injectTurnId: args.turnId,
          });
          const res = await deps.chatPost(
            new Request(`${deps.origin}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
          );
          return drainOneCall(res, deps.onRawText);
        },
        // A checkpoint failure must not abandon a generation that is going
        // fine, so it is swallowed here rather than inside the loop: the loop
        // has no opinion about storage.
        onCheckpoint: async (accum, attempt) => {
          lastCheckpoint = accum;
          lastAttempts = attempt + 1;
          try {
            await deps.writeRecord(args.folder, args.label, baseRecord({
              accum,
              attempts: attempt + 1,
              updatedAt: deps.nowMs(),
            }));
          } catch { /* the final write is the one that must land */ }
        },
        isAborted: deps.isAborted,
      },
    );
  } catch (e) {
    const reason = String((e as Error)?.message || e);
    // A failed run still gets a record, and still keeps whatever text it had
    // produced. Discarding it would make a provider error that lands on round
    // 6 of 7 cost the whole document - the thing "Continue from the right-side
    // text" exists to rescue.
    const record = baseRecord({
      status: 'error',
      error: reason,
      accum: lastCheckpoint,
      attempts: lastAttempts,
      sawSentinel: lastCheckpoint.includes(END_SENTINEL),
      updatedAt: deps.nowMs(),
    });
    try {
      await deps.writeRecord(args.folder, args.label, record);
    } catch (e2) {
      return { ok: false, stage: 'record', reason: `${reason} (and the record failed: ${String((e2 as Error)?.message || e2)})`, record };
    }
    return { ok: false, stage: 'stream', reason, record };
  }

  const record = baseRecord({
    status: outcome.endedBecause === 'aborted' ? 'stopped' : 'done',
    accum: outcome.accum,
    sawSentinel: outcome.sawSentinel,
    attempts: outcome.attempts,
    endedBecause: outcome.endedBecause,
    updatedAt: deps.nowMs(),
  });
  try {
    await deps.writeRecord(args.folder, args.label, record);
  } catch (e) {
    // The generation succeeded and the only durable copy failed to land. That
    // is worth a distinct stage: retrying the write is cheap, redoing seven
    // provider calls is not.
    return { ok: false, stage: 'record', reason: String((e as Error)?.message || e), record };
  }
  return { ok: true, record };
}
