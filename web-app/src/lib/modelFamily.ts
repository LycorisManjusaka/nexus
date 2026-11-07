// Model-id → billing family, and the Claude OAuth/API split.
//
// Extracted from stats/route.ts (2026-11-07) so the SPU billing ledger derives
// a family the SAME way a saved message does. Two derivations of "which family
// is this model" is exactly the drift this house pays for: a soul-updater run on
// deepseek-v4-pro must land in the same column as a chat turn on the same model,
// and the OAuth exclusion option must see "Claude (OAuth)" spelled one way.
//
// The two functions below are a byte-identical transcription of what lived
// inline in the stats route; splitClaudeByAuth replaces the inline
// `family === 'Claude' ? …` branch there and is reused by the billing path.

/** The flat, priced, family-tagged record both the message walk and the SPU
 *  billing ledger produce. The client (StatsModal) groups these into reports. */
export interface StatRecord {
  entity: string;
  convoId: string;
  convoTitle: string;
  ts: number | null;   // event timestamp (ms), null when the source lacks one
  family: string;      // canonical family; Claude split into OAuth/API
  model: string;       // resolved model id used for pricing (display form)
  usd: number;
  estimated: boolean;  // true = derived, false = from real cacheUsage
  unpriced: boolean;   // model has no price row (usd forced to 0)
}

// Canonicalize the stored modelFamily string (fixes casing drift like
// "Minimax" vs "MiniMax"; leaves unknown values untouched).
export function canonFamily(stored?: string | null): string {
  const map: Record<string, string> = {
    minimax: 'MiniMax', chatgpt: 'ChatGPT', openai: 'ChatGPT', claude: 'Claude',
    gemini: 'Gemini', kimi: 'Kimi', glm: 'GLM', grok: 'Grok', qwen: 'Qwen',
    deepseek: 'DeepSeek', cohere: 'Cohere', mimo: 'MiMo', bytedance: 'ByteDance',
    meta: 'Meta', local: 'Local',
  };
  const key = (stored || '').toLowerCase().trim();
  return map[key] || (stored || 'Unknown');
}

// Derive a family from a bare model id — used when a message has no stored
// modelFamily (old, pre-tagging messages priced at the entity default model),
// and for every SPU billing entry (which stores only the model id it ran).
export function familyFromModelId(id?: string | null): string {
  const s = (id || '').toLowerCase().trim();
  if (!s) return 'Unknown';
  // Local LM Studio slugs: vendor/name or name@quant. moonshotai/ is the one
  // cloud id that legitimately carries a slash — everything else with / or @ is
  // a local GGUF and must NOT be priced.
  if (s.includes('@')) return 'Local';
  if (s.includes('/') && !s.startsWith('moonshotai/')) return 'Local';
  const k = s.replace(/^moonshotai\//, '');
  if (k.startsWith('claude-')) return 'Claude';
  if (k.startsWith('gpt-') || k.startsWith('o1') || k.startsWith('o3') || k.startsWith('o4')) return 'ChatGPT';
  if (k.startsWith('gemini')) return 'Gemini';
  if (k.startsWith('kimi')) return 'Kimi';
  if (k.startsWith('glm')) return 'GLM';
  if (k.startsWith('grok')) return 'Grok';
  if (k.startsWith('deepseek')) return 'DeepSeek';
  if (k.startsWith('qwen')) return 'Qwen';
  if (k.startsWith('minimax')) return 'MiniMax';
  if (k.startsWith('command')) return 'Cohere';
  if (k.startsWith('mimo')) return 'MiMo';
  if (k.startsWith('dola-') || k.startsWith('seed-') || k.startsWith('doubao')) return 'ByteDance';
  // Meta Model API ids. `sam-` is matched too so an old log that used the
  // segmentation model is attributed rather than silently falling into
  // 'Unknown' — it is not offered in the chat dropdown (it demands an
  // input_image/input_video part), but attribution is cheap and a wrong
  // 'Unknown' is not.
  if (k.startsWith('muse-') || k.startsWith('sam-')) return 'Meta';
  return 'Unknown';
}

/**
 * Split the Claude family by auth mode. A no-op for every other family.
 *
 * OAuth Claude runs on a flat subscription the person running NEXUS may not be
 * the one paying for (Pilot does not pay Lizard-kun's), so the stats "exclude
 * OAuth" option keys on this exact string. Both the message walk and the SPU
 * billing ledger route through here so the two spell it identically.
 */
export function splitClaudeByAuth(family: string, authMode?: string | null): string {
  if (family !== 'Claude') return family;
  return authMode === 'oauth' ? 'Claude (OAuth)' : 'Claude (API)';
}
