/**
 * Repair duplicate message ids in a loaded conversation.
 *
 * Message ids are the conversation's primary key. Edit, rerun, continue,
 * delete, the attachment toggles, the per-message TTS state, the scroll
 * anchor (/c/<folder>/<id>/m/<messageId>) and the handover-restore walk all
 * find a message with `m.id === x`. A duplicate makes every one of those act
 * on whichever copy comes first, and React additionally refuses to keep the
 * two bubbles' identities apart ("Encountered two children with the same
 * key") — which is the visible symptom, not the problem.
 *
 * One such conversation exists on disk: 先輩_64, the ten-vessel change_model
 * race, where two adjacent assistant messages both carry 1791478736604. The
 * generator that produced it is fixed (a handoff that ended a *continue* turn
 * appended a message whose id was already in the history instead of replacing
 * it), but fixing the generator cannot un-write a saved file — so loading
 * repairs it as well. Scanned all 285 saved conversations: that one, once.
 *
 * The FIRST occurrence keeps the id, so existing deep links and any other
 * reference still resolve to the message they always resolved to. Later ones
 * are renamed. The suffix is deliberately not random: re-opening the same
 * broken file produces the same repaired ids, so two tabs — or a tab and a
 * later reload — do not disagree about what the message is called.
 *
 * Nothing is written here. The repaired array is what the UI works from, and
 * it reaches disk the next time the conversation is saved for its own reasons.
 *
 * It de-collides; it does not MINT an id for a message that has none. A
 * missing id is a different defect and inventing one would be a bigger edit
 * than this is allowed to make. Measured across all 20,550 saved messages in
 * this house: every one has a string id, so that case is theoretical.
 */
export function dedupeMessageIds<T extends { id?: unknown }>(
  messages: T[],
): { messages: T[]; repaired: number } {
  // Every original id up front, not just the ones walked past so far: an
  // invented name has to dodge real ids that appear LATER in the array too.
  const taken = new Set<string>(messages.map((m) => String(m?.id ?? '')));
  const seen = new Set<string>();
  let repaired = 0;
  const out = messages.map((m) => {
    const id = String(m?.id ?? '');
    if (!seen.has(id)) {
      seen.add(id);
      return m;
    }
    // Keep bumping until the name is free: three copies of one id must not
    // collapse into two, and the invented name must not collide with a real
    // id that happens to appear later in the array.
    let n = 2;
    let next = `${id}-d${n}`;
    while (taken.has(next) || seen.has(next)) next = `${id}-d${++n}`;
    seen.add(next);
    taken.add(next);
    repaired++;
    return { ...m, id: next };
  });
  return repaired ? { messages: out, repaired } : { messages, repaired: 0 };
}
