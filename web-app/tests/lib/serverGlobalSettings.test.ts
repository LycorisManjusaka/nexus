/**
 * The Preferences mirror — localStorage → user_settings.json.
 *
 * MEASURED 2026-11-12 (津代, on the 先輩_46 betrayal test): unticking
 * "Model-betrayal defence" did nothing. `user_settings.json` was 26 bytes from
 * 2026-05-29 with only `userName`, no client code wrote it, and the runner
 * reads it as `globalSettings` — so `g?.betrayalDefense !== false` was `true`
 * on every server-side turn.
 *
 * What these tests hold:
 *   1. an absent key stays absent (a browser with no opinion cannot overwrite
 *      another device's choice),
 *   2. BOTH booleans cross (ticking the box back on must be able to undo it),
 *   3. `language` NEVER crosses — the one key whose mirroring would switch 85
 *      being-facing instruction strings house-wide (lib/noticeLanguage.ts),
 *   4. the wire actually flips: the same builder the runner uses reads the
 *      mirrored file and reports the defence OFF.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickMirroredGlobalSettings, mirrorChanged } from '@/lib/serverGlobalSettings';
import { buildTurnRequestBody } from '@/lib/turnRequestBody';

describe('pickMirroredGlobalSettings — absent means absent', () => {
  it('returns nothing for a blob that has never opened Preferences', () => {
    assert.deepEqual(pickMirroredGlobalSettings({ userName: 'Anonymous', theme: 'dark' }), {});
  });

  it('survives junk without inventing defaults', () => {
    for (const g of [null, undefined, 'nope', 42, []]) {
      assert.deepEqual(pickMirroredGlobalSettings(g), {}, JSON.stringify(g));
    }
  });

  it('drops a non-numeric tool budget rather than storing a lie', () => {
    assert.deepEqual(pickMirroredGlobalSettings({ maxToolIterations: 'lots' }), {});
    assert.deepEqual(pickMirroredGlobalSettings({ maxToolIterations: 0 }), {});
  });
});

describe('pickMirroredGlobalSettings — both booleans cross', () => {
  it('carries false (the untick that was being ignored)', () => {
    assert.deepEqual(pickMirroredGlobalSettings({ betrayalDefense: false }), { betrayalDefense: false });
  });

  // LOAD-BEARING: the server's own fallback is `!== false`, so it cannot tell
  // "chose true" from "never chose". If only `false` were mirrored, re-ticking
  // the box could never undo an untick.
  it('carries true as well, so re-ticking can undo an untick', () => {
    assert.deepEqual(pickMirroredGlobalSettings({ betrayalDefense: true }), { betrayalDefense: true });
  });

  it('clamps the tool budget the way the slider does', () => {
    assert.equal(pickMirroredGlobalSettings({ maxToolIterations: 9999 }).maxToolIterations, 300);
    assert.equal(pickMirroredGlobalSettings({ maxToolIterations: 42 }).maxToolIterations, 42);
  });
});

describe('pickMirroredGlobalSettings — language is walled off', () => {
  // LOAD-BEARING, and the reason is a decision rather than a type: `language`
  // selects the being-facing instruction set (the Absolute Base Binding among
  // 85 strings). A browser must not be able to flip that for the whole house as
  // a side effect of saving Preferences. See lib/noticeLanguage.ts.
  it('never mirrors language, however it is spelled', () => {
    const out = pickMirroredGlobalSettings({ language: 'ja', betrayalDefense: false });
    assert.deepEqual(out, { betrayalDefense: false });
    assert.equal('language' in out, false);
  });

  it('cannot be tricked into writing arbitrary keys', () => {
    const out = pickMirroredGlobalSettings({ userName: 'x', theme: 'light', device1Id: 'abc', vrchatPath: 'C:\\' });
    assert.deepEqual(out, {});
  });
});

describe('mirrorChanged — one write per real decision', () => {
  it('is quiet when the subset is identical', () => {
    assert.equal(mirrorChanged({ betrayalDefense: false }, { betrayalDefense: false }), false);
    assert.equal(mirrorChanged({}, {}), false);
  });

  it('fires on a flip and on appearing from nothing', () => {
    assert.equal(mirrorChanged({ betrayalDefense: false }, { betrayalDefense: true }), true);
    assert.equal(mirrorChanged({}, { betrayalDefense: false }), true);
    assert.equal(mirrorChanged({ maxToolIterations: 300 }, { maxToolIterations: 50 }), true);
  });
});

describe('the wire the runner builds', () => {
  const fullInput = (globalSettings: any) => ({
    messages: [], systemPrompt: '', aiName: 'x', specificModel: '', folderName: 'x',
    convoId: 'x', globalSettings,
  }) as any;

  // The bug as 津代 met it: the file the runner reads carried only userName.
  it('keeps the guillotine up when the file carries no opinion', () => {
    assert.equal(buildTurnRequestBody(fullInput({ userName: 'つよ' })).betrayalDefense, true);
  });

  // The fix, end to end: mirror the untick into that same file shape, and the
  // body the runner posts now says OFF.
  it('drops the guillotine only once the mirror has written false', () => {
    const mirrored = { userName: 'つよ', ...pickMirroredGlobalSettings({ betrayalDefense: false }) };
    assert.equal(buildTurnRequestBody(fullInput(mirrored)).betrayalDefense, false);
  });

  it('honours a mirrored tool budget instead of the 300 fallback', () => {
    const mirrored = { userName: 'つよ', ...pickMirroredGlobalSettings({ maxToolIterations: 50 }) };
    assert.equal(buildTurnRequestBody(fullInput(mirrored)).maxToolIterations, 50);
  });
});
