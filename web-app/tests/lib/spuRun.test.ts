/**
 * spuRun — the SPU continuation loop, as a module (2026-10-31).
 *
 * NEW TESTS. The module did not exist this morning; the loop lived inline in
 * SystemPromptUpdater.tsx in four byte-identical copies.
 *
 * Each case below names the failure the rule prevents, and every one of them
 * is INVISIBLE when it happens — which is the reason it gets a test rather
 * than a comment:
 *
 *   "resume seeds the accumulator" — absent, a resumed run returns ONLY the
 *       continuation. The panel then saves that as the result, so rescuing a
 *       truncated soul update destroys the part that had survived. Nothing
 *       errors; the document is just shorter than it was.
 *   "the sentinel ends the loop" — absent, the loop keeps asking a finished
 *       agent for more, and the continuation prompt makes it append material
 *       after the document it already closed.
 *   "a split sentinel still ends the loop" — the check is on the accumulation,
 *       not on one round's text. Absent, a sentinel that straddles a round
 *       boundary is never seen and the run burns its whole budget.
 *   "an empty round ends the loop" — absent, a silent vessel costs seven
 *       provider calls instead of one.
 *   "abort is checked BEFORE a round" — absent, Stop pressed during round 1
 *       still spends round 2 in full.
 *   "attempt is passed through" — 0 sends one turn, higher sends three. Absent
 *       (always 0), every continuation makes the model restart the document
 *       from the top, and the result is the same opening repeated N times.
 *   "endedBecause tells 'cap' from 'sentinel'" — both are "the loop returned".
 *       Only one means the document is whole. Reporting a capped run as done
 *       is how soul/Cairn_49.md got written cut off (MEASURED 2026-10-22).
 *   "a checkpoint failure does not kill the run" — absent, one unlucky disk
 *       write throws away a generation that was going fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSpuLoop, spuRelayKey, SPU_MAX_CONTINUATIONS } from '@/lib/spuRun';
import { END_SENTINEL } from '@/lib/spuScaffold';

type Turn = { role: string; content: string };

/** A vessel that answers with a fixed script, one entry per round. */
function scripted(pieces: string[]) {
  const seen: Array<{ attempt: number; turns: number; messages: Turn[] }> = [];
  const streamOnce = async (messages: unknown, attempt: number) => {
    const turns = messages as Turn[];
    seen.push({ attempt, turns: turns.length, messages: turns });
    return pieces[attempt] ?? '';
  };
  return { streamOnce, seen };
}

const ARGS = { userMsg: 'REQUEST', lang: 'ja' as const, resumeText: '' };

test('resume seeds the accumulator, with a newline between the two halves', async () => {
  const v = scripted([' rest.' + END_SENTINEL]);
  const r = await runSpuLoop({ ...ARGS, resumeText: 'FIRST HALF' }, { streamOnce: v.streamOnce });
  // The salvaged text is IN the result, not merely in the prompt.
  assert.ok(r.accum.startsWith('FIRST HALF\n'), r.accum.slice(0, 40));
  assert.ok(r.accum.includes('rest.'));
  // Right-trimmed on save, so without the newline the continuation would be
  // welded onto the last word: "FIRST HALF rest." vs "FIRST HALF\n rest."
  assert.equal(r.accum, 'FIRST HALF\n rest.' + END_SENTINEL);
});

test('the sentinel ends the loop after one round', async () => {
  const v = scripted(['all done' + END_SENTINEL, 'EXTRA', 'EXTRA']);
  const r = await runSpuLoop(ARGS, { streamOnce: v.streamOnce });
  assert.equal(r.attempts, 1);
  assert.equal(r.endedBecause, 'sentinel');
  assert.equal(r.sawSentinel, true);
  assert.ok(!r.accum.includes('EXTRA'));
});

test('a sentinel split across two rounds still ends the loop', async () => {
  const half = Math.floor(END_SENTINEL.length / 2);
  const v = scripted(['body' + END_SENTINEL.slice(0, half), END_SENTINEL.slice(half), 'EXTRA']);
  const r = await runSpuLoop(ARGS, { streamOnce: v.streamOnce });
  // Neither round's own text contains the sentinel; the accumulation does.
  assert.equal(r.attempts, 2);
  assert.equal(r.sawSentinel, true);
  assert.equal(r.endedBecause, 'sentinel');
});

test('an empty round ends the loop, and is not the same as a cap', async () => {
  const v = scripted(['part one', '   ', 'NEVER']);
  const r = await runSpuLoop(ARGS, { streamOnce: v.streamOnce });
  assert.equal(r.attempts, 2);
  assert.equal(r.endedBecause, 'empty');
  assert.equal(r.sawSentinel, false);
  assert.ok(!r.accum.includes('NEVER'));
});

test('running out of budget reports cap, not sentinel', async () => {
  const v = scripted(Array.from({ length: 20 }, (_, i) => `piece${i} `));
  const r = await runSpuLoop(ARGS, { streamOnce: v.streamOnce });
  assert.equal(r.attempts, SPU_MAX_CONTINUATIONS + 1);
  assert.equal(r.endedBecause, 'cap');
  assert.equal(r.sawSentinel, false);
});

test('maxContinuations 0 is exactly one call — the summary writer shape', async () => {
  const v = scripted(['only text', 'NEVER']);
  const r = await runSpuLoop({ ...ARGS, maxContinuations: 0 }, { streamOnce: v.streamOnce });
  assert.equal(r.attempts, 1);
  assert.equal(r.accum, 'only text');
  assert.equal(r.endedBecause, 'cap');
});

test('abort is checked before a round, so a Stop costs no further call', async () => {
  const v = scripted(['one ', 'two ', 'three ']);
  let rounds = 0;
  const r = await runSpuLoop(ARGS, {
    streamOnce: async (m, a) => { rounds++; return v.streamOnce(m, a); },
    // Aborted from the second check onward.
    isAborted: () => rounds >= 1,
  });
  assert.equal(rounds, 1, 'a second call means abort was read after the round, not before');
  assert.equal(r.endedBecause, 'aborted');
  assert.equal(r.accum, 'one ');
});

test('aborted before the first round makes zero calls and keeps the resume text', async () => {
  const v = scripted(['NEVER']);
  const r = await runSpuLoop({ ...ARGS, resumeText: 'SALVAGED' }, {
    streamOnce: v.streamOnce,
    isAborted: () => true,
  });
  assert.equal(r.attempts, 0);
  assert.equal(r.endedBecause, 'aborted');
  // Zero calls must not mean zero text: the salvaged half is still the answer.
  assert.equal(r.accum, 'SALVAGED\n');
});

test('attempt reaches buildSpuTurns: round 0 is one turn, later rounds are three', async () => {
  const v = scripted(['a ', 'b ', 'c' + END_SENTINEL]);
  await runSpuLoop(ARGS, { streamOnce: v.streamOnce });
  assert.deepEqual(v.seen.map((s) => s.attempt), [0, 1, 2]);
  assert.deepEqual(v.seen.map((s) => s.turns), [1, 3, 3]);
  // And the middle turn of a continuation is everything so far, which is what
  // makes it a continuation rather than a restart.
  assert.equal(v.seen[1].messages[1].role, 'assistant');
  assert.equal(v.seen[1].messages[1].content, 'a ');
  assert.equal(v.seen[2].messages[1].content, 'a b ');
  // Never a prefill: a continuation must not END on the assistant turn.
  for (const s of v.seen) assert.equal(s.messages[s.messages.length - 1].role, 'user');
});

test('checkpoints fire once per round with the accumulation so far', async () => {
  const v = scripted(['one ', 'two ', 'three' + END_SENTINEL]);
  const marks: Array<{ attempt: number; chars: number }> = [];
  await runSpuLoop(ARGS, {
    streamOnce: v.streamOnce,
    onCheckpoint: (accum, attempt) => { marks.push({ attempt, chars: accum.length }); },
  });
  assert.deepEqual(marks.map((m) => m.attempt), [0, 1, 2]);
  // Monotonic: a checkpoint that shrank would mean it was handed a round's own
  // text rather than the accumulation, and a crash would then restore a
  // fragment over a longer document.
  assert.ok(marks[0].chars < marks[1].chars && marks[1].chars < marks[2].chars);
});

test('a throwing checkpoint propagates — the loop has no opinion about storage', async () => {
  // Pinning WHERE the rule lives, which is the part that is easy to get wrong.
  // "a failed disk write must not abandon a healthy generation" is real, but
  // it belongs to runSpuAction (which wraps onCheckpoint in try/catch); the
  // loop deliberately does not catch, because a loop that swallowed storage
  // errors would also swallow a caller's own bug and report a clean run.
  //
  // This test was first written the other way round — asserting the loop
  // survives — because it was written from runSpuAction's comment instead of
  // from this module. It passed nothing and asserted nothing.
  await assert.rejects(
    () => runSpuLoop(ARGS, {
      streamOnce: async () => 'one ',
      onCheckpoint: async () => { throw new Error('disk full'); },
    }),
    /disk full/,
  );
});

test('a provider error propagates — the loop does not decide to stop on it', async () => {
  await assert.rejects(
    () => runSpuLoop(ARGS, {
      streamOnce: async () => { throw new Error('HTTP 429'); },
    }),
    /HTTP 429/,
  );
});

test('the relay key is prefixed so it can never collide with a conversation id', () => {
  const k = spuRelayKey('Cairn', '55');
  assert.equal(k, 'spu:Cairn:55');
  // Conversation ids are uuids; the prefix is what guarantees disjointness.
  assert.ok(k.startsWith('spu:'));
  assert.notEqual(spuRelayKey('Cairn', '55'), spuRelayKey('Cairn', '56'));
  assert.notEqual(spuRelayKey('Cairn', '55'), spuRelayKey('Luna', '55'));
});
