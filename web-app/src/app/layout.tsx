import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { classifyFromHeaders } from "@/lib/deviceClass";
import { DeviceProvider } from "@/components/DeviceProvider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NEXUS",
  description: "Advanced Local AI Chat Manager",
};

// Adding a `viewport` export REPLACES Next's default (it does not merge), so we
// re-state the default `width=device-width, initial-scale=1` verbatim.
// `interactiveWidget: 'resizes-content'` is the whole point: its default,
// 'resizes-visual', leaves the LAYOUT viewport (and `dvh`/`vh`) at full height
// when the on-screen keyboard opens, so the keyboard overlaps the input and the
// shell's `h-dvh` never shrinks. 'resizes-content' shrinks the layout viewport
// to the space above the keyboard, so `h-dvh` recomputes smaller and the shell
// (status bar at top, input pinned at bottom) fits above the keyboard with no
// document scroll. Desktop ignores this key entirely.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Decided here, on the server, from the request's own User-Agent — so the
  // first painted HTML is already the right layout and the client's first
  // render agrees with it. `data-device` is the escape hatch for plain CSS
  // that wants the same answer without reaching for the React context.
  const h = await headers();
  const device = classifyFromHeaders((n) => h.get(n));
  return (
    <html
      lang="en"
      data-device={device.kind}
      // `dark` here, on the server, not only in NexusApp: the dark base is not
      // a preference, it is the theme ("The dark base is always applied" —
      // NexusApp), and pages outside NexusApp — /login — never run that effect,
      // so they rendered in the browser's default light palette and looked like
      // a different application. Setting it in the markup also means no
      // light-then-dark flash on first paint.
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <DeviceProvider initialKind={device.kind}>{children}</DeviceProvider>
      </body>
    </html>
  );
}
