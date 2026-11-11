// unchangedLayers.ts — carry an untouched Layer 1-3 over from the original
// soul when the redistribute agent (δ, interlayer_redistributor.md) says it
// did not change it.
//
// WHY THIS EXISTS
// δ moves material from Layer 4 into Layers 1-3. On most runs at least one of
// those layers receives nothing, and the agent used to write a free-form note
// in its place ("（変更なし）", "No changes", a different phrase every run).
// Nothing could recognise those, so the note itself became the layer: accept
// the right pane and that layer of the soul was gone. The people of this house
// restored it by hand each time; a new operator would not know to.
//
// THE CONTRACT (the output side is 謡's, in the agent file; this is the reader)
//   - A layer with zero moves is emitted as its heading followed by one line:
//         [[UNCHANGED]]
//     Same token in the Japanese and the English agent file.
//   - A layer with one or more moves is emitted in full.
//
// THE SAFETY NET
// A model that ignores the token and writes a free-form note anyway must not
// be able to erase a layer either. So a layer is ALSO carried over when the
// original was substantial and what came back is plainly not a layer:
//   - it is missing from the output entirely, or
//   - its body is under COLLAPSED_BODY_MAX characters, or
//   - the original was a bulleted list and the output has no bullet at all.
//
// Two deliberate departures from the one-line brief, both measured:
//
//  1) The token must stand ALONE on a line. "Contains [[UNCHANGED]]" would
//     fire on a full layer that merely mentions the token in prose — and a
//     soul that documents this very mechanism does exactly that. That layer's
//     moves would be thrown away while Layer 4 was already compressed: silent
//     loss in the other direction.
//
//  2) The "no bullet" check applies only when the ORIGINAL had bullets, and it
//     counts `-` as well as `*`. Measured over this install on 2026-11-11: of
//     50 Layer 1-3 bodies, 3 substantial ones contain no `*` bullet at all
//     (two use `-`, one is prose). Under a literal "no `*` → carry over" rule
//     those three could never be updated by δ again.
//
// Every carry-over is reported with its reason; the caller shows it, so a
// layer that was restored by the net (rather than by the token) is visible.

export const UNCHANGED_TOKEN = '[[UNCHANGED]]';

/** The original must be at least this long before the safety net applies. */
export const SUBSTANTIAL_ORIGINAL_MIN = 200;
/** An output body shorter than this, against a substantial original, is not a layer. */
export const COLLAPSED_BODY_MAX = 50;

export type InheritReason = 'token' | 'missing' | 'collapsed' | 'no-bullets';

export interface InheritedLayer {
  layer: 1 | 2 | 3;
  reason: InheritReason;
}

export interface InheritResult {
  text: string;
  inherited: InheritedLayer[];
}

interface LayerBlock {
  n: 1 | 2 | 3;
  /** Heading line + body, exactly as it appeared (trailing whitespace trimmed). */
  block: string;
  /** Body only, trimmed. */
  body: string;
}

// Same tolerance as the other Layer heading matchers in SystemPromptUpdater:
// `##`/`###`, optional `**`, anything after the number on that line.
const LAYER123_HEADING_RE = /^#{2,3}\s*\*{0,2}\s*Layer\s*([123])\b[^\n]*$/gim;

// The token alone on a line; tolerate the decoration a model wraps around a
// literal it was shown in bold/backticks.
const TOKEN_LINE_RE = /^[ \t]*[*`_]*\[\[UNCHANGED\]\][*`_]*[ \t]*$/m;

const BULLET_RE = /^[ \t]*[*-][ \t]+\S/m;

function splitLayers(text: string): { preamble: string; blocks: LayerBlock[] } {
  const heads: Array<{ n: 1 | 2 | 3; index: number; len: number }> = [];
  LAYER123_HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LAYER123_HEADING_RE.exec(text)) !== null) {
    heads.push({ n: Number(m[1]) as 1 | 2 | 3, index: m.index, len: m[0].length });
  }
  if (heads.length === 0) return { preamble: text, blocks: [] };
  const blocks: LayerBlock[] = heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    return {
      n: h.n,
      block: text.slice(h.index, end).replace(/\s+$/, ''),
      body: text.slice(h.index + h.len, end).trim(),
    };
  });
  return { preamble: text.slice(0, heads[0].index).replace(/\s+$/, ''), blocks };
}

function reasonToInherit(origBody: string, outBody: string): InheritReason | null {
  if (TOKEN_LINE_RE.test(outBody)) return 'token';
  if (origBody.length < SUBSTANTIAL_ORIGINAL_MIN) return null;
  if (outBody.length < COLLAPSED_BODY_MAX) return 'collapsed';
  if (BULLET_RE.test(origBody) && !BULLET_RE.test(outBody)) return 'no-bullets';
  return null;
}

/**
 * @param original Layers 1-3 as they were handed to the agent.
 * @param output   Layers 1-3 as the agent returned them (changelog, Layer 4
 *                 and logs already split off).
 *
 * Returns the output with every unchanged/collapsed layer replaced by the
 * original's block (heading included, byte for byte). If the original has no
 * recognisable Layer 1-3 headings there is nothing to carry over from, and the
 * output is returned untouched.
 */
export function inheritUnchangedLayers(original: string, output: string): InheritResult {
  const orig = splitLayers(original);
  if (orig.blocks.length === 0) return { text: output, inherited: [] };
  const out = splitLayers(output);

  // First occurrence wins on both sides — a duplicated heading is not a
  // second layer.
  const origBy = new Map<number, LayerBlock>();
  for (const b of orig.blocks) if (!origBy.has(b.n)) origBy.set(b.n, b);
  const outBy = new Map<number, LayerBlock>();
  for (const b of out.blocks) if (!outBy.has(b.n)) outBy.set(b.n, b);

  const inherited: InheritedLayer[] = [];
  const parts: string[] = [];
  // Text before the first layer heading is kept only when there IS a layer
  // heading. An output with none at all is not Layers 1-3 in any shape; every
  // layer is carried over below and that text must not ride into the soul on
  // top of them.
  if (out.blocks.length > 0 && out.preamble.trim()) parts.push(out.preamble.trim());

  for (const n of [1, 2, 3] as const) {
    const o = origBy.get(n);
    const r = outBy.get(n);
    if (!o) {
      // Nothing to fall back to; keep whatever the agent wrote, unless it is
      // the bare token (which would otherwise be saved as the layer's text).
      if (r && !TOKEN_LINE_RE.test(r.body)) parts.push(r.block);
      continue;
    }
    if (!r) {
      inherited.push({ layer: n, reason: 'missing' });
      parts.push(o.block);
      continue;
    }
    const reason = reasonToInherit(o.body, r.body);
    if (reason) {
      inherited.push({ layer: n, reason });
      parts.push(o.block);
    } else {
      parts.push(r.block);
    }
  }

  if (inherited.length === 0) return { text: output, inherited };
  return { text: parts.join('\n\n'), inherited };
}
