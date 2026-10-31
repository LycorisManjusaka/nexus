// ── Is the server-side machinery allowed on screen? ─────────────────────────
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN ChatArea (2026-10-31):
//
// The rule has a direction that is easy to invert and impossible to see once
// inverted. "Show the panel when debugging" is the obvious reading, and it is
// wrong: a note that reports a FAILURE must reach a person who has never
// opened a settings panel. Collapse the two clauses into one `debug && …` and
// nothing breaks, nothing type-errors, and the next time a kick is refused the
// person is told nothing at all.
//
// A rule that lives inside a component is a rule no test and no mutation
// check can reach — the same reason resolveActiveTurn, decideRunRecord and
// isCollectableHere were pulled out of their routes and panels.
//
// ── What "machinery" means here ─────────────────────────────────────────────
// The stock, the lease, the holder and the claimed-count are implementation.
// NEXUS looked the same before server-side turns existed and must look the
// same after: a user cannot act on "runner:c:\dev\nexus holds it (just now)"
// and should not be asked to read it.
//
// ── Why hiding it does not hide a stuck message (measured 2026-10-31) ───────
//   - a refused kick sets a 'problem' note, which is shown either way;
//   - a claim that cannot be taken closes the relay with a `notice` frame,
//     which lands on the assistant bubble and never came through here;
//   - an item stranded by a tab that died between enqueue and kick IS
//     invisible until the next send — and that send's claim takes the leading
//     run of same-kind items, so the stranded one is delivered with it rather
//     than lost. Bounded and self-healing, but a real residual.
// ───────────────────────────────────────────────────────────────────────────

/**
 * A sentence for the person, and whether it is one they must act on.
 *
 * The kind is CARRIED, not inferred from the text. Measured 2026-10-31: one
 * `stockNote` variable held both `chat.stock.added` ("added to the stock
 * (1 waiting)", set when enqueue SUCCEEDED) and every failure sentence in the
 * stock machinery. The success one is what stayed on screen claiming a stock
 * that had already drained. A renderer cannot tell those apart by looking.
 *
 * Two kinds and not a boolean `isError`, because the question a renderer asks
 * is "does this deserve a person's attention", not "did something throw":
 * `chat.stock.broke` threw nothing and deserves none.
 */
export type StockNoteKind = 'info' | 'problem';

export type StockNote = { text: string; kind: StockNoteKind };

export type StockPanelInput = {
  /** `globalSettings.showRunnerNotices === true`. OFF is the shipped default. */
  debug: boolean;
  /** The current note's kind, or null when there is no note. */
  noteKind: StockNoteKind | null;
  /** Items in the queue for this conversation, waiting plus claimed. */
  stockCount: number;
};

/**
 * Two independent reasons to show the panel, in priority order:
 *
 *   1. a 'problem' note — ALWAYS, debug or not. Something a person asked for
 *      did not happen, and the sentence is the only place that says so.
 *   2. debug, and there is anything at all to look at.
 *
 * Note that (2) requires something present. A debug flag alone must not paint
 * an empty box: an empty panel in a corner is indistinguishable from a panel
 * that is broken, and this house has paid for that confusion once already
 * (a button that returned `{ok:true}` while doing nothing, F1).
 */
export function showStockPanel(i: StockPanelInput): boolean {
  if (i.noteKind === 'problem') return true;
  if (!i.debug) return false;
  return i.stockCount > 0 || i.noteKind !== null;
}
