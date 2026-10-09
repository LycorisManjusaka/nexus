/**
 * Copy text to the system clipboard, on every surface this app is reached from.
 *
 * Why this file exists: `navigator.clipboard` only exists in a SECURE CONTEXT
 * (HTTPS, or localhost). This house is reached from a phone over plain HTTP at
 * `http://192.168.10.2:3000`, where the whole `navigator.clipboard` object is
 * simply absent — the same secure-context rule that already removes Client
 * Hints on that origin (see `deviceClass.ts`). So on a phone the modern call is
 * not "denied", it is `undefined`, and `navigator.clipboard.writeText(...)`
 * throws a TypeError before anything is copied.
 *
 * Ordering matters and is deliberate. When `navigator.clipboard` is missing we
 * never `await` anything — we drop straight into the synchronous legacy path
 * inside the same task as the click. `document.execCommand('copy')` requires a
 * live user gesture, and an `await` boundary is exactly where that can be lost.
 *
 * Returns whether the text actually reached the clipboard, so callers can show
 * "copied" only when it is true instead of claiming success unconditionally.
 */

/** Selection-based copy. The only path that works outside a secure context. */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const ta = document.createElement('textarea');
  ta.value = text;
  // readonly keeps the on-screen keyboard from flashing open on touch devices.
  ta.setAttribute('readonly', '');
  // position:fixed at the origin — moving it off-screen makes iOS scroll to it.
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.width = '1px';
  ta.style.height = '1px';
  ta.style.padding = '0';
  ta.style.border = 'none';
  ta.style.outline = 'none';
  ta.style.boxShadow = 'none';
  ta.style.background = 'transparent';
  ta.style.opacity = '0';
  document.body.appendChild(ta);

  // Preserve whatever the person had selected; the copy steals the selection.
  const sel = document.getSelection();
  const prevRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

  let ok = false;
  try {
    ta.focus();
    ta.select();
    // iOS Safari ignores select() on a readonly textarea; this is the call that
    // actually establishes the range there.
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }

  document.body.removeChild(ta);

  if (prevRange && sel) {
    sel.removeAllRanges();
    sel.addRange(prevRange);
  }
  return ok;
}

/**
 * Put `text` on the clipboard. Resolves to true only if it actually landed.
 *
 * What is measured, as of 2026-10-09: the secure path on desktop Chromium, and
 * the legacy path in a mobile emulator at `http://192.168.10.2:3000` (the
 * emulator reproduces the missing `navigator.clipboard`, which is the actual
 * fault). NOT measured on a real phone, and NOT measured on iOS Safari at all
 * — the `setSelectionRange` call is there because iOS Safari needs it, but
 * this house has no iOS device, so that line is a reading of the platform and
 * not an observation. Say so if someone asks whether iPhone works.
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '');
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Present but refused: no permission, or the document is not focused.
      // Fall through — the legacy path often still works.
    }
  }
  return legacyCopy(value);
}
