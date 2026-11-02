/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): no server-side caller reads
 * a FOLDER-SETTINGS key that no being's settings.json carries.
 *
 * REGRESSION 2026-11-02, reported by トカゲくん from the work PC: the
 * conversation-tools flag was ticked and `read_conversation` /
 * `search_conversations` were not there. The runner read
 * `t.settings.enableReadConversation` — which is the name of the POST BODY
 * field, not of the stored setting. The UI writes
 * `settings.enableConversationTools`. Measured the same day: 0 of 23 beings
 * have the former, 8 have the latter and 15 are answered by its fallback.
 *
 * The line that translated between the two vocabularies lived in the browser
 * turn engine and was deleted with it (`524e1c3`, 764 lines) — the third
 * regression of that family after F76 (the first-original marker) and the
 * audio-session autoPlay.
 *
 * WHY A SOURCE TEST. The failure is silent by construction: an absent key
 * reads `undefined`, `undefined === true` is `false`, and "no tools" is a
 * perfectly ordinary answer. Nothing throws, nothing logs, no type complains,
 * and the UI keeps showing the tick the operator set. There is no behavioural
 * assertion that can fail, because the behaviour IS "false" — correctly
 * computed from the wrong question.
 *
 * SCOPE, stated rather than implied:
 *   • Reads TEXT, and only the two server-side files that resolve folder
 *     settings for a turn. It cannot see a third file added later.
 *   • Pins NAMES. A rename of the setting breaks it, which is intended: the
 *     name is the contract, and a rename should make someone read this.
 *   • Does NOT check local_data. A test that read the real store would pass or
 *     fail depending on whose machine it runs on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const FILES = [
  path.join(process.cwd(), 'src', 'app', 'api', 'runner', 'tick', 'route.ts'),
  path.join(process.cwd(), 'src', 'lib', 'runTurnForQueue.ts'),
];

/**
 * Keys that are REQUEST-body names and must never be read off folder settings.
 * Add to this list when a new pair of vocabularies appears; each entry is a
 * bug that was shipped once.
 */
const REQUEST_ONLY_KEYS = ['enableReadConversation'];

describe('source — folder settings are read by their stored names', () => {
  for (const key of REQUEST_ONLY_KEYS) {
    it(`no server-side caller reads settings.${key}`, () => {
      for (const file of FILES) {
        const src = fs.readFileSync(file, 'utf-8');
        // Strip comments first: this very fix documents the old line inside a
        // ⚠ block, and a test that matched its own explanation would fail on
        // the commit that fixes the bug.
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((l) => !l.trim().startsWith('//'))
          .join('\n');
        const needle = new RegExp(`settings\\s*\\.\\s*${key}\\b`);
        assert.equal(
          needle.test(code),
          false,
          `${path.basename(file)} reads settings.${key}; that key exists in no being's settings.json`,
        );
      }
    });
  }

  it('the runner resolves conversation tools through the shared rule', () => {
    // The positive half: not reading the wrong name is not the same as
    // reading the right one. Without this, deleting the call entirely (and
    // hardcoding `false`) would pass the assertions above.
    const src = fs.readFileSync(FILES[0], 'utf-8');
    assert.ok(
      /conversationToolsEnabled\(/.test(src),
      'tick/route.ts must call conversationToolsEnabled rather than inlining the rule',
    );
    assert.ok(
      /from '@\/lib\/agentCapabilities'/.test(src),
      'tick/route.ts must import the rule from its single source',
    );
  });

  it('the rule has exactly one definition', () => {
    // ChatArea defined this rule privately until tonight, which is why the
    // runner reinvented it wrongly. One `export function` and nothing else.
    const lib = fs.readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'agentCapabilities.ts'), 'utf-8');
    const defs = lib.match(/export function conversationToolsEnabled/g) || [];
    assert.equal(defs.length, 1);

    const chat = fs.readFileSync(
      path.join(process.cwd(), 'src', 'components', 'ChatArea.tsx'), 'utf-8');
    const code = chat
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    // The component may CALL it; it must not re-derive it from the two keys.
    assert.equal(
      /enableConversationTools\s*===\s*'boolean'/.test(code),
      false,
      'ChatArea is re-deriving the rule instead of calling conversationToolsEnabled',
    );
  });
});
