// ── Mid-turn "partner interjection" queue ────────────────────────────────────
// Lets you push a message INTO a turn that is already running — e.g. to steer a
// long multi-tool task while you watch it work. A chat request is a single SSE
// stream, but the interjection arrives LATER on a separate HTTP request
// (POST /api/chat/inject). That request drops the text into a per-turn queue
// here, keyed by a turnId the frontend generates and sends in the chat body.
//
// The running turn drains the queue at points where it's about to build the
// next model call:
//   • Non-OAuth (Nexus drives the tool loop): at each tool-loop iteration
//     boundary — the drained text is appended as an extra user turn, so the
//     model sees it on its very next step. TRUE mid-turn injection.
//   • OAuth / Agent SDK (the SDK drives the loop): inside the canUseTool
//     callback, which fires before every tool call — the pending text is
//     delivered by pausing that one tool call with the note, then the retry
//     proceeds. TRUE mid-loop, at the next tool boundary.
//
// Stored on globalThis so Next.js dev hot-reload doesn't orphan a queue
// mid-turn (same pattern as the AskQuestion rendezvous + saveLog write-locks).

/**
 * One media attachment riding along with an interjection.
 *
 * Only the REF is queued, never the bytes. The browser already externalized
 * every attachment into the content-addressed store at attach time (see
 * InputArea.processFiles → uploadAttachment), so the payload is on disk before
 * the interjection is even sent, and holding a second copy of a 20 MB video in
 * a globalThis map for the length of a turn would be pure waste.
 *
 * `kind` is resolved once, at the endpoint, from the mime type — so every drain
 * point asks the same question of the same answer instead of re-sniffing.
 */
export interface InjectedMedia {
  ref: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'audio' | 'video';
}

/** What one drained interjection carries. */
export interface DrainedInjection {
  texts: string[];
  media: InjectedMedia[];
}

interface Queued { texts: string[]; media: InjectedMedia[]; ts: number }
const _g = globalThis as any;
if (!_g.__nx_inject_pending) _g.__nx_inject_pending = new Map<string, Queued>();
const pending: Map<string, Queued> = _g.__nx_inject_pending;

// ── System notes ────────────────────────────────────────────────────────────
// Server-generated notices delivered to the entity MID-TURN — e.g. "automatic
// compaction just replaced your conversation history with a summary". Same
// queue mechanics as partner interjections, but a different framing: a system
// note is infrastructure fact, not a human message, so it is drained SEPARATELY
// and never wrapped in `injectionFraming`. Boundary visibility, not instruction
// — the note states what changed, and deliberately says nothing the entity
// "should" do.
const _g2 = globalThis as any;
if (!_g2.__nx_sysnote_pending) _g2.__nx_sysnote_pending = new Map<string, Queued>();
const sysPending: Map<string, Queued> = _g2.__nx_sysnote_pending;

// Entries whose turn ended without their queue being drained (e.g. the entity
// stopped making tool calls) would otherwise linger forever. Drop anything
// older than this on the next push, keeping the map bounded without needing
// every provider path to call clearInjections on all its exit branches.
const STALE_MS = 15 * 60 * 1000;
function pruneStale() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.ts > STALE_MS) pending.delete(k);
  }
  for (const [k, v] of sysPending) {
    if (now - v.ts > STALE_MS) sysPending.delete(k);
  }
  // `undelivered` is declared further down (it is only reachable through the
  // functions below), so guard against the first prune running before it is
  // initialized during module evaluation.
  const un: Map<string, Queued> | undefined = (globalThis as any).__nx_inject_undelivered;
  if (un) {
    for (const [k, v] of un) {
      if (now - v.ts > STALE_MS) un.delete(k);
    }
  }
}

/**
 * Queue an interjection for a running turn. Returns false on empty input —
 * which now means "no text AND no media", because an attachment with no
 * covering sentence is a complete message ("look at this").
 */
export function pushInjection(turnId: string, text: string, media?: InjectedMedia[]): boolean {
  if (!turnId) return false;
  const body = typeof text === 'string' ? text.trim() : '';
  const files = Array.isArray(media) ? media.filter((m) => m && typeof m.ref === 'string' && m.ref) : [];
  if (!body && files.length === 0) return false;
  pruneStale();
  const entry = pending.get(turnId) || { texts: [], media: [], ts: Date.now() };
  if (body) entry.texts.push(body);
  if (files.length) entry.media.push(...files);
  entry.ts = Date.now();
  pending.set(turnId, entry);
  return true;
}

/**
 * Take and remove everything queued for a turn.
 *
 * Returns an OBJECT, not a string array: media has to travel with the text it
 * was sent alongside, and the two must be drained in one atomic step or a
 * second drain at the next tool boundary would deliver the image without its
 * sentence (or vice versa).
 */
export function drainInjections(turnId: string): DrainedInjection {
  const empty: DrainedInjection = { texts: [], media: [] };
  if (!turnId) return empty;
  const entry = pending.get(turnId);
  if (!entry || (entry.texts.length === 0 && entry.media.length === 0)) return empty;
  pending.delete(turnId);
  return { texts: entry.texts, media: entry.media };
}

/** Queue a system note (infrastructure fact) for a running turn. */
export function pushSystemNote(turnId: string, text: string): boolean {
  if (!turnId || typeof text !== 'string' || !text.trim()) return false;
  pruneStale();
  const entry = sysPending.get(turnId) || { texts: [], media: [], ts: Date.now() };
  entry.texts.push(text.trim());
  entry.ts = Date.now();
  sysPending.set(turnId, entry);
  return true;
}

/** Take and remove all queued system notes for a turn (empty array if none). */
export function drainSystemNotes(turnId: string): string[] {
  if (!turnId) return [];
  const entry = sysPending.get(turnId);
  if (!entry || entry.texts.length === 0) return [];
  sysPending.delete(turnId);
  return entry.texts;
}

// ── Undelivered interjections ───────────────────────────────────────────────
// An interjection can only be handed over at a TOOL-CALL BOUNDARY. A turn that
// makes no tool call after one arrives has nowhere to put it, and until
// 2026-11-04 that entry was simply dropped — by `clearInjections` on the OAuth
// path, by the 15-minute prune everywhere else. The send looked identical
// whether it landed or not.
//
// So a dropped interjection is MOVED here instead of deleted, and the sender
// collects it with GET /api/chat/inject once the turn ends. Doing it this way
// rather than enqueueing a notice before each stream close is deliberate: there
// are eleven stream exits across five provider paths, and a rule that has to be
// re-applied at eleven sites is a rule that will be three-quarters applied the
// next time a path is added. This single store covers every path, including the
// ones that never call `clearInjections` at all.
//
// Same staleness bound as the live queue — a sender who never comes back for it
// must not pin the text in memory forever.
const _g3 = globalThis as any;
if (!_g3.__nx_inject_undelivered) _g3.__nx_inject_undelivered = new Map<string, Queued>();
const undelivered: Map<string, Queued> = _g3.__nx_inject_undelivered;

/**
 * Discard leftovers for a turn, keeping any undelivered INTERJECTION so the
 * sender can be told. Call when the turn ends.
 *
 * System notes are dropped outright: those are generated by this house, not
 * sent by a person, so there is nobody to report the loss to.
 */
export function clearInjections(turnId: string): void {
  if (!turnId) return;
  const left = pending.get(turnId);
  if (left && (left.texts.length > 0 || left.media.length > 0)) {
    pending.delete(turnId);
    undelivered.set(turnId, { ...left, ts: Date.now() });
  } else {
    pending.delete(turnId);
  }
  sysPending.delete(turnId);
}

/**
 * Take whatever never reached the entity for this turn, and forget it.
 *
 * Reads BOTH stores on purpose. `undelivered` holds what an exit path moved
 * aside; `pending` holds the paths that never call `clearInjections` — for
 * those, "still queued after the turn ended" IS the undelivered set. The caller
 * knows the turn is over; this function cannot know that on its own, which is
 * why it does not try to decide.
 */
export function takeUndelivered(turnId: string): DrainedInjection {
  const empty: DrainedInjection = { texts: [], media: [] };
  if (!turnId) return empty;
  pruneStale();
  const moved = undelivered.get(turnId);
  const still = pending.get(turnId);
  undelivered.delete(turnId);
  pending.delete(turnId);
  const texts = [...(moved?.texts ?? []), ...(still?.texts ?? [])];
  const media = [...(moved?.media ?? []), ...(still?.media ?? [])];
  if (texts.length === 0 && media.length === 0) return empty;
  return { texts, media };
}

// Central framing so every provider path phrases an interjection identically —
// clearly a real-time human note, NOT an error or a system directive. The
// wrapper text comes from the per-Entity-customizable `injectionFraming`
// instruction (see agentInstructions.ts): the `{messages}` token is replaced
// with the note(s); if the template has no token, the notes are appended after
// it. A blank template falls back to the note text alone.
export function frameInjection(texts: string[], template?: string): string {
  const body = texts.map((t) => `“${t}”`).join('\n');
  const tpl = (template ?? '').trim();
  if (!tpl) return body;
  if (tpl.includes('{messages}')) return tpl.replace('{messages}', body);
  return `${tpl}\n${body}`;
}
