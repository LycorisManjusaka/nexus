/**
 * TEMPORARY instrument — delete once task 32 is closed.
 *
 * Writes a line to BOTH the browser console and `local_data/ui_probe.log`.
 *
 * The console alone was not enough. The question being measured ("which of the
 * four setMessages paths erases the live turn's bubbles in a second tab?") can
 * only be observed in the tab that reproduces it, and that tab is つよ's — so a
 * console-only probe asks her to open devtools, find the right lines and paste
 * them, on top of reproducing the bug. A file she never has to look at costs
 * her nothing beyond the reproduction she was doing anyway, and I can read it.
 *
 * Deliberately fire-and-forget: a probe that can throw, block a render, or make
 * a failing turn look like a probe failure is worse than no probe. Every error
 * path here swallows.
 */

/** Identifies one page load, so two tabs are distinguishable in the log. */
const TAB_ID =
  typeof window === 'undefined'
    ? 'server'
    : Math.random().toString(36).slice(2, 8);

export function uiProbe(event: string, data: Record<string, unknown>): void {
  try {
    const line = { event, tab: TAB_ID, at: new Date().toISOString(), ...data };
    // eslint-disable-next-line no-console
    console.warn(`[nexus-probe] ${event}`, line);
    if (typeof window === 'undefined') return;
    void fetch('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(line),
      // The most interesting lines are the ones written while a tab is being
      // torn down or navigated away from; without this they are cancelled.
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* an instrument must never be the thing that breaks */
  }
}
