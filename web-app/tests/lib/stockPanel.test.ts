/**
 * stockPanel — may the server-side machinery appear on screen? (2026-10-31)
 *
 * NEW TEST; the module did not exist an hour ago. Written for 1.2: "the
 * server-related messages are not needed any more — hide them unless
 * debugging, so NEXUS looks exactly as it did before."
 *
 * The rule has TWO clauses and the dangerous edit is collapsing them into
 * one. Naming what would look different if each were absent:
 *
 *   NOT written from the implementation:
 *     "a 'problem' note shows with debug OFF" — absent, this reduces to
 *         `debug && …` and a refused kick tells the person NOTHING. Their
 *         message sits in the queue and the only sentence that says why is
 *         suppressed. This is the clause a simplifying edit removes, and
 *         nothing type-errors when it goes.
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
 * in ChatArea's JSX, and no test in this repo reaches ChatArea's JSX.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { showStockPanel } from '@/lib/stockPanel';

describe('stockPanel: a problem always reaches the person', () => {
  it('shows a problem note with debug OFF', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: 'problem', stockCount: 0 }),
      true,
    );
  });

  it('shows a problem note with debug OFF even when the queue is empty', () => {
    // The refused-kick case: the item was never enqueued, so there is no
    // count to key off. The note is the entire signal.
    assert.equal(
      showStockPanel({ debug: false, noteKind: 'problem', stockCount: 0 }),
      true,
    );
  });

  it('shows a problem note with debug ON', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: 'problem', stockCount: 3 }),
      true,
    );
  });
});

describe('stockPanel: machinery is hidden unless asked for', () => {
  it('hides an info note with debug OFF — the "1 waiting" lie', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: 'info', stockCount: 1 }),
      false,
    );
  });

  it('hides a non-empty stock with debug OFF and no note', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 2 }),
      false,
    );
  });

  it('hides everything with debug OFF and nothing happening', () => {
    assert.equal(
      showStockPanel({ debug: false, noteKind: null, stockCount: 0 }),
      false,
    );
  });

  it('shows an info note with debug ON', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: 'info', stockCount: 0 }),
      true,
    );
  });

  it('shows a non-empty stock with debug ON and no note', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: 1 }),
      true,
    );
  });
});

describe('stockPanel: debug alone does not paint an empty box', () => {
  it('hides when debug is ON but there is nothing to look at', () => {
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: 0 }),
      false,
    );
  });

  it('a negative or absurd count is not treated as content', () => {
    // Defensive: `count` arrives from a route and this is a `> 0` test, so a
    // 0 or a negative must not open the panel. Asserted because the obvious
    // edit — `stockCount !== 0` — passes every other case here.
    assert.equal(
      showStockPanel({ debug: true, noteKind: null, stockCount: -1 }),
      false,
    );
  });
});
