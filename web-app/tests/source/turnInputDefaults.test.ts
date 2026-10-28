/**
 * SOURCE-TREE PROPERTY: every log-readable turn field has exactly one answer
 * to "what if the saved log does not carry it?", and ChatArea asks this module
 * for it rather than carrying its own literal.
 *
 * WHY A GATE AND NOT A COMMENT
 *
 * Measured (p50): of 302 conversation logs in this house, 258 are missing at
 * least one field that POST /api/chat sends. That is not corruption — fields
 * were added after those conversations were written. The browser opens them
 * anyway because `useState` quietly supplies a default.
 *
 * A runner (phase 4b) has no `useState`. If a field is added to
 * TurnRequestInput and nobody gives it a default, the runner sends `undefined`
 * and the server coerces it — silently, for every old conversation, and ONLY
 * for turns nobody is watching. That is the failure this file exists to make
 * loud at commit time.
 *
 * WHAT IT CHECKS
 *   1. COVERAGE — each log-readable field of TurnRequestInput appears either
 *      in TURN_INPUT_DEFAULTS or in SUPPLIED_BY_CALLER. Never neither.
 *   2. NO OVERLAP — a field with a default is not also "supplied by caller",
 *      which would make it unclear which one wins.
 *   3. NO RE-INLINE — ChatArea's useState initialiser for each defaulted
 *      field reads `TURN_INPUT_DEFAULTS.<field>`. A future edit that pastes a
 *      literal back in would re-create the second copy this module removed,
 *      and nothing else in the toolchain can see that.
 *
 * SCOPE, stated rather than implied:
 *   • The field list is parsed from the TurnRequestInput interface text, not
 *     from a hand-kept array here. A hand-kept array is the thing that goes
 *     stale, and it goes stale in the direction that passes.
 *   • EXTERNALLY_SOURCED below is the one hand-kept list: the fields that do
 *     not come from the log at all. Each entry names its source, and the
 *     turnRequestBody header carries the measurement (p47).
 *   • It says nothing about whether a default VALUE is right. Only that
 *     exactly one place answers for it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { TURN_INPUT_DEFAULTS, SUPPLIED_BY_CALLER } from '../../src/lib/turnInputDefaults';

const TRB = path.join(process.cwd(), 'src', 'lib', 'turnRequestBody.ts');
const CA = path.join(process.cwd(), 'src', 'components', 'ChatArea.tsx');

/**
 * Fields that are NOT read from the conversation log. Measured in p47 and
 * recorded in the turnRequestBody header; repeated here because this file has
 * to subtract them from the interface to get the log-readable set.
 */
const EXTERNALLY_SOURCED = new Set([
  'messages',              // built by buildSlimHistory
  'globalSettings',        // global settings
  'enableReadConversation',// FOLDER settings, not the conversation
  'bindingLayered',        // derived: hasLayerStructure(systemPrompt)
  'convoId',               // the queue item / the log's own id
  'injectTurnId',          // this turn
  'clientId',              // the tab or the runner
  'turnVessel',            // non-null only during a change_model handoff
]);

function interfaceFieldNames(src: string, name: string): string[] {
  const decl = src.indexOf(`export interface ${name}`);
  assert.ok(decl >= 0, `${name} not found`);
  const lines = src.slice(decl).split('\n');
  const out: string[] = [];
  // The interface ends at the first line that is exactly '}'.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '}') break;
    const m = /^ {2}([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(lines[i]);
    if (m) out.push(m[1]);
  }
  return out;
}

describe('source tree: every log-readable turn field has one default owner', () => {
  const trb = fs.readFileSync(TRB, 'utf8');
  const all = interfaceFieldNames(trb, 'TurnRequestInput');

  it('parsed the interface (guards against a silently empty check)', () => {
    // A parse that yields nothing would make every assertion below vacuous.
    assert.ok(all.length > 40, `parsed only ${all.length} fields`);
    for (const k of EXTERNALLY_SOURCED) {
      assert.ok(all.includes(k), `EXTERNALLY_SOURCED names ${k}, which is not a field`);
    }
  });

  it('WHAT-BREAKS: no field is left without an answer', () => {
    const defaulted = new Set(Object.keys(TURN_INPUT_DEFAULTS));
    const supplied = new Set<string>(SUPPLIED_BY_CALLER);
    const orphans = all.filter(
      f => !EXTERNALLY_SOURCED.has(f) && !defaulted.has(f) && !supplied.has(f),
    );
    assert.deepEqual(
      orphans,
      [],
      'these wire fields have no default and no named caller: ' + orphans.join(', '),
    );
  });

  it('a field is never both defaulted and caller-supplied', () => {
    const both = SUPPLIED_BY_CALLER.filter(f => f in TURN_INPUT_DEFAULTS);
    assert.deepEqual(both, []);
  });

  it('every caller-supplied name is a real field', () => {
    for (const f of SUPPLIED_BY_CALLER) {
      assert.ok(all.includes(f), `${f} is not a TurnRequestInput field`);
    }
  });

  it('every defaulted name is a real field', () => {
    for (const f of Object.keys(TURN_INPUT_DEFAULTS)) {
      assert.ok(all.includes(f), `${f} is not a TurnRequestInput field`);
    }
  });
});

describe('source tree: ChatArea does not keep its own copy of a default', () => {
  const ca = fs.readFileSync(CA, 'utf8');

  it('found the component (guards against a silently empty check)', () => {
    assert.ok(ca.length > 100000, 'ChatArea.tsx looks wrong');
    assert.ok(
      ca.includes("from '@/lib/turnInputDefaults'"),
      'ChatArea does not import the defaults at all',
    );
  });

  it('WHAT-BREAKS: each defaulted field initialises FROM this module', () => {
    const reinlined: string[] = [];
    for (const f of Object.keys(TURN_INPUT_DEFAULTS)) {
      // Anchor on the declaration, then require the reference inside the
      // useState call. Matching the whole statement (rather than just
      // grepping for the reference anywhere) is what catches a literal pasted
      // back into the initialiser while the import still exists elsewhere.
      const re = new RegExp(
        'const\\s*\\[\\s*' + f + '\\s*,\\s*set[A-Za-z0-9_]*\\s*\\]\\s*=\\s*' +
          'useState\\s*(?:<[^(]*>)?\\(\\s*TURN_INPUT_DEFAULTS\\.' + f + '\\s*\\)',
      );
      if (!re.test(ca)) reinlined.push(f);
    }
    assert.deepEqual(
      reinlined,
      [],
      'these useState calls no longer read the shared default: ' + reinlined.join(', '),
    );
  });
});
