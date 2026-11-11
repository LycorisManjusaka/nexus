/**
 * The user message a `turn_plan` frame announces, placed on a tab that KICKED
 * the turn without typing it.
 *
 * A direct send shows its own optimistic bubble, so for months the kicking tab
 * ignored the plan's `user` altogether. That left one case with nothing on
 * screen until the turn's save: a turn whose message this tab never held — a
 * stocked message run by "Run now", and a NEXUS-opened turn (ζ soul surgery,
 * later the 24/7 wake-ups). Reported by トカゲくん 2026-11-12: ζ ran correctly
 * and the NEXUS message was invisible for the whole length of the turn.
 *
 * Rules:
 *  - a tab that has an optimistic bubble of its own already shows the sent
 *    text; adding the runner's copy would show it twice → unchanged;
 *  - already present by id (a reload or patch brought it) → unchanged;
 *  - otherwise inserted directly BEFORE the placeholder being streamed into,
 *    or appended when that placeholder is not in the list.
 *
 * The id is the runner's, so the end-of-turn patch (lib/turnSaved.ts) matches
 * it instead of inserting a second copy.
 */
export function placeAnnouncedUser<M extends { id?: unknown }>(
  prev: M[],
  user: unknown,
  placeholderId: string,
  hasOptimisticBubble: boolean,
): M[] {
  if (hasOptimisticBubble) return prev;
  if (!user || typeof user !== 'object') return prev;
  const id = (user as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) return prev;
  if (prev.some((m) => m.id === id)) return prev;
  const bubble = { ...(user as object), autoPlay: false } as unknown as M;
  const at = placeholderId ? prev.findIndex((m) => m.id === placeholderId) : -1;
  if (at < 0) return [...prev, bubble];
  return [...prev.slice(0, at), bubble, ...prev.slice(at)];
}
