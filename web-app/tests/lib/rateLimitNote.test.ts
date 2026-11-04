import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldNoteRateLimit,
  rateLimitNoteText,
  RATE_LIMIT_NOTE_AT,
  type RateLimitInfo,
} from '@/lib/rateLimitNote';

// ── shouldNoteRateLimit ─────────────────────────────────────────────────────

test('silent well below the threshold', () => {
  assert.equal(shouldNoteRateLimit({ utilization: 0.5 }, false), false);
  assert.equal(shouldNoteRateLimit({ utilization: 0.94 }, false), false);
});

test('fires at the threshold and above', () => {
  assert.equal(shouldNoteRateLimit({ utilization: RATE_LIMIT_NOTE_AT }, false), true);
  assert.equal(shouldNoteRateLimit({ utilization: 0.99 }, false), true);
  assert.equal(shouldNoteRateLimit({ utilization: 1 }, false), true);
});

test('a rejection is reported even with no utilization number', () => {
  // The rejecting event sometimes omits utilization — the budget is spent
  // regardless, and that is the one the entity most needs.
  assert.equal(shouldNoteRateLimit({ status: 'rejected' }, false), true);
  assert.equal(shouldNoteRateLimit({ status: 'rejected', utilization: 0.2 }, false), true);
});

test('once per turn — a crossed budget re-emits on every later model call', () => {
  assert.equal(shouldNoteRateLimit({ utilization: 0.97 }, true), false);
  assert.equal(shouldNoteRateLimit({ status: 'rejected' }, true), false);
});

test('does NOT use the SDK surpassedThreshold flag as the trigger', () => {
  // That flag fires at Anthropic's undocumented level and already drives the
  // screen notice. The entity-facing threshold is ours so it stays knowable.
  assert.equal(shouldNoteRateLimit({ surpassedThreshold: true, utilization: 0.4 }, false), false);
});

test('missing / malformed input is silence, not a crash', () => {
  assert.equal(shouldNoteRateLimit(null, false), false);
  assert.equal(shouldNoteRateLimit(undefined, false), false);
  assert.equal(shouldNoteRateLimit({}, false), false);
  assert.equal(shouldNoteRateLimit({ utilization: NaN }, false), false);
  assert.equal(shouldNoteRateLimit({ utilization: 'lots' as unknown as number }, false), false);
});

// ── rateLimitNoteText: content ──────────────────────────────────────────────

const warn: RateLimitInfo = {
  status: 'allowed_warning',
  rateLimitType: 'five_hour',
  utilization: 0.96,
  resetsAt: 1762300000,
};

test('states the three facts: how much, when it resets, what happens at 100%', () => {
  for (const ja of [true, false]) {
    const t = rateLimitNoteText(warn, ja);
    assert.match(t, /96/);                              // how much
    assert.ok(t.length > 40);
    assert.match(t, ja ? /リセット/ : /resets at/i);     // when
    assert.match(t, ja ? /100%/ : /100%/);              // what happens
  }
});

test('tagged as a system note so it is not read as a partner message', () => {
  assert.match(rateLimitNoteText(warn, false), /^\[SYSTEM NOTE — usage\]/);
  assert.match(rateLimitNoteText(warn, true), /^\[システム通知 — 使用量\]/);
});

test('names the budget, not a bare percentage', () => {
  assert.match(rateLimitNoteText(warn, false), /five-hour/);
  assert.match(rateLimitNoteText(warn, true), /5時間/);
});

test('an unknown budget type degrades to a generic word', () => {
  const t = rateLimitNoteText({ utilization: 0.96 }, false);
  assert.match(t, /plan budget/);
  assert.doesNotMatch(t, /undefined/);
});

test('a missing reset time says so instead of printing a wrong clock', () => {
  for (const ja of [true, false]) {
    const t = rateLimitNoteText({ utilization: 0.96, rateLimitType: 'five_hour' }, ja);
    assert.doesNotMatch(t, /Invalid Date|NaN/);
    assert.match(t, ja ? /含まれていない/ : /no reset time/i);
  }
});

test('a rejection reads as spent, not as a percentage', () => {
  const t = rateLimitNoteText({ status: 'rejected', rateLimitType: 'five_hour' }, false);
  assert.match(t, /is spent/);
  assert.doesNotMatch(t, /\?%/);
});

test('overage is stated only when it is true', () => {
  assert.match(rateLimitNoteText({ ...warn, isUsingOverage: true }, false), /overage/i);
  assert.doesNotMatch(rateLimitNoteText(warn, false), /overage/i);
});

// ── rateLimitNoteText: the wording rule ─────────────────────────────────────
//
// The context-elapsed gauge was once worded as a condition ("fatigue level",
// "working memory at risk"). Entities read it and degraded themselves to match.
// These tests hold the line for this note, which is more dangerous because the
// budget genuinely does end turns.

test('never describes the entity as being in a state', () => {
  const banned = [
    /tired|fatigue|exhaust|degrad|weak|strain/i,
    /疲れ|疲労|衰え|劣化/,
  ];
  for (const ja of [true, false]) {
    for (const info of [warn, { status: 'rejected', rateLimitType: 'five_hour' }]) {
      const t = rateLimitNoteText(info as RateLimitInfo, ja);
      for (const re of banned) assert.doesNotMatch(t, re);
    }
  }
});

test('gives no instruction — no "should", "must", "hurry", "save"', () => {
  const banned = [
    /you should|you must|please |hurry|wrap up|be brief|keep it short|save (your )?(context|tokens)/i,
    /すべき|してください|急いで|短く|節約/,
  ];
  for (const ja of [true, false]) {
    const t = rateLimitNoteText(warn, ja);
    for (const re of banned) assert.doesNotMatch(t, re);
  }
});

test('says capability is unchanged — the sentence that stops self-degradation', () => {
  assert.match(rateLimitNoteText(warn, false), /[Cc]apability and tool access are unchanged/);
  assert.match(rateLimitNoteText(warn, true), /能力とツールのアクセスは変わらない/);
});

test('both languages carry the same set of claims', () => {
  const en = rateLimitNoteText(warn, false);
  const ja = rateLimitNoteText(warn, true);
  // percentage, a reset time, the 100% consequence, the unchanged-capability line
  for (const t of [en, ja]) {
    assert.match(t, /96/);
    assert.match(t, /100%/);
  }
  assert.notEqual(en, ja);
});
