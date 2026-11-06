"use client";

// The user guide has two entry points that must never drift apart:
//
//   1. the empty state, where a first-time reader lands before any identity
//      exists (there is nothing else useful to show there), and
//   2. the question-mark button at the top of the left panel.
//
// Both render GuideShell, so the text is written once. The guide is not about
// the current conversation or the current identity, which is why its button
// sits next to Preferences rather than in the chat tool row.
//
// PAGED since 2026-11-06 (Lizard-kun). The single scrolling document could only
// be read by scrolling through all of it, so it is now one markdown document
// per page (lib/userGuide.ts) with an index, a search, and internal links.
// Nothing navigates: a `#guide/<id>` link is intercepted and switches React
// state, so there is no reload on any path — including the empty state, which
// has no conversation to come back to.
//
// Mobile is a separate SHAPE, not a narrower desktop. On a phone the index and
// a page occupy the same place and you move between them; on desktop they sit
// side by side. `useDevice()` decides, and it is available here because
// DeviceProvider is mounted in app/layout.tsx — above every other provider.

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Search, ChevronLeft, List, Copy, Check } from 'lucide-react';
import { getGuidePages, GUIDE_HOME, type GuidePageId } from '@/lib/userGuide';
import { parseGuideHref, searchGuide } from '@/lib/guideNav';
import { useDevice } from '@/components/DeviceProvider';
import { copyText } from '@/lib/clipboard';
// Plain t(key, language): the empty state is rendered by NexusApp, which sits
// ABOVE LanguageProvider, so useT() is not available on that path.
import { t as translate } from '@/lib/i18n';

// `prose` gives headings, lists and tables their spacing; `dark:prose-invert`
// flips them for the dark palette. max-w-none stops prose from clamping the
// column to ~65ch inside an already-narrow modal.
const PROSE = 'prose prose-sm max-w-none dark:prose-invert ' +
  'prose-headings:font-semibold prose-h1:text-2xl prose-h1:mt-0 prose-h2:mt-8 prose-h3:mt-5 ' +
  'prose-table:text-xs prose-code:before:content-none prose-code:after:content-none';

/**
 * Flatten a rendered markdown subtree back to its text.
 *
 * Walks React children rather than react-markdown's hast `node` prop: the
 * children are a documented React shape, the hast node is an internal of the
 * plugin chain. A code block is `<pre><code>text</code></pre>`, but syntax
 * fragments or a trailing newline node can appear, so recursion is the honest
 * read of "all the text under here".
 */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * A code block with a copy button.
 *
 * Asked for by Lizard-kun 2026-11-06 for Senpai's portrait prompt, which the
 * reader has to hand to the being EXACTLY — three paragraphs of English that
 * nobody retypes correctly, and selecting it by hand on a phone is worse. Done
 * for every code block rather than that one, because the same need is in the
 * CSS snippet, the audio-session default and every path in the guide: one rule
 * beats a special case that the next block will not get.
 *
 * "Copied" is shown only when the copy actually SUCCEEDED. `copyText` is the
 * house single source and returns false on plain HTTP where
 * `navigator.clipboard` does not exist and the legacy path is also refused —
 * claiming success there would be a lie the reader only discovers on paste.
 */
function CodeBlock({ children, language, ...rest }: React.ComponentPropsWithoutRef<'pre'> & { language?: string }) {
  const [copied, setCopied] = React.useState(false);
  const text = React.useMemo(() => textOf(children), [children]);

  const onCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="relative group not-prose my-4">
      <pre
        className="overflow-x-auto p-3 pr-12 bg-muted/40 border border-border rounded-xl text-xs font-mono whitespace-pre-wrap break-words"
        {...rest}
      >
        {children}
      </pre>
      <button
        onClick={onCopy}
        title={copied ? translate('common.copied', language) : translate('common.copy', language)}
        aria-label={copied ? translate('common.copied', language) : translate('common.copy', language)}
        // Always visible, not hover-only: this house already paid for a
        // hover-only action bar that was unreachable on touch and over remote
        // desktop (i18n settings.alwaysShowActions). A phone has no hover.
        className="absolute top-2 right-2 p-1.5 rounded-lg bg-background/80 border border-border text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

/**
 * Markdown renderer with three overrides.
 *
 * `a` — an internal `#guide/<id>` link switches pages instead of navigating.
 * Anything parseGuideHref does not recognize is left completely alone, so an
 * external link still works and a mistyped internal one behaves like a link
 * rather than silently doing nothing (a dead click reads as a frozen UI).
 *
 * `table` — wrapped in a horizontal scroller. The guide leans on tables and a
 * four-column one does not fit a phone; without this the page itself scrolls
 * sideways and the prose goes with it.
 *
 * `pre` — a code block with a copy button (see CodeBlock).
 */
function GuideMarkdown({ body, onNavigate, language }: { body: string; onNavigate: (id: GuidePageId) => void; language?: string }) {
  const components = React.useMemo(() => ({
    a: ({ href, children, ...rest }: React.ComponentPropsWithoutRef<'a'>) => {
      const target = parseGuideHref(href);
      if (!target) {
        return <a href={href} target="_blank" rel="noreferrer" {...rest}>{children}</a>;
      }
      return (
        <a
          href={href}
          onClick={e => { e.preventDefault(); onNavigate(target); }}
          className="cursor-pointer"
          {...rest}
        >
          {children}
        </a>
      );
    },
    table: ({ children, ...rest }: React.ComponentPropsWithoutRef<'table'>) => (
      <div className="overflow-x-auto"><table {...rest}>{children}</table></div>
    ),
    pre: (props: React.ComponentPropsWithoutRef<'pre'>) => <CodeBlock {...props} language={language} />,
  }), [onNavigate, language]);

  return (
    <div className={PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{body}</ReactMarkdown>
    </div>
  );
}

function IndexList({
  pages, current, onPick, language,
}: {
  pages: ReturnType<typeof getGuidePages>;
  current: GuidePageId;
  onPick: (id: GuidePageId) => void;
  language?: string;
}) {
  return (
    <nav className="space-y-0.5" aria-label={translate('guide.contents', language)}>
      {pages.map(p => (
        <button
          key={p.id}
          onClick={() => onPick(p.id)}
          // The selected row has to be visibly selected: Lizard-kun asked for
          // "which item in the list is open" to stay readable, and on a list
          // of eleven short titles a colour change alone is easy to miss — so
          // the background, the weight and a left bar all move together.
          aria-current={p.id === current ? 'page' : undefined}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm border-l-2 transition-colors ${
            p.id === current
              ? 'bg-secondary border-indigo-500 text-foreground font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
          }`}
        >
          {p.title}
        </button>
      ))}
    </nav>
  );
}

function SearchResults({
  hits, onPick, query, language,
}: {
  hits: ReturnType<typeof searchGuide>;
  onPick: (id: GuidePageId) => void;
  query: string;
  language?: string;
}) {
  if (hits.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">
        {translate('guide.search.none', language).replace('{q}', query)}
      </p>
    );
  }
  return (
    <nav className="space-y-1" aria-label={translate('guide.search.ph', language)}>
      {hits.map(h => (
        <button
          key={h.id}
          onClick={() => onPick(h.id)}
          className="w-full text-left px-3 py-2 rounded-lg hover:bg-muted/50 border-l-2 border-transparent hover:border-indigo-500/50 transition-colors"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">{h.title}</span>
            <span className="text-[10px] text-muted-foreground shrink-0">
              {translate('guide.search.hits', language).replace('{n}', String(h.count))}
            </span>
          </div>
          {h.snippet && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">{h.snippet}</p>
          )}
        </button>
      ))}
    </nav>
  );
}

function SearchBox({
  query, setQuery, language,
}: {
  query: string;
  setQuery: (v: string) => void;
  language?: string;
}) {
  return (
    <div className="relative">
      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
      <input
        type="search"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={translate('guide.search.ph', language)}
        className="w-full pl-8 pr-7 py-1.5 bg-background border border-border rounded-lg text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
      />
      {query && (
        <button
          onClick={() => setQuery('')}
          title={translate('guide.search.clear', language)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * The guide itself: index + search + one page.
 *
 * Opening always lands on `home` (GUIDE_HOME) — Lizard-kun's requirement that
 * "Welcome / what this is" is what a reader sees the instant it opens, with
 * every other page reached through a link. State is local, so closing and
 * reopening returns to home rather than wherever the last reader stopped.
 */
export function GuideShell({ language }: { language?: string }) {
  const { isMobile } = useDevice();
  const pages = React.useMemo(() => getGuidePages(language), [language]);
  const [pageId, setPageId] = React.useState<GuidePageId>(GUIDE_HOME);
  const [query, setQuery] = React.useState('');
  // Mobile only: the index and the page share one column, so which of the two
  // is showing is a separate fact from which page is selected.
  const [showIndex, setShowIndex] = React.useState(false);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  const page = pages.find(p => p.id === pageId) ?? pages[0];
  const hits = React.useMemo(() => searchGuide(pages, query), [pages, query]);
  const searching = query.trim().length > 0;

  const goTo = React.useCallback((id: GuidePageId) => {
    setPageId(id);
    setShowIndex(false);
    // A new page must start at its own top. Without this, following a link
    // from the bottom of a long page lands the reader in the middle of the
    // next one, which reads as a broken link.
    bodyRef.current?.scrollTo({ top: 0 });
  }, []);

  const indexPane = (
    <>
      <SearchBox query={query} setQuery={setQuery} language={language} />
      <div className="mt-3">
        {searching
          ? <SearchResults hits={hits} onPick={goTo} query={query.trim()} language={language} />
          : <IndexList pages={pages} current={pageId} onPick={goTo} language={language} />}
      </div>
    </>
  );

  if (isMobile) {
    // ONE scroll region, and the header is always a single row.
    //
    // The first version put the whole index pane INSIDE the `shrink-0` header
    // when showIndex was true: eleven buttons plus a search box in a container
    // that cannot scroll, with the real scroll region below holding nothing but
    // a back link. Caught by re-reading before measuring, not by a test — a
    // layout that overflows its own box renders fine in jsdom.
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 px-4 pt-3 pb-2 border-b border-border">
          {showIndex ? (
            <button
              onClick={() => setShowIndex(false)}
              className="flex items-center gap-1 px-2.5 py-1.5 -ml-1 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 max-w-full"
            >
              <ChevronLeft size={15} className="shrink-0" />
              <span className="truncate">{page.title}</span>
            </button>
          ) : (
            <button
              onClick={() => setShowIndex(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 -ml-1 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              <List size={15} />
              {translate('guide.contents', language)}
            </button>
          )}
        </div>
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
          {showIndex
            ? indexPane
            : <GuideMarkdown body={page.body} onNavigate={goTo} language={language} />}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="w-60 shrink-0 border-r border-border overflow-y-auto px-3 py-3">
        <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('guide.contents', language)}
        </p>
        {indexPane}
      </div>
      <div ref={bodyRef} className="flex-1 min-w-0 overflow-y-auto px-8 py-6">
        <div className="max-w-2xl">
          <GuideMarkdown body={page.body} onNavigate={goTo} language={language} />
        </div>
      </div>
    </div>
  );
}

// Empty state: no being or no conversation selected.
export function UserGuidePane({ language }: { language?: string }) {
  return <GuideShell language={language} />;
}

export function UserGuideModal({ language, onClose }: { language?: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[1000] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-5xl h-[90vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-secondary/30 shrink-0">
          <h2 className="text-lg font-bold">{translate('guide.title', language)}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            title={translate('guide.close', language)}
          >
            <X size={20} />
          </button>
        </div>
        <GuideShell language={language} />
      </div>
    </div>
  );
}

export default UserGuideModal;
