/**
 * agentCapabilities — the fold that stopped the UI from claiming a confinement
 * the shell walks straight through.
 *
 * NEW TEST, written 2026-10-27. No probe existed. This is four lines of product
 * code carrying a safety claim, and the distinction it encodes (SAVED vs
 * EFFECTIVE) is exactly the kind a refactor "simplifies" away: writing the
 * folded value into settings.json would leave full access silently ON after the
 * shell is turned back off — a permission the operator never granted, made
 * permanent by a fix meant to stop lying.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFullAccess, fullAccessForcedByShell } from '../../src/lib/agentCapabilities';

describe('effectiveFullAccess', () => {
  it('is ON when the operator asked for it', () => {
    assert.equal(effectiveFullAccess(true, false), true);
  });

  it('is ON when the shell is enabled, whatever the checkbox says', () => {
    // The shell runs `bash -c <anything>` with no sandbox on all four provider
    // paths. Reporting anything narrower would be a label that does not
    // describe the system.
    assert.equal(effectiveFullAccess(false, true), true);
  });

  it('is OFF only when neither is set', () => {
    assert.equal(effectiveFullAccess(false, false), false);
  });

  it('coerces truthy/falsy stored values to booleans', () => {
    assert.equal(effectiveFullAccess(undefined as never, undefined as never), false);
    assert.equal(effectiveFullAccess(null as never, 1 as never), true);
  });
});

describe('fullAccessForcedByShell — so the UI can say WHY', () => {
  it('is true only when the shell is the thing setting it', () => {
    assert.equal(fullAccessForcedByShell(false, true), true);
  });

  it('is false when the operator set it themselves', () => {
    // Then the control is theirs to move; it must not render as locked.
    assert.equal(fullAccessForcedByShell(true, true), false);
  });

  it('is false when nothing forces it', () => {
    assert.equal(fullAccessForcedByShell(false, false), false);
    assert.equal(fullAccessForcedByShell(true, false), false);
  });
});

describe('the two together — saved state is never overwritten', () => {
  it('turning the shell off restores the operator original answer', () => {
    const saved = false; // what the operator chose, stored as-is
    assert.equal(effectiveFullAccess(saved, true), true, 'shell on: effective ON');
    assert.equal(effectiveFullAccess(saved, false), false, 'shell off: back to OFF');
  });
});
