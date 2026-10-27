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
// 3001 are two Next installs on one shared local_data (and 3000 is on `dev`
// while 3001 stays on `main`). `fs.open(path, 'wx')` is the primitive that
// fails when the file exists; an in-process Map would not see the other install.
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

/**
 * What woke (or will wake) the being. Only `user_message` is produced today;
 * the others are the extension points phase 4c/4d land on and are declared
 * here so the on-disk shape does not have to change when they arrive.
 */
export type QueueItemKind = 'user_message' | 'letter' | 'schedule' | 'system';

export interface QueueItem {
  /** Unique per item. Also the ack/dedupe handle for the enqueuer. */
  id: string;
  /** Epoch ms at enqueue. FIFO is by this value, ties broken by `id`. */
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
  /** Nothing to do. No lease was left behind. */
  | { ok: false; reason: 'empty' };

interface Opts {
  /** Override the beings root. Tests point this at a temp dir; nothing else should. */
  beingsDir?: string;
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
  draft: { kind?: QueueItemKind; from: string; payload: unknown },
  opts?: Opts
): Promise<{ item: QueueItem; position: number }> {
  if (!being || !convoId) throw new Error('turnQueue.enqueue: being and convoId are required');
  const dir = queueDir(being, convoId, opts);
  await fs.mkdir(dir, { recursive: true });

  const item: QueueItem = {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind: draft.kind || 'user_message',
    from: draft.from || '',
    payload: draft.payload ?? null,
  };

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
): Promise<{ items: QueueItem[]; unreadable: string[] }> {
  const dir = queueDir(being, convoId, opts);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { items: [], unreadable: [] };
    throw e;
  }
  const items: QueueItem[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter(isItemFile).sort()) {
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
        unreadable.push(name);
        continue;
      }
      items.push(parsed as QueueItem);
    } catch {
      unreadable.push(name);
    }
  }
  return { items, unreadable };
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

  const items = await pending(being, convoId, opts);
  if (items.length === 0) {
    // Nothing to run. Give the lease back rather than hold it for a poll that
    // found nothing — `release` is used so the same ownership check applies.
    await release(being, convoId, lease.token, [], opts);
    return { ok: false, reason: 'empty' };
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

/** `user_message` payload shape. The only kind produced today. */
export interface UserMessagePayload {
  /** The text EXACTLY as it would have been sent directly, label included. */
  text: string;
  attachments?: unknown[];
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
