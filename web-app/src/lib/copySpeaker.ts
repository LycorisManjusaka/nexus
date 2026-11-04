/**
 * What lands on the clipboard when someone copies one message.
 *
 * Why this exists: a USER message already carries its speaker in the body. The
 * .md dialect writes `[Name]` as the first line of the turn and the parser
 * reads it back from there, so Pilot's own turns begin with `[Пилот]` and
 * survive being pasted anywhere. A BEING's message does not — the name is
 * drawn by the bubble from `msg.name` (falling back to the folder it lives in)
 * and lives nowhere inside the text. So copying a being's reply and pasting it
 * into a chat produced an unattributed wall of text, while copying the human's
 * turn right above it produced an attributed one.
 *
 * Reported 2026-11-04 by Lizard-kun: Pilot copies messages out of NEXUS and
 * sends them to him; hers arrive named, the Navigator's arrive anonymous. His
 * words for the fix: "that way it ends up equal."
 *
 * The name resolved here is deliberately the SAME expression the bubble renders
 * (`msg.name || folderName`). If the two ever disagree, the clipboard would
 * attribute a message to someone other than the name the person was looking at
 * when they pressed the button — a false signpost, and the one failure mode
 * that matters here.
 */

export interface CopySpeakerInput {
  content: string;
  role: string;
  /** Baked into the message at save time. Wins when present. */
  name?: string | null;
  /** The being whose folder this conversation lives in. Fills the gap only. */
  folderName?: string | null;
}

/**
 * The name the bubble shows above a being's message, or null when it shows
 * none. Mirrors `!isUser && (msg.name || folderName)` in MessageBubble.
 */
export function copySpeakerName(input: CopySpeakerInput): string | null {
  if (input.role === 'user') return null;
  const name = (input.name || input.folderName || '').trim();
  return name ? name : null;
}

/**
 * True when `content` already opens with this speaker's own tag. Copying an
 * imported transcript, or a being that quoted its own header, must not end up
 * double-stamped.
 */
function alreadyTagged(content: string, name: string): boolean {
  // Only the very first line counts. A `[Name]` further down is body text.
  const firstLine = content.replace(/^﻿/, '').split('\n', 1)[0].trim();
  if (!firstLine.startsWith('[')) return false;
  const close = firstLine.indexOf(']');
  if (close < 0) return false;
  const tag = firstLine.slice(1, close).trim();
  // A header occupies the WHOLE line. Measured against the parser rather than
  // assumed: markdownLogic matches `/^\[(.+)\]:[ \t]*$/`. So `[Name]: text` is
  // one line of prose that opens with a bracket — treating it as a header would
  // drop the attribution this file exists to add. The colon is optional here
  // because the form this file WRITES has none (`[Name]\n`), and the OAuth
  // transcript uses that same bare form (see speakerTag.ts).
  const rest = firstLine.slice(close + 1).trim();
  if (rest !== '' && rest !== ':') return false;
  return tag === name;
}

/**
 * The text to put on the clipboard for one message.
 *
 * A user turn is returned untouched — its speaker is already the first line,
 * and prepending anything would either duplicate it or overwrite it.
 */
export function copyTextForMessage(input: CopySpeakerInput): string {
  const content = String(input.content ?? '');
  const name = copySpeakerName(input);
  if (!name) return content;
  if (alreadyTagged(content, name)) return content;
  // An empty body still gets the header: "this turn was empty" is information,
  // and a Stop that reached no output is exactly that.
  return content ? `[${name}]\n${content}` : `[${name}]\n`;
}
