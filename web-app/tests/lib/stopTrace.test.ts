import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginStopTrace,
  markStop,
  noteStopHow,
  stopSpans,
  stopTotalMs,
  formatStopTrace,
} from '@/lib/stopTrace';

const LABELS = {
  reach: '到達',
  save: '保存',
  apply: '反映',
  patch: 'パッチ',
  reload: '再取得',
  incomplete: '未完',
};

test('spans localise the wait to one of three places', () => {
  let tr = beginStopTrace(1000);
  tr = markStop(tr, 'reach', 1100);   // server aborted 100ms after the press
  tr = markStop(tr, 'close', 4100);   // finalize + save took 3s
  tr = markStop(tr, 'apply', 4150);   // tab patched in 50ms
  assert.deepEqual(stopSpans(tr), [
    { key: 'reach', ms: 100 },
    { key: 'save', ms: 3000 },
    { key: 'apply', ms: 50 },
  ]);
  assert.equal(stopTotalMs(tr), 3150);
});

test('a span with no far end is omitted, not reported as zero', () => {
  // The relay never closed: "instant" and "never" must not print alike.
  let tr = beginStopTrace(0);
  tr = markStop(tr, 'reach', 80);
  assert.deepEqual(stopSpans(tr), [{ key: 'reach', ms: 80 }]);
  assert.equal(stopTotalMs(tr), null);
  assert.match(formatStopTrace(tr, LABELS), /^未完 — 到達 80ms$/);
});

test('a second mark for the same stage does not overwrite the first', () => {
  // The drain can hand back `close` more than once; the first sighting is the
  // answer to "when did the server get there".
  let tr = beginStopTrace(0);
  tr = markStop(tr, 'close', 500);
  tr = markStop(tr, 'close', 9000);
  assert.equal(tr.at.close, 500);
});

test('format names the spans in order and says how the screen caught up', () => {
  let tr = beginStopTrace(0);
  tr = markStop(tr, 'reach', 120);
  tr = markStop(tr, 'close', 2120);
  tr = markStop(tr, 'apply', 2200);
  tr = noteStopHow(tr, 'reload');
  assert.equal(
    formatStopTrace(tr, LABELS),
    '2.20s — 到達 120ms · 保存 2.00s · 反映 80ms [再取得]',
  );
});

test('clock going backwards cannot produce a negative span', () => {
  let tr = beginStopTrace(5000);
  tr = markStop(tr, 'reach', 4000);
  assert.deepEqual(stopSpans(tr), [{ key: 'reach', ms: 0 }]);
});

test('a press with nothing after it still prints', () => {
  const tr = beginStopTrace(7);
  assert.equal(formatStopTrace(tr, LABELS), '未完');
});
