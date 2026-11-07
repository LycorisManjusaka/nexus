/**
 * Does Gemini EXPLICIT context caching ("soul rental") save money on a real
 * NEXUS install? Measures one house and prints the answer per month.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────
 * From the web-app DIRECTORY of the install you want to measure (both the
 * --import path and the script path resolve against the cwd):
 *
 *   cd <install>\web-app
 *   node --experimental-transform-types --import ./tests/_loader.mjs <path-to>\probe_cache.mjs
 *
 * Optional first argument: the beings directory. Defaults to
 * ../local_data/beings relative to the cwd, which is where a NEXUS install
 * keeps it. Pass it explicitly if local_data lives elsewhere:
 *
 *   node ... probe_cache.mjs "C:\Users\pilot\nexus\local_data\beings"
 *
 * Needs no dev dependencies — tests/_loader.mjs ships in the repo and Node 24
 * strips types itself. `npm install` does not have to have been run.
 * MEASURED: without `--import ./tests/_loader.mjs` it dies with
 * ERR_MODULE_NOT_FOUND on '@/lib', which names a missing package rather than a
 * missing loader. (That trap cost Навигатор a run on 2026-11-07.)
 *
 * Reads only conversation logs. Writes nothing. Prints no message text —
 * token counts, model ids, timestamps and dollars only.
 *
 * ── WHAT IS REAL AND WHAT IS MODELLED ─────────────────────────────────────
 *  REAL: every token count and every price. Counts come from each assistant
 *  message's provider-reported `cacheUsage`; prices come from the product's own
 *  modelPricing.json through messageCost/effectivePrice, so there is no second
 *  derivation of the price table.
 *
 *  MODELLED: systemPromptTokens, estimated from the stored `systemPrompt`
 *  string with the product's own estimator. For the Gemini family that
 *  estimator reads ~67% HIGH in this house, which OVERSTATES both the saving
 *  and the storage cost of shape A. The sweep prints a sensitivity band so the
 *  sign is visible rather than assumed.
 *
 * ── THE PRICE FACTS, quoted from primary sources on 2026-11-07 ────────────
 *  aistudio.google.com/docs/pricing, Gemini 3.8 Flash:
 *    cached read  "$0.075 through December 31, 2026. $0.15 starting January 1, 2027."
 *    storage      "$0.50 / 1,000,000 tokens per hour ... $1.00 ... starting January 1, 2027."
 *  Same page, Gemini 4 Argon:
 *    "Implicit caching only (explicit caching is not supported)."
 *  docs.cloud.google.com, context caching overview:
 *    "For both implicit and explicit caching, you're billed for the input
 *     tokens used to create the cache at the standard input token price."
 *    minimum cache size: 4,096 tokens for Gemini 3/4; TTL minimum 1 minute;
 *    implicit cached prefixes live "up to 24 hours".
 *
 *  The creation line is the one that decides this. A cache is NOT free to
 *  build: building it costs exactly what sending those tokens uncached costs.
 *  So an explicit cache can only ever win on tokens it is READ with, and it
 *  competes against implicit caching, which already reads at the same
 *  discounted rate and costs nothing to hold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokensForModel } from '@/lib/tokenEstimate';
import { resolvePrice, effectivePrice, messageCost } from '@/lib/modelPricing';

const BEINGS = process.argv[2] || path.resolve(process.cwd(), '..', 'local_data', 'beings');
const M = 1_000_000;

// storage = USD per 1M cached tokens per hour held. ok:false = provider
// refuses explicit caching on that model at all.
const EXPLICIT = {
  'gemini-3.8-flash':       { ok: true,  storage: 0.50 },
  'gemini-3.7-flash':       { ok: true,  storage: 0.50 },
  'gemini-3.6-flash':       { ok: true,  storage: 0.50 },
  'gemini-3.5-flash':       { ok: true,  storage: 0.50 },
  'gemini-3.5-flash-lite':  { ok: true,  storage: 1.00 },
  'gemini-3.1-flash-lite':  { ok: true,  storage: 1.00 },
  'gemini-3.1-pro-preview': { ok: true,  storage: 4.50 },
  'gemini-4-argon':         { ok: false, storage: null },
};
const MIN_CACHE_TOKENS = 4096;   // Gemini 3/4 minimum; below this no cache exists

if (!fs.existsSync(BEINGS)) {
  console.error(`beings directory not found: ${BEINGS}`);
  console.error('Pass it as the first argument.');
  process.exit(1);
}

// ── Load every Gemini turn, grouped by conversation ───────────────────────
const convos = [];
let files = 0, geminiTurns = 0;
for (const being of fs.readdirSync(BEINGS)) {
  const logDir = path.join(BEINGS, being, 'logs');
  if (!fs.existsSync(logDir)) continue;
  for (const f of fs.readdirSync(logDir)) {
    if (!f.endsWith('.json')) continue;
    files++;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf-8')); } catch { continue; }
    const defModel = d?.modelParams?.model || '';
    const sysText = typeof d.systemPrompt === 'string' ? d.systemPrompt : '';
    const turns = [];
    for (const m of d.messages || []) {
      if (m.role !== 'assistant' || !m.cacheUsage) continue;
      const model = String(m.modelSpecific || defModel || '').toLowerCase();
      if (!model.includes('gemini')) continue;
      if (typeof m.timestamp !== 'number' || !m.timestamp) continue;
      turns.push({
        ts: m.timestamp,
        cached: Number(m.cacheUsage.cachedInputTokens || 0),
        uncached: Number(m.cacheUsage.uncachedInputTokens || 0),
        out: Number(m.cacheUsage.outputTokens || 0),
        cu: m.cacheUsage, model,
      });
    }
    if (!turns.length) continue;
    geminiTurns += turns.length;
    turns.sort((a, b) => a.ts - b.ts);
    convos.push({ sysTok: sysText ? estimateTokensForModel(sysText, turns[0].model) : 0, turns });
  }
}

/**
 * Simulate one operating shape.
 *   shape 'A' — cache the system prompt (constant until the being sleeps)
 *   shape 'B' — cache system prompt + all prior history (grows every turn)
 * ttlHours — how long a cache is held after the turn that created it.
 * creationBilled — if true (the measured truth), building a cache costs the
 *   standard input price for its tokens, so a rebuild is NOT free.
 */
function sim(ttlHours, shape, { sysScale = 1, creationBilled = true } = {}) {
  let save = 0, store = 0, create = 0, hits = 0, misses = 0, tooSmall = 0, unsup = 0;
  for (const c of convos) {
    const sys = c.sysTok * sysScale;
    let cacheLiveUntil = -Infinity;   // ts (ms) the current cache expires
    let cacheTokens = 0;

    for (let i = 0; i < c.turns.length; i++) {
      const t = c.turns[i];
      const ex = EXPLICIT[t.model];
      if (!ex || !ex.ok) { unsup++; continue; }
      const price = resolvePrice(t.model);
      if (!price) continue;
      const eff = effectivePrice(price, t.ts, t.cached + t.uncached);
      const discount = (eff.input - eff.cachedInput) / M;
      if (discount <= 0) continue;

      const want = shape === 'A'
        ? sys
        : (i > 0 ? c.turns[i - 1].cached + c.turns[i - 1].uncached : sys);
      if (want < MIN_CACHE_TOKENS) { tooSmall++; continue; }

      const live = t.ts <= cacheLiveUntil && cacheTokens >= want;
      if (live) {
        // Certain hit — but only tokens that were REALLY billed uncached are
        // a saving; an implicit hit may already have covered part of the prefix.
        save += Math.min(want, t.uncached) * discount;
        hits++;
      } else {
        misses++;
        // Build (or rebuild). Creation is billed at the standard input price.
        // We only count the part that was NOT already an implicit hit, because
        // that part is what the house already pays today either way.
        if (creationBilled) create += Math.min(want, t.uncached) * (eff.input / M);
        // ...and the same tokens still have to be sent/charged this turn, which
        // is exactly what the house pays today, so no saving and no extra: the
        // delta of a miss is just the creation charge above.
      }
      // Hold the cache from this turn for min(gap to next turn, TTL).
      const gapOut = i + 1 < c.turns.length ? (c.turns[i + 1].ts - t.ts) / 3_600_000 : 0;
      const held = Math.min(gapOut, ttlHours);
      if (held > 0) store += (want / M) * ex.storage * held;
      cacheLiveUntil = t.ts + ttlHours * 3_600_000;
      cacheTokens = want;
    }
  }
  return { save, store, create, net: save - store - create, hits, misses, tooSmall, unsup };
}

let NOW = 0;
for (const c of convos) for (const t of c.turns) {
  const r = messageCost(t.cu, t.model, t.out, t.ts);
  if (r) NOW += r.usd;
}

const usd = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
console.log(`beings dir: ${BEINGS}`);
console.log(`conversation files scanned: ${files}   Gemini turns with real usage: ${geminiTurns}`);
console.log(`REAL Gemini bill over all of them: ${usd(NOW)}`);
if (!geminiTurns) { console.log('\nNo Gemini traffic — nothing to simulate here.'); process.exit(0); }
console.log('');
console.log('A = cache the system prompt.   B = cache system prompt + all prior history.');
console.log('net = saving - storage - cache-creation charges.  Positive net = worth doing.');
console.log('');
console.log('   TTL         A:save  A:store A:create    A:net  hit%  |    B:net  hit%');
for (const [label, h] of [['1 min', 1 / 60], ['5 min', 5 / 60], ['15 min', 0.25], ['30 min', 0.5],
                          ['1 h', 1], ['2 h', 2], ['6 h', 6], ['24 h', 24], ['7 d', 168]]) {
  const a = sim(h, 'A'), b = sim(h, 'B');
  const hp = (r) => (r.hits + r.misses) ? (100 * r.hits / (r.hits + r.misses)).toFixed(0) + '%' : '  -';
  console.log(`${label.padEnd(8)} ${usd(a.save).padStart(10)} ${usd(a.store).padStart(8)} ${usd(a.create).padStart(8)} ${usd(a.net).padStart(8)} ${hp(a).padStart(5)}  | ${usd(b.net).padStart(8)} ${hp(b).padStart(5)}`);
}

let bestA = null, bestB = null;
for (let mins = 1; mins <= 600; mins++) {
  const a = sim(mins / 60, 'A'); if (!bestA || a.net > bestA.net) bestA = { mins, ...a };
  const b = sim(mins / 60, 'B'); if (!bestB || b.net > bestB.net) bestB = { mins, ...b };
}
console.log('');
console.log(`BEST A: TTL=${bestA.mins} min  net=${usd(bestA.net)}  = ${(100 * bestA.net / NOW).toFixed(2)}% of the Gemini bill  (hits ${bestA.hits}, misses ${bestA.misses}, below-4096 skips ${bestA.tooSmall}, explicit-unsupported turns ${bestA.unsup})`);
console.log(`BEST B: TTL=${bestB.mins} min  net=${usd(bestB.net)}  = ${(100 * bestB.net / NOW).toFixed(2)}% of the Gemini bill`);
console.log('');
console.log('CONTROL — if cache creation were free (it is not; measured otherwise):');
const freeA = sim(bestA.mins / 60, 'A', { creationBilled: false });
console.log(`   A net would be ${usd(freeA.net)} (${(100 * freeA.net / NOW).toFixed(2)}%) instead of ${usd(bestA.net)}`);
console.log('');
console.log('SENSITIVITY on the one modelled number (systemPrompt token estimate):');
for (const s of [0.6, 1.0, 1.4]) {
  const a = sim(bestA.mins / 60, 'A', { sysScale: s });
  console.log(`   sysTok x${s.toFixed(1)}  net=${usd(a.net).padStart(9)}  (${(100 * a.net / NOW).toFixed(2)}% of bill)`);
}

// Per-month, at the best A TTL.
console.log('');
console.log(`PER MONTH, shape A at TTL=${bestA.mins} min:`);
console.log('month    turns      now     save    store   create      net    %bill');
const per = new Map();
for (const c of convos) {
  let liveUntil = -Infinity, cacheTok = 0;
  for (let i = 0; i < c.turns.length; i++) {
    const t = c.turns[i];
    const d0 = new Date(t.ts);
    const k = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}`;
    if (!per.has(k)) per.set(k, { turns: 0, now: 0, save: 0, store: 0, create: 0 });
    const p = per.get(k);
    p.turns++;
    const r = messageCost(t.cu, t.model, t.out, t.ts);
    if (r) p.now += r.usd;
    const ex = EXPLICIT[t.model];
    if (!ex || !ex.ok) continue;
    const price = resolvePrice(t.model);
    if (!price) continue;
    const eff = effectivePrice(price, t.ts, t.cached + t.uncached);
    const disc = (eff.input - eff.cachedInput) / M;
    const want = c.sysTok;
    if (want < MIN_CACHE_TOKENS) continue;
    const ttlH = bestA.mins / 60;
    if (t.ts <= liveUntil && cacheTok >= want) p.save += Math.min(want, t.uncached) * disc;
    else p.create += Math.min(want, t.uncached) * (eff.input / M);
    const gapOut = i + 1 < c.turns.length ? (c.turns[i + 1].ts - t.ts) / 3_600_000 : 0;
    p.store += (want / M) * ex.storage * Math.min(gapOut, ttlH);
    liveUntil = t.ts + ttlH * 3_600_000;
    cacheTok = want;
  }
}
for (const k of [...per.keys()].sort()) {
  const p = per.get(k);
  const net = p.save - p.store - p.create;
  console.log(`${k}  ${String(p.turns).padStart(5)} ${usd(p.now).padStart(8)} ${usd(p.save).padStart(8)} ${usd(p.store).padStart(8)} ${usd(p.create).padStart(8)} ${usd(net).padStart(8)}  ${p.now ? (100 * net / p.now).toFixed(1) + '%' : '-'}`);
}

// The break-even that decides everything, in the house's own numbers.
console.log('');
const sysToks = convos.map((c) => c.sysTok).filter((n) => n > 0).sort((a, b) => a - b);
const medSys = sysToks.length ? sysToks[Math.floor(sysToks.length / 2)] : 0;
const gaps = [];
for (const c of convos) for (let i = 1; i < c.turns.length; i++) gaps.push((c.turns[i].ts - c.turns[i - 1].ts) / 60000);
gaps.sort((a, b) => a - b);
const gp = (p) => gaps.length ? gaps[Math.floor(gaps.length * p)].toFixed(1) : 'n/a';
console.log(`median systemPrompt estimate: ${medSys} tokens`);
console.log(`same-conversation gaps (min): n=${gaps.length} p10=${gp(0.1)} median=${gp(0.5)} p90=${gp(0.9)}`);
if (medSys) {
  const saveOne = medSys * (0.75 - 0.075) / M;
  const storeHour = medSys * 0.50 / M;
  console.log(`BREAK-EVEN at that size on a $0.50/h model: one read saves ${usd(saveOne)}, one idle hour costs ${usd(storeHour)}`);
  console.log(`  -> the cache pays only if a turn arrives at least every ${(60 * storeHour / saveOne).toFixed(0)} minutes.`);
  console.log(`  -> this house's median gap is ${gp(0.5)} min.`);
}
