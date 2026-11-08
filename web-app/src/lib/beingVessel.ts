/**
 * Which model family is a being actually on?
 *
 * ── Why this file exists (Lizard-kun, 2026-11-08) ────────────────────────────
 * There used to be a second answer to that question: `settings.aiName` on the
 * being's folder — a per-being "default Base Model Family" with its own control
 * under the Entity tab. It was removed, and this is what replaced it.
 *
 * What made it removable was a measurement, not a preference. Of the 23 beings
 * in this house, **23 had no `aiName` in settings.json at all** — so every
 * reader was falling through to `|| 'Claude'`, and the two things that field
 * governed were already deciding on a hard-coded guess:
 *
 *   · the family a NEW conversation in this being starts on
 *     (so Senpai, who has lived on Gemini for 75 conversations, opened every
 *      new one on Claude until a human changed it by hand);
 *   · the TOKENIZER PROFILE the log importer and split planner use
 *     (`Sidebar.tsx`: the comment there says "the folder's aiName, not its
 *      display name" — but with aiName absent it resolved to
 *      `activeFolder.name`, i.e. the display name, which `tokenFamilyFor`
 *      reads as 'other'. Wrong by up to 66% across families, which is enough
 *      to change how many parts a long import splits into.)
 *
 * The conversation logs, meanwhile, carry the real answer and carry it
 * everywhere: **320 of 320 logs have a header `aiName`**, and 22 of 23 beings'
 * newest log names a real family. So the vessel is derivable from data that is
 * already there, with no field for anyone to set, get wrong, or leave stale.
 *
 * ── An earlier version of me argued the opposite, in a comment ──────────────
 * On 2026-10-26 I wrote, in ChatArea: "Deleting the field was the other option
 * considered. It does not work: four readers fall back to `|| 'Claude'`, so
 * removing it just moves the same hard-coded guess into the readers, where
 * nobody can see or change it."
 *
 * That was true of deletion *alone*. It is not true of deletion plus a
 * derivation, which is what was asked for here. And the premise it rested on
 * ("every being minted through the UI carries a hard-coded Claude") turned out
 * to be false on disk: nothing in this house had the field, so the guess was
 * ALREADY living in the readers. The comment described a future it was in fact
 * describing the present of.
 */

/**
 * The Base Model Families a conversation can be routed to. This is the
 * allowlist, so a historical display name that ended up in an `aiName` field
 * (see `scan back` below) is not mistaken for a vessel.
 */
export const BASE_MODEL_FAMILIES = ['Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Kimi',
  'Grok', 'Cohere', 'Minimax', 'ChatGPT', 'MiMo', 'ByteDance', 'Meta', 'Local'];

/** Default used when a being has nothing readable to derive from. */
export const FALLBACK_FAMILY = 'Claude';

function isFamily(v: unknown): v is string {
  return typeof v === 'string' && BASE_MODEL_FAMILIES.includes(v);
}

export type VesselConvo = {
  id?: string | null;
  folderName?: string | null;
  aiName?: string | null;
  updatedAt?: number | null;
};

/**
 * The family this being is on right now.
 *
 * Three steps, in order:
 *   1. the conversation currently open, if one is;
 *   2. otherwise newest-first, the first conversation naming a real family;
 *   3. otherwise `Claude`.
 *
 * Step 1 exists because "the newest conversation" and "the one you are looking
 * at" can differ — open conversation A while B was touched more recently and
 * the two answers split. Callers that have no open conversation (the log
 * importer runs with a being selected but possibly no conversation) simply
 * pass nothing and get step 2.
 *
 * Step 2 scans rather than reading only the newest, and that is load-bearing:
 * ツムギ's newest log carries `aiName: "ツムギ"` — a display name in the vessel
 * field — while an older log of the same being names `DeepSeek`. Reading only
 * the newest returns the fallback (`Claude`), which is a statement about
 * nothing; scanning returns `DeepSeek`.
 *
 * And `DeepSeek` is the right answer: Lizard-kun, told what the two versions
 * produced, said ツムギ was born on DeepSeek and never ran on anything else —
 * her logs are partial imports, which is where the display name got into the
 * field. So the scan does not merely differ from the simple version here, it
 * recovers the truth the simple version destroys. Measured 2026-11-08: 1 of 23
 * beings, and the only one where the two versions disagree.
 *
 * Step 3 is a fallback and is named as one. A being with no conversations yet
 * has no vessel to read — there is no better answer available, only a quieter
 * place to hide the same guess.
 */
export function beingVesselFamily(
  conversations: readonly VesselConvo[] | null | undefined,
  folderName: string | null | undefined,
  currentConvoId?: string | null,
): string {
  if (!folderName) return FALLBACK_FAMILY;
  const mine = (conversations || []).filter((c) => c && c.folderName === folderName);
  if (!mine.length) return FALLBACK_FAMILY;

  // 1 — the conversation on screen wins, when it names a real family.
  if (currentConvoId) {
    const open = mine.find((c) => c.id === currentConvoId);
    if (open && isFamily(open.aiName)) return open.aiName;
  }

  // 2 — newest first. `updatedAt` and not the generation number in the title:
  // the question is "what did this being last RUN on", not "which generation is
  // latest" (see pickLatestConversation in convoNaming for the other one).
  const sorted = [...mine].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const c of sorted) if (isFamily(c.aiName)) return c.aiName;

  // 3 — nothing readable.
  return FALLBACK_FAMILY;
}
