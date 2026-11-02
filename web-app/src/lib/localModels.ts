import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { loadKeys } from './fsStorage';
import { killTree } from './shellTool';

const execAsync = promisify(exec);

export type ExecOutcome =
  | { kind: 'done'; stdout: string; stderr: string }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted' };

/**
 * Run one command, but stop WAITING for it the moment `signal` fires.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Reported 2026-11-02 (Lizard-kun): with LM Studio loading a model, Stop did
 * nothing until the load finished — and was instant once it had. The turn was
 * parked inside `lms load` (timeout 120_000, after `lms unload --all` at
 * 30_000), and the turn's abort signal reached the provider fetch, the tool
 * loops and the shell tool — everywhere EXCEPT here. Same family as the Bash
 * fix the night before: a blocking child with no abort path.
 *
 * `signal` is deliberately NOT handed to exec(). MEASURED 2026-11-02 while
 * fixing the Bash tool: Node's own abort listener kills the direct child
 * first, so a `taskkill /T` that follows finds no tree left to walk and the
 * grandchildren are orphaned. We keep the listener and do the killing, with
 * the same killTree this house already uses — one source for "/T is present".
 *
 * Returns as soon as the signal fires, WITHOUT awaiting the kill. A Stop that
 * waits for cleanup is the bug this fixes.
 *
 * What killing `lms` does NOT claim to do: cancel the load. `lms` is a client
 * of the LM Studio server, and the server is a separate process doing the
 * actual work. NOT MEASURED — proving it would mean loading a model here,
 * which evicts whatever this house has resident — so the claim stops at the
 * one thing that was asked for and can be checked: the TURN stops.
 */
export async function execOrAbandon(
  cmd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  // Seam, for the same reason killTree has one: the testable claim is
  // mechanical ("the tree is killed, and we return without awaiting it"), and
  // spawning taskkill in a test is not.
  kill: (child: Pick<ChildProcess, 'pid' | 'kill'>) => void = killTree,
): Promise<ExecOutcome> {
  // Checked before spawning, not only raced after: a turn already stopped must
  // not start a 120-second child whose only effect is to be killed.
  if (signal?.aborted) return { kind: 'aborted' };

  const running = execAsync(cmd, { timeout: timeoutMs });
  const child = running.child;

  // Folded into an outcome rather than left to throw, so the race below has
  // one settled shape to compare. A rejection that stays a rejection would
  // make the abort branch and the failure branch need different plumbing.
  const done: Promise<ExecOutcome> = running.then(
    ({ stdout, stderr }): ExecOutcome => ({ kind: 'done', stdout: String(stdout), stderr: String(stderr) }),
    (e: unknown): ExecOutcome => ({
      kind: 'failed',
      message: String((e as { stderr?: string })?.stderr || (e as Error)?.message || e),
    }),
  );

  if (!signal) return done;

  let onAbort: (() => void) | null = null;
  try {
    const abandoned = new Promise<ExecOutcome>((resolve) => {
      onAbort = () => {
        if (child) { try { kill(child); } catch { /* already gone */ } }
        resolve({ kind: 'aborted' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // Promise.race subscribes to `done`, so a rejection arriving after the
    // abort won is already handled and cannot surface as an unhandled one.
    return await Promise.race([done, abandoned]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

const LOCAL_BASE = process.env.LOCAL_LLM_BASE || 'http://localhost:1234';

export interface LocalModelMeta {
  id: string;
  displayName: string;
  sizeGB: string;
  params: string;
  arch: string;
  quant: string;
  vision: boolean;
  tools: boolean;
  maxContext: number;
  loaded: boolean;
  loadedContext: number;
  status: string;
}

/** Check if LM Studio HTTP server is up */
export async function checkServerUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${LOCAL_BASE}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/** Launch LM Studio GUI/server if configured in keys.json or common paths */
export async function ensureLmStudioLaunched(): Promise<{ launched: boolean; message: string }> {
  const isUp = await checkServerUp();
  if (isUp) return { launched: false, message: 'LM Studio is already running.' };

  const keys = await loadKeys();
  const exePath = keys.lmStudioPath?.trim();

  if (!exePath) {
    return { launched: false, message: `LM Studio server is not running at ${LOCAL_BASE}. Configure 'LM Studio Executable Path' in Preferences -> Other to auto-launch it.` };
  }

  try {
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();

    // Poll up to 15 seconds for port 1234 to respond
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await checkServerUp()) {
        return { launched: true, message: 'LM Studio launched successfully.' };
      }
    }
    return { launched: false, message: 'LM Studio executable started, but server port 1234 did not respond within 15 seconds.' };
  } catch (e: any) {
    return { launched: false, message: `Failed to launch LM Studio at "${exePath}": ${e?.message || e}` };
  }
}

/** Retrieve detailed metadata for installed & loaded models using lms CLI or /v1/models fallback */
export async function getLocalModelsMeta(): Promise<{ models: string[]; meta: LocalModelMeta[]; error?: string }> {
  // Try launching if down
  const isUp = await checkServerUp();
  if (!isUp) {
    await ensureLmStudioLaunched();
  }

  let lsData: any[] = [];
  let psData: any[] = [];
  let lmsCliAvailable = false;

  try {
    const { stdout: lsOut } = await execAsync('lms ls --json', { timeout: 4000 });
    lsData = JSON.parse(lsOut);
    lmsCliAvailable = true;
  } catch {
    lmsCliAvailable = false;
  }

  if (lmsCliAvailable) {
    try {
      const { stdout: psOut } = await execAsync('lms ps --json', { timeout: 4000 });
      psData = JSON.parse(psOut);
    } catch {}
  }

  if (lmsCliAvailable && Array.isArray(lsData) && lsData.length > 0) {
    const loadedMap = new Map<string, any>();
    if (Array.isArray(psData)) {
      for (const p of psData) {
        const key = p.modelKey || p.identifier || p.indexedModelIdentifier;
        if (key) loadedMap.set(key, p);
        if (p.modelKey) loadedMap.set(p.modelKey, p);
      }
    }

    const metaList: LocalModelMeta[] = [];
    const ids: string[] = [];

    for (const item of lsData) {
      // `lms ls` lists embedding models too — only chat LLMs are usable as
      // conversation models. (The old `&&` here let embeddings through.)
      if (item.type && item.type !== 'llm') continue;
      const id = item.modelKey || item.indexedModelIdentifier;
      if (!id) continue;

      ids.push(id);
      const loadedInfo = loadedMap.get(id) || loadedMap.get(item.modelKey);
      const isLoaded = !!loadedInfo;
      const sizeGB = item.sizeBytes ? `${(item.sizeBytes / (1024 ** 3)).toFixed(2)} GB` : '';

      metaList.push({
        id,
        displayName: item.displayName || id,
        sizeGB,
        params: item.paramsString || '',
        arch: item.architecture || '',
        quant: item.quantization?.name || '',
        vision: !!item.vision,
        tools: !!item.trainedForToolUse,
        maxContext: item.maxContextLength || 0,
        loaded: isLoaded,
        loadedContext: isLoaded ? (loadedInfo.contextLength || 0) : 0,
        status: isLoaded ? (loadedInfo.status || 'loaded') : 'off',
      });
    }

    return { models: ids, meta: metaList };
  }

  // Fallback to HTTP /v1/models if lms CLI is not in PATH or failed
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${LOCAL_BASE}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      return { models: [], meta: [], error: `LM Studio HTTP ${res.status}` };
    }

    const data = await res.json();
    const ids: string[] = Array.isArray(data?.data) ? data.data.map((m: any) => m.id).filter(Boolean) : [];
    const fallbackMeta: LocalModelMeta[] = ids.map((id: string) => ({
      id,
      displayName: id,
      sizeGB: '',
      params: '',
      arch: '',
      quant: '',
      vision: false,
      tools: false,
      maxContext: 0,
      loaded: true,
      loadedContext: 0,
      status: 'loaded',
    }));

    return { models: ids, meta: fallbackMeta };
  } catch (e: any) {
    return { models: [], meta: [], error: e?.message || 'LM Studio server unreachable' };
  }
}

/**
 * Execute `lms load` CLI command to explicitly load a model into VRAM with
 * context length.
 *
 * `signal` is the turn's abort controller. Without it the two commands below
 * hold a turn for up to 150 seconds with Stop pressed and nothing happening —
 * see execOrAbandon for the report and the measurement.
 */
export async function loadLocalModel(
  modelKey: string,
  contextLength?: number,
  signal?: AbortSignal,
  // Seam. The claim worth testing is that BOTH commands carry the signal —
  // dropping it from the unload leaves up to 30 seconds of dead button, which
  // is a quarter of the bug still present. Mutation testing found this hole
  // (2026-11-02): every test here drove execOrAbandon directly and none drove
  // THIS function, so removing the signal from the first call changed nothing
  // any test could see. Injected rather than tested through the real `lms`,
  // because a test that reaches the real CLI would eject whatever model this
  // house has resident — and it would do it on the FAILING path, where the
  // damage is least expected.
  run: typeof execOrAbandon = execOrAbandon,
): Promise<{ ok: boolean; message: string; aborted?: boolean }> {
  if (!modelKey) return { ok: false, message: 'No model specified' };

  // Eject every currently-loaded model first. LM Studio will otherwise keep
  // multiple models resident in VRAM, which either OOMs or silently fails to
  // load the requested one. `unload --all` errors when nothing is loaded, so
  // its failure is non-fatal — the `lms load` below is what actually matters.
  //
  // An ABORT here is fatal though, and that asymmetry is the point: a failure
  // means "carry on and load", a Stop means there is no turn left to load for.
  const unloaded = await run('lms unload --all', 30000, signal);
  if (unloaded.kind === 'aborted') {
    return { ok: false, aborted: true, message: 'Stopped before the model was loaded.' };
  }

  const ctx = contextLength && contextLength > 0 ? contextLength : 80000;
  // Deliberately NOT forcing `--gpu max`: LM Studio auto-picks the optimal
  // offload ratio when the flag is omitted, which is safer on machines whose
  // VRAM is smaller than the model. `-c` is the context window the caller
  // resolved from the conversation's "Context window" setting.
  const cmd = `lms load "${modelKey}" -c ${ctx} --yes`;

  const loaded = await run(cmd, 120000, signal);
  if (loaded.kind === 'aborted') {
    return { ok: false, aborted: true, message: 'Stopped while the model was loading.' };
  }
  if (loaded.kind === 'failed') {
    return { ok: false, message: `Failed to run \`${cmd}\`: ${loaded.message}` };
  }
  const output = (loaded.stdout + '\n' + loaded.stderr).trim();
  return { ok: true, message: output || `Model ${modelKey} loaded with ${ctx} context.` };
}
