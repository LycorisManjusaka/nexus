/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): `ChatArea` hands the SAME
 * optimistic boundary index to every consumer of the copied/original rule, and
 * writes its render-time mirror wherever it writes the ref behind it.
 *
 * REGRESSION 2026-11-02, reported by Lizard-kun: after a sleep the pending
 * "Next = First Original" flag is set; you send a message and both it and the
 * reply stay grey until the turn ends. The runner mints the user message, so
 * the marker only reaches disk at save — and `isNext && !markerId` reads this
 * tab's own copy of the sent text as pre-clone carry-over.
 *
 * WHY A SOURCE TEST AND NOT A UNIT TEST. The rule itself has 25 unit tests and
 * 10 mutations in `lib/firstOriginal.ts`; all of them were green while the
 * screen was wrong, because the defect was never in the rule — it was in what
 * the component passed to it. `ChatArea` has no DOM fixture in this repo, so
 * the wiring has no other instrument. This is the same failure shape as F76
 * (a rule moved house and the consumer did not follow) and the same shape as
 * the token breakdown's inline partial derivation, removed tonight: both are
 * about a call site, not about arithmetic.
 *
 * SCOPE, stated rather than implied:
 *   • Reads TEXT. It cannot tell whether the value passed is correct, only
 *     that the argument is present at every call and computed in one place.
 *   • Counts WRITE SITES for the ref/mirror pair; it does not check that each
 *     pair sits in the same block. The failure it is aimed at is adding a
 *     third place that writes the ref and forgetting the mirror — which moves
 *     the count.
 *   • A rename breaks it. That is intended: the names are the contract this
 *     file is pinning, and a rename should make someone read this comment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const SRC = path.join(process.cwd(), 'src', 'components', 'ChatArea.tsx');
const src = fs.readFileSync(SRC, 'utf-8');

describe('source — the copied/original boundary is wired to one number', () => {
  it('the optimistic index is computed exactly once', () => {
    // Without this, a second site can derive the same index differently and
    // the bar and the bubbles assert different boundaries on one screen. This
    // rule has already been independently derived four times (see
    // firstOriginal.ts's header), plus a FIFTH partial form in the token
    // breakdown that the 2026-10-27 extraction left behind because it was not
    // a full copy. That fifth one was removed tonight.
    const decls = src.match(/const optimisticMarkerIdx\b/g) || [];
    assert.equal(decls.length, 1, `expected 1 declaration, found ${decls.length}`);
  });

  it('every makeIsOriginal* call passes the optimistic index', () => {
    // The actual defect: the predicate was called without it, so the message
    // just sent read as carry-over. Both adapters are called here — the index
    // form by the token breakdown, the id form by the bubbles.
    const calls = [...src.matchAll(/makeIsOriginal(Index|Id)\(([\s\S]*?)\);/g)];
    assert.ok(calls.length >= 2, `expected both adapters to be called, found ${calls.length}`);
    const forms = new Set(calls.map((c) => c[1]));
    assert.deepEqual([...forms].sort(), ['Id', 'Index']);
    for (const c of calls) {
      assert.match(
        c[2], /optimisticMarkerIdx/,
        `a makeIsOriginal${c[1]} call omits optimisticMarkerIdx:\n${c[0]}`,
      );
    }
  });

  it('the ref and its render-time mirror are written in the same places', () => {
    // The mirror exists because reading a ref during render is what
    // react-hooks flags (and the rule is right: a render that depends on a ref
    // goes stale when only the ref changes). A ref write with no matching
    // mirror write is a render that silently keeps the previous boundary.
    const refWrites = (src.match(/optimisticIdsRef\.current\s*=/g) || []).length;
    const mirrorWrites = (src.match(/setOptimisticIds\(/g) || []).length;
    assert.equal(refWrites, 2, `expected 2 ref writes (send, clear), found ${refWrites}`);
    assert.equal(
      mirrorWrites, refWrites,
      `ref written in ${refWrites} places, mirror in ${mirrorWrites}`,
    );
  });
});
