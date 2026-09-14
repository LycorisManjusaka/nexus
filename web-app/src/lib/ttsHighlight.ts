/**
 * TTS phrase highlight — paint-level, zero DOM mutation.
 *
 * While TTS speaks, the phrase currently being pronounced is tinted inside the
 * message bubble. This is built on the CSS Custom Highlight API
 * (`CSS.highlights` + `::highlight()`), which is the same machinery the browser
 * uses for `::selection`, and that choice is the whole point:
 *
 *   • It mutates NOTHING. No wrapper <span>, no React re-render, no change to
 *     the DOM the message renders into. React's reconciliation never sees it.
 *   • It CANNOT change font metrics. `::highlight()` only accepts colour-ish
 *     properties (color, background-color, text-decoration, text-shadow,
 *     -webkit-text-stroke). There is no way for it to alter glyph width, so the
 *     "text reflows as it is highlighted" failure of a bold/font approach is
 *     structurally impossible here.
 *   • Cost is one O(text length) walk per spoken phrase — i.e. once every few
 *     seconds of audio, over a few thousand characters. Not per frame, not per
 *     token.
 *
 * If the browser lacks the API (Firefox < 140, older Safari), every function
 * here is a no-op and TTS behaves exactly as before.
 *
 * ── Why the colour is swapped, not copied ───────────────────────────────────
 * A being's bubble already IS `--card`; painting its spoken phrase in `--card`
 * would nearly vanish into its own background. So the highlight borrows the
 * OTHER side's bubble colour instead: a being's phrase is lit in the
 * partner's `--primary`/`--primary-foreground`, and the partner's own spoken
 * phrase (Read Aloud) is lit in the being's `--card`/`--card-foreground`.
 * Foreground always travels with its matching background — some beings'
 * `--card-foreground` is dark, and pairing it with the wrong background would
 * be unreadable. Two separate `CSS.highlights` registrations carry this (one
 * per side); only one is ever populated at a time, the other is deleted.
 *
 * ── Why the CSS lives here and not in globals.css ───────────────────────────
 * The two `::highlight()` rules were in `globals.css` until 2026-09-14. They
 * compiled and shipped correctly, but LightningCSS — the CSS parser Turbopack
 * uses — has not implemented `::highlight()` yet, so every dev-server compile
 * logged two "not recognized as a valid pseudo-element" warnings about working
 * code. `@supports selector(::highlight(x))` does NOT silence it (measured:
 * the warning comes from parsing the selector, not from evaluating support).
 * The parser is compiled into the native `@next/swc` binary, so upgrading the
 * node_modules copy cannot help either. So the rules are injected at runtime
 * instead, which keeps them out of every build-time CSS parser's path — the
 * same mechanism NexusApp.tsx already uses for per-folder custom CSS.
 * This is a WORKAROUND, not a fix. When LightningCSS supports the selector,
 * delete `ensureHighlightStyle()` and put the rules back in globals.css.
 *
 * ── Why the text matching is fuzzy ──────────────────────────────────────────
 * The spoken chunk is a slice of the RAW markdown (after timestamp stripping,
 * the output filter and sentence splitting). The DOM holds the RENDERED text,
 * where markdown syntax has been consumed. `**bold**` is three characters
 * shorter on screen than in the source. So both sides are normalised the same
 * way — whitespace and markdown punctuation dropped, lower-cased — and the
 * match is done on that. Where the two genuinely cannot line up (a link, whose
 * URL exists in the source but not in the rendered text), the phrase simply
 * isn't highlighted for that moment. Never an exception, never a wrong range
 * that breaks playback.
 */

/** One registration per side, so the two colours (see file header) never
 *  collide. Exactly one of the two is populated at any moment. */
const HIGHLIGHT_ASSISTANT = 'nexus-tts-current-assistant';
const HIGHLIGHT_USER = 'nexus-tts-current-user';

/** Punctuation dropped from both sides before matching. Mostly markdown
 *  syntax, plus dashes/brackets that markdown renderers move around. Dropping
 *  a character class is always safe as long as BOTH sides drop it. */
const DROPPED = new Set('*_~`#>|[]()!\\-–—+=<'.split(''));

function keepChar(ch: string): boolean {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '　') return false;
  return !DROPPED.has(ch);
}

function normalize(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (keepChar(ch)) out += ch.toLowerCase();
  }
  return out;
}

type TextIndex = {
  /** Normalised, lower-cased text of the whole subtree. */
  norm: string;
  /** For each character of `norm`: the text node it came from … */
  nodes: Text[];
  /** … and its offset inside that node. */
  offsets: number[];
};

/** Id of the injected <style>. Stable so a Fast Refresh that re-evaluates this
 *  module finds the existing tag instead of stacking duplicates. */
const STYLE_TAG_ID = 'nexus-tts-highlight-css';

/**
 * Put the two `::highlight()` rules into the document (see file header for why
 * they aren't in globals.css). Called from the paint path, behind the same
 * `supported()` gate as everything else — a browser without the API gets no
 * style tag at all.
 *
 * Inserted as the FIRST child of <head> on purpose: that is the weakest cascade
 * position, so a being's theme.css or a folder's custom CSS — both appended
 * later — can still override the highlight colours, exactly as they could when
 * these rules sat at the top of globals.css.
 */
function ensureHighlightStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_TAG_ID)) return;
  const tag = document.createElement('style');
  tag.id = STYLE_TAG_ID;
  // Paint-only property set: the browser accepts colour, background-color,
  // text-decoration, text-shadow and -webkit-text-stroke inside ::highlight()
  // and nothing else. It cannot change font, weight or size, so highlighted
  // text can never reflow — the whole reason this approach was chosen.
  tag.textContent = [
    `::highlight(${HIGHLIGHT_ASSISTANT}) {`,
    '  background-color: var(--primary);',
    '  color: var(--primary-foreground);',
    '}',
    `::highlight(${HIGHLIGHT_USER}) {`,
    '  background-color: var(--card);',
    '  color: var(--card-foreground);',
    '}',
  ].join('\n');
  document.head.insertBefore(tag, document.head.firstChild);
}

function supported(): boolean {
  try {
    return typeof CSS !== 'undefined'
      && !!(CSS as any).highlights
      && typeof (globalThis as any).Highlight === 'function';
  } catch {
    return false;
  }
}

function buildIndex(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let norm = '';
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const s = t.data;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (!keepChar(ch)) continue;
      norm += ch.toLowerCase();
      nodes.push(t);
      offsets.push(i);
    }
  }
  return { norm, nodes, offsets };
}

// ── Module state ────────────────────────────────────────────────────────────
// Only one message speaks at a time, so a single registration is enough and a
// new phrase naturally replaces the old one.
let lastRange: Range | null = null;
let lastRoot: HTMLElement | null = null;
let lastText = '';
let lastStart = 0;
/** Which of the two registrations is the one currently populated — needed so
 *  `reapplyTtsHighlight` (which only gets a root, not a role) re-applies with
 *  the same colour it was showing before the DOM node it anchored to died. */
let lastKind: 'user' | 'assistant' = 'assistant';
/** Forward-only search cursor: the same sentence can legitimately appear twice
 *  in a message, and playback always moves forward through it. */
let searchFrom = 0;

function applyRange(index: TextIndex, at: number, end: number, isUser: boolean): void {
  // Single choke point for "a highlight becomes visible", so this is the one
  // place that has to guarantee the rules exist. Idempotent and O(1) after the
  // first call.
  ensureHighlightStyle();
  const range = document.createRange();
  range.setStart(index.nodes[at], index.offsets[at]);
  range.setEnd(index.nodes[end - 1], index.offsets[end - 1] + 1);
  const highlights = (CSS as any).highlights;
  // Only one side is ever lit — clear both before setting the active one, or
  // switching mid-conversation between a being's turn and a Read-Aloud of the
  // partner's own message would leave a stale range glowing in the old spot.
  highlights.delete(HIGHLIGHT_ASSISTANT);
  highlights.delete(HIGHLIGHT_USER);
  highlights.set(isUser ? HIGHLIGHT_USER : HIGHLIGHT_ASSISTANT, new (globalThis as any).Highlight(range));
  lastRange = range;
  lastKind = isUser ? 'user' : 'assistant';
}

function locate(index: TextIndex, needle: string, from: number): number {
  let at = index.norm.indexOf(needle, from);
  if (at >= 0) return at;
  // Wrapped or re-rendered — try from the top before giving up.
  at = index.norm.indexOf(needle);
  if (at >= 0) return at;
  // Lenient: a link or an entity inside the phrase makes the tail unmatchable.
  // Anchor on a distinctive prefix instead and span the phrase's length.
  const probe = needle.slice(0, Math.min(needle.length, 16));
  if (probe.length < 6) return -1;
  at = index.norm.indexOf(probe, from);
  if (at >= 0) return at;
  return index.norm.indexOf(probe);
}

/**
 * Highlight `text` inside `root`. Silently does nothing if the API is missing,
 * the arguments are empty, or the phrase can't be located.
 *
 * `isUser` says whose phrase this is (`msg.role === 'user'`), which selects
 * the colour — see the file header for why it's the OTHER side's bubble
 * colour, not this message's own.
 */
export function highlightTtsPhrase(root: HTMLElement | null | undefined, text: string, isUser: boolean = false): void {
  if (!supported() || !root || !text) return;
  try {
    // Collapse markdown links to their label first. This is the one place the
    // two sides genuinely hold different characters: `[Nexus](https://…)` is
    // spoken/stored with the URL, but the rendered DOM shows only "Nexus" (the
    // URL lives in href). Applied to the needle only — the DOM side never
    // contains link syntax, and removing characters there would desync the
    // node/offset map.
    const needle = normalize(text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    if (needle.length < 2) return;
    if (root !== lastRoot) searchFrom = 0;
    const index = buildIndex(root);
    const at = locate(index, needle, searchFrom);
    if (at < 0) { clearTtsHighlight(); return; }
    const end = Math.min(at + needle.length, index.norm.length);
    if (end <= at) { clearTtsHighlight(); return; }
    applyRange(index, at, end, isUser);
    lastRoot = root;
    lastText = text;
    lastStart = at;
    searchFrom = end;
  } catch {
    // A highlight is decoration. It must never be able to break playback.
    clearTtsHighlight();
  }
}

/**
 * Re-apply the current phrase if React replaced the text nodes underneath it
 * (which happens to the last paragraph of a message that is still streaming).
 * The common case is an `isConnected` check on one node — O(1) — so this is
 * cheap enough to call on every content tick.
 */
export function reapplyTtsHighlight(root: HTMLElement | null | undefined): void {
  if (!supported() || !root || !lastText || !lastRange) return;
  try {
    const anchor = lastRange.startContainer;
    if (anchor && anchor.isConnected) return;
    // Detached — rebuild from where this phrase started, not from where it
    // ended, or the search cursor would skip past it. Reuse whichever side
    // was lit before the detach — this call has no role of its own.
    searchFrom = lastStart;
    const text = lastText;
    const isUser = lastKind === 'user';
    highlightTtsPhrase(root, text, isUser);
  } catch {
    clearTtsHighlight();
  }
}

/** Remove the highlight and reset the forward-only search cursor. */
export function clearTtsHighlight(): void {
  lastRange = null;
  lastRoot = null;
  lastText = '';
  lastStart = 0;
  lastKind = 'assistant';
  searchFrom = 0;
  if (!supported()) return;
  try {
    (CSS as any).highlights.delete(HIGHLIGHT_ASSISTANT);
    (CSS as any).highlights.delete(HIGHLIGHT_USER);
  } catch {}
}
