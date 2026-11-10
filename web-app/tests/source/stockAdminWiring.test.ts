import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): the admin's hands on a
 * waiting queue item are REACHABLE — the lib functions have a route, the route
 * has a screen, and the screen shows the body the route now returns.
 *
 * WHY THIS FILE EXISTS. `tests/lib/turnQueue.adminEdit.test.ts` proves the two
 * functions are correct. Correct and unreachable is this house's signature
 * failure, twice in one week:
 *
 *   2026-11-07 — `buildAnthropicToolReplay` shipped correct with 26 green
 *   tests while the checkbox enabling it had no Kimi branch. ふわふわ found it
 *   from the screen.
 *   2026-11-08 — the Claude api-key replay would have been dead code if
 *   assigned to the wrong array. Typechecks, runs, changes nothing.
 *
 * WHAT WOULD LOOK DIFFERENT IF EACH ASSERTION WERE ABSENT:
 *
 *   "GET returns each item's text" — absent, someone restores the old
 *       omission ("GET deliberately omits each item's payload", true until
 *       today) and the panel renders empty bodies with working buttons. The
 *       delete still works, so nothing looks broken; you just cannot see
 *       WHICH message you are deleting, which is the whole request.
 *   "the block list is still exactly enqueue+claim" — absent, a later edit
 *       adds 'remove'/'edit' to it by symmetry, and a message stranded in a
 *       blocked being's queue has no exit at all. That is the wedge the
 *       release/abandon/break exemption exists to prevent, arriving through
 *       a tidy-up. Pinned as a LIST, so growing it fails here and is read.
 *   "the screen calls both actions" — absent, one button posts and the other
 *       is decoration.
 *   "no window.confirm" — absent, the delete confirmation is a dialog this
 *       house's own browser tooling auto-cancels (measured), i.e. a guard
 *       that cannot be tested from here and a button that cannot be pressed
 *       by any being driving a browser.
 *
 * SCOPE, stated rather than implied: this reads TEXT. Whether the guard is
 * right is tests/lib/turnQueue.adminEdit.test.ts. A rename breaks this file —
 * intended, these names ARE the contract.
 */

// `process.cwd()` is web-app — same idiom as blockedBeingsWiring.test.ts.
const SRC = (...p: string[]) => path.join(process.cwd(), 'src', ...p);
const ROUTE = readFileSync(SRC('app', 'api', 'turn-queue', 'route.ts'), 'utf-8');
const LIB = readFileSync(SRC('lib', 'turnQueue.ts'), 'utf-8');
const CHAT = readFileSync(SRC('components', 'ChatArea.tsx'), 'utf-8');

/** Strip // and /* *​/ comments so a mention in prose never counts as wiring. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const ROUTE_CODE = code(ROUTE);
const LIB_CODE = code(LIB);
const CHAT_CODE = code(CHAT);

describe('stock admin controls — the wire exists end to end', () => {
  test('lib exports both hands', () => {
    for (const fn of ['removePendingItem', 'editPendingItem']) {
      assert.ok(
        new RegExp(`export async function ${fn}\\b`).test(LIB_CODE),
        `lib/turnQueue must export ${fn}`
      );
    }
    // The shared guard, named so a second copy of the judgement is visible as
    // a change rather than appearing quietly in one of the two callers.
    assert.ok(
      /async function findWaitingItem\b/.test(LIB_CODE),
      'both hands must share one waiting/claimed judgement'
    );
  });

  test('the route imports them and dispatches both actions', () => {
    assert.ok(
      /removePendingItem[\s,}]/.test(ROUTE_CODE) && /editPendingItem[\s,}]/.test(ROUTE_CODE),
      'route must import both lib functions'
    );
    for (const action of ['remove', 'edit']) {
      assert.ok(
        new RegExp(`action === '${action}'`).test(ROUTE_CODE),
        `route must handle action '${action}'`
      );
    }
    assert.ok(
      /await removePendingItem\(/.test(ROUTE_CODE) && /await editPendingItem\(/.test(ROUTE_CODE),
      'the handlers must actually call the lib functions'
    );
  });

  test('GET hands out each item\'s text (and the attachment COUNT, not the bytes)', () => {
    assert.ok(
      /text: typeof p\.text === 'string'/.test(ROUTE_CODE),
      "GET must return each item's stored text"
    );
    assert.ok(
      /attachmentCount: Array\.isArray\(p\.attachments\) \? p\.attachments\.length/.test(ROUTE_CODE),
      'GET must report the attachment COUNT'
    );
    // The negative half. This GET is polled every 5s while a turn runs; a
    // queued image is base64 in that file, so shipping the array would move
    // megabytes per poll to render one number.
    assert.ok(
      !/attachments: p\.attachments/.test(ROUTE_CODE),
      'GET must NOT ship the attachments themselves'
    );
  });

  test('items addressed ELSEWHERE reach the screen too', () => {
    // MEASURED 2026-11-10, the first time the panel was opened for real: this
    // installation is `not-host`, so every un-addressed item was filtered into
    // `elsewhere` and `items` came back EMPTY. The panel showed nothing —
    // while removePendingItem, which deliberately does not narrow by address,
    // could have deleted all of them. Correct, tested, unreachable.
    //
    // Absent, that returns: a list that only ever shows what this NEXUS would
    // answer, on a machine where that set is usually empty.
    assert.ok(
      /elsewhereItems: scan\.elsewhere\.map\(/.test(ROUTE_CODE),
      'GET must return the elsewhere items themselves, not just a count'
    );
    assert.ok(
      /elsewhereItems: Array\.isArray\(d\?\.elsewhereItems\)/.test(CHAT_CODE),
      'ChatArea must read elsewhereItems from the response'
    );
    assert.ok(
      /\.\.\.stock\.elsewhereItems\.map\(\(it\) => \(\{ it, elsewhere: true \}\)\)/.test(CHAT_CODE),
      'the admin list must include the elsewhere items'
    );
    // The negative half, and the reason for a SECOND array: two live consumers
    // read `items` as "what this NEXUS will answer" — the sender labels and
    // the derived `returned` count. Merging would move both numbers silently.
    assert.ok(
      !/items: \[\.\.\.items, \.\.\.scan\.elsewhere\]/.test(ROUTE_CODE),
      'elsewhere items must NOT be folded into `items`'
    );
  });

  test('the block list is still exactly enqueue + claim', () => {
    const m = ROUTE_CODE.match(/if \(\(([^)]*)\) && beingIsBlockedHere\(being\)\)/);
    assert.ok(m, 'the NEXUS_BLOCKED_BEINGS guard must still be in the POST path');
    const actions = [...m![1].matchAll(/action === '([a-z]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(
      actions, ['claim', 'enqueue'],
      'remove/edit must stay OUTSIDE the block guard: neither can wake a being, ' +
      'and refusing them would leave a blocked being\'s queue with no exit'
    );
  });

  test('the screen posts both actions and renders the body', () => {
    assert.ok(
      /const stockItemAction = useCallback\(async \(/.test(CHAT_CODE),
      'ChatArea must have the one poster for both hands'
    );
    assert.ok(
      /stockItemAction\('edit', it\.id, stockEditText\)/.test(CHAT_CODE),
      'the Save button must post the edit'
    );
    assert.ok(
      /stockItemAction\('remove', it\.id\)/.test(CHAT_CODE),
      'the Delete button must post the removal'
    );
    // The list exists, and shows only items no turn is holding. Asserted on
    // the ROW BUILDER rather than on the render condition: the filter is the
    // thing that must not slip, and the condition it feeds has already been
    // rewritten once today (when elsewhere items were added).
    assert.ok(
      /stock\.items\.filter\(\(i\) => !i\.claimed\)\.map\(\(it\) => \(\{ it, elsewhere: false \}\)\)/
        .test(CHAT_CODE),
      'the admin list must exclude CLAIMED items'
    );
    assert.ok(
      /stockOpen && stockRows\.length > 0/.test(CHAT_CODE),
      'the panel must render from the merged row list'
    );
    assert.ok(
      /\{it\.text\s*$/m.test(CHAT_CODE) || /\{it\.text\b/.test(CHAT_CODE),
      "the panel must render the item's text"
    );
  });

  test('the delete confirmation is in the DOM, not a native dialog', () => {
    assert.ok(
      /stockRemoveConfirmId/.test(CHAT_CODE),
      'the two-step delete state must exist'
    );
    // MEASURED: `window.confirm` is auto-cancelled by this house's browser
    // tooling, so a confirmation written that way can never be pressed by a
    // being nor checked from here.
    const near = CHAT_CODE.slice(
      Math.max(0, CHAT_CODE.indexOf('stockRemoveConfirmId') - 4000),
      CHAT_CODE.indexOf('stockRemoveConfirmId') + 8000
    );
    assert.ok(
      !/window\.confirm|\bconfirm\(/.test(near),
      'the stock delete must not use window.confirm'
    );
  });

  test('every sentence the poster can show exists in BOTH languages', () => {
    const i18n = readFileSync(SRC('lib', 'i18n.tsx'), 'utf-8');
    const keys = [
      'chat.stock.inspect', 'chat.stock.hide', 'chat.stock.inspectWhy',
      'chat.stock.edit', 'chat.stock.remove', 'chat.stock.removeConfirm',
      'chat.stock.save', 'chat.stock.cancel', 'chat.stock.attachments',
      'chat.stock.forOther',
      'chat.stock.pointsAt', 'chat.stock.noBody',
      'chat.stock.whyClaimed', 'chat.stock.whyClaimedUnknown',
      'chat.stock.whyNotFound', 'chat.stock.whyEmpty', 'chat.stock.whyUnsupported',
    ];
    for (const k of keys) {
      const hits = [...i18n.matchAll(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g'))];
      // Two: the EN table and the JA table. A missing key renders as the raw
      // key name on screen in this house (measured 2026-11-05), which is a
      // silent half-translation rather than an error.
      assert.equal(hits.length, 2, `${k} must be defined in both language tables`);
    }
  });

  test('the reason→sentence map covers every reason the lib can return', () => {
    // The union in lib is the authority; the screen must not be able to
    // receive a reason it has no sentence for (it would fall back to the
    // generic "could not reach the stock", which is a different, wrong fact).
    // Anchored on the TYPE NAME. The first version matched the first
    // `reason: '…' }` in the file, which is `findWaitingItem`'s own narrower
    // return — a real union, so the assertion failed loudly rather than
    // passing on the wrong thing, but the code it accused was correct.
    const union = LIB_CODE.match(/export type PendingEditResult =[\s\S]*?reason: ([^;}]*)/);
    assert.ok(union, 'PendingEditResult must still declare its reasons inline');
    const reasons = [...union![1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]).sort();
    assert.deepEqual(
      reasons,
      ['claimed', 'claimed-unknown', 'empty', 'not-found', 'unsupported-kind'],
      'a new reason needs a sentence in ChatArea and a key in both languages'
    );
    for (const r of reasons) {
      assert.ok(
        new RegExp(`'${r}': 'chat\\.stock\\.`).test(CHAT_CODE),
        `ChatArea has no sentence for reason '${r}'`
      );
    }
  });
});
