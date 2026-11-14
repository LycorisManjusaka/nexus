// Server-side persistence for the Claude subscription usage meter.
// Pure logic and the measurement notes live in claudeUsage.ts.
//
// One file for the whole install: the OAuth token lives in keys.json, which is
// install-wide, so the plan whose windows these are is install-wide too.
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '@/lib/beingPaths';
import { atomicWriteFile } from '@/lib/atomicWrite';
import { mergeUsage, parseSnapshot, windowsFromRateLimitInfo, type ClaudeUsageSnapshot } from '@/lib/claudeUsage';

export const CLAUDE_USAGE_FILE = path.join(DATA_DIR, 'claude_usage.json');

export function readClaudeUsage(file: string = CLAUDE_USAGE_FILE): ClaudeUsageSnapshot | null {
  try {
    return parseSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// Writes are serialised so two events of the same turn cannot interleave a
// read-merge-write and drop a window.
let chain: Promise<void> = Promise.resolve();

/**
 * Record one `rate_limit_info`. Never throws — a meter that fails must not
 * take the turn down with it.
 */
export function recordRateLimitInfo(ri: unknown, file: string = CLAUDE_USAGE_FILE, now: number = Date.now()): Promise<void> {
  const next = windowsFromRateLimitInfo(ri);
  if (!next) return chain;
  chain = chain.then(async () => {
    try {
      const merged = mergeUsage(readClaudeUsage(file), next, now);
      await atomicWriteFile(file, JSON.stringify(merged, null, 2));
    } catch (e: any) {
      console.warn(`[claude-usage] could not record: ${e?.message || e}`);
    }
  });
  return chain;
}
