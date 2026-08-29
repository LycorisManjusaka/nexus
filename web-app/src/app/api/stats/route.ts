import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePrice, messageCost, effectivePrice } from '@/lib/modelPricing';

// Full-scan billing statistics. Unlike the header-only listLogs() path, this
// reads every active conversation in full, walks its messages in order, and
// emits one cost record per ORIGINAL (non-copied) assistant message. The client
// (StatsModal) does all the grouping/aggregation for the six report layouts —
// this route just produces the priced, family-tagged flat dataset once.
//
// Pricing follows the "best-estimate hybrid" the user chose:
//   - message carries real usage (cacheUsage) → priced exactly (measured).
//   - otherwise → estimate: input tokens ≈ system prompt + all preceding
//     messages in that conversation, output ≈ the message's own token count,
//     priced at the resolved model's rate. Flagged estimated=true. This ignores
//     historical prompt-cache discounts and context-trimming, so estimates lean
//     high — an intentional, documented "notional list price".
//
// Model resolution for messages that predate model-tagging: fall back to the
// entity's current default model (folders/<name>.json settings.specificModel,
// or claude-opus-4-8 when unset). Claude is split into OAuth vs API families
// via each conversation's stored claudeAuthMode.

export const dynamic = 'force-dynamic';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const FOLDERS_DIR = path.join(DATA_DIR, 'folders');

const GLOBAL_DEFAULT_MODEL = 'claude-opus-4-8';

interface StatRecord {
  entity: string;
  convoId: string;
  convoTitle: string;
  ts: number | null;   // message timestamp (ms), null when the log lacks one
  family: string;      // canonical family; Claude split into OAuth/API
  model: string;       // resolved model id used for pricing (display form)
  usd: number;
  estimated: boolean;  // true = derived, false = from real cacheUsage
  unpriced: boolean;   // model has no price row (usd forced to 0)
}

// Canonicalize the stored modelFamily string (fixes casing drift like
// "Minimax" vs "MiniMax"; leaves unknown values untouched).
function canonFamily(stored?: string | null): string {
  const map: Record<string, string> = {
    minimax: 'MiniMax', chatgpt: 'ChatGPT', openai: 'ChatGPT', claude: 'Claude',
    gemini: 'Gemini', kimi: 'Kimi', glm: 'GLM', grok: 'Grok', qwen: 'Qwen',
    deepseek: 'DeepSeek', cohere: 'Cohere', mimo: 'MiMo', bytedance: 'ByteDance',
    local: 'Local',
  };
  const key = (stored || '').toLowerCase().trim();
  return map[key] || (stored || 'Unknown');
}

// Derive a family from a bare model id — used only when a message has no stored
// modelFamily (old, pre-tagging messages priced at the entity default model).
function familyFromModelId(id?: string | null): string {
  const s = (id || '').toLowerCase().trim();
  if (!s) return 'Unknown';
  // Local LM Studio slugs: vendor/name or name@quant. moonshotai/ is the one
  // cloud id that legitimately carries a slash — everything else with / or @ is
  // a local GGUF and must NOT be priced.
  if (s.includes('@')) return 'Local';
  if (s.includes('/') && !s.startsWith('moonshotai/')) return 'Local';
  const k = s.replace(/^moonshotai\//, '');
  if (k.startsWith('claude-')) return 'Claude';
  if (k.startsWith('gpt-') || k.startsWith('o1') || k.startsWith('o3') || k.startsWith('o4')) return 'ChatGPT';
  if (k.startsWith('gemini')) return 'Gemini';
  if (k.startsWith('kimi')) return 'Kimi';
  if (k.startsWith('glm')) return 'GLM';
  if (k.startsWith('grok')) return 'Grok';
  if (k.startsWith('deepseek')) return 'DeepSeek';
  if (k.startsWith('qwen')) return 'Qwen';
  if (k.startsWith('minimax')) return 'MiniMax';
  if (k.startsWith('command')) return 'Cohere';
  if (k.startsWith('mimo')) return 'MiMo';
  if (k.startsWith('dola-') || k.startsWith('seed-') || k.startsWith('doubao')) return 'ByteDance';
  return 'Unknown';
}

// Unicode-aware token heuristic — used ONLY to estimate the system-prompt size
// (per-message input tokens come from the stored, accurate `tokens` field).
// CJK counts ~1 token/char; other scripts ~0.28 token/char (~chars÷3.6).
function estTokens(s?: string | null): number {
  if (!s) return 0;
  let t = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    const cjk =
      (c >= 0x3000 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xff00 && c <= 0xffef);
    t += cjk ? 1 : 0.28;
  }
  return Math.ceil(t);
}

function msgTokens(m: any): number {
  if (typeof m?.tokens === 'number') return m.tokens;
  if (typeof m?.textTokens === 'number') return m.textTokens;
  return estTokens(m?.content);
}

// Replicates ChatArea.isMessageOriginal over a static log:
//   - firstOriginalIsNext && no marker  → everything is copied
//   - no marker                          → everything is original
//   - marker set                         → original at/after the marker index
function makeIsOriginal(log: any, messages: any[]): (idx: number) => boolean {
  const markerId = log.firstOriginalMessageId || null;
  const isNext = log.firstOriginalIsNext === true;
  if (isNext && !markerId) return () => false;
  if (!markerId) return () => true;
  const markerIdx = messages.findIndex((m) => m.id === markerId);
  if (markerIdx < 0) return () => true;
  return (idx: number) => idx >= markerIdx;
}

async function readEntityDefaults(): Promise<Record<string, { model: string; authMode: string }>> {
  const out: Record<string, { model: string; authMode: string }> = {};
  let files: string[] = [];
  try { files = await fs.readdir(FOLDERS_DIR); } catch { return out; }
  await Promise.all(files.filter((f) => f.endsWith('.json')).map(async (f) => {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(FOLDERS_DIR, f), 'utf-8'));
      const name = parsed.name || f.replace(/\.json$/, '');
      const s = parsed.settings || {};
      out[name] = {
        model: s.specificModel || GLOBAL_DEFAULT_MODEL,
        authMode: s.claudeAuthMode || 'api-key',
      };
    } catch {}
  }));
  return out;
}

export async function GET() {
  try {
    const entityDefaults = await readEntityDefaults();

    let dirs: any[] = [];
    try { dirs = await fs.readdir(LOGS_DIR, { withFileTypes: true }); } catch {}

    const records: StatRecord[] = [];
    let skippedInactive = 0;

    // Collect every (entity, file) pair, then read in parallel.
    const files: { entity: string; full: string }[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let fnames: string[] = [];
      try { fnames = await fs.readdir(path.join(LOGS_DIR, d.name)); } catch { continue; }
      for (const fn of fnames) {
        if (fn.startsWith('.') || !fn.endsWith('.json')) continue;
        files.push({ entity: d.name, full: path.join(LOGS_DIR, d.name, fn) });
      }
    }

    await Promise.all(files.map(async ({ entity, full }) => {
      let log: any;
      try {
        let raw = await fs.readFile(full, 'utf-8');
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
        log = JSON.parse(raw);
      } catch { return; }

      // Ignore inactive conversations entirely.
      if (log.active === false) { skippedInactive++; return; }

      const messages: any[] = Array.isArray(log.messages) ? log.messages : [];
      if (messages.length === 0) return;

      const def = entityDefaults[entity] || { model: GLOBAL_DEFAULT_MODEL, authMode: 'api-key' };
      // Auth mode for the Claude OAuth/API split. A model-TAGGED message really
      // ran under this conversation's stored mode, so honor it. An UNTAGGED
      // message (imported / pre-tagging) has no real run behind it — its stored
      // per-conversation mode is just whatever the default was at save time, so
      // it must follow the entity's *current* default mode, exactly the same way
      // an untagged message falls back to the entity's default MODEL. Without
      // this, an all-imported entity like Cairn (folder = oauth) gets scattered
      // across Claude (API)/(OAuth) purely by stale header values.
      const taggedAuth: string = log.claudeAuthMode || def.authMode || 'api-key';
      const untaggedAuth: string = def.authMode || 'api-key';
      const isOriginal = makeIsOriginal(log, messages);

      // Running prompt size = system prompt + all messages seen so far.
      let running = estTokens(log.systemPrompt);

      messages.forEach((m, idx) => {
        const mt = msgTokens(m);
        if (m.role === 'assistant' && isOriginal(idx)) {
          const modelId: string = m.modelSpecific || def.model;
          let family = m.modelFamily ? canonFamily(m.modelFamily) : familyFromModelId(modelId);

          // Local models are free — never counted.
          if (family !== 'Local') {
            if (family === 'Claude') {
              const authMode = m.modelFamily ? taggedAuth : untaggedAuth;
              family = authMode === 'oauth' ? 'Claude (OAuth)' : 'Claude (API)';
            }

            const output = (typeof m.textTokens === 'number' ? m.textTokens
              : typeof m.tokens === 'number' ? m.tokens : estTokens(m.content));
            const price = resolvePrice(modelId);

            let usd = 0;
            let estimated = true;
            let unpriced = false;

            if (m.cacheUsage) {
              const mc = messageCost(m.cacheUsage, modelId, output, m.timestamp);
              if (mc) { usd = mc.usd; estimated = false; }
              else { unpriced = !price; estimated = false; }
            } else if (price) {
              const eff = effectivePrice(price, m.timestamp);
              usd = (running * eff.input + output * eff.output) / 1_000_000;
              estimated = true;
            } else {
              unpriced = true;
            }

            records.push({
              entity,
              convoId: log.id || path.basename(full, '.json'),
              convoTitle: log.title || 'Untitled',
              ts: typeof m.timestamp === 'number' ? m.timestamp : null,
              family,
              model: modelId,
              usd,
              estimated,
              unpriced,
            });
          }
        }
        running += mt;
      });
    }));

    const entities = Array.from(new Set(records.map((r) => r.entity))).sort();
    const families = Array.from(new Set(records.map((r) => r.family))).sort();
    const withTs = records.filter((r) => r.ts != null).map((r) => r.ts as number);
    const minTs = withTs.length ? Math.min(...withTs) : null;
    const maxTs = withTs.length ? Math.max(...withTs) : null;

    return NextResponse.json({
      records,
      entities,
      families,
      minTs,
      maxTs,
      skippedInactive,
      generatedAt: Date.now(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'stats scan failed' }, { status: 500 });
  }
}
