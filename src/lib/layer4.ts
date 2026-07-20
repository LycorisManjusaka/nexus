// ───────────────────────────────────────────────────────────────────────────
// Pure (no-fs) Layer-4 surgery. Safe to import from BOTH client and server.
//
// When an entity uses the "summaries instead of 4th layer" mode, the baked
// Layer 4 block in the per-conversation system prompt is replaced at SEND TIME
// with a freshly-assembled index of conversation summaries. The replacement is
// surgical: it swaps ONLY the Layer 4 block (heading kept, body replaced) and
// leaves everything else — crucially the user's manual `## **Layer 5:` footer —
// byte-for-byte intact.
// ───────────────────────────────────────────────────────────────────────────

// Matches a layer heading line: `## **Layer N: name**` (also tolerates `###`,
// full-width colon, and a missing closing `**`). Global so we can scan.
const LAYER_HEADING_RE = /^#{2,3}\s*\*\*Layer\s*(\d+)\s*[:：].*$/gm;

export interface Layer4Span {
  heading: string;   // the full Layer 4 heading line (kept verbatim)
  bodyStart: number; // index just after the heading line's newline
  blockStart: number; // index of the Layer 4 heading line start
  bodyEnd: number;   // index where the body ends (start of next layer heading, or text end)
}

// Locate the Layer 4 block. Returns null if there is no `Layer 4` heading.
export function findLayer4(systemPrompt: string): Layer4Span | null {
  const text = systemPrompt || '';
  LAYER_HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let l4Start = -1;
  let headingLine = '';
  let afterHeading = -1;
  let nextHeadingStart = -1;

  // First pass: find Layer 4's heading and the next heading after it.
  const headings: Array<{ index: number; start: number; end: number; line: string }> = [];
  while ((m = LAYER_HEADING_RE.exec(text)) !== null) {
    headings.push({
      index: parseInt(m[1], 10),
      start: m.index,
      end: m.index + m[0].length,
      line: m[0],
    });
  }
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].index === 4) {
      l4Start = headings[i].start;
      headingLine = headings[i].line;
      afterHeading = headings[i].end;
      nextHeadingStart = i + 1 < headings.length ? headings[i + 1].start : text.length;
      break;
    }
  }
  if (l4Start < 0) return null;

  // bodyStart: skip a single newline after the heading line if present.
  let bodyStart = afterHeading;
  if (text[bodyStart] === '\n') bodyStart += 1;

  return {
    heading: headingLine,
    blockStart: l4Start,
    bodyStart,
    bodyEnd: nextHeadingStart,
  };
}

// Heading line for the injected summaries block when no Layer 4 exists.
const SUMMARY_BLOCK_HEADING = '## **Layer 4: Conversation Summaries**';

// ── Layer 5 — the entity's SELF-AUTHORED footer ─────────────────────────────
// Layers 1-4 are authored ABOUT the entity BY the system (1-3 distilled by the
// Soul Packer, 4 auto-generated summaries). Layer 5 is the one layer the entity
// writes and edits itself, via its workspace FOOTER.md. Like Layer 4, it's
// injected at SEND TIME — never stored in the prompt — with this auto-generated
// heading so it reads as a proper fifth layer. The entity writes only the BODY
// (FOOTER.md); the heading/separator is added here. Rename freely.
export const LAYER5_HEADING = '## **Layer 5: The Signature (Self-Authored)**';

/**
 * Append an entity's FOOTER.md body as a Layer-5 block. Returns the prompt
 * unchanged when the footer is empty. Placed at the very end, so it follows the
 * Layer-4 index (which the client injects before send).
 */
export function appendLayer5Footer(systemPrompt: string, footerBody: string): string {
  const body = (footerBody || '').trim();
  if (!body) return systemPrompt || '';
  return `${(systemPrompt || '').replace(/\s+$/, '')}\n\n${LAYER5_HEADING}\n\n${body}\n`;
}

// Make the live summaries index appear in the system prompt.
//
// • If a `Layer 4` heading EXISTS, replace ONLY its body with `indexBody`
//   (heading kept, footer/Layer 5+ preserved) — the original behavior.
// • If NO `Layer 4` heading exists (the user removed it manually, which is now
//   the intended end state), INSERT a fresh `## **Layer 4: Conversation
//   Summaries**` block carrying the index. It's placed just before the first
//   Layer 5+ heading (the manual footer) if present, otherwise appended at the
//   end. This guarantees the entity always sees its summaries, whether or not
//   Layer 4 has been removed yet.
//
// If `indexBody` is empty, the prompt is returned unchanged (nothing to show).
export function injectLayer4Index(systemPrompt: string, indexBody: string): string {
  const body = (indexBody || '').replace(/\s+$/, '');
  const text = systemPrompt || '';
  // Nothing to show → leave the prompt untouched. This is important now that the
  // call is unconditional: an empty index must NOT wipe an existing Layer 4 body
  // (and must not append an empty Layer-4 block).
  if (!body) return text;
  const span = findLayer4(text);
  if (span) {
    const before = text.slice(0, span.bodyStart);
    const after = text.slice(span.bodyEnd);
    const tail = after.startsWith('\n') ? after : (after ? '\n' + after : after);
    return `${before}${body}\n${tail}`;
  }
  // No Layer 4 heading — insert a fresh summaries block.
  const block = `${SUMMARY_BLOCK_HEADING}\n${body}`;

  // Find the first heading with index >= 5 (the manual footer) to insert before.
  LAYER_HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let footerStart = -1;
  while ((m = LAYER_HEADING_RE.exec(text)) !== null) {
    if (parseInt(m[1], 10) >= 5) { footerStart = m.index; break; }
  }
  if (footerStart >= 0) {
    const before = text.slice(0, footerStart).replace(/\s+$/, '');
    const after = text.slice(footerStart);
    return `${before}\n\n${block}\n\n${after}`;
  }
  // No footer — append at the end.
  return `${text.replace(/\s+$/, '')}\n\n${block}\n`;
}
