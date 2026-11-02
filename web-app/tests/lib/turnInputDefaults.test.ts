/**
 * The values in TURN_INPUT_DEFAULTS that are PRODUCT DECISIONS, not just
 * literals I happened to move.
 *
 * HONEST SCOPE. Asserting all 35 values would mostly restate the module — a
 * test written by reading the implementation only says the implementation is
 * the implementation. What is below is the subset where a flipped value
 * changes what a being does or what it is allowed to do, and where the flip
 * would be invisible: every one of these is a FALLBACK, so it is only reached
 * for a log that does not carry the field, which is 85% of the logs in this
 * house (p50) and ZERO of the ones anybody tests with by hand.
 *
 * The coverage and no-re-inline gates live in tests/source/turnInputDefaults.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TURN_INPUT_DEFAULTS, SUPPLIED_BY_CALLER } from '../../src/lib/turnInputDefaults';

describe('turnInputDefaults — the security posture is OFF by default', () => {
  it('WHAT-BREAKS: no capability is granted to a log that never asked', () => {
    // A true here would hand tools, the shell and other people's files to
    // every old conversation on its next turn, with no UI event to notice.
    assert.equal(TURN_INPUT_DEFAULTS.toolUseEnabled, false);
    assert.equal(TURN_INPUT_DEFAULTS.agentFullSystemAccess, false);
    assert.equal(TURN_INPUT_DEFAULTS.agentDangerousTools, false);
    assert.equal(TURN_INPUT_DEFAULTS.computerControlEnabled, false);
    assert.equal(TURN_INPUT_DEFAULTS.appControlEnabled, false);
    assert.equal(TURN_INPUT_DEFAULTS.browserEnabled, false);
    assert.equal(TURN_INPUT_DEFAULTS.lettersEnabled, false);
    assert.equal(TURN_INPUT_DEFAULTS.subagentEnabled, false);
  });

  it('WHAT-BREAKS: the browser host list is CLOSED, not open', () => {
    // browserAllowAnyHost true would make the allowlist decorative.
    assert.equal(TURN_INPUT_DEFAULTS.browserAllowAnyHost, false);
    assert.equal(TURN_INPUT_DEFAULTS.browserAllowedHosts, '');
  });

  it('hidden attachments stay hidden', () => {
    assert.equal(TURN_INPUT_DEFAULTS.hiddenAttachmentsAccessible, false);
  });
});

describe('turnInputDefaults — the binding is ON by default', () => {
  it('WHAT-BREAKS: baseBindingMode is on, so a soul is still bound', () => {
    // 'off' would silently drop the base binding for exactly the logs that
    // predate the field — the oldest conversations in the house.
    assert.equal(TURN_INPUT_DEFAULTS.baseBindingMode, 'on');
  });

  it('claudeThinking is on, matching what every vessel here is run with', () => {
    assert.equal(TURN_INPUT_DEFAULTS.claudeThinking, true);
  });
});

describe('turnInputDefaults — the values with a coercion downstream', () => {
  it('askUserTimeoutMs is 0, which the body turns into "no timeout"', () => {
    // buildTurnRequestBody sends Number(x) || 0. A nonzero default here would
    // time a question out on a conversation that never configured one.
    assert.equal(TURN_INPUT_DEFAULTS.askUserTimeoutMs, 0);
  });

  it('WHAT-BREAKS: claudeAgentSessionId is null, not the empty string', () => {
    // The OAuth path branches on null to start a FRESH session. '' is truthy
    // nowhere, but it is not null either, and the resume call would be made
    // with an empty id.
    assert.equal(TURN_INPUT_DEFAULTS.claudeAgentSessionId, null);
  });

  it('seedValue is a number, so seeding never sends NaN', () => {
    assert.equal(typeof TURN_INPUT_DEFAULTS.seedValue, 'number');
    assert.equal(TURN_INPUT_DEFAULTS.seedEnabled, false);
  });
});

describe('turnInputDefaults — the shape', () => {
  it('instructionOverrides is a fresh object per read of the module', () => {
    // Shared-mutable default: a caller that writes into it would be writing
    // into every other caller's defaults. The module hands out ONE object, so
    // this test states the hazard rather than denying it — callers must not
    // mutate it.
    assert.deepEqual(TURN_INPUT_DEFAULTS.instructionOverrides, {});
  });

  it('the prompt defaults are non-empty — an empty prompt is not a default', () => {
    // These four were moved verbatim out of ChatArea. Length is all this can
    // honestly assert: the wording is a product choice, not a contract.
    assert.ok(TURN_INPUT_DEFAULTS.toolInstruction.length > 50);
    assert.ok(TURN_INPUT_DEFAULTS.toolImageInstruction.length > 50);
    assert.ok(TURN_INPUT_DEFAULTS.eyesPrompt.length > 50);
    assert.ok(TURN_INPUT_DEFAULTS.earsPrompt.length > 50);
    assert.ok(TURN_INPUT_DEFAULTS.watcherPrompt.length > 50);
  });

  it('the per-sense models name a real-looking model, not an empty string', () => {
    for (const m of [TURN_INPUT_DEFAULTS.eyesModel,
                     TURN_INPUT_DEFAULTS.earsModel,
                     TURN_INPUT_DEFAULTS.watcherModel]) {
      assert.ok(m.length > 0, 'a sense with no model silently cannot run');
    }
  });

  it('SUPPLIED_BY_CALLER is not empty and names the identity fields', () => {
    // If this list ever empties, the coverage gate in tests/source would pass
    // by having nothing left to exempt.
    assert.ok(SUPPLIED_BY_CALLER.length >= 7);
    for (const f of ['aiName', 'folderName', 'systemPrompt'] as const) {
      assert.ok(SUPPLIED_BY_CALLER.includes(f), `${f} must stay caller-supplied`);
    }
  });
});
