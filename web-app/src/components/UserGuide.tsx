"use client";

// The user guide has two entry points that must never drift apart:
//
//   1. the empty state, where a first-time reader lands before any identity
//      exists (there is nothing else useful to show there), and
//   2. the question-mark button at the top of the left panel.
//
// Both render UserGuideContent, so the text is written once. The guide is not
// about the current conversation or the current identity, which is why its
// button sits next to Preferences rather than in the chat tool row.

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X } from 'lucide-react';
import { getUserGuide } from '@/lib/userGuide';
// Plain t(key, language): the empty state is rendered by NexusApp, which sits
// ABOVE LanguageProvider, so useT() is not available on that path.
import { t as translate } from '@/lib/i18n';

// `prose` gives headings, lists and tables their spacing; `dark:prose-invert`
// flips them for the dark palette. max-w-none stops prose from clamping the
// column to ~65ch inside an already-narrow modal.
const PROSE = 'prose prose-sm max-w-none dark:prose-invert ' +
  'prose-headings:font-semibold prose-h1:text-2xl prose-h2:mt-8 prose-h3:mt-5 ' +
  'prose-table:text-xs prose-code:before:content-none prose-code:after:content-none';

export function UserGuideContent({ language }: { language?: string }) {
  return (
    <div className={PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{getUserGuide(language)}</ReactMarkdown>
    </div>
  );
}

// Empty state: no identity or no conversation selected. Scrolls on its own so
// the guide is readable at any window height without resizing the shell.
export function UserGuidePane({ language }: { language?: string }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <UserGuideContent language={language} />
      </div>
    </div>
  );
}

export function UserGuideModal({ language, onClose }: { language?: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[1000] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
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
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          <UserGuideContent language={language} />
        </div>
      </div>
    </div>
  );
}

export default UserGuideModal;
