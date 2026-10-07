// Deep links: addressable URLs for a folder, a conversation, or a single message.
//
// WHY UUIDs AND NOT TITLES
// A conversation's identity on disk is `local_data/beings/<folder>/logs/<uuid>.json`.
// The `title` ("Cairn_18") lives INSIDE the file and is neither unique nor
// stable: clones produce "copy(2)", two folders can hold the same title, and a
// rename would silently break every link that had been shared. The UUID is
// already globally unique and never changes, so it is what the URL carries.
//
// SCHEME
//   /c/<folder>                          → folder, top conversation in the list
//   /c/<folder>/<convoId>                → that conversation
//   /c/<folder>/<convoId>/m/<messageId>  → that conversation, scrolled to a message
//
// Folder names may contain Japanese and spaces, so every segment is encoded on
// the way out. Next.js decodes route params on the way in, so `parseDeepLinkParts`
// receives plain strings.

export interface DeepLink {
  folderName: string;
  /** Absent → open the folder's top conversation. */
  convoId?: string;
  /** Absent → no scroll. */
  messageId?: string;
}

export const DEEP_LINK_PREFIX = '/c';
/** Separates the conversation id from the message id. */
const MESSAGE_SEGMENT = 'm';

/** Path-only link, e.g. `/c/Cairn/0680df61-…/m/3f2a91c4-…`. */
export function buildDeepLink(folderName: string, convoId?: string | null, messageId?: string | null): string {
  const parts = [DEEP_LINK_PREFIX, encodeURIComponent(folderName)];
  if (convoId) {
    parts.push(encodeURIComponent(convoId));
    if (messageId) parts.push(MESSAGE_SEGMENT, encodeURIComponent(messageId));
  }
  return parts.join('/');
}

/** Full URL for the clipboard. Browser-only — falls back to the path server-side. */
export function absoluteDeepLink(folderName: string, convoId?: string | null, messageId?: string | null): string {
  const p = buildDeepLink(folderName, convoId, messageId);
  if (typeof window === 'undefined') return p;
  return `${window.location.origin}${p}`;
}

/**
 * Percent-decode a route segment, but only when it really is encoded.
 *
 * Next.js does NOT decode catch-all (`[...parts]`) segments, so an entity named
 * カナ arrives as the literal string "%E3%82%AB%E3%83%8A" and every name
 * comparison against it fails — the link silently fell back to the last-viewed
 * conversation. Latin-named entities were unaffected, which is exactly why this
 * only ever showed up on the Japanese ones.
 *
 * The round-trip test (`encodeURIComponent(decoded) === raw`) makes this safe to
 * apply unconditionally: it decodes an encoded segment, leaves an
 * already-decoded one alone, and also leaves alone a name that legitimately
 * contains a '%' — so it can't corrupt anything if Next's behavior ever changes.
 */
function safeDecodeSegment(s: string): string {
  try {
    const decoded = decodeURIComponent(s);
    return encodeURIComponent(decoded) === s ? decoded : s;
  } catch {
    return s; // malformed escape — keep the raw text
  }
}

/**
 * Turn the catch-all route segments back into a DeepLink.
 * Returns null for anything unrecognized so a malformed URL degrades to the
 * normal app rather than throwing.
 */
export function parseDeepLinkParts(parts: string[] | undefined | null): DeepLink | null {
  if (!parts || parts.length === 0) return null;
  const [rawFolder, rawConvo, marker, rawMessage] = parts.map(safeDecodeSegment);
  if (!rawFolder) return null;
  if (!rawConvo) return { folderName: rawFolder };
  if (marker === MESSAGE_SEGMENT && rawMessage) {
    return { folderName: rawFolder, convoId: rawConvo, messageId: rawMessage };
  }
  return { folderName: rawFolder, convoId: rawConvo };
}

/**
 * The order the sidebar displays, so "top conversation in the folder" means the
 * same thing to a link as it does to the eye: the user's manual drag order
 * first (folder settings `convoOrder`), then most-recently-updated.
 *
 * Shared with Sidebar deliberately — two copies of this comparator would drift
 * and `/c/<folder>` would start opening something other than the visible top row.
 */
export function orderFolderConversations<T extends { id: string; updatedAt: number }>(
  convos: T[],
  convoOrder: string[] = [],
): T[] {
  return [...convos].sort((a, b) => {
    const ia = convoOrder.indexOf(a.id);
    const ib = convoOrder.indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** DOM id for a rendered message, used as the scroll anchor. */
export function messageAnchorId(messageId: string): string {
  return `msg-${messageId}`;
}
