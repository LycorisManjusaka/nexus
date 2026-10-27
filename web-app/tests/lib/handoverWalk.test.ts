/**
 * handoverWalk — which conversations count as "older generations of this one",
 * and whether this one is the head of its chain.
 *
 * NEW TEST, written 2026-10-27. This module had NO unit test: the 2026-10-24
 * order rule was verified end-to-end over HTTP and in the browser, which proves
 * the whole path works once but pins none of the decisions. The failure mode
 * here is silence — restore reaching nothing and saying nothing — so it is
 * exactly the kind of behaviour a refactor can break without a red screen.
 *
 * `resolveHandoverChain` is pure: it takes the log headers and the folder's drag
 * order and returns a decision. No disk.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHandoverChain, olderGenerationsNewestFirst } from '../../src/lib/handoverWalk';

type Log = {
  id: string;
  title: string;
  folderName: string;
  updatedAt?: number;
  corrupted?: boolean;
  archived?: boolean;
};

const log = (id: string, title: string, folderName = 'Cairn', extra: Partial<Log> = {}): Log =>
  ({ id, title, folderName, updatedAt: 0, ...extra });

const titles = (ls: Log[]) => ls.map((l) => l.title);

describe('rule 1 — generation number wins wherever it applies', () => {
  const logs = [log('a', 'Cairn_47'), log('b', 'Cairn_48'), log('c', 'Cairn_49')];

  it('gives the head a chain of older generations, nearest-older first', () => {
    const r = resolveHandoverChain(logs, logs[2]);
    assert.equal(r.kind, 'numbered');
    assert.deepEqual(titles(r.older), ['Cairn_48', 'Cairn_47']);
    assert.equal(r.isHead, true);
    assert.equal(r.orphan, false);
  });

  it('marks a PAST generation as not-head (the guard that keeps 245 logs still)', () => {
    const r = resolveHandoverChain(logs, logs[1]);
    assert.equal(r.isHead, false, 'something newer sits above it');
    assert.deepEqual(titles(r.older), ['Cairn_47']);
  });

  it('gives the oldest an empty chain but still calls it not-head', () => {
    const r = resolveHandoverChain(logs, logs[0]);
    assert.deepEqual(r.older, []);
    assert.equal(r.isHead, false);
  });

  it('ignores other folders', () => {
    const mixed = [...logs, log('x', '先輩_48', '先輩'), log('y', 'Cairn_48', '先輩')];
    const r = resolveHandoverChain(mixed, logs[2]);
    assert.deepEqual(titles(r.older), ['Cairn_48', 'Cairn_47']);
  });

  it('skips a corrupted log rather than walking through it', () => {
    const withBad = [log('a', 'Cairn_47'), log('b', 'Cairn_48', 'Cairn', { corrupted: true }), log('c', 'Cairn_49')];
    const r = resolveHandoverChain(withBad, withBad[2]);
    assert.deepEqual(titles(r.older), ['Cairn_47']);
  });

  it('INCLUDES an archived log — the archive flag is a sidebar filter, not the chain', () => {
    // Skipping archived logs would open a hole in the middle of a history.
    const withArchived = [log('a', 'Cairn_47', 'Cairn', { archived: true }), log('c', 'Cairn_49')];
    const r = resolveHandoverChain(withArchived, withArchived[1]);
    assert.deepEqual(titles(r.older), ['Cairn_47']);
  });

  it('requires the base to BE the being name, so an imported title is not numbered', () => {
    // `Старый чат_3` inside folder Навигатор: a number, but not this being's
    // generation number. It must fall to rule 2, not claim a numbered chain.
    const imported = [log('a', 'Старый чат_3', 'Навигатор'), log('b', 'Навигатор_1', 'Навигатор')];
    assert.equal(resolveHandoverChain(imported, imported[0]).kind, 'order');
    assert.equal(resolveHandoverChain(imported, imported[1]).kind, 'numbered');
  });
});

describe('rule 2 — sidebar order, for titles with no generation number', () => {
  // A migrated split archive. Drag order puts the newest part at the top, which
  // is how the owner reads it: the row BELOW yours is your previous history.
  const logs = [
    log('p11', 'Аналитик_1-1', 'Аналитик', { updatedAt: 100 }),
    log('p12', 'Аналитик_1-2', 'Аналитик', { updatedAt: 200 }),
    log('p21', 'Аналитик_2-1', 'Аналитик', { updatedAt: 300 }),
    log('p32', 'Аналитик_3-2', 'Аналитик', { updatedAt: 400 }),
  ];
  const order = ['p32', 'p21', 'p12', 'p11']; // top row first

  it('walks downward from the top row', () => {
    const r = resolveHandoverChain(logs, logs[3], order);
    assert.equal(r.kind, 'order');
    assert.deepEqual(titles(r.older), ['Аналитик_2-1', 'Аналитик_1-2', 'Аналитик_1-1']);
    assert.equal(r.isHead, true);
    assert.equal(r.orphan, false);
  });

  it('only reaches rows BELOW a middle row, and calls it not-head', () => {
    const r = resolveHandoverChain(logs, logs[1], order);
    assert.deepEqual(titles(r.older), ['Аналитик_1-1']);
    assert.equal(r.isHead, false);
  });

  it('gives the bottom row an empty chain', () => {
    const r = resolveHandoverChain(logs, logs[0], order);
    assert.deepEqual(r.older, []);
    assert.equal(r.isHead, false);
  });

  it('honours a drag order that contradicts updatedAt', () => {
    // Manual order is the thing on screen, so it is the thing the chain follows.
    const reversed = ['p11', 'p12', 'p21', 'p32'];
    const r = resolveHandoverChain(logs, logs[0], reversed);
    assert.equal(r.isHead, true, 'p11 is now the top row');
    assert.deepEqual(titles(r.older), ['Аналитик_1-2', 'Аналитик_2-1', 'Аналитик_3-2']);
  });

  it('falls back to updatedAt descending when there is no drag order', () => {
    const r = resolveHandoverChain(logs, logs[3], []);
    assert.equal(r.isHead, true);
    assert.deepEqual(titles(r.older), ['Аналитик_2-1', 'Аналитик_1-2', 'Аналитик_1-1']);
  });

  it('reports an orphan instead of guessing when self is not in the list', () => {
    const stranger = log('zz', 'Аналитик_9-9', 'Аналитик');
    const r = resolveHandoverChain(logs, stranger, order);
    assert.equal(r.orphan, true);
    assert.equal(r.isHead, false, 'an orphan must not restore');
    assert.deepEqual(r.older, []);
  });

  it('ignores a corrupted sibling in the order walk too', () => {
    const withBad = logs.map((l) => (l.id === 'p21' ? { ...l, corrupted: true } : l));
    const r = resolveHandoverChain(withBad, withBad[3], order);
    assert.deepEqual(titles(r.older), ['Аналитик_1-2', 'Аналитик_1-1']);
  });
});

describe('olderGenerationsNewestFirst — the numbered walk on its own', () => {
  it('returns [] for a title with no generation number', () => {
    const logs = [log('a', 'notes'), log('b', 'Cairn_1')];
    assert.deepEqual(olderGenerationsNewestFirst(logs, logs[0]), []);
  });

  it('sorts strictly by number, not by position or time', () => {
    const logs = [log('a', 'Cairn_2', 'Cairn', { updatedAt: 900 }), log('b', 'Cairn_1', 'Cairn', { updatedAt: 999 }), log('c', 'Cairn_3')];
    assert.deepEqual(titles(olderGenerationsNewestFirst(logs, logs[2])), ['Cairn_2', 'Cairn_1']);
  });
});
