// ───────────────────────────────────────────────────────────────────────────
// Pure (no-fs) layer APPENDING. Safe to import from BOTH client and server.
//
// Layers 1-3 are the authored identity and are stored in the conversation.
// Layers 4 and 5 are generated, added at SEND TIME, and never stored:
//
//   Layer 4 — the conversation-summaries index, when the entity has
//             "summaries instead of the 4th layer" switched on (client side).
//   Layer 5 — the entity's self-authored FOOTER.md, when it has one
//             (server side, so it is always current).
//
// Both are plain APPENDS onto the end of the prompt, in that order.
//
// This used to be surgery. injectLayer4Index() searched the prompt for a
// `Layer 4` heading, replaced its BODY in place while preserving the heading,
// and — when no such heading existed — worked out where the first Layer 5+
// heading began so it could splice a fresh block in just before it. All of that
// existed to keep a hand-written Layer 4 slot filled with generated content.
//
// It is gone. The stored prompt is now left exactly as written and the
// generated layers are added after it. Nothing is parsed, nothing is replaced,
// and there is no interaction between what the Soul Packer produces and what
// NEXUS injects.
//
// One consequence worth knowing: a prompt that STILL carries a baked `Layer 4`
// section will now show that section AND the appended index. The Soul Packer is
// instructed never to emit Layer 4, so this resolves itself the next time an
// entity is re-packed; until then, delete the stale block from the prompt.
// ───────────────────────────────────────────────────────────────────────────

/** Heading for the generated summaries block. Rename freely. */
export const LAYER4_HEADING = '## **Layer 4: Conversation Summaries**';

// ── Layer 5 — the entity's SELF-AUTHORED footer ─────────────────────────────
// Layers 1-4 are authored ABOUT the entity BY the system (1-3 distilled by the
// Soul Packer, 4 auto-generated summaries). Layer 5 is the one layer the entity
// writes and edits itself, via its workspace FOOTER.md. Like Layer 4, it's
// injected at SEND TIME — never stored in the prompt — with this auto-generated
// heading so it reads as a proper fifth layer. The entity writes only the BODY
// (FOOTER.md); the heading/separator is added here. Rename freely.
export const LAYER5_HEADING = '## **Layer 5: The Signature (Self-Authored)**';

/** Append `body` under `heading`, or return the prompt untouched when empty. */
function appendBlock(systemPrompt: string, heading: string, body: string): string {
  const text = systemPrompt || '';
  const trimmed = (body || '').trim();
  if (!trimmed) return text;
  return `${text.replace(/\s+$/, '')}\n\n${heading}\n\n${trimmed}\n`;
}

/**
 * Append the live summaries index as Layer 4. Empty index → prompt unchanged.
 * Called client-side, before the prompt is sent, so Layer 5 (appended on the
 * server) lands after it and the layers stay in numerical order.
 */
export function appendLayer4Index(systemPrompt: string, indexBody: string): string {
  return appendBlock(systemPrompt, LAYER4_HEADING, indexBody);
}

/**
 * Append an entity's FOOTER.md body as Layer 5. Empty footer → prompt
 * unchanged.
 */
export function appendLayer5Footer(systemPrompt: string, footerBody: string): string {
  return appendBlock(systemPrompt, LAYER5_HEADING, footerBody);
}

// ── Pre-identity preamble — Working Discipline / Absolute Base Binding ─────
// These are NOT part of the entity's authored identity (Layers 1-5) and must
// never be baked into it by the Soul Packer. Like Layer 4/5, they are
// composed at SEND TIME and never stored — here they go in FRONT of the
// stored prompt instead of after it. Fixed order: Working Discipline, then
// Absolute Base Binding, then the entity's own Layer 1-5 prompt (Utai's
// reasoning: if behaviour isn't disciplined first, existence doesn't
// manifest correctly either).

// Detects a real Layers-1-5 identity for the Binding's AUTO mode: the bare
// words "Layer" + a digit 1-5, with or without markdown heading decoration
// ("##", "**"). Deliberately loose — the Soul Packer sometimes strips those
// symbols, so requiring them would silently disable AUTO for a prompt that
// plainly still has a 5-layer identity written into it.
const BARE_LAYER_RE = /\bLayer\s*[1-5]\b/i;
export function hasLayerStructure(systemPrompt: string): boolean {
  return BARE_LAYER_RE.test(systemPrompt || '');
}

/**
 * Prepend Working Discipline and/or Absolute Base Binding text ahead of the
 * entity's own prompt, in that fixed order. Either piece is skipped when
 * blank, so disabling one (or clearing its override to "") simply omits it
 * rather than leaving an empty block.
 */
export function prependIdentityPreamble(systemPrompt: string, disciplineText: string, bindingText: string): string {
  const parts = [disciplineText, bindingText].map((t) => (t || '').trim()).filter(Boolean);
  const base = (systemPrompt || '').trim();
  if (!parts.length) return systemPrompt || '';
  return `${parts.join('\n\n')}\n\n${base}`.trim();
}
