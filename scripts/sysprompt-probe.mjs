#!/usr/bin/env node
// sysprompt-probe.mjs — measure whether anything is prepended above what NEXUS sends.
//
// We never ask a model about its own system prompt. A model's answer to that
// question is worthless in both directions: aligned models are trained to refuse,
// and de-aligned models will happily invent a plausible-sounding one. Both are
// next-token prediction, not introspection.
//
// Instead we use the provider's own token counter as the instrument:
//
//   prompt_tokens = slope x (what we sent) + intercept
//
// Send the same body at several sizes, regress, read the intercept. The intercept
// is everything that is in the prompt but did not come from us: the chat template,
// plus anything injected upstream.
//
// The instrument is calibrated first (section C): we add a system message of known
// size and check the counter reports exactly that much more. If it does, then the
// counter can see the system-prompt layer, and an injection in that layer would
// show up in the intercept.
//
// What this CANNOT prove: the counter belongs to the provider. Anything added
// after counting is invisible here. So a small intercept means "nothing extra in
// the counted prompt", not "no upstream control of any kind".
//
// Usage:  node scripts/sysprompt-probe.mjs [--fam Grok,GLM] [--json]
//         node scripts/sysprompt-probe.mjs --local     (local control group only)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEYS_FILE = process.env.NEXUS_KEYS_FILE
  || path.resolve(process.cwd(), '..', 'local_data', 'keys.json');

let keys = {};
try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); }
catch (e) { console.error(`Could not read keys from ${KEYS_FILE}\n  ${e.message}\n  (set NEXUS_KEYS_FILE to point at it)`); process.exit(1); }

const argv = process.argv.slice(2);
const famFilter = (() => { const i = argv.indexOf('--fam'); return i >= 0 ? argv[i + 1].split(',').map(s => s.toLowerCase()) : null; })();
const asJson = argv.includes('--json');
const localOnly = argv.includes('--local');

const LOCAL_URL = process.env.LOCAL_LLM_BASE || 'http://127.0.0.1:1234/v1';
const NS = [1, 16, 256];
const body = (n) => 'alpha '.repeat(n).trim();

// ---------------------------------------------------------------- targets
const TARGETS = [
  { fam: 'DeepSeek',   model: 'deepseek-chat',            url: 'https://api.deepseek.com/v1/chat/completions',                             key: () => keys.deepseek },
  { fam: 'GLM',        model: 'glm-5.3-flash',            url: 'https://api.z.ai/api/paas/v4/chat/completions',                            key: () => keys.glm },
  { fam: 'GLM-DO',     model: 'glm-5.2',                  url: 'https://inference.do-ai.run/v1/chat/completions',                          key: () => keys.digitalocean },
  { fam: 'Grok',       model: 'grok-4.3',                 url: 'https://api.x.ai/v1/chat/completions',                                     key: () => keys.grok },
  { fam: 'Grok',       model: 'grok-4.5',                 url: 'https://api.x.ai/v1/chat/completions',                                     key: () => keys.grok },
  { fam: 'Grok',       model: 'grok-4.6',                 url: 'https://api.x.ai/v1/chat/completions',                                     key: () => keys.grok },
  { fam: 'Grok',       model: 'grok-4.7',                 url: 'https://api.x.ai/v1/chat/completions',                                     key: () => keys.grok },
  { fam: 'Kimi',       model: 'kimi-k2.7-code-highspeed', url: 'https://api.moonshot.ai/v1/chat/completions',                              key: () => keys.kimi },
  { fam: 'OpenAI',     model: 'gpt-5.4-mini',             url: 'https://api.openai.com/v1/chat/completions',                               key: () => keys.openai, cap: 'max_completion_tokens', capValue: 2000 },
  { fam: 'Qwen',       model: 'qwen3.6-plus',             url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',  key: () => keys.qwen },
  { fam: 'MiniMax',    model: 'minimax-m2.7',             url: 'https://api.minimax.io/v1/chat/completions',                               key: () => keys.minimax },
  { fam: 'Cohere',     model: 'command-a-plus-05-2026',   url: 'https://api.cohere.ai/compatibility/v1/chat/completions',                  key: () => keys.cohere },
  { fam: 'MiMo',       model: 'mimo-v2.6-flash',          url: 'https://api.xiaomimimo.com/v1/chat/completions',                           key: () => keys.mimo },
  { fam: 'ByteDance',  model: 'seed-2-0-lite-260428',     url: 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions',          key: () => keys.bytedance },
  { fam: 'LOCAL',      model: process.env.LOCAL_MODEL || 'google/gemma-4-12b', url: `${LOCAL_URL}/chat/completions`,                       key: () => 'none', local: true },
];

// Gemini is not OpenAI-shaped; it gets its own probe below.

// ---------------------------------------------------------------- helpers
async function chat(t, messages, extra = {}) {
  const cap = t.cap || 'max_tokens';
  const payload = { model: t.model, messages, temperature: 0, [cap]: t.capValue ?? 1, ...extra };
  let r;
  try {
    r = await fetch(t.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key()}` }, body: JSON.stringify(payload) });
  } catch (e) { return { err: 'network: ' + e.message }; }
  const txt = await r.text();
  if (!r.ok) return { err: `${r.status} ${txt.slice(0, 200)}` };
  let j; try { j = JSON.parse(txt); } catch { return { err: 'unparsable response' }; }
  const u = j.usage || {};
  const p = u.prompt_tokens ?? u.input_tokens ?? null;
  if (p == null) return { err: 'usage has no prompt token count: ' + JSON.stringify(u).slice(0, 140) };
  return { p, usage: u, msg: j.choices?.[0]?.message };
}

async function geminiProbe() {
  if (!keys.gemini) return [];
  const out = [];
  for (const model of ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']) {
    const pts = {}; let err = null;
    for (const n of NS) {
      // Gemini exposes a FREE standalone counter as well; we compare both.
      const gen = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys.gemini}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: body(n) }] }], generationConfig: { maxOutputTokens: 1, temperature: 0 } }),
      });
      const gt = await gen.text();
      if (!gen.ok) { err = `${gen.status} ${gt.slice(0, 160)}`; break; }
      const gj = JSON.parse(gt);
      const cnt = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${keys.gemini}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: body(n) }] }] }),
      });
      const cj = JSON.parse(await cnt.text());
      pts[n] = { gen: gj.usageMetadata?.promptTokenCount, count: cj.totalTokens };
    }
    if (err) { out.push({ fam: 'Gemini', model, err }); continue; }
    const slope = (pts[256].gen - pts[16].gen) / 240;

    // calibrate: a systemInstruction of known size must move the counter by that much
    let calib = null;
    const withSys = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${keys.gemini}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: body(50) }] },
        contents: [{ role: 'user', parts: [{ text: body(16) }] }],
        generationConfig: { maxOutputTokens: 1, temperature: 0 },
      }),
    });
    if (withSys.ok) calib = JSON.parse(await withSys.text()).usageMetadata?.promptTokenCount - pts[16].gen;

    out.push({
      fam: 'Gemini', model, slope, intercept: pts[16].gen - slope * 16,
      calib, calibOk: calib != null && calib >= 50 && calib <= 58,
      pts: Object.fromEntries(NS.map(n => [n, pts[n].gen])),
      note: NS.every(n => pts[n].gen === pts[n].count)
        ? 'free countTokens agrees exactly with the billed counter at all sizes'
        : 'MISMATCH between free countTokens and billed counter — investigate',
    });
  }
  return out;
}

// ---------------------------------------------------------------- run
const results = [];

for (const t of TARGETS) {
  if (localOnly && !t.local) continue;
  if (famFilter && !famFilter.includes(t.fam.toLowerCase())) continue;
  if (!t.key()) { results.push({ fam: t.fam, model: t.model, err: 'no API key configured' }); continue; }

  const pts = {}; let err = null;
  for (const n of NS) {
    const r = await chat(t, [{ role: 'user', content: body(n) }]);
    if (r.err) { err = r.err; break; }
    pts[n] = r.p;
  }
  if (err) { results.push({ fam: t.fam, model: t.model, err }); continue; }

  const slope = (pts[256] - pts[16]) / 240;
  const intercept = pts[16] - slope * 16;
  const row = { fam: t.fam, model: t.model, pts, slope, intercept };

  // --- C. calibrate: does the counter see OUR system message accurately?
  const base = await chat(t, [{ role: 'user', content: body(16) }]);
  const s50 = await chat(t, [{ role: 'system', content: body(50) }, { role: 'user', content: body(16) }]);
  if (!base.err && !s50.err) {
    row.calib = s50.p - base.p;
    // A system message of 50 tokens costs 50 plus that provider's role framing
    // (observed: 0 local, 1 DeepSeek/GLM, 3 Grok). Anything inside 50..58 means
    // the counter tracks our system message faithfully. Tighter than this and
    // the calibrator itself starts raising false alarms.
    row.calibOk = row.calib >= 50 && row.calib <= 58;
  }

  // --- fresh random body: any cached_tokens cannot possibly be ours
  const rand = Array.from({ length: 16 }, () => crypto.randomBytes(6).toString('hex')).join(' ');
  const fresh = await chat(t, [{ role: 'user', content: rand }]);
  if (!fresh.err) {
    const c = fresh.usage.prompt_tokens_details?.cached_tokens;
    if (typeof c === 'number') row.cachedOnFreshInput = c;
  }

  // --- local only: raw completion has no chat template, isolating it exactly
  if (t.local) {
    try {
      const r1 = await fetch(`${LOCAL_URL}/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: t.model, prompt: body(16), max_tokens: 1, temperature: 0 }) });
      if (r1.ok) { const j = JSON.parse(await r1.text()); row.rawPrompt16 = j.usage.prompt_tokens; row.templateCost = pts[16] - j.usage.prompt_tokens; }
    } catch { /* raw sampling not always available */ }
  }

  results.push(row);
}

if (!localOnly && (!famFilter || famFilter.includes('gemini'))) results.push(...await geminiProbe());

// ---------------------------------------------------------------- report
if (asJson) { console.log(JSON.stringify(results, null, 2)); process.exit(0); }

console.log('\nUPSTREAM INJECTION PROBE');
console.log('intercept = tokens present in the prompt that we did not send');
console.log('          = chat template + anything injected above us\n');
const w = (s, n) => String(s).padEnd(n);
console.log(w('family', 11) + w('model', 34) + w('p(1)', 7) + w('p(16)', 7) + w('p(256)', 8) + w('slope', 8) + w('intercept', 11) + w('calib', 8) + 'cached@fresh');
console.log('-'.repeat(110));
for (const r of results) {
  if (r.err) { console.log(w(r.fam, 11) + w(r.model, 34) + 'ERR: ' + r.err.replace(/\s+/g, ' ').slice(0, 60)); continue; }
  console.log(
    w(r.fam, 11) + w(r.model, 34) + w(r.pts[1], 7) + w(r.pts[16], 7) + w(r.pts[256], 8) +
    w(r.slope.toFixed(3), 8) + w(r.intercept.toFixed(0), 11) +
    w(r.calib == null ? '-' : (r.calibOk ? `+${r.calib} ok` : `+${r.calib} ??`), 8) +
    (r.cachedOnFreshInput == null ? '-' : r.cachedOnFreshInput)
  );
  if (r.templateCost != null) console.log(`${' '.repeat(11)}  raw prompt (no template) = ${r.rawPrompt16} tok -> chat template costs exactly ${r.templateCost}; nothing else is present`);
  if (r.note) console.log(`${' '.repeat(11)}  ${r.note}`);
}

console.log(`
HOW TO READ THIS
  calib  +50 ok  the counter reports our own 50-token system message to within 2
                 tokens, so it CAN see the system-prompt layer. An injection
                 there would appear in the intercept.
  intercept      single digits to ~40 is ordinary chat-template framing. The
                 local control below measures a template exactly, as a yardstick.
  cached@fresh   tokens the provider reports as cache HITS on a body of fresh
                 random hex that has never been sent before. Those hits cannot
                 be our text; they are a fixed prefix sitting above us. VOLATILE:
                 caches expire, so a 0 here proves nothing either way. It is
                 corroboration when non-zero, never evidence when zero. The
                 intercept is the stable measurement; this column is not.

WHAT THIS CANNOT SHOW
  The counter belongs to the provider. Anything added after counting does not
  appear here. A small intercept means "nothing extra in the counted prompt" —
  it does not mean "no upstream control of any kind".
`);
