import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billedTokens,
  unfinishedBillingFrames,
  unfinishedBillingLog,
  type NormalizedUsageFrame,
} from '@/lib/unfinishedBilling';

const frame = (over: Partial<NormalizedUsageFrame> = {}): NormalizedUsageFrame => ({
  type: 'cache_usage',
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  totalInputTokens: 0,
  outputTokens: 0,
  ...over,
});

// ── billedTokens ────────────────────────────────────────────────────────────

test('billedTokens: a stop that reached no model is zero', () => {
  assert.equal(billedTokens(frame()), 0);
});

test('billedTokens: null / undefined are zero, not a crash', () => {
  assert.equal(billedTokens(null), 0);
  assert.equal(billedTokens(undefined), 0);
});

test('billedTokens: does NOT double-count the cache buckets', () => {
  // totalInputTokens already includes cached + cacheCreation. Adding them
  // again is the bug this guards: 1000 input + 200 output must read 1200,
  // not 1200 + 900 (the cached 700 + creation 200 counted twice).
  const f = frame({
    cachedInputTokens: 700,
    cacheCreationTokens: 200,
    uncachedInputTokens: 100,
    totalInputTokens: 1000,
    outputTokens: 200,
  });
  assert.equal(billedTokens(f), 1200);
});

test('billedTokens: output alone counts (model spoke, input was all cache)', () => {
  assert.equal(billedTokens(frame({ outputTokens: 42 })), 42);
});

test('billedTokens: non-numeric fields degrade to zero', () => {
  const f = frame({ totalInputTokens: NaN as unknown as number, outputTokens: 5 });
  assert.equal(billedTokens(f), 5);
});

// ── unfinishedBillingFrames ─────────────────────────────────────────────────

test('frames: billed turn emits the usage record AND the sentence', () => {
  const out = unfinishedBillingFrames(frame({ totalInputTokens: 900, outputTokens: 100 }), false);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'cache_usage');
  assert.equal(out[1].type, 'notice');
  assert.match(String(out[1].content), /^Billed: 1,000 tokens/);
});

test('frames: unbilled turn emits NO usage record — a row of zeros reads like a bill', () => {
  const out = unfinishedBillingFrames(frame(), false);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'notice');
  assert.match(String(out[0].content), /Not billed/);
});

test('frames: the sentence is always present — absence of tokens is not readable as "free"', () => {
  for (const f of [null, frame(), frame({ outputTokens: 1 })]) {
    const out = unfinishedBillingFrames(f, false);
    assert.equal(out.filter(x => x.type === 'notice').length, 1);
  }
});

test('frames: null frame is treated as unbilled, not skipped silently', () => {
  const out = unfinishedBillingFrames(null, false);
  assert.equal(out.length, 1);
  assert.match(String(out[0].content), /Not billed/);
});

test('frames: Japanese says which of the two happened', () => {
  const billed = unfinishedBillingFrames(frame({ totalInputTokens: 10, outputTokens: 5 }), true);
  assert.match(String(billed[1].content), /課金あり/);
  assert.match(String(billed[1].content), /モデルは走りました/);

  const free = unfinishedBillingFrames(frame(), true);
  assert.match(String(free[0].content), /課金なし/);
  assert.match(String(free[0].content), /呼ばれていません/);
});

test('frames: the two sentences are never the same string', () => {
  for (const ja of [true, false]) {
    const a = String(unfinishedBillingFrames(frame({ outputTokens: 1 }), ja).at(-1)!.content);
    const b = String(unfinishedBillingFrames(frame(), ja).at(-1)!.content);
    assert.notEqual(a, b);
  }
});

test('frames: the emitted usage record is the same object the success path sends', () => {
  const f = frame({ totalInputTokens: 5, outputTokens: 5, providerHint: 'gemini' });
  const out = unfinishedBillingFrames(f, false);
  assert.equal(out[0].providerHint, 'gemini');
  assert.equal(out[0].type, 'cache_usage');
});

// ── unfinishedBillingLog ────────────────────────────────────────────────────

test('log: names the provider and distinguishes billed from free', () => {
  assert.match(unfinishedBillingLog('[gemini]', frame()), /\[gemini\].*NOT billed/);
  assert.match(
    unfinishedBillingLog('[claude-oauth]', frame({ totalInputTokens: 300, outputTokens: 7 })),
    /\[claude-oauth\].*billed 307 tokens/,
  );
});

test('log: a billed line carries the breakdown, so a surprise bill is traceable', () => {
  const line = unfinishedBillingLog('[x]', frame({
    totalInputTokens: 1000, outputTokens: 20, cachedInputTokens: 900,
  }));
  assert.match(line, /in=1000/);
  assert.match(line, /out=20/);
  assert.match(line, /cacheRead=900/);
});
