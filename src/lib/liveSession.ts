/**
 * Module-level Live Session state. Single-user dev: at most one active session.
 *
 * The session holds:
 *   - The WebSocket to Gemini Live
 *   - File watchers for kohai.txt / ear_log.txt / VRChat dir
 *   - The SSE controller that pushes events to the browser
 *   - Accumulated transcript entries (timestamped) for final log merge
 *
 * IMPORTANT: this only works because the Next.js dev server runs as a
 *  single Node process. In production / serverless this would need to live
 *  in Redis or similar. We're explicitly local-only.
 */

import type { FSWatcher } from 'fs';

export interface LiveTranscriptEntry {
  ts: number;          // epoch ms
  role: 'user' | 'human' | 'assistant';
  text: string;
  thought?: string;    // assistant-only: the accumulated thinking content for this turn
}

export interface LiveImageEntry {
  ts: number;
  filePath: string;
  dataUrl: string;     // already converted to JPEG
  width: number;
  height: number;
}

export interface LiveSessionState {
  sessionId: string;       // unique per start() call; used to ignore stale callbacks
  ws: WebSocket | null;
  setupComplete: boolean;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  encoder: TextEncoder;
  // Events that arrived before the SSE stream was attached
  bufferedEvents: any[];
  // file watchers / cleanup hooks
  watchers: FSWatcher[];
  filePos: { kohai: number; ear: number };
  // accumulated state
  transcripts: LiveTranscriptEntry[];
  images: LiveImageEntry[];
  cumulativeTokens: number;
  contextLimit: number;
  pendingAssistantText: string;
  pendingAssistantThought: string;
  startedAt: number;
  // teardown
  closed: boolean;
}

// Stash on globalThis so hot-reloads in dev don't leak orphan WebSockets and
// file watchers from previous module instances. Without this, a code change
// during testing left old watchers alive — they kept tailing kohai.txt and
// pushing duplicate transcripts to a session the user thought was already gone.
const _g = globalThis as any;
if (!_g.__nx_live_singleton) _g.__nx_live_singleton = { state: null as LiveSessionState | null };

export function getSession(): LiveSessionState | null { return _g.__nx_live_singleton.state; }
export function setSession(s: LiveSessionState | null) { _g.__nx_live_singleton.state = s; }

export function emit(event: any) {
  const state = getSession();
  if (!state || state.closed) return;
  if (!state.controller) {
    // SSE not yet connected — buffer for later flush.
    state.bufferedEvents.push(event);
    return;
  }
  try {
    state.controller.enqueue(state.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  } catch {}
}

export function flushBuffered() {
  const state = getSession();
  if (!state || !state.controller || state.closed) return;
  const buf = state.bufferedEvents;
  state.bufferedEvents = [];
  for (const event of buf) {
    try {
      state.controller.enqueue(state.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {}
  }
}

export function teardown() {
  const state = getSession();
  if (!state) return;
  state.closed = true;
  for (const w of state.watchers) {
    try { w.close(); } catch {}
  }
  state.watchers = [];
  // Close the @google/genai live session if present
  const live = (state as any).live;
  if (live) {
    try { live.close(); } catch {}
    (state as any).live = null;
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try { state.ws.close(); } catch {}
  }
  state.ws = null;
}
