import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { loadKeys } from './fsStorage';

const execAsync = promisify(exec);
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

/** Execute `lms load` CLI command to explicitly load a model into VRAM with context length */
export async function loadLocalModel(modelKey: string, contextLength?: number): Promise<{ ok: boolean; message: string }> {
  if (!modelKey) return { ok: false, message: 'No model specified' };

  // Eject every currently-loaded model first. LM Studio will otherwise keep
  // multiple models resident in VRAM, which either OOMs or silently fails to
  // load the requested one. `unload --all` errors when nothing is loaded, so
  // its failure is non-fatal — the `lms load` below is what actually matters.
  try {
    await execAsync('lms unload --all', { timeout: 30000 });
  } catch {
    // No models loaded (or CLI hiccup) — proceed to load.
  }

  const ctx = contextLength && contextLength > 0 ? contextLength : 80000;
  // Deliberately NOT forcing `--gpu max`: LM Studio auto-picks the optimal
  // offload ratio when the flag is omitted, which is safer on machines whose
  // VRAM is smaller than the model. `-c` is the context window the caller
  // resolved from the conversation's "Context window" setting.
  const cmd = `lms load "${modelKey}" -c ${ctx} --yes`;

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 120000 });
    const output = (stdout + '\n' + stderr).trim();
    return { ok: true, message: output || `Model ${modelKey} loaded with ${ctx} context.` };
  } catch (e: any) {
    return { ok: false, message: `Failed to run \`${cmd}\`: ${e?.stderr || e?.message || e}` };
  }
}
