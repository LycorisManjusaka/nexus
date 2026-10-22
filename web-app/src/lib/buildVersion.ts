'use client';

// ───────────────────────────────────────────────────────────────────────────
// Client-side handle on the build identifier from /api/version.
//
// Module-level rather than React state on purpose: the place this matters
// most is an `alert()` inside an import handler, which needs the string
// SYNCHRONOUSLY and has no component to read state from. The app loads it
// once at mount; everything after that reads the cached value.
//
// If it hasn't loaded (or this isn't a git checkout), every helper degrades
// to returning the message unchanged. A missing build tag must never be the
// reason an error message fails to appear.
// ───────────────────────────────────────────────────────────────────────────

let cachedLabel = '';
let inflight: Promise<string> | null = null;

export async function loadBuildTag(): Promise<string> {
  if (cachedLabel) return cachedLabel;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch('/api/version');
      if (r.ok) {
        const d = await r.json();
        if (typeof d?.label === 'string') cachedLabel = d.label;
      }
    } catch { /* offline/dev-restart — leave it empty */ }
    inflight = null;
    return cachedLabel;
  })();
  return inflight;
}

/** Cached build label, or '' if not loaded yet. Never throws. */
export function buildTag(): string {
  return cachedLabel;
}

/**
 * Replace the cached label after this tab caused the checkout to move
 * (`/api/update`). Without this, every failure message produced for the rest
 * of the session would carry the PREVIOUS build — a build tag whose whole job
 * is to identify the running code, naming code that is no longer there.
 */
export function setBuildTag(label: string): void {
  if (typeof label === 'string' && label.trim()) cachedLabel = label.trim();
}

/**
 * Append the build identifier to a message destined for a human to copy.
 * Used on failure paths only: when the report is the sole channel back to
 * whoever maintains this code, the build has to travel WITH the complaint.
 */
export function withBuildTag(message: string): string {
  return cachedLabel ? `${message}\n\n[NEXUS ${cachedLabel}]` : message;
}
