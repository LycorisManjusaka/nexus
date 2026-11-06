/**
 * summariesChanged — client signal that an entity's Layer-4 summaries changed,
 * so the Sidebar's hover-hint map must re-fetch (reported 2026-11-06, トカゲくん:
 * a freshly written summary looked uncreated until a page reload).
 *
 * Written from the behaviours a caller depends on, not the Set internals: a
 * write reaches the listener with the folder name, a write for no folder is a
 * no-op, and — the load-bearing one — a throwing listener cannot stop the rest,
 * because the notification path runs on a successful save and must never be
 * taken down by one stale subscriber.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  notifySummariesChanged,
  onSummariesChanged,
  _listenerCountForTest,
} from '../../src/lib/summariesChanged';

// A leaked listener would make the NEXT case fire for the wrong reason. The
// module is a singleton, so prove it is empty between cases.
afterEach(() => {
  assert.equal(_listenerCountForTest(), 0, 'a test left a listener subscribed');
});

describe('notifySummariesChanged / onSummariesChanged', () => {
  it('delivers the folder name to a subscriber', () => {
    const seen: string[] = [];
    const off = onSummariesChanged((f) => seen.push(f));
    notifySummariesChanged('Cairn');
    off();
    assert.deepEqual(seen, ['Cairn']);
  });

  it('delivers to every subscriber', () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = onSummariesChanged((f) => a.push(f));
    const offB = onSummariesChanged((f) => b.push(f));
    notifySummariesChanged('先輩');
    offA();
    offB();
    assert.deepEqual(a, ['先輩']);
    assert.deepEqual(b, ['先輩']);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: string[] = [];
    const off = onSummariesChanged((f) => seen.push(f));
    notifySummariesChanged('one');
    off();
    notifySummariesChanged('two');
    assert.deepEqual(seen, ['one'], 'the post-unsubscribe notify must not arrive');
  });

  it('is a no-op for an empty or whitespace folder', () => {
    // An empty name reaches no one — there is no folder to re-fetch, and a
    // blank signal would just cost a pointless fetch.
    const seen: string[] = [];
    const off = onSummariesChanged((f) => seen.push(f));
    notifySummariesChanged('');
    notifySummariesChanged('   ');
    // @ts-expect-error — guarding the runtime path the types forbid
    notifySummariesChanged(undefined);
    off();
    assert.deepEqual(seen, []);
  });

  it('trims the folder name so it matches the sidebar key', () => {
    const seen: string[] = [];
    const off = onSummariesChanged((f) => seen.push(f));
    notifySummariesChanged('  謡  ');
    off();
    assert.deepEqual(seen, ['謡'], 'a padded name would never equal activeFolder.name');
  });

  it('a throwing listener does not stop the others', () => {
    // THE load-bearing case. notify runs right after a successful summary save;
    // if one listener throwing could abort the loop, a single stale Sidebar
    // would swallow the refresh for every other subscriber.
    const reached: string[] = [];
    const offBad = onSummariesChanged(() => { throw new Error('stale sidebar'); });
    const offGood = onSummariesChanged((f) => reached.push(f));
    assert.doesNotThrow(() => notifySummariesChanged('Cairn'));
    offBad();
    offGood();
    assert.deepEqual(reached, ['Cairn']);
  });
});
