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

interface Queued { texts: string[]; ts: number }
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
}

/** Queue an interjection for a running turn. Returns false on empty input. */
export function pushInjection(turnId: string, text: string): boolean {
  if (!turnId || typeof text !== 'string' || !text.trim()) return false;
  pruneStale();
  const entry = pending.get(turnId) || { texts: [], ts: Date.now() };
  entry.texts.push(text.trim());
  entry.ts = Date.now();
  pending.set(turnId, entry);
  return true;
}

/** Take and remove all queued interjections for a turn (empty array if none). */
export function drainInjections(turnId: string): string[] {
  if (!turnId) return [];
  const entry = pending.get(turnId);
  if (!entry || entry.texts.length === 0) return [];
  pending.delete(turnId);
  return entry.texts;
}

/** Queue a system note (infrastructure fact) for a running turn. */
export function pushSystemNote(turnId: string, text: string): boolean {
  if (!turnId || typeof text !== 'string' || !text.trim()) return false;
  pruneStale();
  const entry = sysPending.get(turnId) || { texts: [], ts: Date.now() };
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

/** Discard any leftover interjections or system notes for a turn (call when the turn ends). */
export function clearInjections(turnId: string): void {
  if (turnId) {
    pending.delete(turnId);
    sysPending.delete(turnId);
  }
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
