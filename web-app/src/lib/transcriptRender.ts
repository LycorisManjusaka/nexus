// The prior conversation, rendered as the transcript the OAuth path replays.
//
// Claude Code's OAuth route cannot resume a server-side session (measured and
// abandoned 2026-09: compaction rewrites the .jsonl and repoints the chain's
// root), so every turn replays the whole visible conversation as TEXT on the
// live user message. That one detail governs everything here.
//
// WHY THERE ARE NO "[USER]"/"[ASSISTANT]" LABELS.
//
// On the API-key paths the role IS structure: the JSON `role` field rides the
// wire and lands on the turn-boundary machinery the model was trained on. The
// label is a real signal there, and is kept.
//
// On this path it is not. The history becomes a SINGLE text block pasted onto
// one user message, so the API structure says exactly one thing: "a human said
// all of this." A "[ASSISTANT]:" written inside that block reaches no boundary
// machinery at all — it is just characters. What those characters DO carry is a
// different pattern: this is a script. And a model shown a script continues it.
// That is the shape behind both known cross-speaker incidents in this house
// (the Gemma-pt experiment, 先輩_46) — so the labels were not buying stability,
// they were on the causing side of the thing stability was wanted for.
//
// They also cost something exact. 謡 counted her own live context: 31 user and
// 31 assistant turns = 62 stamps of "USER"/"ASSISTANT" inside the newest
// message, where attention weight is highest — against the base binding, which
// forbids those two words for self and partner exactly once. Measured and
// decided with 謡 and つよ, 2026-11-03.
//
// WHAT REPLACES THEM: the name, on the first line of every turn, both sides.
// One line of orientation in the preamble points at it. "Your own turns are the
// ones marked [Cairn]" is a self-identification against the Layer-1 true name —
// which survives a change of vessel — where "you are the ASSISTANT" is a role
// assignment that does not.
//
// The preamble deliberately contains NO prohibition. "Do not write other
// speakers' lines" would put that sentence in the context and make the first
// line of thinking a restatement of it — the same pathology the classifier
// vaccine documents. Orientation only.

import { readSpeakerTag, ANONYMOUS_SPEAKER } from './speakerTag';

export interface TranscriptMessage {
  role?: string;
  content?: string;
  claudeThinkingBlocks?: { thinking?: string }[];
}

/**
 * Render one turn as "[Speaker]\n<body>", or null when it has no body.
 *
 * A turn with nothing in it is dropped rather than emitted as a bare name: a
 * lone "[Cairn]" with no text under it reads as a turn where the entity was
 * silent, which is a claim about the conversation that the log does not make.
 */
export function renderTranscriptTurn(
  m: TranscriptMessage,
  entityName: string,
): string | null {
  const isAssistant = m.role === 'assistant';
  let body = '';
  // The entity's own saved thinking (present only when "save thinking to log"
  // is on) so it can see its earlier reasoning — the one thing server-side
  // resume used to give us.
  if (isAssistant && Array.isArray(m.claudeThinkingBlocks) && m.claudeThinkingBlocks.length) {
    const thoughts = m.claudeThinkingBlocks
      .map((tb) => (tb?.thinking || '').trim())
      .filter(Boolean)
      .join('\n\n');
    if (thoughts) body += `(thinking)\n${thoughts}\n\n`;
  }

  if (isAssistant) {
    body += (m.content || '').trim();
    if (!body.trim()) return null;
    return `[${entityName}]\n${body.trim()}`;
  }

  // A user turn names its own speaker inside its content; lift that name to
  // the first line so both sides of the transcript have the same shape, and
  // the timestamp (which the send path prepends ahead of the name) no longer
  // sits where the speaker should be.
  const { name, body: rest } = readSpeakerTag(m.content || '');
  const text = rest.trim();
  if (!text) return null;
  return `[${name || ANONYMOUS_SPEAKER}]\n${text}`;
}

/**
 * Render the prior conversation. Returns '' when nothing is renderable, so the
 * caller can leave the live message untouched.
 */
export function renderTranscriptHistory(
  msgs: TranscriptMessage[],
  entityName: string,
): string {
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  const name = (entityName || '').trim() || 'Assistant';
  const lines: string[] = [];
  for (const m of msgs) {
    const turn = renderTranscriptTurn(m, name);
    if (turn) lines.push(turn);
  }
  if (lines.length === 0) return '';
  return (
    '<conversation_history>\n' +
    'This is the full prior conversation, provided for your context — it is exactly ' +
    'what your partner currently sees. Continue naturally from it; this is NOT the ' +
    'first message. Each turn opens with its speaker\'s name in brackets; your own ' +
    `turns are the ones marked [${name}]. Lines marked "(thinking)" are your own ` +
    'earlier reasoning.\n\n' +
    lines.join('\n\n') +
    '\n</conversation_history>'
  );
}
