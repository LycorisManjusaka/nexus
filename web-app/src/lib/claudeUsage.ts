// Claude subscription usage meter — the 5-hour window and the weekly window
// of a Claude.ai plan, as the indicator beside the context gauge shows them.
//
// WHERE THE NUMBERS COME FROM (measured 2026-11-14, SDK 0.3.322 / CLI 2.1.322)
//
//   1. `rate_limit_event`, emitted by the SDK DURING an OAuth turn. Its
//      `rate_limit_info` carries an undocumented `unifiedWindows` object:
//        { five_hour: { utilization: 0.55, resetsAt: 1794633600, status },
//          seven_day: { utilization: 0.07, resetsAt: 1795161600, status } }
//      utilization is a FRACTION (0–1), resetsAt is epoch SECONDS. The same
//      turn's Claude.ai usage page read 50% / 8%, so these are the same rows.
//      The documented fields (`rateLimitType` + `utilization`) describe only
//      the one window the event is about; they are the fallback here.
//
//   2. NOT used: the SDK's `usage_EXPERIMENTAL_…()` control request. It
//      answered in 0.8 s on an empty session, but with
//      `rate_limits_available: false` — the long-lived OAuth token NEXUS holds
//      has no profile scope, which the SDK documents as one reason for false.
//      So nothing can be read BETWEEN turns: the meter is only as fresh as the
//      last OAuth turn, and says so (`capturedAt`).
//
//   NOT AVAILABLE from either source: the per-model weekly bucket (the
//   Claude.ai page's "Fable" row). The event did not carry it. The meter does
//   not invent it.
//
// A window whose reset time has passed is reported as `reset`, never as its
// old percentage: the stored number described a window that no longer exists.

export interface UsageWindow {
  /** 0–1. */
  utilization: number;
  /** Epoch ms, or null when the event did not say. */
  resetsAt: number | null;
}

export interface ClaudeUsageSnapshot {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Epoch ms of the last event that touched this snapshot. */
  capturedAt: number;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Epoch seconds (what the wire sends) → ms. Tolerates an already-ms value. */
function toMs(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function windowFrom(raw: any): UsageWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = num(raw.utilization);
  if (u === null) return undefined;
  return { utilization: u, resetsAt: toMs(raw.resetsAt ?? raw.resets_at) };
}

/**
 * Pull the windows out of one `rate_limit_info`. Returns only the windows the
 * event actually carried; null when it carried none.
 */
export function windowsFromRateLimitInfo(ri: any): Omit<ClaudeUsageSnapshot, 'capturedAt'> | null {
  if (!ri || typeof ri !== 'object') return null;
  const out: Omit<ClaudeUsageSnapshot, 'capturedAt'> = {};
  const uw = ri.unifiedWindows;
  if (uw && typeof uw === 'object') {
    const f = windowFrom(uw.five_hour);
    const s = windowFrom(uw.seven_day);
    if (f) out.fiveHour = f;
    if (s) out.sevenDay = s;
  }
  // Documented single-window form — only fills what unifiedWindows left empty.
  const single = windowFrom({ utilization: ri.utilization, resetsAt: ri.resetsAt });
  if (single) {
    if (ri.rateLimitType === 'five_hour' && !out.fiveHour) out.fiveHour = single;
    if (ri.rateLimitType === 'seven_day' && !out.sevenDay) out.sevenDay = single;
  }
  return out.fiveHour || out.sevenDay ? out : null;
}

/** Merge per window: an event that names one window keeps the other. */
export function mergeUsage(
  prev: ClaudeUsageSnapshot | null,
  next: Omit<ClaudeUsageSnapshot, 'capturedAt'>,
  now: number,
): ClaudeUsageSnapshot {
  return {
    fiveHour: next.fiveHour ?? prev?.fiveHour,
    sevenDay: next.sevenDay ?? prev?.sevenDay,
    capturedAt: now,
  };
}

export type WindowView =
  | { state: 'unknown' }
  | { state: 'reset'; resetsAt: number }
  | { state: 'live'; pct: number; resetsAt: number | null };

/** What the indicator may honestly say about one window right now. */
export function viewWindow(w: UsageWindow | undefined, now: number): WindowView {
  if (!w) return { state: 'unknown' };
  if (w.resetsAt !== null && w.resetsAt <= now) return { state: 'reset', resetsAt: w.resetsAt };
  const pct = Math.max(0, Math.min(100, Math.round(w.utilization * 100)));
  return { state: 'live', pct, resetsAt: w.resetsAt };
}

/** Parse the stored file; anything malformed reads as "no snapshot". */
export function parseSnapshot(raw: unknown): ClaudeUsageSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r: any = raw;
  const capturedAt = num(r.capturedAt);
  if (capturedAt === null) return null;
  const f = r.fiveHour ? windowFrom({ utilization: r.fiveHour.utilization, resetsAt: r.fiveHour.resetsAt }) : undefined;
  const s = r.sevenDay ? windowFrom({ utilization: r.sevenDay.utilization, resetsAt: r.sevenDay.resetsAt }) : undefined;
  if (!f && !s) return null;
  return { fiveHour: f, sevenDay: s, capturedAt };
}
