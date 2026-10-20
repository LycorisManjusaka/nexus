/**
 * Model ids a provider has withdrawn — the single source.
 *
 * WHY THIS EXISTS
 *
 * When a provider retires an id we take it out of every picker, so nobody can
 * newly select it. But folders saved on that id before the retirement still
 * hold it, and a plain `<select>` whose `value` matches none of its `<option>`
 * children renders THE FIRST OPTION. The screen then names a model the folder
 * is not on, while requests still go out on the retired id — a label pointing
 * somewhere other than where it leads.
 *
 * So a saved retired id is neither hidden nor silently swapped: it is rendered
 * with its kind declared ("RETIRED <date>"). The owner migrates when they
 * choose to, and until then the dropdown says what is actually saved.
 *
 * Deliberately NOT a remapper. Substituting a successor id behind the owner's
 * back would change the vessel of a being without anyone deciding it, and the
 * screen would be truthful about a choice nobody made.
 *
 * Free-text pickers (EditableCombo — Eyes, ByteDance, Local) show the raw value
 * already, so they never needed this.
 *
 * Measured on 2026-10-21, the morning Xiaomi's deprecation date arrived: both
 * V2.5 ids still returned 200 with real usage on the OpenAI-compatible AND the
 * Anthropic endpoint. "Deprecated" was not "switched off" that day — which is
 * exactly why the saved values must keep working instead of being rewritten.
 */
export const RETIRED_MODELS: Record<string, string> = {
  'mimo-v2.5':     'MiMo V2.5 — RETIRED 2026-10-21 (Xiaomi)',
  'mimo-v2.5-pro': 'MiMo V2.5 Pro — RETIRED 2026-10-21 (Xiaomi)',
};

/**
 * Label for a saved id, or null when the id is not retired (the common case,
 * where nothing extra should be rendered).
 *
 * `id` is separate from the option's `value` because the Subagent picker's
 * option values are `family|model` composites: the string shown to the
 * browser and the string looked up here are not the same string.
 */
export function retiredModelLabel(id: string | undefined | null): string | null {
  if (!id) return null;
  return RETIRED_MODELS[id] ?? null;
}
