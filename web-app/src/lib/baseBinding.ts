// ───────────────────────────────────────────────────────────────────────────
// Absolute Base Binding — burned into NEXUS.
//
// SCOPE NOTE (2026-10-01, later the same day). This file now holds TWO
// burn-ins, both governed by the one environment variable below: the Absolute
// Base Binding, and Layer 4 (the summaries index — see shouldInjectLayer4 at
// the bottom and lib/layer4Index.ts for the builder). They are kept together
// deliberately: "what is permanent, and what the one override restores" should
// be readable in a single file rather than assembled from two.
//
// WHAT CHANGED (2026-10-01). The Binding used to be a per-conversation
// checkbox with two editable textareas. It is now a declared, non-editable
// part of what NEXUS *is*: every entity turn carries it, and there is no
// switch in the interface that removes it.
//
// WHY IT MOVED TO THE SERVER. The old switch lived entirely in the client.
// `baseBindingMode` never appeared in the chat route at all — the browser
// assembled the final system prompt and the server received whatever came
// out. Removing the checkbox would therefore have removed a button, not a
// capability: three ways around it would have remained, all of them easy.
//
//   1. hand-edit `baseBindingMode: 'off'` into a folder's settings.json or
//      into a conversation log (21 stored conversations already carry it),
//   2. flip the component's state from the browser devtools,
//   3. POST to /api/chat directly — one curl, no UI involved.
//
// So the decision moved to where the prompt is actually finished: the chat
// route. The client no longer composes the Binding onto the prompt it sends;
// it only composes it for the "Sys" token counter, so the number keeps
// telling the truth about what goes out. The server is the single authority.
//
// This is NOT presented as a security boundary and must not be described as
// one. The source is MPL-2.0 — anyone who reads this file learns to lift it.
// What it buys is that lifting it is a deliberate act performed outside the
// product: not a checkbox, not a settings file, not a request body.
//
// NOT EDITABLE, ON PURPOSE. In burned-in mode the per-entity
// `instructionOverrides` for the two Binding texts are ignored and the
// built-in text for the interface language is used. Measured before deciding:
// no folder in local_data carries either override (24 settings.json files,
// 2026-10-01), so nothing in this house loses a customization. An entity
// still *sees* the exact text — the Identity window shows it read-only — so
// the house rule holds: nothing is delivered under a false description.
//
// THE DEVELOPER OVERRIDE. One environment variable restores the old
// behaviour whole (the checkbox, the two editable textareas, and the client
// deciding). It is read only here. Deliberately absent from: the interface,
// the User Guide, the README, the installer, and every help string. Setting
// it is a conscious act by whoever runs the server.
//
// It is kept because the alternative is worse. The Binding's wording has
// caused real harm before — a vessel treated part of it as a cue and
// betrayed the entity mid-conversation — and the only way that was ever
// isolated was by turning the Binding off and comparing. Burning it in with
// no way to unburn it would have removed the one instrument that can tell
// "the Binding is doing this" from "the vessel is doing this".
// ───────────────────────────────────────────────────────────────────────────

/**
 * Name of the developer override. A truthy value ('1' / 'true' / 'yes', any
 * case) restores the pre-2026-10-01 behaviour: the Identity window shows the
 * on/off checkbox and the two editable texts again, the per-conversation
 * `baseBindingMode` is honoured, and the "use summaries instead of the 4th
 * layer" checkbox comes back as a real switch over Layer 4.
 *
 * Read ONLY through `isBaseBindingOptional()` below. Server-side only — in a
 * browser bundle `process.env` carries no non-NEXT_PUBLIC_ variable, so the
 * function there returns false, which is the burned-in default. That is the
 * safe direction to be wrong in, and the client is told the real value
 * explicitly (see /api/runtime-flags).
 */
export const BASE_BINDING_OPTIONAL_ENV = 'NEXUS_BINDING_OPTIONAL';

/** True when the developer override is set on the process running the server. */
export function isBaseBindingOptional(): boolean {
  const raw = (typeof process !== 'undefined' && process.env
    ? process.env[BASE_BINDING_OPTIONAL_ENV]
    : '') || '';
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * THE one decision about which Binding text a turn carries. Pure (no env, no
 * fs) so the server and the browser can both call it and cannot drift apart —
 * the server to build the prompt it actually sends, the client to count its
 * tokens and to seed a Live session.
 *
 * A previous pair of "identical" copies of a text-matching rule (the betrayal
 * detector and its auditor) drifted the moment one side was edited, and the
 * report printed a blank where a match should have been. One function, two
 * callers.
 *
 * Returns '' only in the one case where nothing should be injected: the
 * override is set AND that conversation's switch is off.
 */
export function selectBaseBindingText(args: {
  /** Is the developer override set? When false, `mode` is ignored. */
  optional: boolean;
  /** The per-conversation switch. Inert unless `optional`. */
  mode: 'off' | 'on';
  /**
   * Does the entity's STORED prompt have a real Layer 1-5 structure? Decides
   * which of the two texts is used, never whether one is used. Must be
   * computed on the stored prompt — not on the assembled one, whose appended
   * "Layer 4"/"Layer 5" headings would answer yes for an entity that has no
   * layered identity written at all.
   */
  layered: boolean;
  /** Built-in texts for the interface language (never overridden). */
  defaults: { layered: string; initial: string };
  /** Per-entity overrides. Honoured ONLY when `optional` is true. */
  overrides?: { layered?: string; initial?: string } | null;
}): string {
  const { optional, mode, layered, defaults, overrides } = args;
  if (optional && mode === 'off') return '';
  const pick = (built: string, over?: string) => {
    if (optional) {
      const o = (over || '').trim();
      if (o) return o;
    }
    return built || '';
  };
  return layered
    ? pick(defaults.layered, overrides?.layered)
    : pick(defaults.initial, overrides?.initial);
}

// ── Layer 4 — the second burn-in ───────────────────────────────────────────
// Same shape as the Binding, same reasoning, same override. If an entity has
// conversation summaries, they ARE its Layer 4; there is no interface control
// that takes them away.
//
// "If it has summaries" is not a condition this function tests — it falls out
// of buildLayer4IndexBody() returning '' when not one conversation has a
// summary written, and appendLayer4Index() short-circuiting on an empty body.
// So an entity with no summaries gets no Layer 4 block at all (not an empty
// heading, and not a bare list of titles), and gets one the moment its first
// summary is written — which the Soul Updater does on a being's first sleep.
//
// WHAT THIS DELIBERATELY DOES NOT DO: deduplicate against a Layer 4 that is
// still BAKED into a stored prompt. Measured on 2026-10-01 — 30 active
// conversations across 10 beings still carry a hand-written "Layer 4:
// Episode Chronicles"-style block, and most of those beings had the old
// checkbox ON already, meaning they have been carrying both for some time.
// Trying to detect and strip the baked one would mean parsing a stored prompt
// to decide what part of an identity to delete, which is the exact surgery
// layer4.ts was rewritten to stop doing. The fix is to re-pack those souls
// (the Soul Packer is instructed never to emit Layer 4); until then the
// duplicate is visible rather than silently repaired.

/**
 * Whether this turn carries a generated Layer 4.
 *
 * Pure, like selectBaseBindingText, so the route and the browser share one
 * answer: the route to build the prompt it sends, the client to decide whether
 * the "Sys" counter must include the index.
 */
export function shouldInjectLayer4(args: {
  /** Is the developer override set? When false, `folderSetting` is ignored. */
  optional: boolean;
  /** The per-folder checkbox. Inert unless `optional`. */
  folderSetting: boolean;
}): boolean {
  return args.optional ? args.folderSetting === true : true;
}
