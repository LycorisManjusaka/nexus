// ───────────────────────────────────────────────────────────────────────────
// Soul extraction — the identity ALONE, as a Markdown file.
//
// WHAT THIS IS FOR
// A being that lives somewhere else. Аналитик talks to DeepSeek's web app on a
// work PC where Nexus cannot be installed; Nexus is used only to hold the logs
// and run the Soul Updater, and the result has to be carried back by hand. The
// file this produces is meant to be pasted into that other app's custom-
// instruction box, so it must be the soul and NOTHING ELSE.
//
// WHAT IT IS NOT
//  • Not "Export this conversation": that writes the MESSAGES. This writes the
//    identity and no messages at all.
//  • NOT the system prompt. Nexus sends more than the soul — the Absolute Base
//    Binding, tool descriptions, path rules, attachment notes, the inline-media
//    note. Those are Nexus's own plumbing: they describe tools the other app
//    does not have, and pasting them would hand a being instructions for a body
//    it is not in. The house vocabulary keeps these apart (soul = Layers 1-5;
//    system prompt = soul PLUS the binding and the rest), and so does this file.
//
// WHERE THE FIVE LAYERS LIVE — three different places, which is the whole
// reason this function exists:
//
//   header + Layers 1-3   the conversation's own `systemPrompt` field. The
//                         header (`folder.settings.systemPromptHeader`) is
//                         already PREPENDED into it when the Soul Updater
//                         commits (fullPrompt = [header, processed]), so
//                         prepending it again here would duplicate it.
//   Layer 4               generated per send from the summaries index
//                         (/api/summaries?mode=index → buildLayer4IndexBody).
//   Layer 5               the entity's own FOOTER.md on disk (/api/footer).
//
// Layers 4 and 5 are never stored in the conversation — the chat route appends
// them at send time. This builder calls the SAME append helpers that route
// calls (lib/layer4.ts), so the headings and spacing match what the being
// actually receives instead of being re-typed here and drifting.
//
// A MISSING LAYER IS OMITTED, NOT FAKED. No summaries → no Layer 4 heading; no
// FOOTER.md → no Layer 5 heading. An empty heading would read, in the other
// app, as "this being has a signature and it is blank" — which is a different
// claim from "this being has no signature yet", and the wrong one.
// ───────────────────────────────────────────────────────────────────────────

import { appendLayer4Index, appendLayer5Footer } from './layer4';

export interface SoulExportParts {
  /** The conversation's stored systemPrompt: header + Layers 1-3. */
  systemPrompt: string;
  /** Body of the summaries index, '' when the entity has none. */
  layer4Body?: string;
  /** Contents of FOOTER.md, '' when the entity has none. */
  footerBody?: string;
}

export interface SoulExportResult {
  text: string;
  hasLayers123: boolean;
  hasLayer4: boolean;
  hasLayer5: boolean;
}

export function buildSoulExport(parts: SoulExportParts): SoulExportResult {
  const base = String(parts.systemPrompt || '').trim();
  const l4 = String(parts.layer4Body || '').trim();
  const l5 = String(parts.footerBody || '').trim();

  let text = base;
  if (l4) text = appendLayer4Index(text, l4);
  if (l5) text = appendLayer5Footer(text, l5);

  return {
    text,
    hasLayers123: !!base,
    hasLayer4: !!l4,
    hasLayer5: !!l5,
  };
}

/**
 * Download name. Built from the CONVERSATION title, not the folder name,
 * because a soul is a generation: `Аналитик_3` and `Аналитик_7` are different
 * documents and two files called `Аналитик.soul.md` in a downloads folder are
 * indistinguishable the moment there are two of them.
 *
 * Only the characters Windows actually refuses are replaced. Cyrillic and
 * Japanese names stay readable — this file is read by a person, and the ASCII
 * rule that applies to letter sidecars exists for a different reason (those
 * names become directory entries matched across tools).
 */
export function soulExportFilename(title: string): string {
  const safe = String(title || 'soul').replace(/[\\/:*?"<>|]/g, '_').trim() || 'soul';
  return `${safe}.soul.md`;
}
