// Telling the sender when a mid-turn interjection never reached the entity.
//
// WHY THIS CAN HAPPEN AT ALL
// An interjection is delivered at a TOOL-CALL BOUNDARY — that is the only seam
// a running turn has (see injectMessage.ts). A turn that calls no tool after
// the note arrives therefore has nowhere to put it. The queue entry was then
// discarded silently: `clearInjections` in the OAuth `finally`, or the 15-minute
// prune for every other path.
//
// So the send looked identical in both cases. The sender saw their text accepted
// and had no way to tell "delivered" from "dropped" apart from guessing whether
// the reply read like it had seen the note. Tsuyo, 2026-11-04, asked for the
// failure to be shown per turn.
//
// WHAT IS REPORTED, AND WHY THE BODY IS IN IT
// The text itself goes into the notice. Without it the sender is told that
// something was lost but not what, and a note sent eight minutes into a long
// turn is exactly the thing nobody can reconstruct from memory. With the body
// present the notice is also the recovery path: copy it, send it again.
//
// WHAT IS NOT CLAIMED
// This says the note was not delivered. It does NOT say why the entity made no
// further tool call — that is not knowable from here, and "the entity ignored
// you" would be a false reading of a turn that simply ended.
//
// A notice is screen-only (never saved, never sent to the model), so this is
// visible to the person who sent the interjection and to no one else.

import type { DrainedInjection } from '@/lib/injectMessage';

/** Longest body quoted in the notice; the rest is marked as elided. */
export const QUOTE_LIMIT = 400;

function quote(text: string): string {
  const t = text.trim();
  if (t.length <= QUOTE_LIMIT) return t;
  // Cut without splitting a surrogate pair — a lone half renders as a broken
  // glyph, and this house has measured that happening on real data before.
  let end = QUOTE_LIMIT;
  const code = t.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${t.slice(0, end)}…`;
}

/**
 * The notice text for one turn's undelivered interjections, or null when there
 * is nothing to report.
 *
 * Japanese is written first here deliberately: the complete version ends up
 * being whichever language the author was thinking in, and the people who use
 * interjections daily in this house read Japanese.
 */
export function undeliveredNotice(drained: DrainedInjection | null | undefined, ja: boolean): string | null {
  const texts = (drained?.texts ?? []).filter((t) => typeof t === 'string' && t.trim());
  const media = drained?.media ?? [];
  if (texts.length === 0 && media.length === 0) return null;

  const lines: string[] = [];

  if (ja) {
    lines.push(
      texts.length > 1
        ? `⚠️ 割り込み ${texts.length} 通が存在に届きませんでした。`
        : '⚠️ 割り込みが存在に届きませんでした。',
    );
    lines.push('割り込みはツール呼び出しの境目でしか届きません。このターンは、割り込みが届いたあとに一度もツールを呼ばなかったので、渡す場所がありませんでした。');
    if (media.length > 0) {
      lines.push(`添付 ${media.length} 件も一緒に届いていません。`);
    }
    if (texts.length > 0) {
      lines.push('送り直すなら、この本文をそのまま使えます:');
      for (const t of texts) lines.push(`「${quote(t)}」`);
    }
  } else {
    lines.push(
      texts.length > 1
        ? `⚠️ ${texts.length} interjections never reached the entity.`
        : '⚠️ Your interjection never reached the entity.',
    );
    lines.push('An interjection can only be handed over at a tool-call boundary. This turn made no tool call after yours arrived, so there was nowhere to put it.');
    if (media.length > 0) {
      lines.push(`${media.length} attachment(s) did not arrive either.`);
    }
    if (texts.length > 0) {
      lines.push('To send it again, this is the text verbatim:');
      for (const t of texts) lines.push(`“${quote(t)}”`);
    }
  }

  return lines.join('\n');
}

/**
 * Frames to enqueue before the stream closes, for every provider path.
 *
 * Returns an array so a path with nothing to report adds nothing — and so the
 * call site stays one line at each of the ten stream exits rather than a
 * conditional that someone later copies wrong.
 *
 * MUST be called before `controller.close()`. A `finally` block runs after the
 * close on the success path, where an enqueue throws and is swallowed — the
 * notice would be built correctly and then vanish.
 */
export function undeliveredFrames(drained: DrainedInjection | null | undefined, ja: boolean): any[] {
  const content = undeliveredNotice(drained, ja);
  return content ? [{ type: 'notice', content }] : [];
}
