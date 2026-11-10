// ─────────────────────────────────────────────────────────────────────────────
// turnQueue — the "stock" a being's turns are fed from. ONE source.
//
// Phase 4a of the server-side-turns overhaul (2026-10-27). Today a turn exists
// only while a browser tab drives it: the tab holds the message array, POSTs it
// to /api/chat, reads the stream, and POSTs the result to /api/logs. Close the
// tab and the turn dies; open two tabs and the loser of the race silently loses
// work (see turnRegistry.ts, which is the gentler half of that same defence).
//
// This module is the other end: a durable, ordered, exclusively-claimed stock
// of things that should cause a turn. It stores and sequences. It does NOT run
// turns, call models, or know what a message is — a runner on top of this does
// that, and lives in lib/ too so it stays importable by `npm test` (MEASURED
// 2026-10-27: `next/server` cannot be imported outside Next's own runtime, so
// anything written inside an API route is untestable from the day it is born).
//
// ── Why one file per item, and not one JSON array ───────────────────────────
// An array means read-modify-write. Two concurrent enqueues both read the old
// array and the second write erases the first item — and a silently dropped
// message is the worst failure this family has. One file per item makes
// enqueue a pure create: concurrent enqueues cannot collide, and items that
// arrive DURING a turn are different files from the ones being consumed, so
// release can never eat them. The invariant is structural, not careful.
//
// ── Why a .lease file and not atomicWriteFile ───────────────────────────────
// atomicWriteFile has replace semantics: it always wins. A claim must express
// "only if nobody holds this", and it must hold across PROCESSES — 3000 and
// 3001 are two Next installs on one shared local_data. `fs.open(path, 'wx')`
// is the primitive that fails when the file exists; an in-process Map would
// not see the other install.
//
// CORRECTION 2026-11-04: this said "(and 3000 is on `dev` while 3001 stays on
// `main`)". `dev` was merged into `main` and deleted on 2026-11-02 (f24bc6d);
// both installs are on `main`. The cross-process requirement is unchanged and
// never depended on the branches — but a comment that names a branch which no
// longer exists is read as a description of today.
//
// ── Why staleness is reported and never acted on ────────────────────────────
// A lease has no TTL. Turns here run for tens of minutes (35m measured), so any
// TTL short enough to free a crashed holder is short enough to cut a live turn
// in half — and breaking a live lease runs two turns against one log, which is
// the exact data loss turnRegistry exists to warn about. So the lease carries
// who holds it (pid, holder label, heartbeat) and `readLease` reports it;
// breaking requires `breakLease` with the token read from disk. Nothing here
// ever frees a lease on a guess.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { BEINGS_DIR, sanitizeBeingName } from './beingPaths';
// Replace semantics are WRONG for the lease (see the header above) and RIGHT
// for stamping an item that already exists: the caller holds the lease, so
// there is no competing writer, and a half-written item file would be read as
// corrupt by `pendingWithErrors`.
import { atomicWriteFile } from './atomicWrite';

/**
 * What woke (or will wake) the being.
 *
 * Two families, and the difference decides how a batch may be formed:
 *
 *   · CONTENT  — `user_message` (and later letter/schedule/system): the item
 *     CARRIES the thing to answer. Several in a row merge into one turn.
 *   · COMMAND  — `rerun`, `continue`: the item carries only a POINTER
 *     (`{ targetMsgId }`) at a message already on disk. Nothing to merge, and
 *     merging would be wrong: a rerun means "throw that answer away", which
 *     cannot also mean "and here is some new text".
 *
 * `letter`/`schedule`/`system` are still unproduced extension points, declared
 * so the on-disk shape does not change when they arrive.
 */
export type QueueItemKind =
  | 'user_message' | 'letter' | 'schedule' | 'system'
  | 'rerun' | 'continue';

/** The kinds that point at an existing message instead of carrying one. */
export const COMMAND_KINDS = ['rerun', 'continue'] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export function isCommandKind(kind: string): kind is CommandKind {
  return (COMMAND_KINDS as readonly string[]).includes(kind);
}

/**
 * May THIS installation run this item?
 *
 * Three answers, and each one is load-bearing:
 *
 *   addressed to me      → yes, EVEN IF this installation is not the host.
 *     Without this the whole field changes nothing: the un-named installation
 *     would still idle, which is exactly the symptom being fixed.
 *   addressed elsewhere  → no, EVEN IF this installation is the host.
 *     Without this the host drains the other clone's messages and answers
 *     them with its own code — the thing `runnerHost.ts`'s header is afraid
 *     of, arriving through the fix for it.
 *   not addressed        → only the host.
 *     Without this an item queued before this field existed, or one that no
 *     screen produced (letter, timer), would be run by every installation
 *     that polled — "whoever polled first", restored.
 *
 * Pure, so the rule is testable without a store. `selfId` and `isHost` are
 * passed in rather than read here because this file must stay usable from a
 * test with no local_data at all.
 */
export function itemIsForThisInstallation(
  item: { host?: string },
  selfId: string,
  isHost: boolean
): boolean {
  const target = (item.host || '').trim();
  if (!target) return isHost;
  return target === selfId;
}

export interface QueueItem {
  /** Unique per item. Also the ack/dedupe handle for the enqueuer. */
  id: string;
  /**
   * Epoch ms at enqueue, made strictly monotonic per process (see `nextAt`).
   *
   * CORRECTION 2026-11-07: this said "FIFO is by this value, ties broken by
   * `id`". There are no ties any more — and the old sentence described the
   * DEFECT as if it were the design. `id` is a uuid, so "broken by `id`" meant
   * "broken at random"; two items stamped in one millisecond came back in
   * either order. The guarantee now is that `at` never repeats, so the
   * filename sort it feeds is a real order.
   */
  at: number;
  kind: QueueItemKind;
  /**
   * Who it is from, as the being should see it — his requirement B: several
   * messages shown together must each carry a sender label. For a user message
   * this is the user-identity name, NOT the word "user".
   */
  from: string;
  /** Kind-specific body. `user_message` → { text, attachments }. */
  payload: unknown;
  /**
   * Which installation may run this item (an `installationId()`, so a realpath).
   *
   * WHY AN ITEM CARRIES THIS (measured 2026-11-02, トカゲくん):
   *   「C:\dev\nexus-cairn\local_data\runner.json と C:\dev\nexus\local_data\
   *     runner.json は両方物理的に同じファイルだ ... 同時には動かない」
   *
   * He is right, and the single flag could not have fixed it: two clones share
   * ONE store by junction, so there is ONE runner.json and it can name only
   * one of them. Whichever is not named idles — and after the merge BOTH have
   * runner code, so the un-named installation stocks a message and never runs
   * it.
   *
   * The flag answers "who hosts this STORE". That was the right question while
   * an item had no address: something had to break the "whoever polled first"
   * tie that `runnerHost.ts`'s header is about. An ADDRESSED item breaks that
   * tie by construction, and breaks it the way a person would want: the
   * installation whose screen you typed into is the one that answers, so the
   * code that runs is the code you are looking at.
   *
   * Absent is NOT "anyone". Absent means "the named host", which is both the
   * backward-compatible reading for items queued before this field and the
   * right reading for an item nobody typed — a letter, a timer (his 2.2).
   * Those have no screen to belong to, so the store-level flag is still the
   * only thing that can place them.
   */
  host?: string;
  /**
   * UI language of the screen this was typed on — 'ja' | 'en' (2026-11-06).
   *
   * Carried for the same reason as `host`, one step further: the installation
   * whose screen you typed into is the one that answers, so the language that
   * screen was speaking is the language a NOTICE about this message comes back
   * in. A notice is never sent to the model, so this is a human-facing choice
   * and belongs to the sender, not to the house.
   *
   * It is deliberately NOT the same field as `body.language` in a turn request.
   * That one picks which built-in language a being's hidden instructions
   * default to — it goes into the being's own context and must stay house-wide.
   * See lib/noticeLanguage.ts for the measurement that separated them.
   *
   * Absent ⇒ no screen (letter, timer), or an item queued before this field.
   * Both fall back to the stored setting and then to English.
   */
  uiLang?: string;
  /**
   * Set when a runner CLAIMED this item, ran a pass, and gave it back without
   * consuming it (2026-11-04, F20 — つよ).
   *
   * WHY THE ITEM HAS TO CARRY THIS:
   * An item that came back is unclaimed again, so every count in the panel
   * puts it in exactly the same place as an item that has never been touched.
   * つよ read "ストックに 1 通" + "今すぐ動かす" as "queued behind something"
   * and asked 「なんであたしの失敗したメッセージをスタックに保存してんの？」
   * — the panel was telling her the truth about the count and nothing at all
   * about the history, and the two readings call for opposite actions ("wait"
   * vs "close the other tab").
   *
   * The sentence cannot live in the in-memory note instead: the note is
   * replaced by the next one, dies with a reload, and belongs to ONE tab,
   * while the item outlives all three. The only place that survives with the
   * item is the item.
   *
   * ABSENT means "never attempted" — the backward-compatible reading for
   * every item queued before this field existed, and the right one.
   */
  returned?: ReturnedMark;
}

/**
 * Why an item came back, as stored.
 *
 * `kind` is a bare string HERE on purpose: this module owns the on-disk shape
 * and must not learn the runner's vocabulary. The enum and the one function
 * that decides it live in `stockPanel.ts`, which owns what a person is shown
 * about the stock.
 */
export interface ReturnedMark {
  /** Epoch ms when the pass gave it back. NOT `item.at`, which is the enqueue. */
  at: number;
  /** A `ReturnedKind` from stockPanel — carried, never inferred from `reason`. */
  kind: string;
  /**
   * The runner's own words. Shown only with the debug flag on: it is English
   * machinery ("409 refused by a newer version"), and the person who needs the
   * plain sentence is the one who has never opened a settings panel.
   */
  reason: string;
}

export interface Lease {
  token: string;
  /** Free-form label of the claimer, e.g. "nexus:3000". Display + diagnosis. */
  holder: string;
  pid: number;
  startedAt: number;
  lastSeen: number;
  convoId: string;
  /**
   * The ids this lease took, written a moment AFTER the lease file appears
   * (the lease must exist before the items are read — see `claim`).
   *
   * Exists so a reader can tell "this item is being worked on right now" from
   * "this item arrived after the batch started". Without it, a count of files
   * on disk is all anyone has, and the two mean opposite things: one is
   * progress, the other is a message still waiting for its turn. Measured
   * symptom that caused this field (つよ, 2026-10-27): the banner kept saying
   * 「ストックに 1 通」 for the whole drained turn, which reads as "your
   * message was ignored" when it actually means "it is in flight".
   *
   * Optional, and absent on any lease written before this field existed. A
   * reader that finds it missing knows only that SOME items are claimed, which
   * is strictly more than it knew before and never less.
   */
  claimedIds?: string[];
}

export interface Claim {
  being: string;
  convoId: string;
  token: string;
  /** The batch as it stood at claim time, in FIFO order. */
  items: QueueItem[];
}

export type ClaimResult =
  | { ok: true; claim: Claim }
  /** Someone holds the lease. `lease` is whatever is on disk, for display. */
  | { ok: false; reason: 'busy'; lease: Lease | null }
  /**
   * Nothing THIS caller may run. No lease was left behind.
   *
   * `elsewhere` is how many items were skipped because they are addressed to
   * a different installation. Zero means the stock is genuinely empty. It is
   * reported rather than folded into the count because "nothing was sent" and
   * "the other clone has not picked yours up yet" are opposite situations
   * that otherwise print the same word, and only the second one needs a
   * sentence on screen.
   */
  | { ok: false; reason: 'empty'; elsewhere: number };

interface Opts {
  /** Override the beings root. Tests point this at a temp dir; nothing else should. */
  beingsDir?: string;
  /**
   * Restrict which items this call can see. Applied in `pendingWithErrors`,
   * so `pending`, `claim` and the `position` an `enqueue` reports all narrow
   * together — one filter, one answer. Omitted means every item, which is
   * what every caller written before addressing existed still gets.
   *
   * Callers pass `itemIsForThisInstallation` bound to their own identity. The
   * predicate lives in this module and the identity does not, because reading
   * local_data from here would make the queue untestable without a store.
   */
  accept?: (item: QueueItem) => boolean;
}

/**
 * Exported for the same reason `queueDir` is: anything that needs to point at
 * the lease file should get the one answer rather than spell it again. A test
 * that hardcoded '.lease' would keep passing while silently testing nothing
 * the day this changes.
 */
export const LEASE_NAME = '.lease';
/** Item files are `<padded at>-<id>.json`; 15 digits keeps ms epoch sortable. */
const AT_PAD = 15;

/**
 * The last `at` this process handed out.
 *
 * MEASURED 2026-11-01, fixed 2026-11-07: FIFO is carried entirely by the
 * filename (`pendingWithErrors` does `names.sort()`), so two items stamped with
 * the SAME millisecond fall back to comparing their uuids — i.e. a coin flip.
 * `turnQueue.test.ts` enqueues three items back to back and asserts
 * oldest-first; it caught this roughly 1 in 3 runs. The test is right and was
 * never loosened: a queue that reorders is a real defect, and now that the
 * repository is public a suite that fails 1 run in 3 reads as "this project is
 * broken".
 *
 * Why monotonic `at` and not a sequence number in the filename: lines 587 and
 * 646 recover an item's id by SLICING the name at a fixed offset (`AT_PAD + 1`).
 * Adding a field would silently shift that cut and corrupt every id read back
 * from disk, including for items already on disk. Making `at` itself monotonic
 * keeps the filename shape byte-identical, so nothing that parses it changes.
 *
 * Cost: an item can carry an `at` up to a few ms ahead of the wall clock. The
 * only consumer that displays it rounds to the second (ChatArea's "arrived at
 * HH:MM:SS"), so that is invisible. Bonus: this also survives a clock that
 * steps backwards (NTP), which `Date.now()` alone does not.
 *
 * THE ASYMMETRY, found by the test that proves this (2026-11-07): a clock that
 * steps BACKWARD is absorbed, a clock that jumps FORWARD is not. Once `lastAt`
 * has been set to some future reading, every later item in this process is
 * `lastAt + 1` — it never returns to the wall clock. A test that froze
 * `Date.now()` at the year 2096 made the next two scenarios stamp items in
 * 2096 ("at 4000000000048 is not now"). In production that needs NTP to jump
 * the clock forward, which is rarer than a step back and costs only the
 * displayed second, so it is accepted rather than defended: recovering would
 * mean deciding how big a gap is "a jump" rather than "a long idle", and that
 * threshold cannot be measured from inside one process.
 *
 * LIMIT, stated out loud: this is per-process. 3000 and 3001 are separate Node
 * processes on one shared local_data, so two installs stamping the same
 * conversation in the same millisecond can still tie. A human cannot send twice
 * in one millisecond, and the programmatic senders (being-to-being messages,
 * mail, timers) all run from the one runner — so there is no path today that
 * reaches it. If one appears, the fix is a lock, not a bigger counter.
 */
let lastAt = 0;

/** `Date.now()`, but never equal to or behind the previous call. */
function nextAt(): number {
  const now = Date.now();
  lastAt = now > lastAt ? now : lastAt + 1;
  return lastAt;
}

function beingsRoot(opts?: Opts): string {
  return opts?.beingsDir || BEINGS_DIR;
}

/**
 * The errno off an unknown catch value. `catch (e: any)` would do the same
 * thing while also switching off every other check on that variable, and the
 * two cases this module distinguishes (ENOENT, EEXIST) are the whole reason
 * the error is inspected at all.
 */
function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

/** `<beings>/<being>/queue/<convoId>/` — the one place this shape is written. */
export function queueDir(being: string, convoId: string, opts?: Opts): string {
  return path.join(
    beingsRoot(opts),
    sanitizeBeingName(being),
    'queue',
    sanitizeBeingName(convoId)
  );
}

function itemFileName(at: number, id: string): string {
  return `${String(at).padStart(AT_PAD, '0')}-${id}.json`;
}

function isItemFile(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.');
}

/**
 * Add one item to the stock. A pure create — never reads or rewrites a
 * sibling, so two concurrent enqueues cannot lose each other.
 *
 * Returns the item as stored plus how many items are now pending. `position`
 * is a snapshot for display ("2 waiting"), not a promise: a concurrent
 * enqueue can change it the instant this returns.
 */
export async function enqueue(
  being: string,
  convoId: string,
  draft: { kind?: QueueItemKind; from: string; payload: unknown; host?: string; uiLang?: string },
  opts?: Opts
): Promise<{ item: QueueItem; position: number }> {
  if (!being || !convoId) throw new Error('turnQueue.enqueue: being and convoId are required');
  const dir = queueDir(being, convoId, opts);
  await fs.mkdir(dir, { recursive: true });

  const item: QueueItem = {
    id: crypto.randomUUID(),
    // Monotonic, not `Date.now()` — see `nextAt`. The filename carries FIFO.
    at: nextAt(),
    kind: draft.kind || 'user_message',
    from: draft.from || '',
    payload: draft.payload ?? null,
  };
  // Only written when there is one, so an un-addressed item keeps exactly the
  // shape it had before this field existed — `host: undefined` would serialise
  // to an absent key anyway, but writing the key conditionally says so out loud.
  const host = (draft.host || '').trim();
  if (host) item.host = host;
  // Same rule as `host`: written only when there is one, so an item with no
  // screen behind it keeps the shape it had before the field existed.
  const uiLang = (draft.uiLang || '').trim();
  if (uiLang) item.uiLang = uiLang;

  // `wx` so a repeated id (impossible in practice) fails loudly instead of
  // overwriting a queued message.
  const fh = await fs.open(path.join(dir, itemFileName(item.at, item.id)), 'wx');
  try {
    await fh.writeFile(JSON.stringify(item));
  } finally {
    await fh.close();
  }

  const all = await pending(being, convoId, opts);
  return { item, position: all.findIndex((i) => i.id === item.id) + 1 || all.length };
}

/**
 * Everything waiting, oldest first. Read-only — safe to call from the UI while
 * a turn runs. Unreadable or malformed item files are SKIPPED and reported by
 * `pendingWithErrors`; this function hides them, so use that one when the
 * difference between "nothing queued" and "could not read the queue" matters.
 */
export async function pending(being: string, convoId: string, opts?: Opts): Promise<QueueItem[]> {
  return (await pendingWithErrors(being, convoId, opts)).items;
}

/**
 * Same as `pending`, but also returns the files that could not be parsed.
 * Three different situations print the same empty list otherwise — nothing
 * queued, directory missing, and a corrupt file — and only the third one is a
 * problem someone has to see.
 */
export async function pendingWithErrors(
  being: string,
  convoId: string,
  opts?: Opts
): Promise<{ items: QueueItem[]; unreadable: string[]; elsewhere: QueueItem[] }> {
  const dir = queueDir(being, convoId, opts);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { items: [], unreadable: [], elsewhere: [] };
    throw e;
  }
  const items: QueueItem[] = [];
  const unreadable: string[] = [];
  const elsewhere: QueueItem[] = [];
  for (const name of names.filter(isItemFile).sort()) {
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
        unreadable.push(name);
        continue;
      }
      // An item this caller may not run is NOT the same as no item, for the
      // same reason `unreadable` is separate: all three print an empty list
      // otherwise, and one of them means "waiting for the other installation
      // to pick it up" while another means "nothing was sent". `unreadable`
      // is deliberately NOT filtered — a file whose address cannot be parsed
      // is everyone's problem, and hiding it from the clone that could show
      // it would be the one failure mode worse than showing it twice.
      if (opts?.accept && !opts.accept(parsed as QueueItem)) {
        elsewhere.push(parsed as QueueItem);
        continue;
      }
      items.push(parsed as QueueItem);
    } catch {
      unreadable.push(name);
    }
  }
  return { items, unreadable, elsewhere };
}

/** The lease on disk, or null. Never throws on a missing/corrupt lease. */
export async function readLease(being: string, convoId: string, opts?: Opts): Promise<Lease | null> {
  try {
    const raw = await fs.readFile(path.join(queueDir(being, convoId, opts), LEASE_NAME), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.token === 'string' ? (parsed as Lease) : null;
  } catch {
    return null;
  }
}

/**
 * Take the stock for one turn.
 *
 * Order matters: the lease is taken FIRST, then the items are read. The other
 * order would let an item land between the read and the lease and sit unseen
 * until the next poll. With the lease first, the batch is everything queued up
 * to the moment the holder looked — and anything arriving after stays for the
 * next turn, which is exactly the stated invariant ("while the being is
 * running, another message in the stock does nothing").
 *
 * An empty queue releases the lease again and reports `empty`, so an idle poll
 * never leaves the conversation looking busy.
 */
export async function claim(
  being: string,
  convoId: string,
  holder: string,
  opts?: Opts
): Promise<ClaimResult> {
  const dir = queueDir(being, convoId, opts);
  await fs.mkdir(dir, { recursive: true });
  const leasePath = path.join(dir, LEASE_NAME);

  const now = Date.now();
  const lease: Lease = {
    token: crypto.randomUUID(),
    holder: holder || '',
    pid: process.pid,
    startedAt: now,
    lastSeen: now,
    convoId,
  };

  let fh;
  try {
    fh = await fs.open(leasePath, 'wx');
  } catch (e) {
    if (errCode(e) === 'EEXIST') {
      return { ok: false, reason: 'busy', lease: await readLease(being, convoId, opts) };
    }
    throw e;
  }
  try {
    await fh.writeFile(JSON.stringify(lease));
  } finally {
    await fh.close();
  }

  const scan = await pendingWithErrors(being, convoId, opts);
  const items = scan.items;
  if (items.length === 0) {
    // Nothing to run. Give the lease back rather than hold it for a poll that
    // found nothing — `release` is used so the same ownership check applies.
    //
    // The lease was taken before this was known, and that order is deliberate
    // (see above). So an installation that may run none of the queued items
    // briefly holds the lease — which is why it is given back here rather
    // than kept: the clone that CAN run them must be able to take it.
    await release(being, convoId, lease.token, [], opts);
    return { ok: false, reason: 'empty', elsewhere: scan.elsewhere.length };
  }

  // Record WHICH items this lease took, so a reader can separate "in flight"
  // from "arrived since". Plain write, like `heartbeat` and for the same
  // reason: a temp+rename would momentarily REMOVE the lease file, and that
  // is the one thing that must not happen while a turn holds it. If this
  // write fails the claim still stands — the ids are for display, and losing
  // them costs precision, not correctness.
  lease.claimedIds = items.map((i) => i.id);
  try {
    await fs.writeFile(leasePath, JSON.stringify(lease));
  } catch {
    /* precision only; the batch below is authoritative either way */
  }

  return { ok: true, claim: { being, convoId, token: lease.token, items } };
}

/**
 * Keep a lease visibly alive. Returns false when there is no lease, or when
 * the lease belongs to a different token — a heartbeat must never resurrect or
 * hijack someone else's claim (same rule as turnRegistry.touchTurn).
 *
 * Nothing in this module reads `lastSeen` to make a decision. It exists so a
 * human (or a UI) can tell a running turn from an abandoned one.
 */
export async function heartbeat(
  being: string,
  convoId: string,
  token: string,
  opts?: Opts
): Promise<boolean> {
  const dir = queueDir(being, convoId, opts);
  const leasePath = path.join(dir, LEASE_NAME);
  const lease = await readLease(being, convoId, opts);
  if (!lease || lease.token !== token) return false;
  lease.lastSeen = Date.now();
  // Plain write, not atomic: the only field that moves is a display-only
  // timestamp, and a torn heartbeat is recovered by the next one. Using a
  // temp+rename here would momentarily REMOVE the lease file, which is the one
  // thing that must never happen while a turn holds it.
  await fs.writeFile(leasePath, JSON.stringify(lease));
  return true;
}

/**
 * Finish a turn: delete the consumed items, then drop the lease.
 *
 * Items are removed BY ID. Items queued while the turn ran are different files
 * and are left alone — that is what makes "send again while they work" safe.
 *
 * Deleting items before the lease matters on a crash: dying between the two
 * leaves consumed items gone and a stale lease (visible, fixable), whereas the
 * other order would leave the batch to be run a SECOND time, which costs money
 * and writes a duplicate reply.
 */
export async function release(
  being: string,
  convoId: string,
  token: string,
  consumedIds: string[],
  opts?: Opts
): Promise<{ ok: boolean; removed: number; remaining: number }> {
  const dir = queueDir(being, convoId, opts);
  const lease = await readLease(being, convoId, opts);
  if (!lease || lease.token !== token) {
    return { ok: false, removed: 0, remaining: (await pending(being, convoId, opts)).length };
  }

  let removed = 0;
  if (consumedIds.length > 0) {
    const want = new Set(consumedIds);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch { /* directory vanished; nothing to remove */ }
    for (const name of names.filter(isItemFile)) {
      // The id is the part after the first '-' following the padded timestamp.
      const id = name.slice(AT_PAD + 1, -'.json'.length);
      if (!want.has(id)) continue;
      try {
        await fs.unlink(path.join(dir, name));
        removed++;
      } catch { /* already gone — the end state is what was asked for */ }
    }
  }

  try {
    await fs.unlink(path.join(dir, LEASE_NAME));
  } catch { /* already gone */ }

  return { ok: true, removed, remaining: (await pending(being, convoId, opts)).length };
}

/**
 * Stamp items with WHY they are coming back, before the lease goes.
 *
 * ORDER IS LOAD-BEARING: this must run while the caller still holds the
 * lease, i.e. before `abandon`. Between abandon and now, an auto-trigger may
 * already have claimed the batch again, and stamping an item some other pass
 * is running would describe a turn that is alive as one that failed.
 *
 * Requires the token for the same reason `release` does — a passer-by must
 * not be able to write "this failed" onto somebody else's running batch.
 *
 * Items that are already gone are SKIPPED, not an error. A pass can consume
 * part of a batch and hand the rest back, and this is also called on the path
 * where the pass threw, where nothing is known about what it managed to do.
 * The end state is what was asked for either way.
 *
 * Rewrites each file UNDER ITS OWN NAME. The name carries the enqueue time
 * and the whole FIFO order is that name, so a stamped item must not move: a
 * message that came back has not lost its place in the line.
 */
export async function markReturned(
  being: string,
  convoId: string,
  token: string,
  ids: string[],
  mark: ReturnedMark,
  opts?: Opts
): Promise<{ ok: boolean; stamped: number }> {
  if (ids.length === 0) return { ok: true, stamped: 0 };
  const dir = queueDir(being, convoId, opts);
  const lease = await readLease(being, convoId, opts);
  if (!lease || lease.token !== token) return { ok: false, stamped: 0 };

  const want = new Set(ids);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: true, stamped: 0 };
  }

  let stamped = 0;
  for (const name of names.filter(isItemFile)) {
    const id = name.slice(AT_PAD + 1, -'.json'.length);
    if (!want.has(id)) continue;
    const file = path.join(dir, name);
    try {
      const item = JSON.parse(await fs.readFile(file, 'utf-8')) as QueueItem;
      // The LATEST attempt replaces the previous one rather than accumulating.
      // A person reads "why is it still here", which is about the last try; a
      // list of every attempt is a log, and this file is not one.
      item.returned = mark;
      await atomicWriteFile(file, JSON.stringify(item));
      stamped++;
    } catch {
      // Unreadable, malformed, or deleted under us. `pendingWithErrors`
      // already reports a corrupt item file; losing a stamp costs the person
      // one sentence, and throwing here would cost them the lease.
    }
  }
  return { ok: true, stamped };
}

/**
 * Give the lease back WITHOUT consuming anything — the turn failed, or was
 * stopped, and the batch should be run again. Separate from `release([])` only
 * by name, on purpose: at the call site "abandon" and "finished with nothing
 * consumed" read as different intentions and the difference is worth seeing.
 */
export async function abandon(
  being: string,
  convoId: string,
  token: string,
  opts?: Opts
): Promise<boolean> {
  const r = await release(being, convoId, token, [], opts);
  return r.ok;
}

/**
 * Force a lease open. Requires the token currently on disk, so the caller has
 * to have READ the lease (pid, holder, how long since its heartbeat) before it
 * can break it. Never called by anything in this module.
 */
export async function breakLease(
  being: string,
  convoId: string,
  expectedToken: string,
  opts?: Opts
): Promise<boolean> {
  const lease = await readLease(being, convoId, opts);
  if (!lease || lease.token !== expectedToken) return false;
  try {
    await fs.unlink(path.join(queueDir(being, convoId, opts), LEASE_NAME));
    return true;
  } catch {
    return false;
  }
}

/**
 * ⚠ `discard` LIVED HERE, 2026-11-01 to 2026-11-02, and was withdrawn.
 *
 * It let a person throw queued items away, because a failed turn left its
 * batch in the stock panel with exactly one control ("Run now") and トカゲくん
 * said "I don't know why it's there and I don't want it". I read that as a
 * missing hand and added a second button.
 *
 * He read it as a missing BEHAVIOUR: "there is no 'run now' and no 'discard'
 * here at all; on a failure this just stays, and the rest is the admin's
 * judgement." A failed turn now commits its user message and an empty
 * assistant message and consumes the batch (runTurnForQueue's pass chain), so
 * a failed send never reaches the stock panel and there is nothing to discard.
 *
 * Kept as a note and not as code because the code was reachable, tested and
 * wrong-shaped — the kind of thing someone restores from history by accident
 * if the only record is a deletion.
 *
 * ── 2026-11-10: a DIFFERENT hand, for a different hole (つよ) ───────────────
 * `removePendingItem` / `editPendingItem` below are not that button coming
 * back, and the difference is the whole reason they are allowed to exist.
 *
 *   discard   was for a FAILED turn's leftovers. That case is gone at the
 *             source: a failed turn now commits and consumes its batch, so
 *             nothing reaches the panel to be discarded.
 *   these     are for a HEALTHY waiting item — typed, queued, not yet run.
 *             Withdrawing discard took the only hand off those too, and
 *             nothing replaced it: a message with a typo in it, or one queued
 *             at a being who is asleep, has no exit from any screen at all.
 *
 * つよ, asking for them: 「まだ送ってないメッセージさぁ、確認する権利は管理者に
 * あると思わない？そもそも壊れたらどうすんのよ？」— the second sentence is the
 * load-bearing one. This machinery is three weeks old; the hand that fixes it
 * when it goes wrong cannot be the machinery itself.
 */

/**
 * Locate one item that is WAITING — not claimed, not in flight.
 *
 * ONE guard for both remove and edit. Written once because the two would
 * otherwise carry the same four-case judgement in two places, and the day they
 * drift is the day one of them edits a batch a turn is already holding in
 * memory (the answer arrives, the file is gone, and nothing says why).
 *
 * The four answers, each load-bearing:
 *
 *   not-found       — no such id here. Already consumed, or another screen
 *                     removed it a moment ago. NOT an error to shout about:
 *                     the end state is what the caller asked for.
 *   claimed         — a runner took this id. Refused: the turn already read
 *                     the payload into memory, so deleting the file now would
 *                     produce an answer to a message that no longer exists,
 *                     and editing it would answer the OLD text while the
 *                     screen shows the new one. Stopping a running turn is a
 *                     different control and already exists (break / stop).
 *   claimed-unknown — a lease is held but does not say WHICH ids it took (a
 *                     lease written before `claimedIds`, or whose id write
 *                     failed). Refused on purpose: `splitByLease` reports this
 *                     case rather than guessing, and a guess here is not a
 *                     display error — it is a deleted message.
 *   ok              — plus the FILE NAME, so the caller never recomputes it.
 *
 * The name comes from a readdir scan keyed on the id, exactly as `release` and
 * `markReturned` do, rather than from `itemFileName(item.at, item.id)`.
 * Rebuilding it would be a second derivation of the on-disk name, and this
 * module has already paid once for a filename parsed at a fixed offset.
 */
async function findWaitingItem(
  being: string,
  convoId: string,
  id: string,
  opts?: Opts
): Promise<
  | { ok: true; name: string; item: QueueItem }
  | { ok: false; reason: 'not-found' | 'claimed' | 'claimed-unknown' }
> {
  const dir = queueDir(being, convoId, opts);
  // `beingsDir` is forwarded and `accept` is deliberately NOT: an item
  // addressed to the other installation is exactly the one a person most needs
  // to be able to delete — nothing here will ever run it (see QueueItem.host),
  // and hiding it from this hand would reproduce the symptom addressing was
  // invented to fix.
  //
  // Spelled as one explicit field rather than `{ ...opts, accept: undefined }`.
  // MEASURED: the first version of this line passed NO opts at all, which drops
  // `beingsDir` as well and silently reads the real BEINGS_DIR — invisible in
  // production (where opts is undefined anyway) and caught only because a test
  // pointed the store at a temp directory.
  const scan = await pendingWithErrors(being, convoId, { beingsDir: opts?.beingsDir });
  const item = scan.items.find((i) => i.id === id);
  if (!item) return { ok: false, reason: 'not-found' };

  const lease = await readLease(being, convoId, opts);
  const split = splitByLease(scan.items, lease);
  if (split.claimedUnknown) return { ok: false, reason: 'claimed-unknown' };
  if (split.claimed.some((i) => i.id === id)) return { ok: false, reason: 'claimed' };

  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  const name = names
    .filter(isItemFile)
    .find((n) => n.slice(AT_PAD + 1, -'.json'.length) === id);
  if (!name) return { ok: false, reason: 'not-found' };
  return { ok: true, name, item };
}

export type PendingEditResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'claimed' | 'claimed-unknown' | 'empty' | 'unsupported-kind' };

/**
 * Delete ONE waiting item.
 *
 * No token. `release` needs one because it deletes the batch a turn is
 * holding; this refuses claimed items outright, so there is no running turn
 * whose work it could erase — the witness `release`'s token provides has
 * nothing left to witness.
 */
export async function removePendingItem(
  being: string,
  convoId: string,
  id: string,
  opts?: Opts
): Promise<PendingEditResult> {
  const found = await findWaitingItem(being, convoId, id, opts);
  if (!found.ok) return found;
  try {
    await fs.unlink(path.join(queueDir(being, convoId, opts), found.name));
  } catch {
    // Gone between the scan and here — another screen, or the runner finishing.
    // The end state is what was asked for.
  }
  return { ok: true };
}

/**
 * Rewrite the TEXT of one waiting `user_message`.
 *
 * ── The filename does not move ──────────────────────────────────────────────
 * Written back under its own name, same as `markReturned`: the name carries
 * `at`, and the whole FIFO order is that name. A corrected message has not
 * lost its place in the line, and must not jump to the back of it.
 *
 * ── Only `user_message` ─────────────────────────────────────────────────────
 * A command (`rerun`/`continue`) carries a POINTER, not a body — there is no
 * text to fix, and letting this write `payload.text` onto one would produce an
 * item that is neither a command nor a message. Refused by kind rather than by
 * inspecting the payload, so the refusal states the rule instead of a symptom.
 *
 * ── Attachments are preserved, never touched ────────────────────────────────
 * Read back and written out unchanged. Dropping them silently would make
 * "fix a typo" delete an image, and this hand exists to prevent loss.
 *
 * ── The `[name]` label is NOT re-derived here ───────────────────────────────
 * Whatever the person types is stored verbatim. `composeBatch` owns the label
 * rule (it prefixes `[from]` only when the text does not already start with
 * it), so deleting the label by hand gets it back at send time and keeping it
 * does not double it. One owner, unchanged.
 */
export async function editPendingItem(
  being: string,
  convoId: string,
  id: string,
  text: string,
  opts?: Opts
): Promise<PendingEditResult> {
  const found = await findWaitingItem(being, convoId, id, opts);
  if (!found.ok) return found;
  if (isCommandKind(found.item.kind)) return { ok: false, reason: 'unsupported-kind' };

  const prev = (found.item.payload || {}) as UserMessagePayload;
  const attachments = Array.isArray(prev.attachments) ? prev.attachments : [];
  // The same rule the enqueue route and the runner both apply, from the same
  // function: an edit that empties a message is an enqueue of nothing, and
  // the two ends must not disagree about what "nothing" means.
  if (isEmptyTurnText(text, attachments)) return { ok: false, reason: 'empty' };

  const next: QueueItem = { ...found.item, payload: { ...prev, text, attachments } };
  // Replace semantics are RIGHT here for the reason stated at the import: the
  // file exists, and a half-written item would be read as corrupt by
  // `pendingWithErrors`.
  await atomicWriteFile(path.join(queueDir(being, convoId, opts), found.name), JSON.stringify(next));
  return { ok: true };
}

/**
 * Every conversation of this being that has anything queued or a live lease.
 * This is what a poller iterates; it deliberately returns the conversation
 * IDS only, so the caller decides what (if anything) to load.
 */
export async function queuedConversations(
  being: string,
  opts?: Opts
): Promise<Array<{ convoId: string; count: number; leased: boolean }>> {
  const root = path.join(beingsRoot(opts), sanitizeBeingName(being), 'queue');
  let names: string[];
  try {
    // Plain `isDirectory()` on purpose. It returns FALSE for a Windows
    // junction (that cost this house a silently invisible letter inbox on
    // 2026-10-26, fixed in fsStorage.listDirs by also following
    // isSymbolicLink). Every directory under queue/ is created by `enqueue`
    // with fs.mkdir, so a junction here would mean someone put it there by
    // hand — and a queue that drains through a link into another install's
    // store is exactly the cross-instance confusion the lease is guarding
    // against. Not following links here is the safe direction.
    names = await fs.readdir(root, { withFileTypes: true }).then((es) =>
      es.filter((e) => e.isDirectory()).map((e) => e.name)
    );
  } catch (e) {
    if (errCode(e) === 'ENOENT') return [];
    throw e;
  }
  const out: Array<{ convoId: string; count: number; leased: boolean }> = [];
  for (const convoId of names.sort()) {
    const items = await pending(being, convoId, opts);
    const lease = await readLease(being, convoId, opts);
    if (items.length === 0 && !lease) continue;
    out.push({ convoId, count: items.length, leased: !!lease });
  }
  return out;
}

/** `user_message` payload shape. */
export interface UserMessagePayload {
  /** The text EXACTLY as it would have been sent directly, label included. */
  text: string;
  attachments?: unknown[];
}

/**
 * `rerun` / `continue` payload shape: a pointer, never a body.
 *
 * The id and NOT the index, because the queue and the runner read the log at
 * two different moments. An index would silently name a different message if
 * anything landed in between; an id that no longer exists is a failure the
 * runner can report, which is the difference between "nothing happened, here
 * is why" and "something happened to the wrong message".
 */
export interface CommandPayload {
  targetMsgId: string;
}

/**
 * Take the longest leading run of items that can form ONE turn together.
 *
 * FIFO is the whole contract of this queue, so the answer is always a PREFIX:
 * nothing is reordered and nothing is skipped over. Two shapes exist —
 *
 *   [user, user, user]            → all three (they merge, composeBatch)
 *   [rerun, …]                    → just the rerun (a command stands alone)
 *   [user, user, rerun, user]     → the two users; the rerun waits for the
 *                                   next pass, which then takes it alone
 *
 * WHY THIS EXISTS AT ALL: before commands, every item merged, so the runner
 * could take the claim whole and the tick route could consume every id it was
 * given. The first mixed batch breaks both — composeBatch would SKIP the
 * command (no payload.text) while the route released its id anyway, and the
 * rerun would vanish with no error anywhere. That is the exact failure
 * `Batch.skipped` warns about, so the fix belongs here rather than in a
 * caller remembering to check.
 *
 * `rest` is returned rather than implied so a caller cannot compute it a
 * second, differing way.
 */
export function splitLeadingTurn(items: QueueItem[]): { take: QueueItem[]; rest: QueueItem[] } {
  if (items.length === 0) return { take: [], rest: [] };
  if (isCommandKind(items[0].kind)) return { take: [items[0]], rest: items.slice(1) };
  let n = 0;
  while (n < items.length && !isCommandKind(items[n].kind)) n++;
  return { take: items.slice(0, n), rest: items.slice(n) };
}

export interface Batch {
  text: string;
  attachments: unknown[];
  /**
   * Items this function refused to render, with why. Never silently dropped:
   * a message that vanishes between the stock and the log is the failure this
   * whole module is built to make impossible, and that includes vanishing
   * inside the formatter.
   *
   * A skipped item contributes NOTHING — not its text, not its attachments.
   * The caller must not list it in `release`'s consumedIds: it stays in the
   * stock for a kind-aware renderer later. Taking its bytes now would deliver
   * them a second time then, and would make "skipped" a false report.
   */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Split what is on disk into "a turn is working on these" and "these are
 * still waiting", given the lease (or null when nobody holds one).
 *
 * WHY THIS IS NOT THE ROUTE'S JOB: the route file states it holds no rules,
 * because `next/server` cannot be imported outside Next's runtime and anything
 * decided there is untestable. This is a rule — specifically the rule that a
 * count of files means two different things depending on the lease — so it
 * lives here with the rest of them and has tests.
 *
 * THE THREE CASES, named because they used to all print the same number:
 *   no lease          → everything is waiting. Nothing is running.
 *   lease + claimedIds → exact split.
 *   lease, no ids      → a lease written before `claimedIds` existed, or whose
 *                        id write failed. We know SOME items are claimed but
 *                        not which, so we report `claimedUnknown` rather than
 *                        guessing. A caller that renders a guess here would be
 *                        telling someone their message is in flight when it
 *                        may be the one still waiting.
 */
export function splitByLease(
  items: QueueItem[],
  lease: Lease | null
): { claimed: QueueItem[]; waiting: QueueItem[]; claimedUnknown: boolean } {
  if (!lease) return { claimed: [], waiting: items, claimedUnknown: false };
  const ids = lease.claimedIds;
  if (!Array.isArray(ids)) {
    return { claimed: [], waiting: items, claimedUnknown: true };
  }
  const set = new Set(ids);
  return {
    claimed: items.filter((i) => set.has(i.id)),
    waiting: items.filter((i) => !set.has(i.id)),
    claimedUnknown: false,
  };
}

/**
 * Is there nothing here to wake anyone for?
 *
 * ONE rule, two places that must agree: the enqueue route refuses a blank
 * send, and the runner refuses to POST a blank turn. They look at different
 * inputs — a request body before it is stored, a composed batch after — and
 * the rule is the same sentence about both. Written down once because the two
 * drifting apart has a specific, silent shape: the route accepts something the
 * runner then sends to a model as an empty user message, which is a real turn,
 * billed, with an answer to nothing.
 *
 * Attachments alone ARE enough: an image with no caption is a message.
 */
export function isEmptyTurnText(text: unknown, attachments: unknown): boolean {
  const hasText = typeof text === 'string' && text.trim().length > 0;
  const hasFiles = Array.isArray(attachments) && attachments.length > 0;
  return !hasText && !hasFiles;
}

/**
 * Render a claimed batch as ONE user message — his requirement B ("several
 * messages shown together, each with a sender label").
 *
 * ── One item is byte-identical to a direct send ─────────────────────────────
 * The single-item case returns the text verbatim: no label line, no separator,
 * nothing added. That is deliberate. Requirement A (one message in the stock)
 * must produce exactly the log a plain send produces today, or the stock
 * becomes a second format for the commonest path in the product and every
 * reader of a log has to know which one produced it.
 *
 * ── Why the label is conditional, and why that is not a heuristic ───────────
 * The `[name]` prefix has an owner today: InputArea applies it on send when the
 * user identity is a real name (empty / "User" / "Anonymous" are skipped on
 * purpose — a meaningless tag burning tokens). So a queued user_message USUALLY
 * already carries its label inside the text. The future kinds do not: a letter
 * or a schedule tick has no InputArea between it and here. Emitting `[from]`
 * unconditionally would double the label on the common case; emitting it never
 * would leave the future kinds anonymous. So it is emitted only when the text
 * does not already start with that exact label — a test, not a guess, and one
 * place owns it.
 */
export function composeBatch(items: QueueItem[]): Batch {
  const skipped: Array<{ id: string; reason: string }> = [];
  const usable: QueueItem[] = [];
  for (const it of items) {
    const p = it.payload as UserMessagePayload | null;
    if (!p || typeof p.text !== 'string') {
      skipped.push({ id: it.id, reason: `kind=${it.kind} has no string payload.text` });
      continue;
    }
    usable.push(it);
  }

  const attachments: unknown[] = [];
  for (const it of usable) {
    const p = it.payload as UserMessagePayload;
    if (Array.isArray(p.attachments)) attachments.push(...p.attachments);
  }

  if (usable.length === 0) return { text: '', attachments, skipped };

  const textOf = (it: QueueItem) => (it.payload as UserMessagePayload).text;

  if (usable.length === 1) {
    return { text: textOf(usable[0]), attachments, skipped };
  }

  const blocks = usable.map((it) => {
    const body = textOf(it);
    const label = (it.from || '').trim();
    if (!label || body.startsWith(`[${label}]`)) return body;
    return `[${label}]\n${body}`;
  });
  // A blank line between blocks — the same separation a human reading two
  // consecutive messages sees, and the shape the `[Name]` transcript
  // convention already uses elsewhere in this house. No new convention.
  return { text: blocks.join('\n\n'), attachments, skipped };
}
