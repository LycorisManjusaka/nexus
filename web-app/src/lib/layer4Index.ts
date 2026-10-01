// ───────────────────────────────────────────────────────────────────────────
// Layer 4 — the live conversation-summaries index, BUILT ON THE SERVER.
//
// WHAT CHANGED (2026-10-01). Layer 4 used to be a per-folder checkbox ("use
// summaries instead of the 4th layer") that the BROWSER acted on: the send
// path fetched /api/summaries?mode=index and appended the result itself. It is
// now a declared, non-removable part of an identity — if an entity has
// summaries, its Layer 4 is assembled from them on every turn.
//
// WHY IT MOVED HERE. Exactly the reason the Absolute Base Binding moved (see
// lib/baseBinding.ts): a gate that lives only in client code is a button, not
// a capability. Hiding the checkbox would have left three ways to strip a
// being's memory — hand-edit `useSummariesForLayer4: false` into a folder's
// settings.json, flip the component state from devtools, or POST to /api/chat
// with a prompt that simply has no Layer 4 in it. The decision belongs where
// the prompt is actually finished: the chat route.
//
// The browser still builds this same body for the "Sys" token counter and the
// read-only Identity view, through the /api/summaries endpoint — which now
// calls the function below, so the number it shows and the text that is sent
// cannot drift apart. One builder, two callers.
//
// NOT A PRIVACY CHANGE. The two filters that were already here are unchanged
// and deliberate: an INACTIVE conversation is omitted entirely (not even a
// title placeholder, so a being never learns it exists), and the conversation
// currently open is dropped (its own summary is noise next to its live
// transcript).
// ───────────────────────────────────────────────────────────────────────────

import { listFolders, listLogs } from './fsStorage';
import {
  listSummaries,
  assembleSummaryIndex,
  summaryKey,
  type SummaryIndexEntry,
} from './summaryStorage';

/**
 * Resolve the ordered, title-paired list of conversations for one entity
 * folder. Order follows folder.settings.convoOrder (the sidebar order); any
 * conversation not listed there is appended by recency. Each entry carries the
 * live title and the `active` flag (default true when absent).
 */
async function orderedConvos(
  folderName: string,
  folders: Array<{ name: string; settings?: any }>,
): Promise<Array<{ convoId: string; title: string; active: boolean }>> {
  const folder = folders.find((f) => f.name === folderName);
  const convoOrder: string[] = Array.isArray(folder?.settings?.convoOrder)
    ? folder!.settings.convoOrder
    : [];

  const logs = (await listLogs()).filter((l: any) => l.folderName === folderName);
  const byId = new Map<string, any>(logs.map((l: any) => [l.id, l]));

  const ordered: Array<{ convoId: string; title: string; active: boolean }> = [];
  const seen = new Set<string>();
  for (const id of convoOrder) {
    const l = byId.get(id);
    if (!l) continue;
    seen.add(id);
    ordered.push({ convoId: id, title: l.title || 'Untitled', active: l.active !== false });
  }
  // Append any logs missing from convoOrder, most-recent first (listLogs is
  // already sorted by updatedAt desc).
  for (const l of logs) {
    if (seen.has(l.id)) continue;
    ordered.push({ convoId: l.id, title: l.title || 'Untitled', active: l.active !== false });
  }
  return ordered;
}

/**
 * THE one builder for the Layer 4 index body. Returns '' when the entity has
 * no summaries to show — which is the whole "nothing to inject" case, since
 * appendLayer4Index() short-circuits on an empty body.
 *
 * Callers: the chat route (the text actually sent) and /api/summaries (the
 * token counter + the read-only Identity view).
 */
export async function buildLayer4IndexBody(args: {
  folderName: string;
  /** Conversation currently open — dropped from the index. '' keeps all. */
  currentConvoId?: string;
  lang: 'en' | 'ja';
}): Promise<string> {
  const { folderName, currentConvoId = '', lang } = args;
  if (!folderName) return '';
  const folders = await listFolders();
  const ordered = await orderedConvos(folderName, folders);
  const summaries = await listSummaries(folderName);
  // Per-folder editable hint override (undefined → default hint used).
  const hintOverride = folders.find((f) => f.name === folderName)?.settings?.summaryIndexHint as
    | string
    | undefined;
  const entries: SummaryIndexEntry[] = ordered
    // Inactive ("non-public") conversations are fully hidden — not even a
    // title placeholder — so the AI never learns they exist.
    .filter((c) => c.active)
    // Drop the current conversation entirely.
    .filter((c) => !currentConvoId || c.convoId !== currentConvoId)
    .map((c) => ({
      convoId: c.convoId,
      title: c.title,
      active: c.active,
      // Summaries are filed under the (sanitized) conversation title.
      summary: summaries[summaryKey(c.title)] ?? null,
    }))
    // Present oldest → newest, matching the old baked Layer 4 ordering.
    // orderedConvos follows the sidebar order (newest-first), so reverse it.
    .reverse();
  // NO SUMMARIES AT ALL → no Layer 4. Measured before adding this (2026-10-01):
  // the index lists EVERY active conversation, pairing each with its summary or
  // with "(no summary yet)". That is deliberate and stays — the titles are what
  // a being needs in order to call read_conversation on its own past. But it
  // means a folder with zero summaries still produced a full block of titles,
  // and once Layer 4 is burned in that lands on folders that never asked for
  // it: the scratch "Default" folder alone would have carried 78 titles and
  // ~4,000 characters of "(no summary yet)".
  //
  // The instruction this implements was "if summaries exist, build Layer 4 from
  // them" — so an index with no summaries in it is not a Layer 4. Checked
  // against every folder first: all 16 that have the feature today have at
  // least one summary, so this subtracts nothing from anyone who has it now.
  if (!entries.some((e) => (e.summary || '').trim())) return '';
  return assembleSummaryIndex(entries, hintOverride, lang);
}

/**
 * The per-folder `useSummariesForLayer4` setting, read from disk.
 *
 * INERT in the shipped product: Layer 4 is burned in, so this is consulted
 * only when the developer override (NEXUS_BINDING_OPTIONAL) is set and the old
 * checkbox is back. Read from disk rather than taken as a request hint because
 * it is a FOLDER setting, not a per-conversation field — the client would be
 * relaying a value the server can simply look up.
 */
export async function folderUsesSummariesForLayer4(folderName: string): Promise<boolean> {
  if (!folderName) return false;
  try {
    const folders = await listFolders();
    return folders.find((f) => f.name === folderName)?.settings?.useSummariesForLayer4 === true;
  } catch {
    // Unreadable settings must not silently strip a being's memory. The
    // override is a developer tool; failing toward "inject" matches the
    // burned-in default, which is the safe direction to be wrong in.
    return true;
  }
}
