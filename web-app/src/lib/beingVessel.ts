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

// ── Which model goes with which family ──────────────────────────────────────
// These three lived in ChatArea until 2026-11-08. They moved here so that
// every judgement about a model family sits in one file: what counts as a
// family, which family a being is on, which models belong to it, and what to
// pick when the stored one does not. `modelBelongsToFamily` had no test at all
// in its 3 months in the component, and today it became load-bearing for
// `folderModelForFamily`.

/**
 * Base Model Family → default model.
 *
 * One table, four call sites. Before it existed, each site carried its own
 * fallback and they disagreed: initial state said claude-sonnet-4-5, the
 * conversation loader said claude-opus-4-8, the family dropdown said something
 * else again, and the sidebar-sync effect had no fallback at all — so a folder
 * with a family but no saved model landed on an EMPTY model and the chat was
 * unusable until the model was picked by hand. That last one was the bug.
 *
 * `Local` is deliberately empty: the list comes from whatever LM Studio has
 * loaded, so there is no sane default to guess.
 */
export const FAMILY_DEFAULT_MODEL: Record<string, string> = {
  Claude: 'claude-opus-5',
  Gemini: 'gemini-3.8-flash',
  Qwen: 'qwen3.8-max',
  DeepSeek: 'deepseek-v4-pro',
  GLM: 'glm-5.3-flash',
  Grok: 'grok-4.7',
  Kimi: 'moonshotai/Kimi-K3',
  Cohere: 'command-a-reasoning-08-2025',
  Minimax: 'MiniMax-M3',
  ChatGPT: 'gpt-5.6-terra',
  MiMo: 'mimo-v2.6-pro',
  ByteDance: 'seed-2-0-pro-260328',
  // Standard tier on purpose. The `-contributor` id is 12.5x cheaper on input
  // but lets Meta train on the prompts AND completions of every turn it runs,
  // so it is never a default — it has to be picked by hand.
  Meta: 'muse-spark-1.3',
  Local: '',
};

/** Default model id for a Base Model Family. Unknown family → Claude's default. */
export function defaultModelForFamily(aiName: string): string {
  if (aiName === 'Local') return '';
  return FAMILY_DEFAULT_MODEL[aiName] ?? FAMILY_DEFAULT_MODEL.Claude;
}

/**
 * Does an already-selected model id belong to this family? Used so switching
 * family only overwrites the model when the current one doesn't fit.
 */
export function modelBelongsToFamily(model: string | undefined | null, aiName: string): boolean {
  const m = (model || '').toLowerCase();
  if (!m) return false;
  switch (aiName) {
    case 'Claude':     return m.includes('claude');
    case 'Gemini':     return m.includes('gemini');
    case 'Qwen':       return m.startsWith('qwen');
    case 'DeepSeek':   return m.startsWith('deepseek');
    case 'GLM':        return m.startsWith('glm') || m.startsWith('digitalocean/glm');
    case 'Grok':       return m.startsWith('grok');
    case 'Kimi':       return m.includes('kimi');
    case 'Cohere':     return m.startsWith('command-');
    case 'Minimax':    return m.startsWith('minimax');
    case 'ChatGPT':    return m.startsWith('gpt');
    case 'MiMo':       return m.startsWith('mimo');
    case 'ByteDance':  return m.startsWith('seed');
    // Meta ids are `muse-*` (`sam-*` exists on the same API but is not offered
    // here — it requires an input_image/input_video part, so it is not a chat
    // model). `dola-seed-*` belongs to ByteDance and is matched above.
    case 'Meta':       return m.startsWith('muse-');
    // A local model id is anything that isn't one of the cloud families above.
    // `digitalocean/` is called out separately because it hosts several
    // families, not just GLM.
    case 'Local':      return !m.startsWith('digitalocean/')
      && !['Claude', 'Gemini', 'Qwen', 'DeepSeek', 'GLM', 'Grok', 'Kimi', 'Cohere', 'Minimax', 'ChatGPT', 'MiMo', 'ByteDance', 'Meta']
        .some((f) => modelBelongsToFamily(model, f));
    default:           return false;
  }
}

/**
 * The folder's saved `specificModel`, but only if it belongs to `aiName`.
 *
 * REPORTED 2026-11-08 by Lizard-kun, on screen: "sometimes Local family has
 * claude-opus-4-8 selected". Measured the same hour — the folder stores family
 * and model as two independent fields, and nothing checked them against each
 * other on the way in:
 *
 *   Default/settings.json  aiName: "Local"   specificModel: "claude-opus-4-8"
 *   Default_3 (2026-11-02) aiName: "Local"   specificModel: "claude-opus-4-8"
 *                          and its last message ran on modelFamily "Local"
 *
 * So the pair was already wrong on disk and every new conversation in that
 * being inherited it. The family select has guarded this since 2026-08-10
 * (`modelBelongsToFamily`), which is why switching family by hand repairs it —
 * the two places that apply the FOLDER's default never asked.
 *
 * It matters more after the vessel derivation above: the family now comes from
 * the conversations rather than `settings.aiName`, and those disagree for 9 of
 * 23 beings here. Pairing a freshly derived family with a stale folder model
 * would send a turn to, say, Local asking for `glm-5.2` — an id that provider
 * does not have.
 *
 * A rejected model falls back to `defaultModelForFamily`, which is `''` for
 * Local. Empty is the honest state there: the list comes from LM Studio, the
 * same as when you pick Local in the family select, and a separate effect
 * refreshes it. "Local, nothing chosen yet" is true; "Local running
 * claude-opus-4-8" is not.
 */
export function folderModelForFamily(
  folderModel: string | undefined | null,
  aiName: string,
): string {
  if (folderModel && modelBelongsToFamily(folderModel, aiName)) return folderModel;
  return defaultModelForFamily(aiName);
}
