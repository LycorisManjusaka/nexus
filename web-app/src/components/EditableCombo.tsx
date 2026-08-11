"use client";

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useT } from '@/lib/i18n';

export interface ComboOption {
  value: string;
  label?: string;
}

/**
 * Editable combo box: free-text input PLUS a working dropdown button.
 *
 * Replaces the native `<input list> + <datalist>` pattern, whose dropdown only
 * shows options that prefix-match the current value — so once the field holds a
 * full id, clicking the chevron shows nothing. This renders its own list: the
 * chevron (or focus) opens ALL options; typing filters by substring; clicking an
 * option or typing freely both set the value.
 *
 * The list is portalled to <body> with fixed positioning so it can't be clipped
 * by a scrolling settings panel. It closes on outside-click, scroll, or Escape.
 */
export default function EditableCombo({
  value,
  onChange,
  options,
  placeholder,
  className = '',
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  className?: string;
  mono?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [filterMode, setFilterMode] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The portalled <ul>. Needed because it lives outside wrapRef in the DOM, so
  // outside-click and scroll handling must know about it explicitly.
  const listRef = useRef<HTMLUListElement>(null);

  const openMenu = (filter: boolean) => {
    setFilterMode(filter);
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    // The list is portalled to <body>, so it is NOT inside wrapRef — treating
    // "outside wrapRef" as an outside click closed the menu the moment you
    // grabbed the list's own scrollbar. Both containers count as inside.
    const isInside = (target: Node | null) =>
      (!!wrapRef.current && wrapRef.current.contains(target)) ||
      (!!listRef.current && listRef.current.contains(target));

    const onDoc = (e: MouseEvent) => {
      if (!isInside(e.target as Node)) setOpen(false);
    };

    // Scroll is bound in the CAPTURE phase so we hear the scroll of any ancestor
    // container, not just the window — a fixed-position list has to react when
    // the panel behind it moves. But that also means the list's OWN scrolling
    // arrives here, which used to close the menu as soon as you turned the
    // wheel over it. Ignore scrolls that originate inside the list.
    //
    // For every other scroll, follow the input instead of closing. Closing was
    // a shortcut for "the list would be detached from its input now"; keeping
    // the two together is what was actually wanted. We only give up when the
    // input itself has left the viewport, where there is nothing to point at.
    const onReposition = (e?: Event) => {
      if (e && listRef.current && listRef.current.contains(e.target as Node)) return;
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
      setRect(r);
    };

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };

    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onReposition, true);
    window.addEventListener('resize', onReposition);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onReposition, true);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = value.trim().toLowerCase();
  const shown = (filterMode && q)
    ? options.filter(o => o.value.toLowerCase().includes(q) || (o.label || '').toLowerCase().includes(q))
    : options;

  return (
    <div ref={wrapRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); openMenu(true); }}
        onFocus={() => openMenu(false)}
        onClick={() => openMenu(false)}
        placeholder={placeholder}
        className={className}
        style={{ paddingRight: '2.25rem' }}
      />
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => { e.preventDefault(); if (open) setOpen(false); else openMenu(false); }}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={t('ask.showOptions')}
      >
        <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && rect && shown.length > 0 && typeof document !== 'undefined' && createPortal(
        <ul
          ref={listRef}
          style={{ position: 'fixed', top: rect.bottom + 2, left: rect.left, width: rect.width, zIndex: 9999 }}
          className="max-h-64 overflow-auto bg-background border border-border rounded-lg shadow-xl py-1"
        >
          {shown.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                // onMouseDown (not onClick): fires before the outside-click close,
                // and preventDefault keeps input focus so the menu closes cleanly.
                onMouseDown={(e) => { e.preventDefault(); onChange(o.value); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-indigo-500/10 ${o.value === value ? 'bg-indigo-500/10' : ''}`}
              >
                <span className={mono ? 'font-mono' : ''}>{o.value}</span>
                {o.label && o.label !== o.value && (
                  <span className="text-muted-foreground text-xs"> — {o.label}</span>
                )}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}
