import type { Metadata } from "next";
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <DeviceProvider initialKind={device.kind}>{children}</DeviceProvider>
      </body>
    </html>
  );
}
