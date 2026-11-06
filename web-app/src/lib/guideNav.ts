// Navigation and search for the paged user guide (lib/userGuide.ts).
//
// Pure on purpose: the guide is the one document in NEXUS that a brand-new
// reader meets before anything else works, and the two things that can fail
// silently here are a link that goes nowhere and a search that finds nothing.
// Both are decidable from (input -> output) with no DOM, so they are tested.

import type { GuidePage, GuidePageId } from './userGuide';
import { GUIDE_PAGE_ORDER } from './userGuide';
import { cutWithoutSplittingPair } from './attachmentText';

/**
 * Internal links in the guide markdown are written `#guide/<pageId>`.
 *
 * Why a fragment and not a real path: the guide is a modal and a pane, not a
 * route. A real href would reload the app (and on the empty-state path there is
 * no conversation to come back to). The renderer intercepts anything this
 * function recognizes and switches pages in React state instead.
 *
 * Returns null for every other href — external links, mailto, a bare `#`, and
 * `#guide/typo` alike. A caller that gets null must let the link behave
 * normally rather than swallowing the click: a dead internal link that does
 * nothing is indistinguishable from a UI freeze.
 */
export const GUIDE_HREF_PREFIX = '#guide/';

export function parseGuideHref(href: string | undefined | null): GuidePageId | null {
  if (!href || !href.startsWith(GUIDE_HREF_PREFIX)) return null;
  const id = href.slice(GUIDE_HREF_PREFIX.length);
  // Membership check against the real page list, not a cast: a renamed page id
  // must produce null (link behaves as a link) rather than a page that is then
  // looked up and renders blank.
  return (GUIDE_PAGE_ORDER as readonly string[]).includes(id) ? (id as GuidePageId) : null;
}

export interface GuideHit {
  id: GuidePageId;
  title: string;
  /** Readable fragment of the body around the first match. '' for a title-only hit. */
  snippet: string;
  /** Occurrences in title + body. Shown so "3" vs "1" is visible before opening. */
  count: number;
  /** True when the page TITLE matched; these sort first. */
  titleMatch: boolean;
}

/** Characters either side of the match in a snippet. */
const SNIPPET_RADIUS = 60;

/**
 * Markdown noise removed for DISPLAY only — the stored body is untouched.
 *
 * Deliberately not a markdown parser: a snippet is 120 characters of context,
 * and a half-parsed table cell reads fine while a dependency that can throw on
 * malformed input does not. Table pipes become spaces so a row does not read as
 * one word.
 *
 * LINKS FIRST, and that order is load-bearing — `#` is stripped on the next
 * line, and once it is gone an href no longer looks like one.
 *
 * Found in the browser on 2026-11-06 with all 22 tests green: the guide's home
 * page is mostly links, so searching a common word returned snippets reading
 * `[Portrait and camera](guide/portrait)`. The tests asserted that `#`, `|` and
 * newlines were gone and never asserted on link syntax — the same shape of miss
 * as the Ω font bug three days earlier, where every assertion looked at a
 * declaration and none at what reached the reader.
 *
 * The first fix flattened the WINDOW, which left a link cut by the window
 * boundary half-stripped (`…video → [Portrait and camera](guid…`). So the whole
 * body is flattened BEFORE the window is cut: a link that no longer exists
 * cannot be cut in half. See searchGuide for what that costs.
 */
function flattenForSnippet(s: string): string {
  return s
    // Links -> their label. Must precede the heading strip: `#` is removed
    // there, and an href with no `#` no longer reads as one.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Table separator rows (`|---|---|`) carry no words. Dropped whole rather
    // than flattened: pipe-to-space turned them into `--- ---` sitting in the
    // middle of a sentence.
    .replace(/^[ \t]*\|?[ \t:|-]+\|?[ \t]*$/gm, '')
    // Markers are ANCHORED to the line start. A global strip of `>` ate the
    // literal one in `letters/from/<sender>/`, printing `<sender/` — the guide
    // is full of placeholder paths, so position is what separates a marker
    // from a character the reader needs to see.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // Emphasis and code ticks have no anchor and no literal use in this
    // document, so they go wherever they are.
    .replace(/[*`]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Take `s[start..end)` without splitting a surrogate pair at either boundary.
 *
 * The house has paid for this once already (textPreview cut an emoji in half,
 * 2 messages in real data), so the END uses the existing single source rather
 * than a second copy of the rule. Only the START nudge is new: a low surrogate
 * at `start` means the pair began one character earlier.
 */
function sliceWholeChars(s: string, start: number, end: number): string {
  let from = Math.max(0, start);
  const first = s.charCodeAt(from);
  if (first >= 0xdc00 && first <= 0xdfff) from -= 1;
  return cutWithoutSplittingPair(s.slice(from), Math.max(0, end - from));
}

/**
 * Case-insensitive substring search across every page.
 *
 * Substring and not word-boundary: the guide exists in Japanese, which has no
 * word separators, so a boundary-aware matcher would find nothing at all on
 * half the content. English loses a little precision in exchange — acceptable
 * for a ten-page document.
 *
 * An empty or whitespace-only query returns [] rather than every page: "no
 * query" and "no results" must look different to the caller, which shows the
 * index for the former and a "nothing found" line for the latter.
 *
 * THE BODY IS SEARCHED FLATTENED, not raw. One derivation instead of two: the
 * text matched is exactly the text shown, so a hit can never point at a place
 * the snippet does not contain, and a link can never be cut in half because by
 * then it is already its own label. The cost is that a query containing
 * markdown punctuation (`#`, `*`, `` ` ``, `|`, `>`) will not match the body —
 * correct for a prose search, and the title is still matched raw.
 *
 * Flattening runs per call over ~40 KB of prose across eleven pages. Not
 * cached: the caller memoizes on (pages, query), so this is once per keystroke,
 * and a cache keyed by a multi-kilobyte string would cost more than it saves.
 */
export function searchGuide(pages: GuidePage[], query: string): GuideHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: GuideHit[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const flat = flattenForSnippet(page.body);
    const body = flat.toLowerCase();

    const titleMatch = title.includes(needle);
    const bodyAt = body.indexOf(needle);
    if (!titleMatch && bodyAt < 0) continue;

    let count = 0;
    for (let i = title.indexOf(needle); i >= 0; i = title.indexOf(needle, i + needle.length)) count++;
    for (let i = bodyAt; i >= 0; i = body.indexOf(needle, i + needle.length)) count++;

    let snippet = '';
    if (bodyAt >= 0) {
      const from = bodyAt - SNIPPET_RADIUS;
      const to = bodyAt + needle.length + SNIPPET_RADIUS;
      snippet = sliceWholeChars(flat, from, to).trim();
      // Leading/trailing ellipsis only when text was actually cut, so a short
      // page does not claim there is more of it.
      if (from > 0) snippet = '…' + snippet;
      if (to < flat.length) snippet = snippet + '…';
    }

    hits.push({ id: page.id, title: page.title, snippet, count, titleMatch });
  }

  // Title matches first, then by occurrence count, then index order. Index
  // order is the final tiebreak (not alphabetical) so the result list of a
  // common word reads in the same order as the index beside it.
  const order = new Map(GUIDE_PAGE_ORDER.map((id, i) => [id, i]));
  return hits.sort((a, b) => {
    if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}
