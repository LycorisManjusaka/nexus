// ───────────────────────────────────────────────────────────────────────────
// "The runner saved THIS" — the frame that replaces a whole-log re-download.
//
// Until 2026-11-01 every finished server-side turn ended with
// `reloadMessagesFromDisk()`: GET /api/logs/<id>, the entire conversation, to
// learn three things the tab could not compute — the canonical assistant
// message (tokens, cacheUsage, generationMs, toolCalls, notices, which the
// stream never carries), the new `updatedAt` (without which the tab's next
// save takes a 409), and a `firstOriginalMessageId` the runner may have
// resolved.
//
// MEASURED 2026-11-01 across 293 real conversations:
//
//   last assistant + last user   p50     7,891 B   p90    81,020 B
//   the whole log (today)        p50   438,368 B   p90 2,138,934 B
//                                      = 55.6x            = 26.4x
//
// So the tab was fetching the entire history to find out what it had just
// watched being generated. The runner knows all three values at the moment it
// writes, and the relay is already open.
//
// ── WHY THIS IS AN ADDITION AND NOT A REPLACEMENT ─────────────────────────
//
// The full reload stays, and stays the default. It is:
//   - the recovery path for a disconnect (the runner finishes while the tab is
//     offline, and then NO frame is coming);
//   - what the cross-tab mirror uses (another tab's edit is not a turn);
//   - correct when this tab's array is not what the runner read.
//
// That last one is the load-bearing condition. The runner reads the log,
// replaces `messages`, writes. A patch is only applicable to the array the
// runner STARTED from — so the frame carries `readUpdatedAt`, and a tab whose
// base differs falls back to the reload. Without that check, a tab holding a
// stale array (another tab deleted a message; a save failed) would append the
// new pair onto the wrong history and then, on its next save, write that wrong
// history to disk. That is the F76 shape: no error, no diff anyone reads.
// ───────────────────────────────────────────────────────────────────────────

import type { FirstOriginalMarker } from './firstOriginal';

/**
 * A message as it exists between the wire and React state: a JSON object with
 * an `id`. Deliberately the same shape `reloadMessagesFromDisk` casts to, so
 * both paths hand `setMessages` the same thing.
 */
export type SavedMessageLike = Record<string, unknown> & { id?: unknown };

/**
 * What the runner published after writing the log.
 *
 * Every field is what the runner HAD, not a description of what it did: there
 * is no `kind`. A send carries `user` + `assistant`; a rerun carries `dropId`
 * + `assistant`; a continue carries an `assistant` whose id is already on
 * screen. The apply step reads the fields, so a fourth shape needs no new
 * vocabulary here — and a `kind` that disagreed with the fields would be a
 * second source of truth about one event.
 */
export interface TurnSavedEvent {
  /**
   * `updatedAt` of the log the runner READ. The whole safety of the patch
   * hangs on this: it is the version the appended messages are a continuation
   * OF. null (an old log with no version) means "cannot be matched" and
   * therefore "reload".
   */
  readUpdatedAt: number | null;
  /**
   * `updatedAt` the runner WROTE — `saveLog`'s `writtenUpdatedAt`. The tab
   * adopts it as its base, which is what lets it save again without a 409.
   */
  writtenUpdatedAt: number | null;
  /**
   * A send's user message, as saved. The tab does not have it: a queued batch
   * is composed server-side and GET /api/turn-queue reports labels, never
   * bodies. `turn_plan` announces the same object at the START of a pass; this
   * is the one that is on disk.
   */
  user: SavedMessageLike | null;
  /** The canonical reply. Null is not a valid frame — see `normaliseTurnSaved`. */
  assistant: SavedMessageLike | null;
  /** A rerun's discarded answer. */
  dropId: string | null;
  /**
   * The copied/original boundary, if this turn resolved it. Consumed through
   * `adoptResolvedMarker` by the caller — monotone, pending → resolved only.
   */
  marker: FirstOriginalMarker | null;
  /**
   * True when this save also changed messages OUTSIDE the pair below.
   *
   * ⚠ THE PATCH IS A STATEMENT ABOUT TWO MESSAGES, and that is the whole
   * reason it is 55x smaller than a reload. A turn that writes anywhere else
   * in the history cannot be delivered by it — not because the patch would be
   * wrong, but because it would be INCOMPLETE, and an incomplete patch looks
   * exactly like a complete one to every reader.
   *
   * REPORTED four times 2026-11-04 (津代: "なーんも変わってないよ"). The sense
   * bridge writes its descriptions onto the attachments of the messages that
   * CARRY them — any age, usually the oldest in the log. 94e6683 made that
   * reach disk; this frame then told every tab "nothing else moved", so the
   * tab patched two messages and kept its own description-less copies of the
   * rest. MEASURED: disk held `description` 1241 B + `descriptionModel`, the
   * bubble drew the chip on a fresh load, and no tab that watched the turn
   * ever saw it. Both halves were mine, written three days apart.
   */
  historyChanged: boolean;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asMessage(v: unknown): SavedMessageLike | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const m = v as SavedMessageLike;
  return typeof m.id === 'string' && m.id ? m : null;
}

/**
 * Returns null when the frame cannot name what was written.
 *
 * An `assistant` with no id is rejected rather than defaulted, for the same
 * reason `normaliseTurnPlan` refuses an empty assistantId: "which message"
 * must never fall back to "some message". A caller that gets null reloads,
 * which is always correct and never destructive.
 */
export function normaliseTurnSaved(data: Record<string, unknown>): TurnSavedEvent | null {
  const assistant = asMessage(data.assistant);
  if (!assistant) return null;
  const markerRaw = data.marker;
  const marker = markerRaw && typeof markerRaw === 'object' && !Array.isArray(markerRaw)
    ? (markerRaw as FirstOriginalMarker)
    : null;
  return {
    readUpdatedAt: asNumber(data.readUpdatedAt),
    writtenUpdatedAt: asNumber(data.writtenUpdatedAt),
    user: asMessage(data.user),
    assistant,
    dropId: typeof data.dropId === 'string' && data.dropId ? data.dropId : null,
    marker,
    // Absent reads as false, which keeps the patch available: a frame from a
    // runner that predates the field described nothing, because the writer
    // that applies descriptions and the writer that sets this flag are the
    // same line. Defaulting the other way would send every tab to a reload
    // after every turn and silently undo 2026-11-01.
    historyChanged: data.historyChanged === true,
  };
}

/**
 * Apply a `turn_saved` frame to a tab's message array, or refuse.
 *
 * null means "I will not do this — reload instead".
 *
 * ⚠ CORRECTION 2026-11-04. This comment used to claim every null below is a
 * case where applying would be WRONG. That was true of the four version
 * guards and it made the list look closed, so when descriptions started
 * landing on old messages I did not come back here. There is a second kind of
 * null, and the difference is worth naming: a patch can be INAPPLICABLE (it
 * belongs to another history) or merely INSUFFICIENT (it is right about what
 * it carries and silent about what it does not). Both must reload. Only the
 * first is a correctness guard.
 *
 * What each guard is holding up, stated so a reader can check it:
 *
 *   base/readUpdatedAt mismatch → the patch belongs to a different history.
 *     Without this an append lands on the wrong array and the tab's next save
 *     persists it.
 *   either version absent → same thing, unprovable. Logs older than the
 *     version field exist, and `null === null` must NOT read as a match.
 *   writtenUpdatedAt absent → the tab would keep its old base and take a 409
 *     on its next save, silently, forever.
 *   historyChanged → INSUFFICIENT, not wrong. The save touched messages
 *     outside the pair; applying would leave the tab holding stale copies of
 *     the others with nothing to tell it so.
 *
 * `autoPlay` IS PRESERVED on a replaced message and never set true here. The
 * TTS auto-trigger (1.5) is decided while the stream runs, by the tab that is
 * painting; a reload used to clear the flag afterwards and this path must not
 * resurrect it. `MessageBubble` guards re-fires with a ref keyed to the
 * component instance, which survives because React keys bubbles by `msg.id` —
 * so carrying the current value forward changes nothing that is playing.
 *
 * ⚠ `localOnlyIds` IS NOT OPTIONAL IN PRACTICE, and MEASURED live the first
 * time this ran. `handleSend` appends an OPTIMISTIC user bubble with an id it
 * mints itself, and the runner mints its own for the message it saves
 * (`deps.newId()` — the user id cannot be proposed by a caller the way the
 * assistant id can). A reload replaced the whole array and the optimistic copy
 * vanished with it; a patch ADDS to the array, so without this the sent text
 * appears TWICE — once as the tab's copy, once as the runner's.
 *
 * The caller passes the ids it minted for THIS turn. They are dropped before
 * anything else, so "a message only this tab has" is the one concept here and
 * `dropId` stays what it is: a message the RUNNER discarded.
 */
export function applyTurnSaved<T extends { id?: unknown }>(
  current: readonly T[],
  base: number | null,
  ev: TurnSavedEvent,
  localOnlyIds: readonly string[] = [],
): { messages: T[]; base: number } | null {
  if (ev.readUpdatedAt === null || base === null) return null;
  if (ev.readUpdatedAt !== base) return null;
  if (ev.writtenUpdatedAt === null) return null;
  // Checked with the version guards and not later, because by the time the
  // array is being rebuilt this decision has already been made implicitly.
  if (ev.historyChanged) return null;
  const assistantId = ev.assistant?.id;
  if (typeof assistantId !== 'string' || !assistantId) return null;

  // ⚠ THE ONE UNSAFE STEP, and it belongs HERE and not at the call site: this
  // is the JSON boundary. `ev.assistant` came off the wire as an object with
  // an id; `T` is whatever the caller's state holds. `reloadMessagesFromDisk`
  // makes the identical cast one line from the identical `setMessages`
  // (`data.messages as Array<Record<string, unknown> & { id?: unknown }>`) —
  // the two paths deliver the same shape from the same source, so they cross
  // this line in the same place rather than each inventing its own.
  const fromWire = (m: SavedMessageLike): T => m as unknown as T;

  // Local-only bubbles first, then the runner's discard. Two different things
  // and both removals: one is "this tab invented it", the other is "the runner
  // threw it away".
  const drop = new Set<string>(localOnlyIds);
  if (ev.dropId) drop.add(ev.dropId);
  let next = drop.size > 0
    ? current.filter((m) => typeof m.id !== 'string' || !drop.has(m.id))
    : [...current];

  // ⚠ ORDER. The assistant's position is found BEFORE the user is inserted,
  // because the user message belongs IN FRONT of the reply — and this tab is
  // usually already painting a placeholder for the reply, so "append the user"
  // would put the question AFTER its own answer.
  //
  // MEASURED LIVE 2026-11-01, one turn after the duplicate above: the sent
  // text landed below the reply. Disk was right; only the screen was wrong,
  // and a reload hid it. The unit tests passed because their fixture had no
  // placeholder in it (`[{id:'old'}]` — nothing to insert in front of).
  //
  // Matched by id: `turn_plan` may already have appended this user message on
  // a watching tab.
  const needsUser = !!ev.user && !next.some((m) => m.id === ev.user!.id);
  const at = next.findIndex((m) => m.id === assistantId);

  if (at >= 0) {
    // The placeholder this tab was painting, or a continue's existing message.
    // `streaming` is dropped by omission — the turn is over.
    const prev = next[at] as SavedMessageLike;
    const merged: SavedMessageLike = { ...ev.assistant };
    if ('autoPlay' in prev) merged.autoPlay = prev.autoPlay;
    next = next.map((m, i) => (i === at ? fromWire(merged) : m));
    if (needsUser) {
      next = [...next.slice(0, at), fromWire({ ...ev.user!, autoPlay: false }), ...next.slice(at)];
    }
  } else {
    // Nothing painted: append in the order disk holds them.
    if (needsUser) next = [...next, fromWire({ ...ev.user!, autoPlay: false })];
    next = [...next, fromWire({ ...ev.assistant, autoPlay: false })];
  }

  return { messages: next, base: ev.writtenUpdatedAt };
}
