/**
 * spuBilling — the soul-updater billing ledger helpers (2026-11-07).
 *
 *   addCacheUsage  — sums one call's usage into the run total; null is identity;
 *                    reportedUsd / serverToolCalls summed then omitted-when-zero.
 *   billableUsage  — distinguishes "spent something" from "spent nothing", so a
 *                    run that died before any call returned writes no entry.
 *   billingToStatRecord — prices through messageCost (one source) and drops a
 *                    Local run, splits Claude by auth, flags unpriced models.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addCacheUsage, billableUsage, billingToStatRecord } from '@/lib/spuBilling';
import type { SpuBillingEntry } from '@/lib/spuBilling';
import type { TurnCacheUsage } from '@/lib/turnEvents';

function usage(over: Partial<TurnCacheUsage> = {}): TurnCacheUsage {
  return {
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    totalInputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    providerHint: 'oai',
    ...over,
  };
}

function entry(over: Partial<SpuBillingEntry> = {}): SpuBillingEntry {
  return {
    runId: 'r1',
    action: 'update',
    label: '2',
    convoId: 'c-1',
    model: 'claude-opus-4-8',
    authMode: 'api-key',
    startedAt: 1_700_000_000_000,
    attempts: 1,
    status: 'done',
    usage: usage({ totalInputTokens: 1000, uncachedInputTokens: 1000, outputTokens: 200 }),
    ...over,
  };
}

// ── addCacheUsage ───────────────────────────────────────────────────────────

test('addCacheUsage: null is the identity on both sides', () => {
  const u = usage({ totalInputTokens: 10 });
  assert.deepEqual(addCacheUsage(null, u), u);
  assert.deepEqual(addCacheUsage(u, null), u);
  assert.equal(addCacheUsage(null, null), null);
});

test('addCacheUsage: buckets sum across rounds', () => {
  const a = usage({ totalInputTokens: 100, cachedInputTokens: 20, outputTokens: 10, cacheCreationTokens: 5 });
  const b = usage({ totalInputTokens: 50, cachedInputTokens: 10, outputTokens: 5, cacheCreationTokens: 1 });
  const sum = addCacheUsage(a, b)!;
  assert.equal(sum.totalInputTokens, 150);
  assert.equal(sum.cachedInputTokens, 30);
  assert.equal(sum.outputTokens, 15);
  assert.equal(sum.cacheCreationTokens, 6);
});

test('addCacheUsage: reportedUsd and serverToolCalls sum, and stay OMITTED when zero', () => {
  const plain = addCacheUsage(usage({ totalInputTokens: 1 }), usage({ totalInputTokens: 1 }))!;
  assert.ok(!('reportedUsd' in plain), 'absent means "provider did not say", not "$0"');
  assert.ok(!('serverToolCalls' in plain));

  const a = usage({ reportedUsd: 0.4, serverToolCalls: 2 });
  const b = usage({ reportedUsd: 0.1, serverToolCalls: 3 });
  const sum = addCacheUsage(a, b)!;
  assert.ok(Math.abs(sum.reportedUsd! - 0.5) < 1e-9);
  assert.equal(sum.serverToolCalls, 5);
});

// ── billableUsage ───────────────────────────────────────────────────────────

test('billableUsage: null and all-zero are not billable', () => {
  assert.equal(billableUsage(null), false);
  assert.equal(billableUsage(usage()), false);
});

test('billableUsage: any token bucket OR a reported cost is billable', () => {
  assert.equal(billableUsage(usage({ outputTokens: 1 })), true);
  assert.equal(billableUsage(usage({ cachedInputTokens: 1 })), true);
  assert.equal(billableUsage(usage({ reportedUsd: 0.01 })), true);
});

// ── billingToStatRecord ─────────────────────────────────────────────────────

test('billingToStatRecord: a Local run is dropped (free, never counted)', () => {
  assert.equal(billingToStatRecord(entry({ model: 'gemma@q4' }), 'Luna'), null);
  assert.equal(billingToStatRecord(entry({ model: 'some-vendor/model' }), 'Luna'), null);
});

test('billingToStatRecord: Claude splits by auth mode, estimated is always false', () => {
  const oauth = billingToStatRecord(entry({ model: 'claude-opus-4-8', authMode: 'oauth' }), 'Cairn')!;
  assert.equal(oauth.family, 'Claude (OAuth)');
  assert.equal(oauth.estimated, false, 'real usage is never a notional estimate');

  const api = billingToStatRecord(entry({ model: 'claude-opus-4-8', authMode: 'api-key' }), 'Cairn')!;
  assert.equal(api.family, 'Claude (API)');
});

test('billingToStatRecord: a priced model yields a real cost at the run timestamp', () => {
  const rec = billingToStatRecord(entry(), 'Cairn')!;
  assert.ok(rec.usd > 0, 'claude-opus-4-8 has a price row');
  assert.equal(rec.unpriced, false);
  assert.equal(rec.ts, 1_700_000_000_000, 'the billing timestamp is the run start');
  assert.equal(rec.convoTitle, 'Soul update');
  assert.equal(rec.convoId, 'soul-update:Cairn', 'entity-scoped bucket');
});

test('billingToStatRecord: a model with no price row is flagged unpriced, usd 0', () => {
  const rec = billingToStatRecord(entry({ model: 'nonexistent-cloud-model-xyz' }), 'Cairn')!;
  assert.equal(rec.unpriced, true);
  assert.equal(rec.usd, 0);
  assert.equal(rec.estimated, false);
});

test('billingToStatRecord: a provider-reported cost prices even without a price row', () => {
  const rec = billingToStatRecord(
    entry({ model: 'nonexistent-cloud-model-xyz', usage: usage({ outputTokens: 10, reportedUsd: 0.25 }) }),
    'Cairn',
  )!;
  assert.ok(Math.abs(rec.usd - 0.25) < 1e-9, 'reportedUsd wins when the token table cannot price it');
  assert.equal(rec.unpriced, false);
});
