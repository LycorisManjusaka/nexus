// Disk side of lib/auxBilling.ts: beings/<name>/billing/<id>.json, one
// immutable file per billed call. One-file-per-call rather than an appended
// log for the reason the SPU ledger gives — two installations share one
// local_data, and separate files cannot interleave.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteFile } from './atomicWrite';
import { beingAuxBillingDir } from './beingPaths';
import { makeAuxEntry, type AuxBillingKind } from './auxBilling';
import type { TurnCacheUsage } from './turnEvents';

/** Who a bridge/subagent call is being made for. Absent → nothing is recorded. */
export interface AuxBillTarget {
  being: string;
  convoId?: string | null;
}

/**
 * Record one auxiliary call. NEVER throws and never rejects: this is
 * accounting, and a failed ledger write must not fail the description or the
 * subagent result it accompanies. Returns the path written, or null when
 * nothing was billable (no target, no usage, local model) or the write failed.
 */
export async function recordAuxBilling(
  target: AuxBillTarget | null | undefined,
  a: {
    kind: AuxBillingKind;
    model: string;
    family?: string | null;
    authMode?: 'oauth' | 'api-key';
    usage: TurnCacheUsage | null | undefined;
  },
): Promise<string | null> {
  try {
    if (!target || !target.being) return null;
    const entry = makeAuxEntry({
      id: crypto.randomUUID(),
      kind: a.kind,
      convoId: target.convoId,
      model: a.model,
      family: a.family,
      authMode: a.authMode,
      at: Date.now(),
      usage: a.usage,
    });
    if (!entry) return null;
    const dir = beingAuxBillingDir(target.being);
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, `${entry.id}.json`);
    await atomicWriteFile(p, JSON.stringify(entry, null, 2));
    return p;
  } catch (e: any) {
    console.warn(`[aux-billing] could not record a ${a?.kind} call: ${e?.message || e}`);
    return null;
  }
}
