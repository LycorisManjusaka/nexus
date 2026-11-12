/**
 * auxBilling — the auxiliary-call ledger (2026-11-12, Tsuyo's request).
 *
 * What was measured before this existed:
 *   • the eyes / ears / video-watcher bridges discarded the provider's usage,
 *     so their spend appeared nowhere;
 *   • a subagent's tokens were added into the PARENT's accumulators and so
 *     were priced at the parent's rate.
 *
 * The load-bearing rules here:
 *   - a call with no usage, zero usage, or a local model writes NO entry;
 *   - Gemini thinking tokens are billed as output;
 *   - the subagent accumulator's `input` is read per runner (Anthropic keeps
 *     the cache buckets separate, the others fold cache-read into the prompt);
 *   - a stated family beats the id-derived one (`digitalocean/…` has a slash);
 *   - every billing call site actually goes through the ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  usageFromOpenAi, usageFromGemini, usageFromAnthropic, usageFromSubagent,
  isLocalAuxModel, makeAuxEntry, auxBillingToStatRecord,
} from '@/lib/auxBilling';
import { messageCost } from '@/lib/modelPricing';

const AT = 1_700_000_000_000;

test('OpenAI-shaped usage: cached split out of prompt_tokens', () => {
  const u = usageFromOpenAi({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } })!;
  assert.equal(u.totalInputTokens, 1000);
  assert.equal(u.cachedInputTokens, 400);
  assert.equal(u.uncachedInputTokens, 600);
  assert.equal(u.outputTokens, 50);
  assert.equal(usageFromOpenAi(undefined), null);
  assert.equal(usageFromOpenAi('nope'), null);
});

test('Gemini usage: thinking tokens are billed as output', () => {
  const u = usageFromGemini({ promptTokenCount: 300, candidatesTokenCount: 40, thoughtsTokenCount: 160 })!;
  assert.equal(u.outputTokens, 200);
  assert.equal(u.uncachedInputTokens, 300);
  assert.equal(usageFromGemini(null), null);
});

test('Anthropic usage: input_tokens excludes the cache buckets', () => {
  const u = usageFromAnthropic({ input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 70, output_tokens: 9 })!;
  assert.equal(u.uncachedInputTokens, 10);
  assert.equal(u.cachedInputTokens, 500);
  assert.equal(u.cacheCreationTokens, 70);
  assert.equal(u.totalInputTokens, 580);
});

test('subagent accumulator: input means different things per runner', () => {
  const su = { input: 1000, output: 20, cacheRead: 300, cacheCreate: 0 };
  // Anthropic runner — cache separate, so 1000 uncached + 300 cached.
  const a = usageFromSubagent(su, false)!;
  assert.equal(a.uncachedInputTokens, 1000);
  assert.equal(a.totalInputTokens, 1300);
  // OpenAI / Gemini runner — the 300 is INSIDE the 1000.
  const o = usageFromSubagent(su, true)!;
  assert.equal(o.uncachedInputTokens, 700);
  assert.equal(o.totalInputTokens, 1000);
});

test('local models are never billed; a stated family is authoritative', () => {
  assert.equal(isLocalAuxModel('local:qwen2-vl-7b'), true);
  assert.equal(isLocalAuxModel('google/gemma-4-12b'), true);
  assert.equal(isLocalAuxModel('some-gguf', 'Local'), true);
  assert.equal(isLocalAuxModel('glm-5.3-flash'), false);
  // The slash would read as a local GGUF; the stated family says otherwise.
  assert.equal(isLocalAuxModel('digitalocean/glm-5.2', 'GLM'), false);
});

test('makeAuxEntry: nothing to bill → null, not a zero entry', () => {
  const u = usageFromOpenAi({ prompt_tokens: 10, completion_tokens: 5 });
  const base = { id: 'x', kind: 'eyes' as const, at: AT };
  assert.equal(makeAuxEntry({ ...base, model: 'glm-5v-turbo', usage: null }), null);
  assert.equal(makeAuxEntry({ ...base, model: 'glm-5v-turbo', usage: usageFromOpenAi({}) }), null);
  assert.equal(makeAuxEntry({ ...base, model: 'local:x', usage: u }), null);
  assert.equal(makeAuxEntry({ ...base, model: '', usage: u }), null);
  const e = makeAuxEntry({ ...base, model: 'glm-5v-turbo', convoId: 'c1', usage: u })!;
  assert.equal(e.kind, 'eyes');
  assert.equal(e.convoId, 'c1');
  assert.equal(e.authMode, 'api-key');
  assert.equal('family' in e, false);
});

test('stat record: priced through messageCost at the CHILD model, one line per kind', () => {
  const usage = usageFromOpenAi({ prompt_tokens: 100_000, completion_tokens: 2_000 })!;
  const e = makeAuxEntry({ id: 'a', kind: 'subagent', model: 'deepseek-v4-pro', family: 'DeepSeek', at: AT, usage })!;
  const rec = auxBillingToStatRecord(e, 'Senpai')!;
  const expected = messageCost(usage, 'deepseek-v4-pro', usage.outputTokens, AT);
  assert.ok(expected, 'the test model must have a price row');
  assert.equal(rec.usd, expected!.usd);
  assert.equal(rec.family, 'DeepSeek');
  assert.equal(rec.convoId, 'aux:subagent:Senpai');
  assert.equal(rec.convoTitle, 'Subagent');
  assert.equal(rec.estimated, false);
  assert.equal(rec.unpriced, false);
});

test('stat record: OAuth eyes land under Claude (OAuth); unknown models are flagged unpriced', () => {
  const usage = usageFromAnthropic({ input_tokens: 900, output_tokens: 80 })!;
  const oauth = makeAuxEntry({ id: 'b', kind: 'eyes', model: 'claude-haiku-4-5', authMode: 'oauth', at: AT, usage })!;
  assert.equal(auxBillingToStatRecord(oauth, 'X')!.family, 'Claude (OAuth)');
  const odd = makeAuxEntry({ id: 'c', kind: 'ears', model: 'qwen-not-a-real-row-9', at: AT, usage })!;
  const rec = auxBillingToStatRecord(odd, 'X')!;
  assert.equal(rec.unpriced, true);
  assert.equal(rec.usd, 0);
});

test('stat record: a stated family rescues a slash-carrying cloud id from "Local"', () => {
  const usage = usageFromOpenAi({ prompt_tokens: 10, completion_tokens: 5 })!;
  const e = makeAuxEntry({ id: 'd', kind: 'subagent', model: 'digitalocean/glm-5.2', family: 'GLM', at: AT, usage })!;
  const rec = auxBillingToStatRecord(e, 'X');
  assert.ok(rec, 'must not be dropped as a local model');
  assert.equal(rec!.family, 'GLM');
});

// ── Wiring: the rules above are only true if the call sites use them ────────
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('wiring: every bridge call keeps the usage and every describe*() bills it', () => {
  for (const [file, kind] of [
    ['src/lib/eyesVision.ts', 'eyes'], ['src/lib/earsBridge.ts', 'ears'], ['src/lib/videoBridge.ts', 'watcher'],
  ] as const) {
    const src = read(file);
    const calls = (src.match(/const data = await res\.json\(\);/g) || []).length;
    const kept = (src.match(/const usage = usageFrom(OpenAi|Gemini)\(/g) || []).length;
    assert.ok(calls >= 4, `${file}: expected the provider call functions`);
    assert.equal(kept, calls, `${file}: a call function reads the body but drops its usage`);
    assert.equal(/return \{ description, fromCache: false \};/.test(src), false,
      `${file}: a successful description is returned without its usage`);
    assert.ok(src.includes(`recordAuxBilling(params.bill, { kind: '${kind}'`), `${file}: describe*() does not bill`);
  }
});

test('wiring: the chat route names the being on every bridge call, and no longer folds a subagent into the parent', () => {
  const src = read('src/app/api/chat/route.ts');
  const describes = (src.match(/await describe(Image|Audio|Video)\(\{/g) || []).length;
  const billed = (src.match(/bill: \{ being: folderName, convoId \},/g) || []).length;
  assert.ok(describes >= 6);
  assert.equal(billed, describes, 'a bridge call site does not say who it is for — it would be free again');
  assert.equal(/\+= sub\.usage\./.test(src), false,
    'a subagent is being added into the parent accumulators again (billed twice, and at the parent rate)');
  const sub = read('src/lib/subagent.ts');
  assert.ok(/kind: 'subagent'/.test(sub) && sub.includes('recordAuxBilling('), 'runSubagent does not bill');
});

test('wiring: the stats route reads the auxiliary ledger', () => {
  const src = read('src/app/api/stats/route.ts');
  assert.ok(src.includes('beingAuxBillingDir(d.name)'));
  assert.ok(src.includes('auxBillingToStatRecord(entry, entity)'));
});

test('wiring: each provider body is read with ITS OWN usage parser', () => {
  // Found by mutation 2026-11-12: a Gemini call parsed with the OpenAI reader
  // yields null (no prompt_tokens in usageMetadata) — the call becomes free
  // again, silently, and the count-only check above still passes.
  for (const file of ['src/lib/eyesVision.ts', 'src/lib/earsBridge.ts', 'src/lib/videoBridge.ts']) {
    const src = read(file);
    assert.equal(/usageFromOpenAi\(data\?\.usageMetadata\)/.test(src), false, `${file}: Gemini body, OpenAI parser`);
    assert.equal(/usageFromGemini\(data\?\.usage\)/.test(src), false, `${file}: OpenAI body, Gemini parser`);
    const fns = src.split(/\nasync function /).slice(1);
    for (const body of fns) {
      const name = body.slice(0, body.indexOf('('));
      if (!/const usage = usageFrom/.test(body)) continue;
      const wantsGemini = /Gemini/.test(name);
      assert.equal(/const usage = usageFromGemini\(/.test(body), wantsGemini, `${file}: ${name} uses the wrong parser`);
    }
  }
});
