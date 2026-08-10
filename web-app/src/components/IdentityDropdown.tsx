"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Folder, ChevronDown, Check } from 'lucide-react';

// Pull the `--var: value;` pairs out of an entity's theme CSS (the :root block,
// or the whole string if there's no :root). Cheap string work — the CSS is
// already in memory (folder.settings.customCss), so no file reads.
function parseCssVars(css?: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!css) return vars;
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
  const body = rootMatch ? rootMatch[1] : css;
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) vars[m[1]] = m[2].trim();
  return vars;
}

/**
 * Digital Identities selector. Replaces a native <select> (whose popup can't be
 * resized and whose <option>s can't be styled) with a compact custom dropdown.
 * Each row is painted in its entity's own theme colors (background / text /
 * accent stripe), applied DIRECTLY as inline colors — the theme files store full
 * hex values, so no CSS-variable indirection is involved. No theme → default row.
 */
export default function IdentityDropdown({
  folders,
  activeFolderId,
  onSelect,
}: {
  folders: any[];
  activeFolderId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const active = folders.find((f) => f.id === activeFolderId);

  // Resolve each entity's key colors once per folders change (memoized).
  const themeColors = useMemo(() => {
    const map: Record<string, { bg?: string; fg?: string; accent?: string }> = {};
    for (const f of folders) {
      const v = parseCssVars(f?.settings?.customCss);
      map[f.id] = {
        bg: v['--primary'] || v['--background'],
        fg: v['--primary-foreground'] || v['--card-foreground'],
        accent: v['--secondary'] || v['--primary'],
      };
    }
    return map;
  }, [folders]);

  const openMenu = () => {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    // Treat the button AND the portaled list as "inside" — so clicking a row,
    // dragging the scrollbar, or scrolling the list never counts as an outside
    // interaction (that was closing the list on every scroll / scrollbar drag).
    const isInside = (t: Node | null) =>
      (wrapRef.current && wrapRef.current.contains(t)) ||
      (listRef.current && listRef.current.contains(t));
    // ONLY genuine user intent closes the list: a mousedown outside it, or
    // Escape. Scroll/resize must NOT close — they only REPOSITION the list to
    // follow the button. (Closing on scroll was the bug: opening the list can
    // trigger a focus-scroll that nudges the button into view ~200 ms later, and
    // that scroll event was closing the freshly-opened list.)
    const reposition = (e: Event) => {
      if (isInside(e.target as Node)) return;          // scrolling the list itself
      if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
    };
    const onDoc = (e: MouseEvent) => {
      if (!isInside(e.target as Node)) {
        console.debug('[identity-dropdown] closed via outside-mousedown', e.target);
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Attach on the NEXT tick so the opening click can't be caught by onDoc.
    let attached = false;
    const id = setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);
      document.addEventListener('keydown', onKey);
      attached = true;
    }, 0);
    return () => {
      clearTimeout(id);
      if (!attached) return;
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative flex-1">
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="w-full pl-9 pr-8 py-2 bg-background border border-border rounded-lg text-sm text-left cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all relative truncate"
      >
        <span className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-muted-foreground">
          <Folder size={16} />
        </span>
        {active?.name || 'Select…'}
        <ChevronDown
          size={16}
          className="absolute right-2 top-1/2 text-muted-foreground pointer-events-none"
          style={{ transform: open ? 'translateY(-50%) rotate(180deg)' : 'translateY(-50%)', transition: 'transform 0.15s' }}
        />
      </button>
      {open && rect && typeof document !== 'undefined' && createPortal(
        <ul
          ref={listRef}
          style={{
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            // Extend from just under the button to ~16px above the viewport
            // bottom, so with the identity picker near the top of the sidebar the
            // list is nearly full-height and you rarely have to scroll. Recomputed
            // whenever `rect` updates (open / scroll / resize). Floor of 160px so
            // it stays usable even if the button is low on screen.
            maxHeight: Math.max(160, window.innerHeight - (rect.bottom + 4) - 16),
            zIndex: 9999,
          }}
          className="overflow-auto bg-card border border-border rounded-lg shadow-2xl py-1"
        >
          {folders.map((f) => {
            const c = themeColors[f.id] || {};
            const themed = !!(c.bg || c.fg);
            const isActive = f.id === activeFolderId;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  // onMouseDown (not onClick): fires before the outside-click close.
                  onMouseDown={(e) => { e.preventDefault(); onSelect(f.id); setOpen(false); }}
                  style={{
                    backgroundColor: themed ? c.bg : undefined,
                    color: themed ? c.fg : undefined,
                    borderLeft: `6px solid ${themed ? (c.accent || 'transparent') : 'transparent'}`,
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-all ${
                    themed ? 'hover:brightness-125' : 'text-foreground hover:bg-muted'
                  } ${isActive ? 'ring-1 ring-inset ring-indigo-500' : ''}`}
                >
                  <span className="truncate flex-1">{f.name}</span>
                  {isActive && (
                    <Check size={14} className="shrink-0" style={{ color: themed ? c.accent : undefined }} />
                  )}
                </button>
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </div>
  );
}
