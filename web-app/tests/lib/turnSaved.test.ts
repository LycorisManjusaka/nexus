/**
 * turnSaved — "the runner wrote this, so do not re-download the log".
 *
 * NEW TEST, new lib. The patch rule could have lived as a few lines inside
 * `runOnRunner`'s finally, where no test and no mutation can reach it. It does
 * not, for the reason written at the top of firstOriginal.ts: the last rule
 * that lived inside a handler was lost when the handler moved (F76).
 *
 * Each case names what would look different if its rule were missing. A guard
 * whose absence changes nothing is not a guard — it is a restatement.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTurnSaved, normaliseTurnSaved, type TurnSavedEvent } from '../../src/lib/turnSaved';

type M = { id?: unknown; role?: string; content?: string; autoPlay?: unknown; streaming?: boolean };

const frame = (over: Partial<TurnSavedEvent> = {}): TurnSavedEvent => ({
  readUpdatedAt: 1000,
  writtenUpdatedAt: 2000,
  user: null,
  assistant: { id: 'a1', role: 'assistant', content: 'done', tokens: 42 },
  dropId: null,
  marker: null,
  ...over,
});

describe('applyTurnSaved — the version gate', () => {
  it('applies when the base matches the version the runner read', () => {
    // The whole point. Without this returning a patch, every finished turn
    // still costs a full-log fetch (p50 438 KB measured).
    const r = applyTurnSaved<M>([{ id: 'u1' }, { id: 'a1', content: 'par' }], 1000, frame());
    assert.ok(r);
    assert.equal(r.base, 2000);
    assert.equal((r.messages[1] as M).content, 'done');
  });

  it('refuses when the base is a DIFFERENT version than the runner read', () => {
    // The load-bearing guard. Without it a tab holding a stale array (another
    // tab deleted a message, a save failed) appends the new pair onto the
    // wrong history and then writes that history to disk on its next save —
    // the F76 shape, with no error and no diff anyone reads.
    assert.equal(applyTurnSaved<M>([{ id: 'a1' }], 1500, frame()), null);
  });

  it('refuses when the frame carries no read version', () => {
    // Logs older than the `updatedAt` field exist. Unprovable is not
    // permission: without this the patch would be applied on faith.
    assert.equal(applyTurnSaved<M>([{ id: 'a1' }], 1000, frame({ readUpdatedAt: null })), null);
  });

  it('refuses when the tab has no base, even against a null read version', () => {
    // `null === null` must NOT read as a match. Without this one line, a tab
    // that has never saved would accept any patch for any history.
    assert.equal(
      applyTurnSaved<M>([{ id: 'a1' }], null, frame({ readUpdatedAt: null })),
      null,
    );
  });

  it('refuses when the frame carries no written version', () => {
    // Without this the tab would keep its OLD base after applying, and take a
    // 409 on its next save — silently, and forever.
    assert.equal(applyTurnSaved<M>([{ id: 'a1' }], 1000, frame({ writtenUpdatedAt: null })), null);
  });

  it('refuses a frame whose assistant has no id', () => {
    // "Which message" must never fall back to "some message".
    const bad = frame({ assistant: { role: 'assistant' } as Record<string, unknown> });
    assert.equal(applyTurnSaved<M>([{ id: 'a1' }], 1000, bad), null);
  });
});

describe('applyTurnSaved — the three turn shapes', () => {
  it('send: appends a user message the tab does not have', () => {
    // A queued batch is composed server-side and GET /api/turn-queue reports
    // labels, never bodies. Without this the tab shows an answer to a question
    // that is not on screen.
    const r = applyTurnSaved<M>(
      [{ id: 'old' }],
      1000,
      frame({ user: { id: 'u9', role: 'user', content: 'hi' } }),
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['old', 'u9', 'a1']);
  });

  it('send: does NOT duplicate a user message already on screen', () => {
    // `turn_plan` appends it at the start of the pass on a watching tab, and
    // the kicking tab has had it since it sent. Without the id match this
    // would show the question twice.
    const r = applyTurnSaved<M>(
      [{ id: 'u9', content: 'hi' }, { id: 'a1' }],
      1000,
      frame({ user: { id: 'u9', role: 'user', content: 'hi' } }),
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['u9', 'a1']);
  });

  it("send: drops the tab's own optimistic bubble before appending the runner's", () => {
    // MEASURED LIVE 2026-11-01, on the first real turn through this path, and
    // the unit tests above could not see it: `handleSend` appends what the
    // sender typed under an id IT minted, and the runner mints its own (the
    // user id cannot be proposed, unlike the assistant id). The reload this
    // replaces rebuilt the whole array, so the optimistic copy went away with
    // it. A patch appends — so without localOnlyIds the sent text appeared
    // twice on screen, the tab's copy sitting above the runner's.
    const r = applyTurnSaved<M>(
      [{ id: 'old' }, { id: 'opt-1', role: 'user', content: 'hi' }],
      1000,
      frame({ user: { id: 'u9', role: 'user', content: 'hi' } }),
      ['opt-1'],
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['old', 'u9', 'a1']);
  });

  it('send into a PAINTED placeholder: the question goes in front of the answer', () => {
    // MEASURED LIVE 2026-11-01, one turn after the duplicate was fixed. Every
    // test above has a fixture with nothing to insert in front of, so
    // "append the user" looked correct — and the real path ALWAYS has a
    // placeholder, because the tab paints a bubble for the reply the moment
    // the stream opens. Appending put the question BELOW its own answer.
    const r = applyTurnSaved<M>(
      [{ id: 'old' }, { id: 'opt-1', role: 'user' }, { id: 'a1', streaming: true }],
      1000,
      frame({ user: { id: 'u9', role: 'user', content: 'hi' } }),
      ['opt-1'],
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['old', 'u9', 'a1']);
    // And the reply is still the canonical one, not the placeholder.
    assert.equal((r.messages[2] as M).content, 'done');
    assert.equal('streaming' in (r.messages[2] as object), false);
  });

  it('watching tab: user already present, placeholder painted — nothing moves', () => {
    // A watcher got the user message from turn_plan at the START of the pass,
    // so it is already in the right place. Without the id check this would
    // insert a second copy in front of the reply.
    const r = applyTurnSaved<M>(
      [{ id: 'u9', role: 'user' }, { id: 'a1', streaming: true }],
      1000,
      frame({ user: { id: 'u9', role: 'user', content: 'hi' } }),
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['u9', 'a1']);
  });

  it('drops nothing when the caller names no local-only ids', () => {
    // A watching tab minted nothing. Without the empty default being a no-op,
    // every watcher's patch would start by deleting messages.
    const r = applyTurnSaved<M>([{ id: 'u1' }, { id: 'a1' }], 1000, frame());
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['u1', 'a1']);
  });

  it('drops a local-only id AND a rerun target together', () => {
    // Two different removals for two different reasons — one "this tab
    // invented it", one "the runner threw it away". Without both in the same
    // set, a rerun from a tab that also had an optimistic bubble keeps one.
    const r = applyTurnSaved<M>(
      [{ id: 'opt-1' }, { id: 'old-answer' }, { id: 'a1' }],
      1000,
      frame({ dropId: 'old-answer' }),
      ['opt-1'],
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['a1']);
  });

  it('rerun: removes the discarded answer', () => {
    // Without the drop the replaced answer sits above the new one until the
    // next open.
    const r = applyTurnSaved<M>(
      [{ id: 'u1' }, { id: 'old-answer' }, { id: 'a1' }],
      1000,
      frame({ dropId: 'old-answer' }),
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['u1', 'a1']);
  });

  it('continue: replaces in place, keeping position', () => {
    // A continue extends a message that is already on screen, mid-array.
    // Without replace-in-place the extended reply would be appended at the
    // end and the half-written one left where it was.
    const r = applyTurnSaved<M>(
      [{ id: 'a1', content: 'half' }, { id: 'u2' }],
      1000,
      frame(),
    );
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['a1', 'u2']);
    assert.equal((r.messages[0] as M).content, 'done');
  });

  it('appends the assistant when the tab never painted a placeholder', () => {
    // A tab that attached late, or one whose turn_plan was rejected, has no
    // bubble for this id. Without the append branch the reply would be
    // invisible until the next open.
    const r = applyTurnSaved<M>([{ id: 'u1' }], 1000, frame());
    assert.ok(r);
    assert.deepEqual(r.messages.map((m) => m.id), ['u1', 'a1']);
    assert.equal(r.messages[1].autoPlay, false);
  });

  it('carries the canonical fields the stream never sent', () => {
    // The actual reason the reload existed: tokens, cacheUsage, generationMs,
    // toolCalls and notices are computed by finalizeTurnMessage and are not on
    // the wire. Without taking the frame's object the bubble would keep the
    // placeholder's bare text.
    const r = applyTurnSaved<M>([{ id: 'a1', content: 'par' }], 1000, frame());
    assert.ok(r);
    assert.equal((r.messages[0] as Record<string, unknown>).tokens, 42);
  });
});

describe('applyTurnSaved — what it must not touch', () => {
  it('preserves autoPlay on a replaced message', () => {
    // 1.5: the TTS auto-trigger is decided while the stream runs, by the tab
    // that is painting. Clearing it here would stop a reply mid-sentence;
    // setting it true would make a watching tab speak. Neither: carry it.
    const r = applyTurnSaved<M>([{ id: 'a1', autoPlay: true }], 1000, frame());
    assert.ok(r);
    assert.equal(r.messages[0].autoPlay, true);
  });

  it('preserves an EXPLICIT autoPlay:false', () => {
    // Found by the mutation check, 2026-11-01: with `prev.autoPlay` instead of
    // `'autoPlay' in prev`, true and absent both behave the same and only this
    // case differs — the field would appear or vanish by its VALUE rather than
    // its presence. 1.5 (the TTS auto-trigger) lives on this field, and the
    // two tests around this one could not tell the versions apart.
    const r = applyTurnSaved<M>([{ id: 'a1', autoPlay: false }], 1000, frame());
    assert.ok(r);
    assert.equal('autoPlay' in (r.messages[0] as object), true);
    assert.equal(r.messages[0].autoPlay, false);
  });

  it('does not invent autoPlay on a message that had none', () => {
    // A bubble with no flag at all must not gain one: `'autoPlay' in prev` is
    // the test, not `prev.autoPlay`, so an absent flag stays absent rather
    // than becoming an explicit false.
    const r = applyTurnSaved<M>([{ id: 'a1' }], 1000, frame());
    assert.ok(r);
    assert.equal('autoPlay' in (r.messages[0] as object), false);
  });

  it('drops `streaming` by omission', () => {
    // The turn is over. Without this the bubble keeps its spinner forever —
    // the reload cleared it by replacing the object, and so does this.
    const r = applyTurnSaved<M>([{ id: 'a1', streaming: true }], 1000, frame());
    assert.ok(r);
    assert.equal('streaming' in (r.messages[0] as object), false);
  });

  it('does not mutate the array it was given', () => {
    // The caller holds this array in a ref that React also reads. Without a
    // copy, a refused patch could still have changed what is on screen.
    const current: M[] = [{ id: 'a1', content: 'par' }];
    applyTurnSaved<M>(current, 1000, frame());
    assert.equal(current[0].content, 'par');
    assert.equal(current.length, 1);
  });
});

describe('normaliseTurnSaved', () => {
  it('reads a full frame', () => {
    const ev = normaliseTurnSaved({
      type: 'turn_saved',
      readUpdatedAt: 1,
      writtenUpdatedAt: 2,
      user: { id: 'u' },
      assistant: { id: 'a' },
      dropId: 'd',
      marker: { firstOriginalMessageId: 'u', firstOriginalIsNext: false },
    });
    assert.ok(ev);
    assert.equal(ev.readUpdatedAt, 1);
    assert.equal(ev.writtenUpdatedAt, 2);
    assert.equal(ev.user?.id, 'u');
    assert.equal(ev.dropId, 'd');
    assert.equal(ev.marker?.firstOriginalMessageId, 'u');
  });

  it('rejects a frame with no assistant', () => {
    // Without the rejection the host would act on a frame that names nothing,
    // and `applyTurnSaved` would be asked to patch an unnamed message.
    assert.equal(normaliseTurnSaved({ type: 'turn_saved', readUpdatedAt: 1 }), null);
  });

  it('rejects an assistant with no id', () => {
    assert.equal(normaliseTurnSaved({ assistant: { role: 'assistant' } }), null);
  });

  it('reads non-finite versions as absent', () => {
    // NaN arrives from `Number(undefined)` upstream and would otherwise
    // compare unequal to everything — a patch that silently never applies is
    // worse than one that declares itself inapplicable.
    const ev = normaliseTurnSaved({ assistant: { id: 'a' }, readUpdatedAt: NaN });
    assert.ok(ev);
    assert.equal(ev.readUpdatedAt, null);
  });

  it('rejects an array as a marker', () => {
    // `typeof [] === 'object'`. Without the Array check an array would reach
    // adoptResolvedMarker, which reads `.firstOriginalMessageId` off it.
    const ev = normaliseTurnSaved({ assistant: { id: 'a' }, marker: [] });
    assert.ok(ev);
    assert.equal(ev.marker, null);
  });

  it('reads an empty dropId as none', () => {
    const ev = normaliseTurnSaved({ assistant: { id: 'a' }, dropId: '' });
    assert.ok(ev);
    assert.equal(ev.dropId, null);
  });
});
