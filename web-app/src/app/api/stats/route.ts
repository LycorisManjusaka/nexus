import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolvePrice, messageCost, effectivePrice } from '@/lib/modelPricing';
import { BEINGS_DIR, beingLogsDir, beingSettingsFile, beingBillingDir, beingAuxBillingDir } from '@/lib/beingPaths';
import { makeIsOriginalIndex } from '@/lib/firstOriginal';
import {
  canonFamily, familyFromModelId, splitClaudeByAuth, type StatRecord,
} from '@/lib/modelFamily';
import { billingToStatRecord, type SpuBillingEntry } from '@/lib/spuBilling';
import { auxBillingToStatRecord, type AuxBillingEntry } from '@/lib/auxBilling';

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

const GLOBAL_DEFAULT_MODEL = 'claude-opus-4-8';

// StatRecord, canonFamily and familyFromModelId moved to lib/modelFamily.ts
// (2026-11-07) so the SPU billing ledger derives a family the SAME way a saved
// message does — see that file. splitClaudeByAuth replaces the inline
// `family === 'Claude' ? …` branch that used to live below.

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

async function readEntityDefaults(): Promise<Record<string, { model: string; authMode: string }>> {
  const out: Record<string, { model: string; authMode: string }> = {};
  let dirs: any[] = [];
  try { dirs = await fs.readdir(BEINGS_DIR, { withFileTypes: true }); } catch { return out; }
  await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
    try {
      const parsed = JSON.parse(await fs.readFile(beingSettingsFile(d.name), 'utf-8'));
      const name = parsed.name || d.name;
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
    try { dirs = await fs.readdir(BEINGS_DIR, { withFileTypes: true }); } catch {}

    const records: StatRecord[] = [];
    let skippedInactive = 0;

    // Collect every (entity, file) pair, then read in parallel. The display
    // name (what the UI and entityDefaults are keyed on) is resolved from
    // settings.json; the directory name is only the sanitized key.
    //
    // The billing dir is collected per being alongside logs, and NOT gated on
    // the logs readdir succeeding: a being can have soul-update spend with an
    // empty or missing logs folder, and gating it on logs would drop that spend.
    const files: { entity: string; full: string }[] = [];
    const billingDirs: { entity: string; dir: string }[] = [];
    const auxBillingDirs: { entity: string; dir: string }[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let entity = d.name;
      try {
        const parsed = JSON.parse(await fs.readFile(beingSettingsFile(d.name), 'utf-8'));
        if (parsed.name) entity = parsed.name;
      } catch {}
      billingDirs.push({ entity, dir: beingBillingDir(d.name) });
      auxBillingDirs.push({ entity, dir: beingAuxBillingDir(d.name) });
      let fnames: string[] = [];
      try { fnames = await fs.readdir(beingLogsDir(d.name)); } catch { continue; }
      for (const fn of fnames) {
        if (fn.startsWith('.') || !fn.endsWith('.json')) continue;
        files.push({ entity, full: path.join(beingLogsDir(d.name), fn) });
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
      const isOriginal = makeIsOriginalIndex(log, messages);

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
              family = splitClaudeByAuth('Claude', authMode);
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
              // `running` is the conversation's accumulated input tokens up to
              // this message — i.e. this turn's prompt size, which is exactly
              // what selects a model's long-context tier (OpenAI >272K,
              // Haiku 5.5 >100K). Without it this estimate path would keep
              // reporting short-context rates on turns billed at the long one.
              const eff = effectivePrice(price, m.timestamp, running);
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

    // ── SPU billing ledger ──────────────────────────────────────────────────
    // Soul-update spend lives outside the conversation logs (a run calls the
    // provider up to seven times and used to be shown live and then discarded —
    // 2026-11-07). Each ledger entry is one completed run; billingToStatRecord
    // prices it through the SAME messageCost the message walk uses and tags the
    // family (Claude split OAuth/API) the same way, so the client's existing
    // filters — exclude-OAuth, last-month, estimated-off — apply unchanged
    // (ledger records are estimated:false, real usage). A Local run returns null
    // and is dropped, matching the message walk's Local skip.
    await Promise.all(billingDirs.map(async ({ entity, dir }) => {
      let fnames: string[] = [];
      try { fnames = await fs.readdir(dir); } catch { return; }
      await Promise.all(fnames.map(async (fn) => {
        if (fn.startsWith('.') || !fn.endsWith('.json')) return;
        let entry: SpuBillingEntry;
        try {
          let raw = await fs.readFile(path.join(dir, fn), 'utf-8');
          if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
          entry = JSON.parse(raw);
        } catch { return; }
        const rec = billingToStatRecord(entry, entity);
        if (rec) records.push(rec);
      }));
    }));

    // ── Auxiliary-call ledger (eyes / ears / video watcher / subagent / anchor) ─
    // beings/<name>/billing/. Same contract as the SPU ledger above: raw usage,
    // priced here through messageCost, Local dropped. See lib/auxBilling.ts.
    await Promise.all(auxBillingDirs.map(async ({ entity, dir }) => {
      let fnames: string[] = [];
      try { fnames = await fs.readdir(dir); } catch { return; }
      await Promise.all(fnames.map(async (fn) => {
        if (fn.startsWith('.') || !fn.endsWith('.json')) return;
        let entry: AuxBillingEntry;
        try {
          let raw = await fs.readFile(path.join(dir, fn), 'utf-8');
          if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
          entry = JSON.parse(raw);
        } catch { return; }
        const rec = auxBillingToStatRecord(entry, entity);
        if (rec) records.push(rec);
      }));
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
