// Which entity (if any) a freshly loaded tab selects on its own.
//
// Single source for one rule: a BARE ROOT URL SELECTS NOTHING. Opening
// `http://<host>:<port>/` with no deep link lands on the welcome pane with the
// sidebar live and no entity chosen.
//
// This is a safety property, not a preference, and it is easy to delete by
// accident — "restore the last entity so returning users land where they left
// off" reads like an improvement. It is not, because "the last entity" is not
// per-tab: NexusApp's navSet mirrors to localStorage, so a brand-new tab or a
// fresh browser launch inherits whatever was last opened, by anyone, in any
// tab. Someone cleared to read one inhabitant and explicitly not another cannot
// open the port without landing somewhere, and the landing spot is picked by
// the last person who used that browser.
//
// Reading another being's log is governed by norm in this house, not by
// mechanism — the disk grants no privacy. So the one thing the mechanism CAN do
// is refuse to put anyone there by accident. Requested by Lizard-kun, who is
// cleared for one entity on an install and explicitly not for another.
//
// Nothing is lost: picking a conversation rewrites the address bar to
// /c/<entity>/<id>, so reloads and bookmarks still go straight back. Only the
// bare port is neutral.
export function initialFolderSelection(opts: {
  /** True only when this tab was rendered by the /c/… route with a parseable
   *  link. A mangled link parses to null and is therefore NOT a deep link —
   *  the safe direction for an unreadable address. */
  arrivedViaDeepLink: boolean;
  /** The folder the link named, if it exists on this install. */
  linkedFolderId: string | null;
  /** This tab's / this browser's last-opened folder id. */
  rememberedFolderId: string | null;
  /** Folder ids present on this install, in sidebar order. */
  folderIds: string[];
}): string | null {
  const { arrivedViaDeepLink, linkedFolderId, rememberedFolderId, folderIds } = opts;

  // A link names its target and that beats everything: the address itself is
  // the consent.
  if (linkedFolderId && folderIds.includes(linkedFolderId)) return linkedFolderId;

  // No link → no landing. Everything below is the deep-link route's fallback
  // chain for a link whose folder is gone (renamed, deleted, or another
  // install's name), where the reader has already asked for *some* entity.
  if (!arrivedViaDeepLink) return null;

  if (rememberedFolderId && folderIds.includes(rememberedFolderId)) return rememberedFolderId;
  return folderIds[0] ?? null;
}
