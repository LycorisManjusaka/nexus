/**
 * lmsEstimate — reading LM Studio's memory estimate out of a CLI that has no
 * machine-readable mode.
 *
 * NEW TEST, written 2026-11-09 with the feature (津代: "can you bring LM
 * Studio's Estimated Memory Usage into NEXUS? it's how you tell whether a
 * model is usable at all").
 *
 * WHY A PARSER IS TESTED INSTEAD OF AVOIDED:
 * The house rule is to stop parsing output and ask for `--json`. `lms load`
 * doesn't have one (`error: unknown option '--json'`, measured on 0.4.28), so
 * the parse is the only road — and the compensation is that it lives in one
 * function whose shape is pinned here. If a future lms changes the wording,
 * these tests fail instead of the UI quietly showing nothing.
 *
 * THE WEIGHT IS ON THE SILENT FAILURE.
 * A wrong model key prints "Model not found" and still EXITS 0. So "the
 * command didn't throw" is not evidence it worked, and `ok` must come from
 * whether the NUMBERS parsed — nothing else. That is the one property here
 * that, if it broke, would show a reader a blank where a 35 GiB warning
 * should be.
 *
 * All fixtures below are verbatim output captured on this machine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLmsEstimate, lmsEstimateArgs } from '../../src/lib/lmsEstimate';

// Captured 2026-11-09: `lms load "google/gemma-4-12b" -c 8192 --estimate-only --yes`
const OK_8K = `Model: google/gemma-4-12b
Context Length: 8,192
Estimated GPU Memory:   13.57 GiB
Estimated Total Memory: 13.57 GiB

Estimate: This model may be loaded based on your resource guardrails settings.
`;

// Same model, -c 100000. The point of the whole feature: the number moves.
const OK_100K = `Model: google/gemma-4-12b
Context Length: 100,000
Estimated GPU Memory:   27.51 GiB
Estimated Total Memory: 27.51 GiB

Estimate: This model may be loaded based on your resource guardrails settings.
`;

// Captured with a PATH instead of a modelKey — note the exit code was 0.
const NOT_FOUND = `Model not found

No model found that matches model key "mradermacher/gemma-4-26B-A4B-it-qat-q4_0-unquantized-uncensored-heretic-v2-i1-GGUF".

To see a list of all downloaded models, run:

    lms ls
`;

describe('parseLmsEstimate — success', () => {
  it('pulls both memory figures with their units', () => {
    const e = parseLmsEstimate(OK_8K);
    assert.equal(e.ok, true);
    assert.equal(e.gpuMemory, '13.57 GiB');
    assert.equal(e.totalMemory, '13.57 GiB');
  });

  it('echoes the model and strips the thousands comma from the context', () => {
    const e = parseLmsEstimate(OK_8K);
    assert.equal(e.model, 'google/gemma-4-12b');
    assert.equal(e.contextLength, 8192);
  });

  it('tracks the context length — the reason this feature exists', () => {
    const small = parseLmsEstimate(OK_8K);
    const big = parseLmsEstimate(OK_100K);
    assert.equal(big.contextLength, 100000);
    assert.equal(big.gpuMemory, '27.51 GiB');
    // If these ever came out equal, the estimate would be answering a
    // different question than the one the context box asks.
    assert.notEqual(small.gpuMemory, big.gpuMemory);
  });

  it('passes the guardrail sentence through verbatim', () => {
    // NOT parsed into a boolean. Every estimate on this machine said "may be
    // loaded" — even 35.54 GiB on a 24 GB card — so the "may NOT" branch is
    // unmeasured here, and classifying it would ship a branch never seen.
    const e = parseLmsEstimate(OK_8K);
    assert.equal(
      e.verdict,
      'This model may be loaded based on your resource guardrails settings.',
    );
  });
});

describe('parseLmsEstimate — the silent failure', () => {
  it('reports ok:false when lms says "Model not found" (which exits 0)', () => {
    const e = parseLmsEstimate(NOT_FOUND);
    assert.equal(e.ok, false);
    assert.equal(e.gpuMemory, undefined);
    assert.equal(e.totalMemory, undefined);
  });

  it('keeps the raw text so a caller can show what the tool actually said', () => {
    const e = parseLmsEstimate(NOT_FOUND);
    assert.ok(e.raw.includes('Model not found'));
  });

  it('is not ok on a half-parse', () => {
    // A format change that renames one line must not read as success with a
    // missing half.
    const half = 'Model: x\nEstimated GPU Memory: 10 GiB\n';
    assert.equal(parseLmsEstimate(half).ok, false);
  });

  it('survives empty and junk input', () => {
    assert.equal(parseLmsEstimate('').ok, false);
    assert.equal(parseLmsEstimate('').raw, '');
    assert.equal(parseLmsEstimate('nonsense').ok, false);
  });
});

describe('parseLmsEstimate — unit handling', () => {
  it('does not assume GiB', () => {
    // A small model can report MiB. The unit is captured, not hardcoded, so
    // whatever lms says is what the reader sees.
    const mib = `Estimated GPU Memory:   820.5 MiB
Estimated Total Memory: 820.5 MiB
`;
    const e = parseLmsEstimate(mib);
    assert.equal(e.ok, true);
    assert.equal(e.gpuMemory, '820.5 MiB');
  });

  it('tolerates the variable column padding lms emits', () => {
    const tight = 'Estimated GPU Memory: 1 GiB\nEstimated Total Memory:    2 GiB\n';
    const e = parseLmsEstimate(tight);
    assert.equal(e.gpuMemory, '1 GiB');
    assert.equal(e.totalMemory, '2 GiB');
  });
});

describe('lmsEstimateArgs', () => {
  it('always passes --estimate-only and --yes', () => {
    const a = lmsEstimateArgs('google/gemma-4-12b', 8192);
    // --estimate-only is what keeps this from LOADING the model; --yes is
    // required because there is no stdin for the interactive picker.
    assert.ok(a.includes('--estimate-only'));
    assert.ok(a.includes('--yes'));
    assert.deepEqual(a.slice(0, 4), ['load', 'google/gemma-4-12b', '-c', '8192']);
  });

  it('sanitizes the context length to a positive integer', () => {
    assert.equal(lmsEstimateArgs('m', 8192.7)[3], '8192');
    assert.equal(lmsEstimateArgs('m', 0)[3], '1');
    assert.equal(lmsEstimateArgs('m', -5)[3], '1');
  });
});
