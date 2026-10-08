"use client";

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * A glyph whose explanatory text opens on CLICK (and therefore on tap), not only
 * on hover.
 *
 * Why this exists: the cost indicators ("$" on each message and on the
 * conversation header) carried their figures in a native `title` attribute. A
 * native tooltip needs a hover, and a touch screen has no hover — so on a phone
 * the glyph was there with no way to read it at all. Reported from a phone:
 * "the symbol is there, no popup ever comes, there is no hint."
 *
 * The native `title` is KEPT (passed straight through), so desktop hover behaves
 * exactly as it did; the click panel is purely additive. One mechanism that
 * works on both, rather than a mobile-only branch.
 *
 * Positioning mirrors IdentityDropdown: measure the trigger, portal a
 * `position: fixed` panel to <body>. That is the only placement that cannot be
 * clipped — the message meta row lives inside a scroll container, and an
 * absolutely-positioned panel there would be cut off at its edge.
 */
export default function ClickTip({
  text,
  className,
  title,
  children,
  panel,
  maxWidth,
}: {
  /** The body of the panel. Rendered pre-wrapped — newlines are preserved. */
  text?: string;
  className?: string;
  /** Native hover tooltip. Defaults to `text`; pass '' to suppress it. */
  title?: string;
  children: React.ReactNode;
  /**
   * Interactive panel body, rendered INSTEAD of `text`. Receives `close` so a
   * control inside can dismiss the panel after acting — a menu that stays open
   * after you pick from it reads as "nothing happened".
   *
   * This exists so the mobile message-action overflow menu can reuse the
   * positioning and dismissal logic above rather than grow a second copy of
   * it. Both were measured the hard way: the portal is what keeps a panel from
   * being clipped by the message scroll container, and "scroll repositions,
   * only an outside press closes" is what keeps an opening panel from closing
   * itself.
   */
  panel?: (close: () => void) => React.ReactNode;
  /** Panel width cap. Defaults to 360 (right for prose, too wide for a menu). */
  maxWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const isInside = (n: Node | null) =>
      (btnRef.current && btnRef.current.contains(n)) ||
      (panelRef.current && panelRef.current.contains(n));
    // Scroll/resize REPOSITION, they do not close — the same bug IdentityDropdown
    // documents (opening can trigger a focus-scroll that would close the panel it
    // just opened). Only a press outside, or Escape, closes.
    const reposition = () => {
      if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    };
    const onDown = (e: Event) => { if (!isInside(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Next tick, so the press that opened the panel cannot close it again.
    let attached = false;
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('touchstart', onDown);
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      document.addEventListener('keydown', onKey);
      attached = true;
    }, 0);
    return () => {
      clearTimeout(id);
      if (!attached) return;
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Clamp into the viewport on both axes: a phone is ~390 css px wide, and the
  // "$" sits at the right edge of a row, so an un-clamped panel would hang off
  // the screen. Flip above the glyph when there is more room up than down.
  let style: React.CSSProperties | null = null;
  if (open && rect && typeof window !== 'undefined') {
    const margin = 8;
    const width = Math.min(maxWidth ?? 360, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const flip = below < 120 && above > below;
    style = {
      position: 'fixed',
      left,
      width,
      maxHeight: Math.max(96, (flip ? above : below) - 4),
      zIndex: 9999,
      ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    };
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        title={title === undefined ? (text || undefined) : (title || undefined)}
        onClick={(e) => {
          e.stopPropagation();
          if (open) { setOpen(false); return; }
          if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
          setOpen(true);
        }}
      >
        {children}
      </button>
      {open && style && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          style={style}
          className={
            panel
              // No `whitespace-pre-wrap` / `break-words` here: those are for
              // prose, and they would fight a row of buttons.
              ? 'overflow-auto rounded-lg border border-border bg-card text-card-foreground shadow-2xl p-1.5 text-left font-normal normal-case tracking-normal'
              : 'overflow-auto rounded-lg border border-border bg-card text-card-foreground shadow-2xl px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-left font-normal normal-case tracking-normal'
          }
        >
          {panel ? panel(() => setOpen(false)) : text}
        </div>,
        document.body
      )}
    </>
  );
}
