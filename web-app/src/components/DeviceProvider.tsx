'use client';

/**
 * Carries the device classification (see src/lib/deviceClass.ts) to every
 * component, and owns the one piece of cross-component plumbing the mobile
 * layout needs.
 *
 * Why the three-value measurement is kept but the layout only sees two:
 * `phone` and `tablet` are different FACTS and the probe page reports them
 * separately, but they ask the same thing of the layout — narrow, touch, no
 * hover. Collapsing at the point of USE (`isMobile`) instead of at the point of
 * MEASUREMENT keeps the evidence intact: if a landscape tablet later turns out
 * to want the desktop layout, the data to decide that still exists. Throwing
 * the distinction away in `deviceClass` would have made that question
 * unanswerable without re-instrumenting.
 *
 * The server decides first (from the request's User-Agent) and hands the answer
 * in as `initialKind`, so the first paint is already the right layout and the
 * client's first render agrees with the server's HTML — no hydration mismatch,
 * no flash of the desktop layout on a phone. The client re-checks once on
 * mount only as a correction path; it deliberately does NOT listen for resize,
 * because window width is not a signal here (a narrow desktop window is still
 * a desktop).
 *
 * `cameraSlot` is a DOM node registered by the sidebar on mobile. ChatArea
 * portals <CameraPanel> into it rather than lifting the camera's state up to
 * NexusApp — the panel's playback machine stays owned by ChatArea (where its
 * signal is computed), and only its rendered output moves.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { classifyFromNavigator, type DeviceKind } from '@/lib/deviceClass';

interface DeviceContextValue {
  /** The honest three-value measurement. */
  kind: DeviceKind;
  /** The layout decision: phone and tablet share one layout. */
  isMobile: boolean;
  /** Where the mobile layout wants the being-camera rendered, if anywhere. */
  cameraSlot: HTMLElement | null;
  /** Ref callback — pass directly as `ref={setCameraSlot}`. */
  setCameraSlot: (el: HTMLElement | null) => void;
  /**
   * Mobile only: whether the conversation drawer is showing. Lives here rather
   * than in NexusApp because the control that OPENS it is in ChatArea's header
   * and the panel it opens is Sidebar — two siblings that would otherwise need
   * the state threaded through a parent that has no other use for it.
   * Always false in effect on desktop, where the sidebar is never a drawer.
   */
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const DeviceContext = createContext<DeviceContextValue>({
  kind: 'desktop',
  isMobile: false,
  cameraSlot: null,
  setCameraSlot: () => {},
  sidebarOpen: false,
  setSidebarOpen: () => {},
});

export function useDevice(): DeviceContextValue {
  return useContext(DeviceContext);
}

export function DeviceProvider({
  initialKind,
  children,
}: {
  initialKind: DeviceKind;
  children: React.ReactNode;
}) {
  const [kind, setKind] = useState<DeviceKind>(initialKind);
  const [cameraSlot, setCameraSlot] = useState<HTMLElement | null>(null);
  // Closed by default: on a phone the conversation is the point of the app,
  // and a drawer that starts open would hide it behind a list every time.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const c = classifyFromNavigator();
    // Only correct on a real reading. A `guessed` result means every signal
    // was absent, which is no reason to overrule what the server actually saw.
    if (!c.guessed) {
      setKind(prev => (c.kind === prev ? prev : c.kind));
    }
    // Once. Resize is deliberately not a trigger — see the header comment.

  }, []);

  const value = useMemo<DeviceContextValue>(
    () => ({ kind, isMobile: kind !== 'desktop', cameraSlot, setCameraSlot, sidebarOpen, setSidebarOpen }),
    [kind, cameraSlot, sidebarOpen],
  );

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}
