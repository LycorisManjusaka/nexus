/**
 * diskVersion — "has another tab changed this conversation on disk?" (1.1).
 *
 * NEW TEST, new lib. The rule could have lived as a boolean inside the poll in
 * ChatArea, where no test and no mutation can reach it. It does not, because
 * the last rule that lived inside a handler was lost when the handler moved:
 * the first-original promotion disappeared with the send path's move to the
 * runner and every cloned conversation read as all-past (F76, 2026-10-31).
 *
 * Each case below names what would look different if its rule were missing.
 * That is the only thing that distinguishes a test from a restatement of the
 * implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReloadFromDisk } from '../../src/lib/diskVersion';

const base = (over: Partial<Parameters<typeof shouldReloadFromDisk>[0]> = {}) => ({
  diskUpdatedAt: 2000,
  baseUpdatedAt: 1000,
  ownWrites: [] as number[],
  ...over,
});

describe('shouldReloadFromDisk', () => {
  it('reloads when disk is newer and the write was not ours', () => {
    // The whole point. Without this returning true, 1.1 does not exist.
    assert.equal(shouldReloadFromDisk(base()), true);
  });

  // ── "cannot tell" is never "unchanged" ──────────────────────────────────
  //
  // fsStorage.readHeaderWindow returns null when updatedAt is outside the 4 KB
  // window or the file is absent, and its own doc says callers must not read
  // that as unchanged. Without these three, a route that stops sending the
  // field — or a log whose header grew past 4 KB — would read as "nothing ever
  // changes": a permanent, silent false negative with no symptom to notice.

  it('null version does not reload', () => {
    assert.equal(shouldReloadFromDisk(base({ diskUpdatedAt: null })), false);
  });

  it('absent version does not reload', () => {
    assert.equal(shouldReloadFromDisk(base({ diskUpdatedAt: undefined })), false);
  });

  it('NaN version does not reload', () => {
    // `Number(x)` on a malformed header gives NaN, and NaN > n is false — so
    // this would pass by accident. It is here so it passes by decision: a
    // later rewrite using `!(disk <= base)` would invert that accident.
    assert.equal(shouldReloadFromDisk(base({ diskUpdatedAt: NaN })), false);
  });

  it('Infinity is not a version', () => {
    assert.equal(shouldReloadFromDisk(base({ diskUpdatedAt: Infinity })), false);
  });

  // ── nothing loaded yet ─────────────────────────────────────────────────

  it('no base version does not reload', () => {
    // A tab that has not loaded a conversation has nothing on screen to
    // correct. Without this, `null` coerces to 0, every disk version is
    // "newer", and the first poll after mount always refetches the whole log.
    assert.equal(shouldReloadFromDisk(base({ baseUpdatedAt: null })), false);
  });

  // ── same, and older ────────────────────────────────────────────────────

  it('equal versions do not reload', () => {
    // The normal case, every ten seconds, for as long as a tab is open.
    // Without it this is a full-log fetch on a timer forever.
    assert.equal(shouldReloadFromDisk(base({ diskUpdatedAt: 1000 })), false);
  });

  it('an OLDER disk version does not reload', () => {
    // This tab is ahead of the file — the window between a local edit and its
    // save. Reloading would discard the edit. (ChatArea additionally refuses
    // while a save is in flight; this is the version-level half of the same
    // refusal.)
    assert.equal(shouldReloadFromDisk(base({ diskUpdatedAt: 999 })), false);
  });

  // ── our own write ──────────────────────────────────────────────────────

  it('does not reload a version this tab wrote', () => {
    // Normally redundant — a successful save sets baseUpdatedAt to what it
    // wrote. Kept because the two fail in different places: baseUpdatedAt is
    // one slot that a reload or a conversation switch can move, ownWrites is
    // the last sixteen and survives that. Without it, a tab whose base was
    // moved would reload its own save and, mid-stream, fight its own painter.
    assert.equal(shouldReloadFromDisk(base({ ownWrites: [1500, 2000] })), false);
  });

  it('recognises our write when it is the FIRST entry', () => {
    // Written while designing the mutation for this rule, which is how the
    // gap showed: every other case here has the match at a later index, so
    // `indexOf(x) > 0` would pass them all and lose only the newest write —
    // the one most likely to be the version on disk.
    assert.equal(shouldReloadFromDisk(base({ ownWrites: [2000, 1500] })), false);
  });

  it('a DIFFERENT write of ours does not excuse a foreign one', () => {
    // The check is membership, not "we have written at all". Without that
    // distinction, any tab that had ever saved would stop mirroring.
    assert.equal(shouldReloadFromDisk(base({ ownWrites: [1500, 1800] })), true);
  });

  it('ownWrites is read, not mutated', () => {
    // The caller passes ownWritesRef.current directly. A predicate that sorted
    // or spliced it would corrupt the 409 path's second line of defence.
    const own = [1500, 1800];
    shouldReloadFromDisk(base({ ownWrites: own }));
    assert.deepEqual(own, [1500, 1800]);
  });
});
