/**
 * Parse `lms load <key> -c <ctx> --estimate-only` output — single source.
 *
 * WHY A PARSER AND NOT --json (measured 2026-11-09, lms 0.4.28):
 * `lms load` has no `--json` flag (`error: unknown option '--json'`). The
 * house rule is "stop parsing output, ask for a machine-readable form" — here
 * there isn't one, so the parser is the only road. The compensation is that it
 * lives in ONE function with tests, instead of a regex inlined at a call site.
 *
 * MEASURED OUTPUT (this machine, 0.318s, model is NOT loaded):
 *   Model: google/gemma-4-12b
 *   Context Length: 8,192
 *   Estimated GPU Memory:   13.57 GiB
 *   Estimated Total Memory: 13.57 GiB
 *
 *   Estimate: This model may be loaded based on your resource guardrails settings.
 *
 * It really does scale with context (same model, same machine):
 *   4,096 -> 15.16 GiB | 8,192 -> 13.57 GiB | 100,000 -> 27.51 GiB
 *   262,144 -> 35.54 GiB
 * which is the whole point of the feature: 津代 asked to see what a context
 * window actually costs in VRAM before committing to it.
 *
 * ⚠ THE FAILURE MODE IS SILENT. A wrong model key prints
 *   "Model not found\n\nNo model found that matches model key ..."
 * and still EXITS 0. So "did it work" cannot be read from the exit code —
 * only from whether the numbers parsed. `ok:false` carries the raw text so a
 * caller can show what the tool actually said.
 *
 * ⚠ THE KEY MUST BE `modelKey`, NOT A PATH. `lms ls --json` exposes both
 * `modelKey` ("gemma-4-26b-a4b-it-qat-...") and `indexedModelIdentifier`
 * (the publisher/repo/file path). Passing the path yields "Model not found".
 *
 * ⚠ THE GUARDRAIL VERDICT IS PASSED THROUGH VERBATIM, NOT CLASSIFIED.
 * Every estimate on this machine said "may be loaded" — even 35.54 GiB on a
 * 24 GB card — so the "may NOT be loaded" branch is UNMEASURED here. Writing
 * an `ok/tooBig` boolean would be shipping a branch I never saw. The caller
 * shows the sentence; the reader compares the number to their own card.
 */

export interface LmsEstimate {
  ok: boolean;
  /** Model key echoed back by lms, when it parsed. */
  model?: string;
  /** Context length echoed back by lms (commas stripped), when it parsed. */
  contextLength?: number;
  /** e.g. "13.57 GiB" — verbatim value + unit as lms printed them. */
  gpuMemory?: string;
  /** e.g. "13.57 GiB". Equals gpuMemory when nothing spills to system RAM. */
  totalMemory?: string;
  /** The "Estimate: ..." sentence, verbatim, without the "Estimate: " prefix. */
  verdict?: string;
  /** Raw stdout+stderr. Always set, so a failed parse can still be shown. */
  raw: string;
}

/** `13.57 GiB` out of `Estimated GPU Memory:   13.57 GiB`. */
function matchMemory(text: string, which: 'GPU' | 'Total'): string | undefined {
  // Unit is captured rather than assumed: a small model can report MiB, and a
  // future lms could print GB. Whatever it says is what the reader sees.
  const re = new RegExp(
    `Estimated\\s+${which}\\s+Memory\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*([KMGT]i?B)`,
    'i',
  );
  const m = text.match(re);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

/**
 * Parse one `--estimate-only` run.
 *
 * `ok` is true only when BOTH memory numbers parsed — that pair is the whole
 * answer the caller wants, and a half-parse means the format moved under us.
 */
export function parseLmsEstimate(output: string): LmsEstimate {
  const raw = output ?? '';
  const gpuMemory = matchMemory(raw, 'GPU');
  const totalMemory = matchMemory(raw, 'Total');

  const modelM = raw.match(/^\s*Model\s*:\s*(.+?)\s*$/m);
  const ctxM = raw.match(/^\s*Context\s+Length\s*:\s*([0-9,]+)\s*$/m);
  const verdictM = raw.match(/^\s*Estimate\s*:\s*(.+?)\s*$/m);

  return {
    ok: !!(gpuMemory && totalMemory),
    model: modelM ? modelM[1] : undefined,
    contextLength: ctxM ? Number(ctxM[1].replace(/,/g, '')) : undefined,
    gpuMemory,
    totalMemory,
    verdict: verdictM ? verdictM[1] : undefined,
    raw,
  };
}

/**
 * Argument vector for the estimate run.
 *
 * `--yes` is required: without it lms drops into an interactive picker when
 * several files match a key, and this runs with no stdin. `--estimate-only`
 * is what keeps it from actually loading the model — verified by watching
 * VRAM stay flat across runs.
 */
export function lmsEstimateArgs(modelKey: string, contextLength: number): string[] {
  return ['load', modelKey, '-c', String(Math.max(1, Math.floor(contextLength))), '--estimate-only', '--yes'];
}
