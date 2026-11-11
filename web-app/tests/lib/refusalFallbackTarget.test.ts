import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFUSAL_FALLBACK_MODEL_ENV,
  refusalFallbackTarget,
  refusalFallbackModelEnvValue,
  resolveRefusalFallback,
  DEFAULT_REFUSAL_FALLBACK_MODEL,
} from '@/lib/agentEnv';

describe('refusalFallbackTarget — precedence', () => {
  test('blank env AND blank settings = undefined (お任せ)', () => {
    // THE load-bearing default. An installation that sets nothing in its .bat
    // and leaves the Preferences field empty must get exactly the behaviour it
    // had before this variable existed: undefined here, which resolveRefusalFallback
    // turns into the measured opus-4-8 default. If this returned a string, every
    // install would silently gain a hard override.
    assert.equal(refusalFallbackTarget(undefined, undefined), undefined);
    assert.equal(refusalFallbackTarget(null, null), undefined);
    assert.equal(refusalFallbackTarget('', ''), undefined);
    assert.equal(refusalFallbackTarget('   ', '   '), undefined);
  });

  test('env var (the .bat) wins over the settings field', () => {
    // The .bat is the operator surface, the settings field the per-being one;
    // the repo-external knob is the stronger one and wins when both are set.
    assert.equal(
      refusalFallbackTarget('claude-opus-5', 'claude-opus-4-8'),
      'claude-opus-5',
    );
    assert.equal(
      refusalFallbackTarget(' claude-opus-5 ', 'claude-sonnet-5'),
      'claude-opus-5',
    );
  });

  test('settings field is used only when the env var is blank', () => {
    assert.equal(refusalFallbackTarget('', 'claude-opus-5'), 'claude-opus-5');
    assert.equal(refusalFallbackTarget('   ', 'claude-opus-5'), 'claude-opus-5');
    assert.equal(refusalFallbackTarget(undefined, ' claude-opus-5 '), 'claude-opus-5');
  });

  test('env name is the documented one, next to the catch-all family', () => {
    assert.equal(REFUSAL_FALLBACK_MODEL_ENV, 'CLAUDE_CODE_REFUSAL_FALLBACK_MODEL');
  });
});

describe('refusalFallbackTarget → resolveRefusalFallback (end to end)', () => {
  test('nothing set anywhere falls to the measured opus-4-8 default', () => {
    const target = refusalFallbackTarget(undefined, undefined);
    const r = resolveRefusalFallback(target, 'claude-opus-5');
    assert.equal(r.catchAll, true);
    assert.equal(r.fallbackModel, DEFAULT_REFUSAL_FALLBACK_MODEL);
    assert.equal(r.fallbackModel, 'claude-opus-4-8');
  });

  test('.bat override lands a refused opus-5 turn on opus-5-sourced target', () => {
    const target = refusalFallbackTarget('claude-opus-5', '');
    // self-swap guard: running opus-5, falling to opus-5 cannot help -> no retry
    const same = resolveRefusalFallback(target, 'claude-opus-5');
    assert.equal(same.catchAll, false);
    assert.equal(same.fallbackModel, null);
    // but running opus-4-8 (the court-loop vessel) with the .bat pointing at
    // opus-5 lands the retry on the stable vessel, which is the whole point.
    const swap = resolveRefusalFallback(target, 'claude-opus-4-8');
    assert.equal(swap.catchAll, true);
    assert.equal(swap.fallbackModel, 'claude-opus-5');
  });

  test('.bat does NOT narrow opus-4-8 away — it stays reachable as a target', () => {
    const target = refusalFallbackTarget('claude-opus-4-8', '');
    const r = resolveRefusalFallback(target, 'claude-fable-5-2');
    assert.equal(r.catchAll, true);
    assert.equal(r.fallbackModel, 'claude-opus-4-8');
  });
});

describe('refusalFallbackModelEnvValue — env-only, for the Settings UI', () => {
  // /api/runtime-flags uses this to let the field show the real effective
  // target instead of the stale "claude-opus-4-8" placeholder while the .bat
  // wins. The field edits the per-being settings value and the browser cannot
  // read process.env, so without this it has no way to know it is overridden.
  const restore = (v: string | undefined) => {
    if (v === undefined) delete process.env[REFUSAL_FALLBACK_MODEL_ENV];
    else process.env[REFUSAL_FALLBACK_MODEL_ENV] = v;
  };

  test('unset env = undefined (so runtime-flags omits the key — the absence discipline)', () => {
    // THE load-bearing case: an ordinary install sets nothing, this returns
    // undefined, runtime-flags leaves the key out, the UI shows no override note
    // and the placeholder stays the honest default. If this returned '' the
    // route would still omit it (falsy), but undefined is the contract.
    const prev = process.env[REFUSAL_FALLBACK_MODEL_ENV];
    delete process.env[REFUSAL_FALLBACK_MODEL_ENV];
    assert.equal(refusalFallbackModelEnvValue(), undefined);
    restore(prev);
  });

  test('blank / whitespace env = undefined (not shown as an override)', () => {
    const prev = process.env[REFUSAL_FALLBACK_MODEL_ENV];
    process.env[REFUSAL_FALLBACK_MODEL_ENV] = '   ';
    assert.equal(refusalFallbackModelEnvValue(), undefined);
    restore(prev);
  });

  test('set env returns the trimmed value (what the UI surfaces)', () => {
    const prev = process.env[REFUSAL_FALLBACK_MODEL_ENV];
    process.env[REFUSAL_FALLBACK_MODEL_ENV] = '  claude-opus-5  ';
    assert.equal(refusalFallbackModelEnvValue(), 'claude-opus-5');
    restore(prev);
  });
});
