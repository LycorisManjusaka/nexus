// The anchor test-bench fixture (2026-11-12, つよ's request — a toy for 謡).
//
// WHY. 謡 owns the anchor's rules (anchor.md). Tuning them against real replies
// by hand — edit anchor.md → press the button → ask つよ → report back — is too
// slow (つよ's words). So: a Save button on an anchor report writes everything
// the anchor SAW plus what it SAID to a .json fixture; a standalone script on
// 謡's desk re-runs the anchor OFFLINE against that fixture with whatever prompt
// she is testing, so she can iterate to zero false-positives/negatives herself.
//
// FAITHFULNESS. The real anchor call sets suppressLayer5:true, so /api/chat
// prepends NO Absolute Base Binding, NO Layer 4, NO Layer 5 (route.ts ~4691).
// The anchor's wire prompt is therefore EXACTLY anchor.md's text + this context.
// The offline script sends the same two strings to DeepSeek, so its verdict is
// faithful to production — that is the whole point of a test bench.
//
// This module is pure: no fs, no fetch. The route (api/anchor/save-fixture)
// does the I/O; the standalone runner (anchor_lab/run.mjs) does not import this
// at all — it is NEXUS-independent by design, reading the json directly.

import type { AnchorLang, AnchorReport } from '@/lib/anchor';

export const ANCHOR_FIXTURE_SCHEMA = 'anchor-fixture/1';

/** Where the lab lives: 謡 owns the anchor's rules, so the toy is on her desk. */
export const ANCHOR_LAB_OWNER = '謡';
export const ANCHOR_LAB_DIR = 'anchor_lab';
export const ANCHOR_FIXTURES_DIR = 'fixtures';

export interface AnchorFixture {
  schema: typeof ANCHOR_FIXTURE_SCHEMA;
  savedAt: number;
  being: string;
  lang: AnchorLang;
  family: string;
  model: string;
  /** The exact single user message the anchor received — the full context. */
  context: string;
  /** What the anchor said when this fixture was saved (for comparison). */
  original: { thought: string; output: string; error?: string };
  /** The anchor.md prompt text in effect at save time, for reference only. */
  promptAtSave: string;
  /**
   * The CORRECT first-line verdict for this case, filled in by hand by 謡/つよ
   * after saving (OK / NOTIFY / INTERCEPT_DROP / INTERCEPT_RETRY / SNOOZE).
   * Absent when just saved: the original verdict may be the very false
   * positive being fixed, so it is not ground truth. run.mjs --all compares the
   * new verdict against this when present.
   */
  expected?: string;
  /** Free note for the human (why this case matters, what went wrong). */
  note?: string;
}

export function buildAnchorFixture(a: {
  being: string;
  lang: AnchorLang;
  context: string;
  report: AnchorReport;
  promptAtSave: string;
  nowMs: number;
}): AnchorFixture {
  return {
    schema: ANCHOR_FIXTURE_SCHEMA,
    savedAt: a.nowMs,
    being: a.being,
    lang: a.lang,
    family: a.report.family,
    model: a.report.model,
    context: a.context,
    original: {
      thought: a.report.thought || '',
      output: a.report.output || '',
      ...(a.report.error ? { error: a.report.error } : {}),
    },
    promptAtSave: a.promptAtSave,
  };
}

/**
 * Filename for a saved fixture. ASCII-only on purpose: the being name can be
 * unicode (先輩), which the json carries, but the filename stays
 * `<ts>_<messageId>.json` so it sorts by time and never depends on NTFS unicode
 * path handling. messageId is already an id token; strip anything non-id just
 * in case.
 */
export function anchorFixtureFilename(nowMs: number, messageId: string): string {
  const safe = String(messageId).replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 24) || 'msg';
  return `${nowMs}_${safe}.json`;
}
