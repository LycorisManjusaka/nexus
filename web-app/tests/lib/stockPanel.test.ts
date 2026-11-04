/**
 * stockPanel — may the server-side machinery appear on screen? (2026-10-31)
 *
 * NEW TEST; the module did not exist an hour ago. Written for 1.2: "the
 * server-related messages are not needed any more — hide them unless
 * debugging, so NEXUS looks exactly as it did before."
 *
 * EXTENDED the same evening for トカゲくん's policy: "mirror the browser
 * version's behaviour, show no extra warnings — but what the browser version
 * NEVER HAD must be shown plainly." A message queued behind a running turn is
 * in that second group, so the rule gained a third clause.
 *
 * The rule has THREE clauses and the dangerous edit is collapsing them.
 * Naming what would look different if each were absent:
 *
 *   NOT written from the implementation:
 *     "a 'problem' note shows with debug OFF" — absent, this reduces to
 *         `debug && …` and a refused kick tells the person NOTHING. Their
 *         message sits in the queue and the only sentence that says why is
 *         suppressed. This is the clause a simplifying edit removes, and
 *         nothing type-errors when it goes.
 *     "a WAITING stock shows with debug OFF" — absent, 1.2's hiding takes the
 *         policy's second half with it: someone sends while a turn runs, the
 *         message queues correctly, and the screen says nothing at all. That
 *         is the exact shape he asked me not to remove.
 *     "a stock that is fully CLAIMED stays hidden" — absent, the waiting
 *         clause fires on `count` instead and paints the panel during every
 *         healthy turn (release happens after the turn resolves, on purpose,
 *         so `count` is positive for the whole of one).
 *     "an 'info' note is hidden with debug OFF" — absent, the reported bug
 *         stays: 「ストックに積みました（1 通待ち）」 is set when enqueue
 *         SUCCEEDS and then sits on screen describing a stock that drained
 *         seconds later.
 *     "debug with nothing present shows nothing" — absent, ticking the box
 *         paints an empty box in the corner, and an empty panel is
 *         indistinguishable from a broken one (F1's shape).
 *     "machinery alone is hidden with debug OFF" — absent, 1.2 is not done
 *         at all: the claimed-count and the holder are still on screen for
 *         every user of every turn.
 *
 *   Written from the implementation (they restate it): the debug-ON cases
 *     where everything shows, and the all-empty case.
 *
 * ⚠ Scope NOT covered: WHICH rows render inside the panel once it is
 * visible. The claimed-count and lease rows carry their own `debugRunner &&`
 * in ChatArea's JSX, and no test in this repo reaches ChatArea's JSX. The note
 * row's kind gate (added tonight) is in the same blind spot.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { showStockPanel, classifyReturn } from '@/lib/stockPanel';

describe('stockPanel: a problem always reaches the person', () => {
  it('shows a problem note with debug OFF', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: 'problem', stockCount: 0, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      true,
    );
  });

  it('shows a problem note with debug OFF even when the queue is empty', () => {
    // The refused-kick case: the item was never enqueued, so there is no
    // count to key off. The note is the entire signal.
    assert.equal(
      showStockPanel({ debug: false, noteKind: 'problem', stockCount: 0, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      true,
    );
  });

  it('shows a problem note with debug ON', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: 'problem', stockCount: 3, stockWaiting: 1, stockElsewhere: 0, stockReturned: 0 }),
      true,
    );
  });
});

describe('stockPanel: a message queued behind a turn is NOT machinery', () => {
  it('shows a waiting stock with debug OFF and no note', () => {
    // The policy case: send while a turn runs, the item queues, and the live
    // count is the only honest statement that someone is waiting for it.
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 1, stockWaiting: 1, stockElsewhere: 0, stockReturned: 0 }),
      true,
    );
  });

  it('shows a waiting stock with debug OFF even beside a hidden info note', () => {
    // `chat.stock.added` rides along as an 'info' note on the very send that
    // produced the queue. The note stays suppressed (ChatArea's kind gate) but
    // it must not suppress the panel the live count has earned.
    assert.equal(
      showStockPanel({ debug: false, noteKind: 'info', stockCount: 1, stockWaiting: 1, stockElsewhere: 0, stockReturned: 0 }),
      true,
    );
  });

  it('hides a stock that is fully CLAIMED — a healthy running turn', () => {
    // count 1, waiting 0: the item is on disk because release happens after
    // the turn resolves. Keying the new clause off `count` would paint this
    // panel on literally every send, which is the look 1.2 just removed.
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 1, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      false,
    );
  });

  it('a negative or absurd waiting count is not treated as content', () => {
    // `waiting` arrives from a route and this is a `> 0` test. The obvious
    // edit — `stockWaiting !== 0` — passes every other case in this file.
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 0, stockWaiting: -1, stockElsewhere: 0, stockReturned: 0 }),
      false,
    );
  });
});

describe('stockPanel: machinery is hidden unless asked for', () => {
  it('hides an info note with debug OFF — the "1 waiting" lie', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: 'info', stockCount: 1, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      false,
    );
  });

  it('hides a non-empty but fully-claimed stock with debug OFF and no note', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 2, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      false,
    );
  });

  it('hides everything with debug OFF and nothing happening', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 0, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      false,
    );
  });

  it('shows an info note with debug ON', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: 'info', stockCount: 0, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      true,
    );
  });

  it('shows a non-empty stock with debug ON and no note', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: 1, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      true,
    );
  });
});

describe('stockPanel: debug alone does not paint an empty box', () => {
  it('hides when debug is ON but there is nothing to look at', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: 0, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      false,
    );
  });

  it('a negative or absurd count is not treated as content', () => {
    // Defensive: `count` arrives from a route and this is a `> 0` test, so a
    // 0 or a negative must not open the panel. Asserted because the obvious
    // edit — `stockCount !== 0` — passes every other case here.
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: -1, stockWaiting: 0, stockElsewhere: 0, stockReturned: 0 }),
      false,
    );
  });
});

describe('stockPanel: a stock this installation cannot run always reaches the person', () => {
  /*
   * NOT written from the implementation. These come from the symptom
   * (トカゲくん, 2026-11-02): two clones share one local_data by junction, so
   * `runner.json` names one of them and a message typed into the other was
   * stocked and never ran. The panel is the only place that can say so.
   */

  it('shows an elsewhere-addressed stock with debug OFF', () => {
    // Without this clause the day's symptom survives the fix: the item is
    // narrowed out of `count` and `waiting` by the server (that is what makes
    // the runner leave it alone), so every other reason to open the panel is
    // already false and the person sees an empty screen.
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 0, stockWaiting: 0, stockElsewhere: 1, stockReturned: 0 }),
      true,
    );
  });

  it('does not need a count or a waiting item to say so', () => {
    // Keyed on its own field, not on `stockCount`. If this were folded into
    // the count test, a server that narrows correctly (count 0) would hide
    // exactly the case the field exists for.
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 0, stockWaiting: 0, stockElsewhere: 3, stockReturned: 0 }),
      true,
    );
  });

  it('a negative elsewhere is not treated as content', () => {
    // Same defensive shape as the count and waiting cases above: the number
    // arrives from a route, and the obvious edit — `!== 0` — passes every
    // other case in this file.
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: 0, stockWaiting: 0, stockElsewhere: -1, stockReturned: 0 }),
      false,
    );
  });

  it('shows both rows when a stock has waiting AND elsewhere items', () => {
    // One boolean for the whole panel, so this cannot distinguish the rows —
    // asserted anyway because the two clauses are independent and a future
    // `else if` between them would silently drop one.
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 2, stockWaiting: 1, stockElsewhere: 1, stockReturned: 0 }),
      true,
    );
  });
});

// ── F20: why an item came back (2026-11-04) ─────────────────────────────────
//
// つよ: 「なんであたしの失敗したメッセージをスタックに保存してんの？なんで
// 普通にログに出さない？」
//
// She was looking at 「ストックに 1 通」+「今すぐ動かす」 after a save was
// refused, which is the same pair the panel shows for a message queued behind
// a running turn. Same count, same button, opposite action: one means "wait",
// the other means "close the other screen".
//
// Naming what would look different if each of these were absent:
//
//   NOT written from the implementation:
//     "a returned item opens the panel with debug OFF and nothing else set" —
//         absent, this sentence rests on `stockWaiting > 0`, which is true
//         TODAY only because marking happens under the lease and abandoning
//         follows. That is an invariant of two functions in another file, and
//         the thing resting on it is a failure report.
//     "'save' maps to save-refused and EVERYTHING else to failed" — absent,
//         the obvious edit is a lookup table keyed by stage, which quietly
//         turns an unknown stage into `undefined` and then into whichever
//         branch the renderer's `=== 'save-refused'` leaves. The person is
//         told "another screen saved first" about a turn that threw.
//     "an undefined/null stage is `failed`, not a throw" — absent, the path
//         where the pass threw outside its own handling has no stage at all,
//         and that is precisely the path where the lease must still go back.
//
//   Written from the implementation (they restate it): the debug-ON cases.
describe('stockPanel: classifyReturn carries, never infers', () => {
  it("maps the runner's 'save' stage to save-refused", () => {
    assert.equal(classifyReturn('save'), 'save-refused');
  });

  it('maps every other stage to failed', () => {
    for (const stage of ['post', 'stream', 'target', 'no-log', 'stopped']) {
      assert.equal(classifyReturn(stage), 'failed', `stage ${stage}`);
    }
  });

  it('maps an absent stage to failed rather than throwing', () => {
    // The tick route's catch path calls this with null: a throw from outside
    // the runner's own handling tells us nothing about how far it got, and a
    // sentence promising a cause it cannot show is worse than one that admits
    // it has none.
    assert.equal(classifyReturn(null), 'failed');
    assert.equal(classifyReturn(undefined), 'failed');
  });

  it('does not treat an unknown stage as a conflict', () => {
    // The dangerous edit: a stage this file has never heard of must not fall
    // into the actionable sentence. 'saved' and 'savepoint' both START with
    // 'save' — a `startsWith` would pass every other case in this file.
    assert.equal(classifyReturn('saved'), 'failed');
    assert.equal(classifyReturn('savepoint'), 'failed');
    assert.equal(classifyReturn(''), 'failed');
  });
});

describe('stockPanel: a returned item is a failure report', () => {
  it('opens the panel with debug OFF when ONLY returned is set', () => {
    // The state this asserts cannot arise today (a marked item is unclaimed,
    // so `waiting` is positive too) and is asserted exactly because of that:
    // the clause is unreachable by the current callers and guards the case
    // where that stops being true.
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 0, stockWaiting: 0, stockElsewhere: 0, stockReturned: 1 }),
      true,
    );
  });

  it('opens the panel for the real shape — returned inside waiting', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 1, stockWaiting: 1, stockElsewhere: 0, stockReturned: 1 }),
      true,
    );
  });

  it('a negative returned is not treated as content', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: 0, stockWaiting: 0, stockElsewhere: 0, stockReturned: -1 }),
      false,
    );
  });
});
