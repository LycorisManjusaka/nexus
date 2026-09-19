/**
 * Gemma vision batch-size patch for LM Studio.
 *
 * WHY THIS EXISTS
 * ---------------
 * Gemma's vision path attends over the image embedding block NON-CAUSALLY.
 * llama.cpp asserts, for a non-causal batch:
 *
 *     GGML_ASSERT((cparams.causal_attn || cparams.n_ubatch >= n_tokens_all))
 *
 * `n_ubatch` is LM Studio's "physical batch size", which defaults to 512.
 * Any image whose embedding block exceeds 512 tokens trips the assert and the
 * model process dies mid-request — the HTTP call comes back 400 "terminated"
 * and the model shows as unloaded. Raising `n_ubatch` to 2048 fixes it.
 *
 * MEASURED, not assumed (2026-09-19, this machine):
 *   - `lms load` has NO batch-size flag (full option list checked), so writing
 *     LM Studio's per-model config file is the only route.
 *   - Config path is `<lmstudio home>/.internal/user-concrete-model-default-config/
 *     <indexedModelIdentifier>.json`. Verified against all 15 installed models
 *     that had configs; every one matched the rule.
 *   - A config file that NEXUS creates from scratch IS read by LM Studio.
 *     A/B probe on a model that had no config: without it, a 1344x1344 image
 *     gave HTTP 400 "terminated"; with a minimal freshly-written config
 *     carrying only physicalBatchSize 2048, the same image gave HTTP 200 with
 *     prompt_tokens 805.
 *
 * KNOWN LIMITS — say these out loud rather than implying the problem is gone:
 *   - This patches the models installed RIGHT NOW. A Gemma downloaded later
 *     crashes again until the button is pressed again.
 *   - An already-loaded model keeps the batch size it was loaded with; the new
 *     value applies at the next load.
 *   - 2048 covered the measured case. A prompt carrying an unusually large
 *     (or multi-) image block could still exceed it; raise the value by hand
 *     in LM Studio if that happens. This code never LOWERS an existing value.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

/** LM Studio's key for llama.cpp `n_ubatch`. */
const BATCH_KEY = 'llm.load.llama.physicalBatchSize';
/** Value we raise to. Never used to lower an existing, larger value. */
const TARGET_BATCH = 2048;

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');

export type PatchAction = 'created' | 'raised' | 'already-ok' | 'refused' | 'failed';

export interface PatchResult {
  modelKey: string;
  displayName: string;
  /** Path of the config file this model maps to, absolute. */
  configPath: string;
  action: PatchAction;
  /** Value found before the patch, if the key was present. */
  previousValue?: number;
  /** Value in the file after this run. */
  value?: number;
  /** Populated for 'refused' and 'failed'. */
  reason?: string;
}

export interface PatchReport {
  ok: boolean;
  /** Absolute path of LM Studio's per-model config directory. */
  configDir: string;
  /** Directory the untouched originals were copied into, if anything changed. */
  backupDir?: string;
  /** Every Gemma-architecture vision model found, whether or not it changed. */
  results: PatchResult[];
  /** Total number of Gemma vision models detected. */
  scanned: number;
  changed: number;
  error?: string;
}

/**
 * LM Studio keeps its per-model defaults under the user's home. There is no
 * documented env override that I have verified, so this resolves from homedir
 * and the caller reports the path — if it is wrong on some install, the report
 * shows exactly which directory was missing instead of failing vaguely.
 */
function configDirFor(): string {
  return path.join(os.homedir(), '.lmstudio', '.internal', 'user-concrete-model-default-config');
}

interface LmsModel {
  type?: string;
  modelKey?: string;
  displayName?: string;
  architecture?: string;
  vision?: boolean;
  indexedModelIdentifier?: string;
}

/**
 * Target predicate: architecture starts with "gemma" AND the model reports
 * vision. Deliberately architecture-based rather than name-based — a model
 * renamed by whoever repackaged it ("...uncensored-balanced") still carries
 * the right architecture string, and a non-Gemma model with "gemma" in its
 * display name is not a target.
 *
 * Non-vision Gemmas are excluded on purpose: the assert only fires on the
 * non-causal image block, so a text-only model gains nothing and we would be
 * editing files for no measured reason.
 */
function isGemmaVision(m: LmsModel): boolean {
  if (m.type && m.type !== 'llm') return false;
  if (!m.vision) return false;
  return /^gemma/i.test(m.architecture || '');
}

/** Read the installed-model list straight from the CLI NEXUS already shells to. */
async function listModels(): Promise<LmsModel[]> {
  const { stdout } = await execAsync('lms ls --json', { timeout: 10000 });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('`lms ls --json` did not return an array.');
  return parsed as LmsModel[];
}

/** tmp-then-rename, the same discipline the rest of NEXUS writes files with. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

interface ConfigShape {
  preset?: unknown;
  operation?: unknown;
  load?: { fields?: Array<{ key?: unknown; value?: unknown }> };
  [k: string]: unknown;
}

/**
 * Decide what a single model's file needs. Returns the text to write, or null
 * when nothing should change, or throws with a human reason when the existing
 * file is a shape we do not recognise — in that case we refuse rather than
 * overwrite someone else's data.
 */
type FilePlan =
  | { change: false; previousValue: number }
  | { change: true; text: string; action: PatchAction; previousValue?: number };

function planFile(raw: string | null): FilePlan {
  let cfg: ConfigShape;

  if (raw === null) {
    // No file yet. Write the minimal shape the A/B probe proved LM Studio reads.
    cfg = { preset: '', operation: { fields: [] }, load: { fields: [] } };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`existing file is not valid JSON (${e?.message || e})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('existing file is not a JSON object');
    }
    cfg = parsed as ConfigShape;
    if (cfg.load !== undefined && (typeof cfg.load !== 'object' || cfg.load === null || Array.isArray(cfg.load))) {
      throw new Error('existing file has a "load" that is not an object');
    }
    if (cfg.load?.fields !== undefined && !Array.isArray(cfg.load.fields)) {
      throw new Error('existing file has a "load.fields" that is not an array');
    }
  }

  if (!cfg.load || typeof cfg.load !== 'object') cfg.load = { fields: [] };
  if (!Array.isArray(cfg.load.fields)) cfg.load.fields = [];

  const fields = cfg.load.fields;
  const idx = fields.findIndex(f => f && typeof f === 'object' && f.key === BATCH_KEY);

  if (idx >= 0) {
    const prev = fields[idx].value;
    if (typeof prev !== 'number') {
      throw new Error(`existing ${BATCH_KEY} is ${JSON.stringify(prev)}, not a number`);
    }
    // Raise, never lower. Somebody who set 4096 by hand keeps 4096, and the
    // report shows 4096 rather than the value we would have written.
    if (prev >= TARGET_BATCH) return { change: false, previousValue: prev };
    fields[idx] = { key: BATCH_KEY, value: TARGET_BATCH };
    return { change: true, text: JSON.stringify(cfg, null, 2) + '\n', action: 'raised', previousValue: prev };
  }

  fields.push({ key: BATCH_KEY, value: TARGET_BATCH });
  return { change: true, text: JSON.stringify(cfg, null, 2) + '\n', action: raw === null ? 'created' : 'raised' };
}

/**
 * Patch every installed Gemma vision model.
 *
 * `dryRun` reports exactly what would change without writing anything, so the
 * same code path answers "what will this do" and "do it".
 */
export async function patchGemmaBatchSize(dryRun = false): Promise<PatchReport> {
  const configDir = configDirFor();

  let models: LmsModel[];
  try {
    models = await listModels();
  } catch (e: any) {
    return {
      ok: false,
      configDir,
      results: [],
      scanned: 0,
      changed: 0,
      error: `Could not read the installed-model list: ${e?.stderr || e?.message || e}. Is the \`lms\` CLI on PATH?`,
    };
  }

  try {
    await fs.access(configDir);
  } catch {
    return {
      ok: false,
      configDir,
      results: [],
      scanned: 0,
      changed: 0,
      error: `LM Studio's per-model config directory does not exist at ${configDir}. Nothing was written.`,
    };
  }

  const targets = models.filter(isGemmaVision);
  const results: PatchResult[] = [];

  // One backup folder per run, created lazily so a no-op run leaves no litter.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DATA_DIR, 'backups', 'lmstudio-config', stamp);
  let backupMade = false;
  const manifest: Array<{ modelKey: string; configPath: string; existedBefore: boolean }> = [];

  for (const m of targets) {
    const modelKey = m.modelKey || m.indexedModelIdentifier || '(unknown)';
    const rel = m.indexedModelIdentifier;
    if (!rel) {
      results.push({
        modelKey,
        displayName: m.displayName || modelKey,
        configPath: '',
        action: 'refused',
        reason: 'model has no indexedModelIdentifier, so its config file cannot be located',
      });
      continue;
    }

    const configPath = path.join(configDir, `${rel}.json`);
    const base: Omit<PatchResult, 'action'> = {
      modelKey,
      displayName: m.displayName || modelKey,
      configPath,
    };

    let raw: string | null = null;
    try {
      raw = await fs.readFile(configPath, 'utf8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') {
        results.push({ ...base, action: 'failed', reason: `could not read: ${e?.message || e}` });
        continue;
      }
    }

    let plan: FilePlan;
    try {
      plan = planFile(raw);
    } catch (e: any) {
      // Unrecognised shape: leave it alone and say so.
      results.push({ ...base, action: 'refused', reason: e?.message || String(e) });
      continue;
    }

    if (!plan.change) {
      results.push({ ...base, action: 'already-ok', value: plan.previousValue, previousValue: plan.previousValue });
      continue;
    }

    if (dryRun) {
      results.push({ ...base, action: plan.action, previousValue: plan.previousValue, value: TARGET_BATCH });
      continue;
    }

    try {
      // Copy the untouched original into NEXUS's own area first. Files we
      // create did not exist, so there is nothing to copy — the manifest
      // records that, which is what makes an undo-by-hand possible.
      if (raw !== null) {
        const dest = path.join(backupDir, `${rel}.json`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, raw, 'utf8');
      } else {
        await fs.mkdir(backupDir, { recursive: true });
      }
      backupMade = true;
      manifest.push({ modelKey, configPath, existedBefore: raw !== null });

      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await writeAtomic(configPath, plan.text);
      results.push({ ...base, action: plan.action, previousValue: plan.previousValue, value: TARGET_BATCH });
    } catch (e: any) {
      results.push({ ...base, action: 'failed', reason: `could not write: ${e?.message || e}` });
    }
  }

  if (backupMade) {
    try {
      await fs.writeFile(
        path.join(backupDir, 'manifest.json'),
        JSON.stringify(
          {
            what: `NEXUS raised ${BATCH_KEY} to ${TARGET_BATCH} for Gemma vision models in LM Studio.`,
            when: new Date().toISOString(),
            configDir,
            undo: 'Files with existedBefore=true: copy the .json back over configPath. Files with existedBefore=false: delete configPath.',
            entries: manifest,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } catch {
      // The patch itself succeeded; a missing manifest must not report failure.
    }
  }

  const changed = results.filter(r => r.action === 'created' || r.action === 'raised').length;

  return {
    ok: !results.some(r => r.action === 'failed'),
    configDir,
    backupDir: backupMade ? backupDir : undefined,
    results,
    scanned: targets.length,
    changed,
  };
}
