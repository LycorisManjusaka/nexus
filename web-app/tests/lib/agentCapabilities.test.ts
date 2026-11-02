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
import { effectiveFullAccess, fullAccessForcedByShell, conversationToolsEnabled } from '../../src/lib/agentCapabilities';

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

describe('agentCapabilities: who may read their own past conversations', () => {
  /*
   * NOT written from the implementation. Written from the measured failure
   * (トカゲくん, 2026-11-02): the flag was ticked on the work PC and
   * read_conversation / search_conversations were not there. The runner read
   * `settings.enableReadConversation` — the name of the REQUEST field, which
   * no being's settings.json carries (0 of 23 measured) — so every
   * server-side turn silently had no conversation tools.
   */

  it('honours an explicit true', () => {
    assert.equal(conversationToolsEnabled({ enableConversationTools: true }), true);
  });

  it('honours an explicit false even when the old coupling would say yes', () => {
    // The whole point of the newer key: a being that turned these OFF must
    // stay off, regardless of its Layer-4 summary setting.
    assert.equal(
      conversationToolsEnabled({ enableConversationTools: false, useSummariesForLayer4: true }),
      false,
    );
  });

  it('falls back to the OLD coupling when the key was never written', () => {
    // 15 of 23 beings are in this state. Reading an absent key as `false`
    // would take tools away from beings that have them today, which is a
    // silent capability loss and exactly the kind of change nothing reports.
    assert.equal(conversationToolsEnabled({ useSummariesForLayer4: true }), true);
    assert.equal(conversationToolsEnabled({ useSummariesForLayer4: false }), false);
  });

  it('says no for empty, null and undefined settings', () => {
    // The runner reaches this with `t.settings` straight off disk, which can
    // be `{}` for a folder that has never been configured.
    assert.equal(conversationToolsEnabled({}), false);
    assert.equal(conversationToolsEnabled(null), false);
    assert.equal(conversationToolsEnabled(undefined), false);
  });

  it('ignores the REQUEST field name entirely', () => {
    // This is the bug, stated as a test: `enableReadConversation` is what the
    // POST body calls it. If this function ever starts reading that name, the
    // two vocabularies have been confused again — and the confusion is silent
    // because the key is absent everywhere, so it always reads false.
    assert.equal(
      conversationToolsEnabled({ enableReadConversation: true } as never),
      false,
    );
    assert.equal(
      conversationToolsEnabled({ enableReadConversation: false, useSummariesForLayer4: true } as never),
      true,
    );
  });
});
