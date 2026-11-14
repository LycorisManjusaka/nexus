// Which models may sit in a sense's seat (eyes / ears / video watcher).
//
// WHY THIS EXISTS (2026-11-14, つよ's ⑥):
// The three sense selects used to be hand-typed lists, a third copy of the
// model catalogue beside the Model tab and the anchor picker. Every new vessel
// (Hydrogen, Carbon) had to be added there by hand as well, and the copy is the
// one nothing checks. Now the sense tab renders the SAME FamilyModelPicker as
// the Model tab and the anchor, and this file is only the filter.
//
// A model is offered for a sense when BOTH hold:
//   1. the bridge can CALL it — each bridge routes by id prefix to a fixed set
//      of providers (eyesVision.ts / earsBridge.ts / videoBridge.ts). A model
//      the bridge cannot route to would be offered and then fail on first use;
//   2. the model can PERCEIVE that kind — the existing single sources
//      isVisionCapable / isAudioCapable / isVideoCapable (modelVision.ts).
// Neither question is answered here a second time; this file only intersects.

import { isVisionCapable, isAudioCapable, isVideoCapable } from './modelVision';

export type SenseKind = 'eyes' | 'ears' | 'watcher';

/**
 * Families each bridge can route to, in the order the family select shows.
 * Must stay in lockstep with the `startsWith` chains in the three bridges —
 * the test pins one representative id per route.
 */
const ROUTES: Record<SenseKind, string[]> = {
  // eyesVision.ts: local: / claude / gemini / mimo / else → Z.AI (GLM)
  eyes: ['Gemini', 'Claude', 'GLM', 'MiMo', 'Local'],
  // earsBridge.ts / videoBridge.ts: qwen / gemini / mimo / seed
  ears: ['Gemini', 'Qwen', 'MiMo', 'ByteDance'],
  watcher: ['Gemini', 'Qwen', 'MiMo', 'ByteDance'],
};

export function senseFamilies(kind: SenseKind): string[] {
  return ROUTES[kind];
}

/**
 * The model a seat jumps to when its family is switched. The Model tab's
 * family default is not usable here (GLM's is text-only glm-5.2). Every entry
 * is pinned by a test to pass senseAccepts for its kind. Local has none: it is
 * picked from whatever LM Studio has loaded at that moment.
 */
const SEAT_DEFAULTS: Record<SenseKind, Record<string, string>> = {
  eyes: { Gemini: 'gemini-3.5-flash-lite', Claude: 'claude-haiku-5-5', GLM: 'glm-5v-turbo', MiMo: 'mimo-v2.6-flash' },
  ears: { Gemini: 'gemini-3.5-flash-lite', Qwen: 'qwen3.5-omni-flash', MiMo: 'mimo-v2.6-pro', ByteDance: 'seed-2-0-lite-260428' },
  watcher: { Gemini: 'gemini-3.5-flash-lite', Qwen: 'qwen3.5-omni-flash', MiMo: 'mimo-v2.6-pro', ByteDance: 'seed-2-0-lite-260428' },
};
export function senseSeatDefault(kind: SenseKind, family: string): string {
  return SEAT_DEFAULTS[kind][family] ?? '';
}

/** Does the bridge's prefix chain reach this id under this family? */
function bridgeRoutes(kind: SenseKind, family: string, id: string): boolean {
  const s = id.toLowerCase();
  if (kind === 'eyes') {
    switch (family) {
      case 'Gemini': return s.startsWith('gemini');
      case 'Claude': return s.startsWith('claude');
      case 'MiMo': return s.startsWith('mimo');
      // The else-branch calls Z.AI; a DigitalOcean GLM id would be sent there
      // with the wrong key and model name.
      case 'GLM': return s.startsWith('glm');
      case 'Local': return true;
      default: return false;
    }
  }
  switch (family) {
    case 'Gemini': return s.startsWith('gemini');
    case 'Qwen': return s.startsWith('qwen');
    case 'MiMo': return s.startsWith('mimo');
    // The bridges test `seed`, so the `dola-seed-…` snapshot is NOT reachable.
    case 'ByteDance': return s.startsWith('seed');
    default: return false;
  }
}

function perceives(kind: SenseKind, id: string, localVision?: boolean): boolean {
  if (kind === 'eyes') return !!localVision || isVisionCapable(id);
  if (kind === 'ears') return isAudioCapable(id);
  return isVideoCapable(id);
}

/**
 * The picker-side filter. `id` is the id as the Model tab lists it (bare for
 * local models). `localVision` is LM Studio's own vision flag for a local id.
 */
export function senseAccepts(kind: SenseKind, family: string, id: string, localVision?: boolean): boolean {
  if (!id) return false;
  return bridgeRoutes(kind, family, id) && perceives(kind, id, localVision);
}

// The eyes bridge marks a local model with a `local:` prefix (the Model tab
// stores the bare id). These two keep that translation in one place.
export function senseStoredValue(family: string, pickerId: string): string {
  return family === 'Local' && pickerId && !pickerId.startsWith('local:') ? `local:${pickerId}` : pickerId;
}
export function sensePickerId(stored: string): string {
  return (stored || '').startsWith('local:') ? stored.slice('local:'.length) : (stored || '');
}

/** Which family a saved sense value belongs to (its family select's value). */
export function senseFamilyOf(kind: SenseKind, stored: string): string {
  const s = (stored || '').toLowerCase();
  const routes = ROUTES[kind];
  if (s.startsWith('local:')) return routes.includes('Local') ? 'Local' : routes[0];
  if (s.startsWith('claude')) return routes.includes('Claude') ? 'Claude' : routes[0];
  if (s.startsWith('gemini')) return 'Gemini';
  if (s.startsWith('mimo')) return 'MiMo';
  if (s.startsWith('qwen')) return routes.includes('Qwen') ? 'Qwen' : routes[0];
  if (s.startsWith('seed') || s.startsWith('dola-')) return routes.includes('ByteDance') ? 'ByteDance' : routes[0];
  if (kind === 'eyes') return 'GLM'; // the eyes bridge's else-branch
  return routes[0];
}
