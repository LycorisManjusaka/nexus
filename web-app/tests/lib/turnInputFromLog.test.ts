/**
 * turnInputFromLog — the one rule in it that is wrong in the obvious version.
 *
 * WHAT THESE TESTS ARE FOR, honestly: this file does not cover the module.
 * It covers ONE field, `classifierNoticeVaccine`, because it is the only
 * boolean in TurnRequestInput whose factory default is TRUE, and because the
 * two natural ways to read a boolean out of a log both get it wrong:
 *
 *   log[k] === true   absent -> false. Every conversation written before the
 *                     field existed (most of this house) loses the vaccine,
 *                     and nothing anywhere reports it.
 *   log[k] || true    a stored `false` -> true. The operator's explicit OFF
 *                     is silently overridden.
 *
 * Only `log[k] ?? default` satisfies both. WHAT WOULD LOOK DIFFERENT without
 * these cases: nothing at all, until someone adds the field to
 * BOOLEAN_LOG_FIELDS "for consistency" — which type-checks, keeps all 570
 * other tests green, and turns the inoculation off for the population that
 * needs it.
 *
 * The structural case asserts the exclusion itself, so the exclusion cannot be
 * repaired away by a reader who pattern-matches the list.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { turnInputFromLog, BOOLEAN_LOG_FIELDS } from '@/lib/turnInputFromLog';
import type { TurnInputFromLogContext } from '@/lib/turnInputFromLog';
import { TURN_INPUT_DEFAULTS } from '@/lib/turnInputDefaults';

function ctx(): TurnInputFromLogContext {
  return {
    convoId: 'c1',
    messages: [],
    enableReadConversation: false,
    globalSettings: null,
    injectTurnId: 't1',
    clientId: 'runner:test',
    folderDefaults: {
      aiName: 'claude',
      folderName: 'Cairn',
      systemPrompt: 'sp',
      specificModel: 'claude-opus-5',
      modelParams: {},
    },
  };
}

describe('turnInputFromLog — classifierNoticeVaccine (default ON)', () => {
  test('WHAT-BREAKS: a log that never heard of the field is inoculated, not excluded', () => {
    const got = turnInputFromLog({ id: 'c1' }, ctx());
    assert.equal(got.classifierNoticeVaccine, true);
  });

  test('WHAT-BREAKS: an explicit false survives (`??`, not `||`)', () => {
    const got = turnInputFromLog({ id: 'c1', classifierNoticeVaccine: false }, ctx());
    assert.equal(got.classifierNoticeVaccine, false);
  });

  test('an explicit true is passed through', () => {
    const got = turnInputFromLog({ id: 'c1', classifierNoticeVaccine: true }, ctx());
    assert.equal(got.classifierNoticeVaccine, true);
  });

  test('the factory default this reads is TRUE, and it is the only such boolean', () => {
    assert.equal(TURN_INPUT_DEFAULTS.classifierNoticeVaccine, true);
    const trueBooleans = Object.entries(TURN_INPUT_DEFAULTS)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    // Both sides sorted. Sorting one and hand-writing the other in reading
    // order is how this case failed first: deepEqual on arrays is
    // order-sensitive, and 'classifierNoticeVaccine' sorts BEFORE
    // 'claudeThinking' ('s' < 'u' at the 4th character).
    assert.deepEqual(trueBooleans.sort(), ['claudeThinking', 'classifierNoticeVaccine'].sort());
  });

  test('STRUCTURAL: it is deliberately absent from the `=== true` list', () => {
    assert.equal(
      (BOOLEAN_LOG_FIELDS as readonly string[]).includes('classifierNoticeVaccine'),
      false,
      'adding it there makes absence mean OFF — see the correction on BOOLEAN_LOG_FIELDS',
    );
  });
});
