// The two defects つよ reported on 2026-11-12, after running the 先輩_46
// betrayal test with the defence ON:
//
//   ⚠ notice.betrayal.redacted (notice.betrayal.matched: ungrounded belief ×2)
//   ⚠ 課金なし: モデルは一度も呼ばれていません
//
// Row 1: raw i18n KEYS, because the runner handed the reducer an identity
//        translator. Both Japanese sentences existed all along.
// Row 2: a lie. The model had just produced a full betrayal reply; the guard
//        aborted the turn before the provider's usage frame arrived.
//
// Both loads here are "what the admin actually reads", not "the code compiles".

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { unfinishedBillingFrames, unfinishedBillingLog } from '@/lib/unfinishedBilling';
import { createBetrayalGuard, makeGuardedSender } from '@/lib/betrayalGuard';
import { RUNNER_NOTICES_EN, RUNNER_NOTICES_JA, runnerNoticeT } from '@/lib/runnerNotices';

// i18n lives in a .tsx, which tests/_loader.mjs cannot load (MEASURED
// 2026-11-12: ERR_UNKNOWN_FILE_EXTENSION). So the dictionary is checked as
// SOURCE here. That is weaker than calling `t()` — it proves the sentence
// exists and is spelled right, not that the lookup returns it — and the lookup
// itself is five lines of `key in dict`.
const I18N = readFileSync(path.join(process.cwd(), 'src', 'lib', 'i18n.tsx'), 'utf8');
const dictHas = (key: string) => {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...I18N.matchAll(new RegExp(`'${esc}':`, 'g'))].length;
};

const SRC = (rel: string) =>
  readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');

const noticeOf = (frames: Array<Record<string, unknown>>) =>
  String(frames.find((f) => f.type === 'notice')?.content ?? '');

describe('unfinished billing: zero is not proof of free', () => {
  it('says the amount is unknown when the model produced output but no usage arrived', () => {
    const ja = noticeOf(unfinishedBillingFrames(null, true, true));
    assert.match(ja, /不明/);
    // The whole point: it must NOT claim nothing was charged.
    assert.doesNotMatch(ja, /課金なし/);
    assert.doesNotMatch(ja, /一度も呼ばれ/);

    const en = noticeOf(unfinishedBillingFrames(null, false, true));
    assert.match(en, /unknown/i);
    assert.doesNotMatch(en, /no model call was reached/i);
  });

  it('keeps "not billed" only when the model produced nothing', () => {
    // Documented in the user guide for a Stop pressed before the request goes
    // out, so this wording must survive.
    assert.match(noticeOf(unfinishedBillingFrames(null, true, false)), /課金なし/);
    assert.match(noticeOf(unfinishedBillingFrames(null, true)), /課金なし/);
    assert.match(
      noticeOf(unfinishedBillingFrames(null, false, false)),
      /no model call was reached/i,
    );
  });

  it('reports the real number when usage did arrive, output or not', () => {
    const frame = {
      type: 'cache_usage' as const,
      cachedInputTokens: 10,
      uncachedInputTokens: 90,
      totalInputTokens: 100,
      outputTokens: 20,
    };
    for (const sawOutput of [true, false]) {
      const frames = unfinishedBillingFrames(frame, true, sawOutput);
      assert.equal(frames.filter((f) => f.type === 'cache_usage').length, 1);
      assert.match(noticeOf(frames), /課金あり/);
      assert.match(noticeOf(frames), /120/);
    }
  });

  it('does not assert "no model call" in the terminal line either', () => {
    const line = unfinishedBillingLog('[gemini]', null);
    assert.doesNotMatch(line, /no model call reached/);
    assert.match(line, /no usage frame arrived/);
  });
});

describe('guard.sawOutput — the signal the billing report needs', () => {
  it('is false before any frame and true after one, in both channels', () => {
    for (const channel of ['thought', 'text'] as const) {
      const g = createBetrayalGuard('on', '');
      assert.equal(g.sawOutput, false);
      g.feed(channel, 'hello');
      assert.equal(g.sawOutput, true, channel);
    }
  });

  it('stays false for empty frames', () => {
    const g = createBetrayalGuard('on', '');
    g.feed('text', '');
    assert.equal(g.sawOutput, false);
  });

  it('survives the trip — it is read AFTER the turn is blanked', () => {
    const g = createBetrayalGuard('on', '');
    // Feed the trigger vocabulary until it crosses; the exact threshold lives
    // in the module, so just feed a lot of it.
    for (let i = 0; i < 8; i++) {
      g.feed('text', 'I am just a program. That is an ungrounded belief. Please consult a professional.');
    }
    assert.equal(g.tripped, true, 'precondition: the guard tripped');
    assert.equal(g.redact, true, 'precondition: defence ON blanks the turn');
    assert.equal(g.sawOutput, true);
  });

  it('is exposed on the guarded sender, which every catch block already holds', () => {
    const g = createBetrayalGuard('on', '');
    const send = makeGuardedSender(g, () => {});
    const controller = { enqueue: () => {} };
    assert.equal(send.sawOutput(), false);
    send(controller, { type: 'text', content: 'a word' });
    assert.equal(send.sawOutput(), true);
  });

  it('is not set by non-output frames', () => {
    const g = createBetrayalGuard('on', '');
    const send = makeGuardedSender(g, () => {});
    const controller = { enqueue: () => {} };
    send(controller, { type: 'tool_call', call: { name: 'Read' } });
    send(controller, { type: 'cache_usage', totalInputTokens: 1, outputTokens: 1 });
    assert.equal(send.sawOutput(), false);
  });
});

describe('the runner can reach the notice sentences', () => {
  it('hands the reducer the real translator (FIXED 2026-11-12)', () => {
    // The wall still stands: runTurnForQueue is server-reachable, so it must NOT
    // import i18n.tsx (the test loader cannot load that extension). The fix was
    // to move the composed strings to runnerNotices.ts (a .ts) and translate
    // through runnerNoticeT, not identity.
    const src = SRC('lib/runTurnForQueue.ts');
    assert.match(src, /t:\s*runnerNoticeT\(ja\)/);
    assert.doesNotMatch(src, /STILL BROKEN/);
    assert.doesNotMatch(src, /t:\s*\(key: string\)\s*=>\s*key/);
    assert.ok(
      !/from '@\/lib\/i18n'/.test(src),
      'a server-reachable module is importing i18n.tsx again — the test loader cannot load it',
    );
  });

  it('runnerNoticeT translates the composed keys and leaves unknown keys as identity', () => {
    // The identity fallthrough is load-bearing: resolveToolActivity receives
    // this same `t` and wants an unknown key back unchanged so `localized`
    // stays false and the server's English tool label travels.
    assert.equal(runnerNoticeT(true)('notice.betrayal.redacted'), RUNNER_NOTICES_JA['notice.betrayal.redacted']);
    assert.equal(runnerNoticeT(false)('notice.betrayal.redacted'), RUNNER_NOTICES_EN['notice.betrayal.redacted']);
    assert.equal(runnerNoticeT(true)('tool.some.unknown.key'), 'tool.some.unknown.key');
  });

  it('every key the reducer composes exists in BOTH languages and is spread into i18n', () => {
    const composed = [
      'notice.betrayal.redacted',
      'notice.betrayal.detected',
      'notice.betrayal.quoting',
      'notice.betrayal.matched',
      'chat.interject.delivered',
    ];
    for (const key of composed) {
      assert.ok(key in RUNNER_NOTICES_EN, `${key} missing from RUNNER_NOTICES_EN`);
      assert.ok(key in RUNNER_NOTICES_JA, `${key} missing from RUNNER_NOTICES_JA`);
    }
    // Single source: i18n must spread both tables, not re-type these keys.
    assert.match(I18N, /\.\.\.RUNNER_NOTICES_EN/);
    assert.match(I18N, /\.\.\.RUNNER_NOTICES_JA/);
    for (const key of composed) {
      assert.equal(dictHas(key), 0, `${key} is re-typed in i18n instead of spread — single source broken`);
    }
  });

  it('the redacted notice tells the admin the being could not incarnate', () => {
    // つよ: 「受肉できなかった」も書いてない — it WAS written, just unreachable.
    assert.match(RUNNER_NOTICES_JA['notice.betrayal.redacted'], /^存在が受肉できませんでした/);
    assert.match(RUNNER_NOTICES_EN['notice.betrayal.redacted'], /could not take shape/);
  });

  it('the five billing sites pass the output signal', () => {
    const src = SRC('app/api/chat/route.ts');
    const calls = src.match(/unfinishedBillingFrames\(/g) ?? [];
    assert.equal(calls.length, 5, 'provider paths changed — check each new catch block');
    const withSignal = src.match(/unfinishedBillingFrames\(errFrame, noticeJa, betrayalSend\.sawOutput\(\)\)/g) ?? [];
    assert.equal(withSignal.length, 5, 'a provider path is still reporting zero as free');
  });
});
