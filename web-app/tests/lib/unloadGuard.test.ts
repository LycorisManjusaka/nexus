/**
 * unloadGuard — "SHOW the reader" and "STOP the reader" are two questions.
 *
 * NEW TEST for a file that had none, written the day one registration drove
 * three surfaces and I narrowed it for one of them.
 *
 * WHAT HAPPENED (2026-11-02, both halves in the same day). The SPU run moved
 * server-side on 2026-10-31, so there was no longer a reason to BLOCK a close
 * during it. I narrowed the SPU's registration to the one case that still
 * chains through the tab ('auto'). That one Map also fed:
 *
 *   1. the beforeunload dialog          <- what I meant to narrow
 *   2. the in-app confirmIfBusy gate    <- also right to narrow
 *   3. the tab title's "●"              <- NOT right, and it went silently
 *
 * REPORTED by トカゲくん within the hour: "that had a different role. It is how
 * you see at a glance whether something is running right now. If the dialog is
 * not needed any more by your judgement, you may delete it. But put the
 * working ● back."
 *
 * Each case below names what would look different without its rule. The dot
 * itself is rendered in ChatArea (`document.title = busyLabel ? ...`), which
 * has no fixture here — so what is testable is the REGISTRY, which is where
 * the mistake was.
 *
 * `confirmIfBusy` is deliberately NOT tested: it returns true unconditionally
 * when `window` is undefined, so under node it cannot distinguish its own
 * branches. Testing it here would be a test that passes for the wrong reason.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setUnloadGuard, setBusyOnly, describeBusy, describeBlocking,
} from '../../src/lib/unloadGuard';

// The registry is module-level state, so every test clears the keys it uses.
const KEYS = ['spu', 'generation', 'save'];
beforeEach(() => { for (const k of KEYS) setUnloadGuard(k, null); });

describe('unloadGuard: show vs block', () => {
  it('a plain registration both shows AND blocks (every pre-existing call site)', () => {
    // Without the default, four call sites that predate the third parameter
    // would silently stop guarding a close mid-generation.
    setUnloadGuard('generation', 'Cairn is working');
    assert.equal(describeBusy(), 'Cairn is working');
    assert.equal(describeBlocking(), 'Cairn is working');
  });

  it('setBusyOnly SHOWS and does not BLOCK', () => {
    // This is the whole fix: the dot comes from describeBusy, the dialog and
    // the navigation gate from describeBlocking. Without the split, work that
    // survives the tab either asks a pointless question or becomes invisible.
    setBusyOnly('spu', 'Updating the soul');
    assert.equal(describeBusy(), 'Updating the soul', 'the dot must appear');
    assert.equal(describeBlocking(), null, 'and nothing may be held back');
  });

  it('a blocking reason beside a non-blocking one blocks with only its own label', () => {
    // Without filtering, the dialog would quote work that is not in danger.
    setBusyOnly('spu', 'Updating the soul');
    setUnloadGuard('save', 'Saving');
    assert.equal(describeBusy(), 'Updating the soul / Saving');
    assert.equal(describeBlocking(), 'Saving');
  });

  it('idle is null on both, not an empty string', () => {
    // ChatArea tests `busyLabel ? ... : base`, so '' would also be falsy — but
    // describeBlocking feeds `e.returnValue` and a '' there is not the same as
    // "no reason held".
    assert.equal(describeBusy(), null);
    assert.equal(describeBlocking(), null);
  });

  it('clearing one key leaves the other', () => {
    setUnloadGuard('generation', 'Cairn is working');
    setBusyOnly('spu', 'Updating the soul');
    setUnloadGuard('generation', null);
    assert.equal(describeBusy(), 'Updating the soul');
    assert.equal(describeBlocking(), null);
  });

  it('changing ONLY the blocking-ness of a held key takes effect', () => {
    // The no-op short-circuit exists to stop effects thrashing, and it used to
    // compare labels alone. With the second field added, a key that re-registers
    // the same text with a different blocking-ness MUST go through — otherwise
    // an SPU run that starts as 'update' and becomes 'auto' would never arm the
    // dialog (and vice versa, it would never disarm).
    setBusyOnly('spu', 'Updating the soul');
    assert.equal(describeBlocking(), null);
    setUnloadGuard('spu', 'Updating the soul');          // same label, now blocking
    assert.equal(describeBlocking(), 'Updating the soul');
    setBusyOnly('spu', 'Updating the soul');             // and back
    assert.equal(describeBlocking(), null);
  });

  it('re-registering an identical reason is a no-op but not a loss', () => {
    setUnloadGuard('save', 'Saving');
    setUnloadGuard('save', 'Saving');
    assert.equal(describeBusy(), 'Saving');
    assert.equal(describeBlocking(), 'Saving');
  });

  it('clearing a key that was never held does nothing', () => {
    setUnloadGuard('never-held', null);
    assert.equal(describeBusy(), null);
  });
});
