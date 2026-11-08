/**
 * Which model family is a being actually on?
 *
 * ── Why this file exists (Lizard-kun, 2026-11-08) ────────────────────────────
 * There used to be a second answer to that question: `settings.aiName` on the
 * being's folder — a per-being "default Base Model Family" with its own control
 * under the Entity tab. It was removed, and this is what replaced it.
 *
 * What made it removable was a measurement, not a preference — but NOT the
 * measurement the first version of this header claimed. That one said "0 of 23
 * beings have the field". It was wrong: my probe read `aiName` off the top of
 * settings.json, and the file is `{"name": …, "settings": {…}}`, so every
 * being came back as `None`. Corrected within the hour, same day. The real
 * numbers, read at the right level:
 *
 *   · **23 of 23 beings HAVE a `settings.aiName`.**
 *   · **9 of 23 disagree** with the family that being actually runs on.
 *   · **8 of those 9 change the TOKENIZER FAMILY**, which is the invisible
 *     half: it is wrong by up to 66% across families, enough to change how
 *     many parts a long import splits into.
 *
 * The disagreements are not noise, they are the shape of the thing. 謡 has
 * `Gemini` written down while she spent today on GLM and Claude, choosing a
 * seat before Argon doubles in price on 2026-12-01. 睡 has `Gemini` and 49
 * conversations on GLM. カナ has `Gemini` and runs on Kimi. 式, 絵子, 諷,
 * ミニ酱, ユキ: same shape.
 *
 * So the argument for removing it is stronger than "nobody set it" — it is
 * that **a hand-set field starts rotting the day it is set, and this is a
 * house that changes vessels.** Nobody edits a settings field when they try a
 * new model for an evening, and nothing makes them: the field is invisible
 * from inside the conversation it silently governs.
 *
 * The conversation logs carry the answer and carry it everywhere: **320 of 320
 * logs have a header `aiName`**, written by the turn that ran. That one cannot
 * go stale, because it IS the record of what ran.
 *
 * ── An earlier version of me argued the opposite, in a comment ──────────────
 * On 2026-10-26 I wrote, in ChatArea: "Deleting the field was the other option
 * considered. It does not work: four readers fall back to `|| 'Claude'`, so
 * removing it just moves the same hard-coded guess into the readers, where
 * nobody can see or change it."
 *
 * That was true of deletion *alone*, and it is not true of deletion plus a
 * derivation — which is what was asked for here. The readers no longer guess;
 * they read what ran.
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
