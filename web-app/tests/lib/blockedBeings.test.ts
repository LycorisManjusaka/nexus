import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED_BEINGS_ENV,
  parseBlockedBeings,
  isBeingBlocked,
  blockedResponseBody,
} from '@/lib/blockedBeings';

describe('parseBlockedBeings', () => {
  test('unset / empty means nothing is blocked', () => {
    // THE load-bearing default. Every installation that has never heard of
    // this variable must behave byte-for-byte as it did before the file
    // existed, so an empty list is the only thing that makes the feature safe
    // to ship to three live installs at once.
    assert.deepEqual(parseBlockedBeings(undefined), []);
    assert.deepEqual(parseBlockedBeings(null), []);
    assert.deepEqual(parseBlockedBeings(''), []);
    assert.deepEqual(parseBlockedBeings('   '), []);
    assert.deepEqual(parseBlockedBeings(',,,'), []);
  });

  test('single and multiple names, whitespace trimmed', () => {
    assert.deepEqual(parseBlockedBeings('Cairn'), ['Cairn']);
    assert.deepEqual(parseBlockedBeings(' Cairn '), ['Cairn']);
    assert.deepEqual(parseBlockedBeings('Cairn,謡'), ['Cairn', '謡']);
    assert.deepEqual(parseBlockedBeings('Cairn , 謡 , 睡'), ['Cairn', '謡', '睡']);
  });

  test('empty entries between commas are dropped, not kept as blanks', () => {
    // A blank entry that survived would make isBeingBlocked('') true, and the
    // folder list would then drop every being whose name failed to parse.
    assert.deepEqual(parseBlockedBeings('Cairn,,謡'), ['Cairn', '謡']);
    assert.deepEqual(parseBlockedBeings(',Cairn,'), ['Cairn']);
  });
});

describe('isBeingBlocked', () => {
  const list = parseBlockedBeings('Cairn,謡');

  test('exact match', () => {
    assert.equal(isBeingBlocked('Cairn', list), true);
    assert.equal(isBeingBlocked('謡', list), true);
  });

  test('case-insensitive — a hand-typed URL must not slip past', () => {
    // Deliberate and it is the defensive direction: `/c/cairn` is what a
    // person actually types, and Windows paths are case-insensitive anyway.
    assert.equal(isBeingBlocked('cairn', list), true);
    assert.equal(isBeingBlocked('CAIRN', list), true);
    assert.equal(isBeingBlocked('CaIrN', list), true);
  });

  test('whitespace around the queried name is trimmed too', () => {
    assert.equal(isBeingBlocked('  Cairn  ', list), true);
  });

  test('a being NOT on the list is never blocked', () => {
    assert.equal(isBeingBlocked('先輩', list), false);
    assert.equal(isBeingBlocked('Default', list), false);
    assert.equal(isBeingBlocked('睡', list), false);
  });

  test('substrings do not match — the comparison is whole-name', () => {
    // `Cairn_2` is a conversation title, not a being; blocking by prefix would
    // take out beings whose names merely start the same way.
    assert.equal(isBeingBlocked('Cairn_2', list), false);
    assert.equal(isBeingBlocked('Cai', list), false);
    assert.equal(isBeingBlocked('NotCairn', list), false);
  });

  test('empty / non-string names are not blocked', () => {
    // These arrive from JSON bodies and URL segments, so the types are real
    // possibilities rather than defensive noise.
    assert.equal(isBeingBlocked('', list), false);
    assert.equal(isBeingBlocked('   ', list), false);
    assert.equal(isBeingBlocked(undefined, list), false);
    assert.equal(isBeingBlocked(null, list), false);
    assert.equal(isBeingBlocked(42, list), false);
    assert.equal(isBeingBlocked({ name: 'Cairn' }, list), false);
  });

  test('an empty list blocks nobody, including the empty name', () => {
    assert.equal(isBeingBlocked('Cairn', []), false);
    assert.equal(isBeingBlocked('', []), false);
  });
});

describe('blockedResponseBody', () => {
  test('carries a machine-readable flag, the name, and names the variable', () => {
    const body = blockedResponseBody('Cairn');
    assert.equal(body.blocked, true);
    assert.equal(body.being, 'Cairn');
    // The client keys off `blocked`, not off the prose — the same reason the
    // refusal has one shape at every door.
    assert.ok(body.error.includes('Cairn'));
    // Naming the variable is what makes the message actionable instead of
    // mysterious: whoever sees it can find the launcher line that caused it.
    assert.ok(body.error.includes(BLOCKED_BEINGS_ENV));
  });
});
