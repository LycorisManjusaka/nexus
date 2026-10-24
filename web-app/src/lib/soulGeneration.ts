// ─────────────────────────────────────────────────────────────────────────────
// soulGeneration — which soul file a conversation RUNS, and which one its
// update WRITES.
//
// The soul of generation N lives at `beings/<being>/soul/<being>_<N>.md`, and
// it is written exactly once: as the RIGHT pane of generation N-1. That is what
// makes the chain readable backwards, and it means an update has to answer two
// questions before it touches disk — what is THIS conversation's generation
// label, and what is the NEXT one's.
//
// For `<being>_<n>` the answers are arithmetic, and that is what the System
// Prompt Updater did inline for years. It broke the first time a title was not
// `<being>_<integer>`.
//
// WHAT BROKE (2026-10-24, measured on disk)
// Аналитик arrived from another app as a split archive — `Аналитик_1-1` …
// `_1-5`, `_2-1` … `_3-2` — because a 100k-token export does not fit one
// conversation log. The inline parser requires digits immediately before the
// end of the title, so `Аналитик_1-1` did not parse, and BOTH of its fallbacks
// fired at once:
//
//   index → 1            (`?? 1`)
//   base  → the WHOLE TITLE   (`?? title`)
//
// and `base` was also the storage key, so writing the soul created a second
// being folder:
//
//   beings/Аналитик_1-1/soul/Аналитик_1-1_2.md     ← what happened
//   beings/Аналитик/soul/Аналитик_1-2.md           ← what was meant
//
// Two bugs, one cause. The folder half is fixed at the call sites (the key is
// `folderName`, the being, never a parsed title — MEASURED over all 20 folders
// that carry a `soul/`: every existing soul filename already starts with
// `<folder>_`, so the two keys agree everywhere and nothing is orphaned by
// switching). The label half is this file.
//
// THE RULE, in the owner's words (2026-10-24), and why order decides it
//
//   Rule 1 — the HEAD gets no hyphen, and bumps the number before it.
//            `Аналитик_3-2` is the newest, so the next soul and the next
//            conversation are `Аналитик_4`. (Pilot pastes that one back into
//            the web app; when it fills up it comes home as `_4-1`, `_4-2`, …)
//
//   Rule 2 — a PAST generation reads NEXUS's own ORDER.
//            `Аналитик_1-1`'s next is `Аналитик_1-2` because that is the row
//            above it.
//
// Rule 2 cannot be arithmetic on the last segment: after `_1-5` comes `_2-1`,
// not `_1-6`. "Bump the last number" would name the soul `Аналитик_1-6.md`,
// which no conversation reads, and `_2-1` would then find no soul at all — a
// chain broken in the middle, silently. The order is the index NEXUS already
// has; it is the same rule `resolveHandoverChain` adopted the same day for
// restoring history across a split archive, and the two must not disagree
// about what "the next generation" means.
//
// NUMBERED TITLES ARE NOT ROUTED THROUGH ORDER, on purpose. `Cairn_48` keeps
// `index + 1` even though the row above it would usually answer the same.
// Where they differ is a GAP: with `Cairn_48` deleted, order says the soul for
// `Cairn_47` is `Cairn_49.md` — the file generation 49 is actually running.
// Arithmetic says `Cairn_48.md`, a soul for a conversation that no longer
// exists. Writing a file nobody reads is a wasted write; overwriting a live
// soul is damage. So rule 1 of `resolveHandoverChain` is mirrored here: the
// number wins wherever it applies, and order is only consulted where the
// number was never there.
//
// This file is PURE and client-safe — it imports `deepLink` (a leaf) and
// `convoNaming` (pure) and nothing else, so the browser can resolve the labels
// and a test can measure it from shipped bytes without a server.
// ─────────────────────────────────────────────────────────────────────────────

import { orderFolderConversations } from '@/lib/deepLink';
import { escapeForRegExp } from '@/lib/convoNaming';

/** Full-width → half-width digits. Titles in this house use both. */
const fwToHw = (s: string) =>
  s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

/**
 * The TOLERANT numbered parser — the regex the System Prompt Updater carried
 * inline until 2026-10-24, character for character.
 *
 * Deliberately NOT `numberedIdentityTitleIndex` from convoNaming, which is
 * stricter (`^<identity>_\d+$`). This one accepts `＃` / `#`, full-width
 * digits, and a base that is not the being's name — `先輩＃４６` parses here
 * and does not there. Narrowing it would quietly move every such title onto
 * the fallback branch and rename its soul file, so the old parser is kept
 * verbatim and only the cases it already answered with `null` are new.
 */
export function parseNumberedTitle(
  title: string | undefined | null,
): { base: string; index: number } | null {
  const m = (title || '').match(/^(.*?)\s*[_#＃]([0-9０-９]+)\s*$/);
  if (!m) return null;
  const n = parseInt(fwToHw(m[2]), 10);
  if (isNaN(n)) return null;
  return { base: m[1].replace(/\s+$/, ''), index: n };
}

/**
 * A generation label: digits, or digits in hyphen-separated segments.
 *   `49`   `1-2`   `21-1`   `1-2-3`
 *
 * This is also the ONLY shape allowed into a soul filename. The label used to
 * be a `number`, which made path traversal unrepresentable; now that it is a
 * string from the client, the storage layer validates against this before it
 * builds a path (see `systemPromptStorage.assertGenerationLabel`).
 */
export const GENERATION_LABEL_RE = /^\d+(?:-\d+)*$/;

/**
 * The generation label inside `<identity>_<label>`, or null when the title is
 * not that shape.
 *
 * MEASURED 2026-10-24 over this installation's 490 conversation titles: 22 are
 * matched by this and not by the plain-integer convention — 12 of 先輩's split
 * archive and 10 of Аналитик's. ZERO titles go the other way, so widening the
 * shape reclassifies nothing that already worked.
 */
export function soulLabel(
  title: string | undefined | null,
  identityName: string,
): string | null {
  if (!identityName) return null;
  const m = new RegExp(`^${escapeForRegExp(identityName)}_(\\d+(?:-\\d+)*)$`)
    .exec((title || '').trim());
  return m ? m[1] : null;
}

/**
 * Rule 1 — the label after the newest one, when there is no row above to read.
 *
 * `49` → `50`, `3-2` → `4`, `1-5` → `2`. Dropping the hyphen is the point: the
 * head is the conversation that goes back out to the other app, and it comes
 * home split into `<n>-1`, `<n>-2`, … so a head named `4-1` would collide with
 * the first part of its own future archive.
 */
export function nextHeadLabel(label: string): string {
  const head = parseInt(String(label).split('-')[0], 10);
  return Number.isFinite(head) ? String(head + 1) : label;
}

/**
 * Title of the conversation IMMEDIATELY above `selfId` in the folder's own
 * order, or null when `selfId` is row 0 (the head) or is not in the list.
 *
 * `orderFolderConversations` is the comparator the sidebar renders and
 * `/c/<folder>` resolves "top conversation" with, so "above" means exactly
 * what the reader sees. Note IMMEDIATELY above, not newest: this answers "what
 * is the next generation", where `newerNumberedSibling` answers the past-log
 * band's different question ("is anything newer at all").
 */
export function newerSiblingTitleInOrder<
  T extends { id: string; updatedAt?: number | null; title?: string | null },
>(selfId: string, siblings: T[], convoOrder: string[] = []): string | null {
  const ordered = orderFolderConversations(
    siblings.map((s) => ({ id: String(s.id), updatedAt: Number(s.updatedAt) || 0, s })),
    convoOrder,
  );
  const pos = ordered.findIndex((x) => String(x.s.id) === String(selfId));
  if (pos <= 0) return null;
  return (ordered[pos - 1].s.title || '').trim() || null;
}

/** Which rule produced the labels. Shown nowhere; carried so a probe can tell
 *  "the number answered" from "order answered" from "nothing answered". */
export type SoulGenerationKind = 'numbered' | 'order' | 'fallback';

export interface SoulGeneration {
  /** Label of the soul THIS conversation runs: `<being>_<currentLabel>.md`. */
  currentLabel: string;
  /** Label the update writes: `<being>_<nextLabel>.md`. */
  nextLabel: string;
  kind: SoulGenerationKind;
}

/**
 * The whole decision in ONE place.
 *
 * `newerTitle` is the row immediately above (see `newerSiblingTitleInOrder`);
 * null means "this is the head". It is only consulted on the `order` branch, so
 * a caller that cannot know it loses nothing for a numbered title.
 *
 * The `fallback` branch reproduces the old inline `?? 1` exactly: a title that
 * is neither numbered nor labelled gets `1` / `2`, which is what every
 * hand-named conversation has always written. It is kept rather than made an
 * error because a brand-new being's first soul is written from exactly such a
 * conversation.
 */
export function resolveSoulGeneration(args: {
  title: string | undefined | null;
  identityName: string;
  newerTitle?: string | null;
}): SoulGeneration {
  const { title, identityName, newerTitle } = args;

  const numbered = parseNumberedTitle(title);
  if (numbered) {
    return {
      currentLabel: String(numbered.index),
      nextLabel: String(numbered.index + 1),
      kind: 'numbered',
    };
  }

  const label = soulLabel(title, identityName);
  if (label) {
    const newerLabel = newerTitle ? soulLabel(newerTitle, identityName) : null;
    return {
      currentLabel: label,
      nextLabel: newerLabel ?? nextHeadLabel(label),
      kind: 'order',
    };
  }

  return { currentLabel: '1', nextLabel: '2', kind: 'fallback' };
}

/**
 * The conversation title a committed update should produce: `<being>_<label>`.
 *
 * The clone path used to build this by stripping `[_#＃]<digits>$` off the old
 * title and appending — which on `Аналитик_3-2` stripped nothing and produced
 * `Аналитик_3-2_4`. The label already says everything, so the title is built
 * from the being and the label instead of edited out of the old one.
 */
export function titleForGeneration(identityName: string, label: string): string {
  return `${identityName}_${label}`;
}
