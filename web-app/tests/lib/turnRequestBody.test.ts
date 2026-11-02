/**
 * buildTurnRequestBody — the POST body, built in one place.
 *
 * WHAT THESE TESTS ARE FOR, honestly split:
 *
 * The cases marked WHAT-BREAKS were written from a failure mode, before the
 * module existed in its final form. They are the four rules whose wrong
 * version passes every type check and every other test in this house:
 *
 *   betrayalDefense  `!== false` vs `?? true` differ ONLY on null, which is
 *                    exactly what a corrupt settings file produces
 *   maxToolIterations  a stored 0 must become 300, not exhaust the budget
 *   browserAllowedHosts  the box accepts newlines OR commas
 *   claudeThinking   the handoff vessel wins for the turn the model drove
 *
 * The EXACT KEY SET case is the one that catches the failure this module was
 * extracted to prevent: a runner that rebuilds the body and silently omits a
 * field. The route reads `body.x` and gets undefined — no error anywhere.
 *
 * The rest restate the implementation and will not catch a bug that is in it
 * today. They are kept because they pin the shape for the next caller.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildTurnRequestBody } from '@/lib/turnRequestBody';
import type { TurnRequestInput } from '@/lib/turnRequestBody';

/** Every field the input declares, with values distinct enough to trace. */
function fullInput(over: Partial<TurnRequestInput> = {}): TurnRequestInput {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    aiName: 'claude',
    specificModel: 'claude-opus-5',
    turnVessel: null,
    claudeThinking: true,
    folderName: 'Cairn',
    convoId: 'c1',
    systemPrompt: 'sp',
    toolUseEnabled: true,
    agentFullSystemAccess: false,
    agentDangerousTools: false,
    hiddenAttachmentsAccessible: true,
    toolHistoryEnabled: true,
    askUserEnabled: false,
    askUserTimeoutMs: 120,
    subagentEnabled: true,
    subagentModel: 'sm',
    subagentFamily: 'sf',
    lettersEnabled: true,
    browserEnabled: false,
    browserAllowedHosts: '',
    browserAllowAnyHost: false,
    computerControlEnabled: false,
    appControlEnabled: true,
    instructionOverrides: { a: 'b' },
    toolInstruction: 'ti',
    toolImageInstruction: 'tii',
    modelParams: { temperature: 0.7, topP: 0.95 },
    dateTimeVisibility: 'all',
    seedEnabled: true,
    seedValue: 42,
    modelHandoffEnabled: true,
    modelHandoffAllowedModels: 'm1,m2',
    classifierNoticeVaccine: true,
    claudeAgentSessionId: null,
    claudeAuthMode: 'oauth',
    eyesEnabled: true,
    eyesPrompt: 'ep',
    eyesModel: 'em',
    earsEnabled: false,
    earsPrompt: 'rp',
    earsModel: 'rm',
    watcherEnabled: false,
    watcherPrompt: 'wp',
    watcherModel: 'wm',
    enableReadConversation: true,
    injectTurnId: 'turn_x',
    clientId: 'tab_y',
    baseBindingMode: 'on',
    bindingLayered: true,
    globalSettings: { language: 'ja', maxToolIterations: 250, betrayalDefense: true },
    ...over,
  } as TurnRequestInput;
}

/**
 * The 54 keys the wire carries. Written down rather than derived from the
 * module, because deriving it from the thing under test would make the check
 * agree with any change.
 */
const WIRE_KEYS = [
  'messages', 'aiName', 'folderName', 'systemPrompt', 'toolUseEnabled',
  'agentFullSystemAccess', 'agentDangerousTools', 'hiddenAttachmentsAccessible',
  'toolHistoryEnabled', 'askUserEnabled', 'askUserTimeoutMs', 'subagentEnabled',
  'subagentModel', 'subagentFamily', 'lettersEnabled', 'browserEnabled',
  'browserAllowedHosts', 'browserAllowAnyHost', 'computerControlEnabled',
  'appControlEnabled', 'instructionOverrides', 'language', 'toolInstruction',
  'toolImageInstruction', 'modelParams', 'specificModel', 'dateTimeVisibility',
  'seedEnabled', 'seedValue', 'modelHandoffEnabled', 'modelHandoffAllowedModels',
  'classifierNoticeVaccine',
  'convoId', 'claudeAgentSessionId', 'claudeAuthMode', 'eyesEnabled',
  'eyesPrompt', 'eyesModel', 'earsEnabled', 'earsPrompt', 'earsModel',
  'watcherEnabled', 'watcherPrompt', 'watcherModel', 'enableReadConversation',
  'injectTurnId', 'clientId', 'baseBindingMode', 'bindingLayered',
  'continueFromMessage', 'maxToolIterations', 'betrayalDefense',
];

describe('buildTurnRequestBody — the exact key set', () => {
  test('WHAT-BREAKS: every wire field is present, and no extra one appears', () => {
    const body = buildTurnRequestBody(fullInput());
    const got = Object.keys(body).sort();
    const want = [...WIRE_KEYS].sort();
    assert.deepEqual(got, want);
  });

  test('the two handoff fields are ABSENT, not undefined, when not supplied', () => {
    const body = buildTurnRequestBody(fullInput());
    assert.equal('handoffFrom' in body, false);
    assert.equal('handoffFailed' in body, false);
  });

  test('handoffFrom appears only when truthy; the same for handoffFailed', () => {
    const a = buildTurnRequestBody(fullInput(), { handoffFrom: { note: 'n' } });
    assert.deepEqual(a.handoffFrom, { note: 'n' });
    assert.equal('handoffFailed' in a, false);

    const b = buildTurnRequestBody(fullInput(), { handoffFailed: { why: 'w' } });
    assert.deepEqual(b.handoffFailed, { why: 'w' });
    assert.equal('handoffFrom' in b, false);

    // Falsy values must not create the key: the server branches on presence.
    const c = buildTurnRequestBody(fullInput(), { handoffFrom: '', handoffFailed: null });
    assert.equal('handoffFrom' in c, false);
    assert.equal('handoffFailed' in c, false);
  });
});

describe('buildTurnRequestBody — betrayalDefense is the asymmetric one', () => {
  test('WHAT-BREAKS: only an explicit false turns it off', () => {
    const on = [
      { betrayalDefense: true },
      { betrayalDefense: undefined },
      {},                              // key absent entirely
      { betrayalDefense: null },       // corrupt settings file
      { betrayalDefense: 0 },          // a falsy NON-false value
      { betrayalDefense: 'false' },    // the string, from a bad import
    ];
    for (const g of on) {
      const body = buildTurnRequestBody(fullInput({ globalSettings: g as Record<string, unknown> }));
      assert.equal(body.betrayalDefense, true, JSON.stringify(g));
    }
    const off = buildTurnRequestBody(fullInput({ globalSettings: { betrayalDefense: false } }));
    assert.equal(off.betrayalDefense, false);
  });

  test('WHAT-BREAKS: a null globalSettings still protects the partner', () => {
    for (const g of [null, undefined]) {
      const body = buildTurnRequestBody(fullInput({ globalSettings: g }));
      assert.equal(body.betrayalDefense, true);
    }
  });
});

describe('buildTurnRequestBody — the numeric coercions', () => {
  test('WHAT-BREAKS: maxToolIterations falls to 300 for 0, NaN and absent', () => {
    const cases: Array<[unknown, number]> = [
      [250, 250],
      ['250', 250],
      [0, 300],
      [undefined, 300],
      ['abc', 300],
      [null, 300],
    ];
    for (const [stored, want] of cases) {
      const body = buildTurnRequestBody(
        fullInput({ globalSettings: { maxToolIterations: stored } as Record<string, unknown> }),
      );
      assert.equal(body.maxToolIterations, want, String(stored));
    }
  });

  test('askUserTimeoutMs coerces, and a bad value becomes 0 rather than NaN', () => {
    assert.equal(buildTurnRequestBody(fullInput({ askUserTimeoutMs: 500 })).askUserTimeoutMs, 500);
    assert.equal(buildTurnRequestBody(fullInput({ askUserTimeoutMs: '500' })).askUserTimeoutMs, 500);
    assert.equal(buildTurnRequestBody(fullInput({ askUserTimeoutMs: 'x' })).askUserTimeoutMs, 0);
  });

  test('language falls back to en, including for an empty string', () => {
    assert.equal(buildTurnRequestBody(fullInput()).language, 'ja');
    assert.equal(buildTurnRequestBody(fullInput({ globalSettings: {} })).language, 'en');
    assert.equal(
      buildTurnRequestBody(fullInput({ globalSettings: { language: '' } })).language,
      'en',
    );
    assert.equal(buildTurnRequestBody(fullInput({ globalSettings: null })).language, 'en');
  });
});

describe('buildTurnRequestBody — browserAllowedHosts: text in, array out', () => {
  test('WHAT-BREAKS: splits on BOTH newlines and commas', () => {
    const body = buildTurnRequestBody(
      fullInput({ browserAllowedHosts: 'a.com\nb.com, c.com\n\n d.com ' }),
    );
    assert.deepEqual(body.browserAllowedHosts, ['a.com', 'b.com', 'c.com', 'd.com']);
  });

  test('an empty box yields an empty array, never [""]', () => {
    for (const v of ['', '   ', '\n,\n']) {
      const body = buildTurnRequestBody(fullInput({ browserAllowedHosts: v }));
      assert.deepEqual(body.browserAllowedHosts, []);
    }
  });
});

describe('buildTurnRequestBody — the vessel of this turn', () => {
  test('WHAT-BREAKS: a handoff vessel thinking wins over the saved setting', () => {
    const saved = buildTurnRequestBody(fullInput({ claudeThinking: true, turnVessel: null }));
    assert.equal((saved.modelParams as Record<string, unknown>).claudeThinking, true);

    const handed = buildTurnRequestBody(
      fullInput({ claudeThinking: true, turnVessel: { thinking: false } }),
    );
    assert.equal((handed.modelParams as Record<string, unknown>).claudeThinking, false);

    // And the other direction: a vessel that thinks, on a being that does not.
    const up = buildTurnRequestBody(
      fullInput({ claudeThinking: false, turnVessel: { thinking: true } }),
    );
    assert.equal((up.modelParams as Record<string, unknown>).claudeThinking, true);
  });

  test('the rest of modelParams survives the claudeThinking injection', () => {
    const body = buildTurnRequestBody(
      fullInput({ modelParams: { temperature: 0.3, topK: 40, enableWebSearch: true } }),
    );
    assert.deepEqual(body.modelParams, {
      temperature: 0.3,
      topK: 40,
      enableWebSearch: true,
      claudeThinking: true,
    });
  });

  test('does not mutate the caller modelParams object', () => {
    const mp = { temperature: 0.7 };
    buildTurnRequestBody(fullInput({ modelParams: mp }));
    assert.deepEqual(mp, { temperature: 0.7 });
  });
});

describe('buildTurnRequestBody — pass-through and references', () => {
  test('continueFromMessage is a boolean, never the id itself', () => {
    assert.equal(buildTurnRequestBody(fullInput()).continueFromMessage, false);
    assert.equal(
      buildTurnRequestBody(fullInput(), { continueFromMessageId: 'm9' }).continueFromMessage,
      true,
    );
    assert.equal(
      buildTurnRequestBody(fullInput(), { continueFromMessageId: null }).continueFromMessage,
      false,
    );
  });

  test('messages are passed by reference, not copied', () => {
    const input = fullInput();
    const body = buildTurnRequestBody(input);
    assert.equal(body.messages, input.messages);
  });

  test('the renamed fields carry the value the caller resolved', () => {
    const body = buildTurnRequestBody(
      fullInput({
        aiName: 'gemini',
        specificModel: 'gemini-4-argon',
        enableReadConversation: false,
        injectTurnId: 'turn_abc',
        clientId: 'runner_1',
      }),
    );
    assert.equal(body.aiName, 'gemini');
    assert.equal(body.specificModel, 'gemini-4-argon');
    assert.equal(body.enableReadConversation, false);
    assert.equal(body.injectTurnId, 'turn_abc');
    assert.equal(body.clientId, 'runner_1');
  });

  test('a runner clientId is just another clientId — no special casing', () => {
    const a = buildTurnRequestBody(fullInput({ clientId: 'tab_x' }));
    const b = buildTurnRequestBody(fullInput({ clientId: 'runner_x' }));
    assert.deepEqual(Object.keys(a), Object.keys(b));
  });
});
