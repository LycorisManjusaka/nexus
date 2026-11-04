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
// The lease, the holder and the claimed-count are implementation. NEXUS looked
// the same before server-side turns existed and must look the same after: a
// user cannot act on "runner:c:\dev\nexus holds it (just now)" and should not
// be asked to read it.
//
// CORRECTION 2026-10-31: this sentence began "The stock, the lease, …" and
// put the whole stock on the hidden side. トカゲくん's policy that evening
// splits it: hide how a turn is run, show what the browser version could not
// do. A message QUEUED BEHIND a running turn is in the second group — the
// browser version simply dropped it, so there is nothing to look the same as,
// and a person is waiting for it. `stockWaiting > 0` therefore opens the
// panel on its own. The lease and the claimed-count stay hidden.
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

// ── Why an item came back (2026-11-04, F20) ─────────────────────────────────
//
// つよ: 「なんであたしの失敗したメッセージをスタックに保存してんの？なんで
// 普通にログに出さない？スタックってさ、そういう役割じゃないっしょ。」
//
// Her reading was right about the role and wrong about the cause, and both
// halves are the bug. The stock is where a message LIVES until the save that
// answers it lands — consuming it before the save would mean a refused save
// deletes the message with nowhere to put it back. So an attempted item and a
// never-attempted one sit in the same directory with the same shape, and the
// panel showed them with the same sentence.
//
// Two kinds and not a boolean, for the reason stockNote has two kinds: what a
// person does next differs. `save-refused` is actionable (another writer is
// live — close the other tab); `failed` is not.
export type ReturnedKind = 'save-refused' | 'failed';

/**
 * The runner's stage → what the person is told. THE ONLY derivation.
 *
 * Kept here rather than at the tick route because that route imports
 * `next/server` and so cannot be reached by a test (measured 2026-10-27), and
 * a classifier nothing can check is how a wrong diagnosis ships quietly.
 *
 * `'save'` is the runner's own name for "the answer existed and the write was
 * refused" — the 3000/3001 collision つよ hit on 2026-11-03, where her message
 * and my reply both vanished from the screen. Everything else, including a
 * pass that threw before it had a stage at all, is `failed`: a sentence that
 * promises a cause it cannot show is worse than one that admits it has none.
 */
export function classifyReturn(stage?: string | null): ReturnedKind {
  return stage === 'save' ? 'save-refused' : 'failed';
}

export type StockPanelInput = {
  /** `globalSettings.showRunnerNotices === true`. OFF is the shipped default. */
  debug: boolean;
  /** The current note's kind, or null when there is no note. */
  noteKind: StockNoteKind | null;
  /** Items in the queue for this conversation, waiting plus claimed. */
  stockCount: number;
  /**
   * Items NOT yet claimed by a runner — i.e. queued behind something.
   *
   * Separate from `stockCount` because the two answer different questions.
   * `count` is "is there anything on disk", which stays true for the whole of
   * a healthy turn (release happens after the turn resolves, on purpose) and
   * so cannot decide whether a person is waiting. `waiting` excludes claimed
   * items, so it is non-zero only while something really is behind something.
   */
  stockWaiting: number;
  /**
   * Items queued for this conversation that are addressed to a DIFFERENT
   * installation of NEXUS (2026-11-02; two clones share one store by junction).
   *
   * A third count and not folded into `waiting`, because the two mean opposite
   * things to the person reading them. `waiting` is "behind something, coming
   * shortly". This is "NOTHING HERE WILL EVER RUN IT" — the other NEXUS has to
   * be the one, and if that one is not running, the message sits forever.
   *
   * Which is why it opens the panel unconditionally: the whole argument for
   * hiding machinery is that a user cannot act on it. A person CAN act on
   * this one — open the other NEXUS, or move the host flag.
   */
  stockElsewhere: number;
  /**
   * Items carrying a `returned` mark — claimed, run, handed back (F20).
   *
   * A SUBSET of `stockWaiting` today, and deliberately its own count anyway.
   * Marking happens while the lease is held and abandoning follows, so a
   * marked item is always unclaimed and `waiting > 0` already opens the panel
   * — which means this clause can never currently be the one that fires.
   *
   * It is here because that is an invariant of two functions in another file,
   * and the thing it guards is a FAILURE REPORT. The whole argument of this
   * module's header is that a sentence saying "what you asked for did not
   * happen" must reach a person who has never opened a settings panel. Leaving
   * that reachability resting on "something else happens to be positive" is
   * the inversion the header is about, one level up.
   */
  stockReturned: number;
};

/**
 * Three independent reasons to show the panel, in priority order:
 *
 *   1. a 'problem' note — ALWAYS, debug or not. Something a person asked for
 *      did not happen, and the sentence is the only place that says so.
 *   2. a WAITING stock — ALWAYS. Someone's message is queued behind another
 *      turn; the browser version could not do that, so there is no old look
 *      to preserve, and a person is waiting for an answer.
 *   3. debug, and there is anything at all to look at.
 *
 * CORRECTION 2026-10-31: this said "Two independent reasons" and listed (1)
 * and (3). Clause (2) was added the same evening, below this comment, which
 * left a count in prose contradicting the code three lines down — the exact
 * failure the ChatArea call site above was corrected for on the same day.
 *
 * Note that (3) requires something present. A debug flag alone must not paint
 * an empty box: an empty panel in a corner is indistinguishable from a panel
 * that is broken, and this house has paid for that confusion once already
 * (a button that returned `{ok:true}` while doing nothing, F1).
 */
export function showStockPanel(i: StockPanelInput): boolean {
  if (i.noteKind === 'problem') return true;
  // Queued-behind-something is NOT machinery. ADDED 2026-10-31 on トカゲくん's
  // policy: hide how a turn is run, show what the browser version could not
  // do. A message waiting behind another turn is new, a person is waiting for
  // it, and the live count is the only honest statement of that.
  //
  // Keyed on `stockWaiting` and not `stockCount`: count stays positive for
  // the whole of a healthy turn, so it would paint this row on every send.
  if (i.stockWaiting > 0) return true;
  // Addressed elsewhere is the STRONGEST of the three "always" clauses and is
  // listed last only because it is the newest. ADDED 2026-11-02: a message
  // this installation may never run is not "queued behind" anything — there
  // is no turn ahead of it that will finish and let it through. Treating it
  // as machinery would reproduce exactly the symptom this day's work started
  // from: a message that is stocked and never runs, with nothing on screen.
  if (i.stockElsewhere > 0) return true;
  // ADDED 2026-11-04 (F20). An item that was run and handed back is a failure
  // report with no note behind it — the note that described it belonged to one
  // tab and is gone by the time anyone reloads. See `stockReturned`.
  if (i.stockReturned > 0) return true;
  if (!i.debug) return false;
  return i.stockCount > 0 || i.noteKind !== null;
}
