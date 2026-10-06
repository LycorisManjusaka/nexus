import type { NextConfig } from "next";
import os from "node:os";

// Next's dev server refuses to serve its own dev resources (/_next/*, /__nextjs*)
// to a browser whose Origin host it does not recognise, answering 403. The SSR
// shell still renders, so the page looks alive while hydration never happens --
// a "Loading conversations..." screen that never loads. /api/* is NOT gated:
// measured, it answers 200 to any Origin. So this list protects dev bundles,
// not data.
//
// A literal address here names ONE machine, so a second machine -- or the same
// machine reached by a different address -- silently 403s every /_next chunk
// while the page still looks half-alive. That is exactly what happened: the
// list held this PC's 192.168.10.2, so 192.168.10.6 answered 403 to every chunk
// and never hydrated.
//
// "Everything" is not expressible: Next rejects a lone "*" or "**" outright
// (csrf-protection.js, matchWildcardDomain). What IS expressible is the set of
// names a client could have typed to reach this machine, and the dev server can
// enumerate that itself at startup. Nothing is hardcoded here, and a DHCP
// change needs no edit.
//
// Three things measured, not assumed:
//   - node: imports resolve in next.config.ts (loaded through Next's own
//     loadConfig at phase-development-server; node:os returned the NIC list).
//   - The matcher compares hostname only, with the port already stripped, so
//     one entry covers both 3000 and 3001.
//   - IPv6 must be bracketed: URL.hostname yields "[::1]", not "::1".
//
// This gate is development-only. next build + next start never call it, so a
// shipped copy needs no entry at all.
function ownDevOrigins(): string[] {
  const out = new Set<string>(["127.0.0.1", "[::1]", os.hostname()]);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      // Link-local IPv6 needs a zone id to be reachable, so it is never a name
      // a client would type. Including it would just be noise.
      if (a.family === "IPv6" && /^fe80:/i.test(a.address)) continue;
      out.add(a.family === "IPv6" ? "[" + a.address + "]" : a.address);
    }
  }
  // Escape hatch for what cannot be enumerated: a VPN name, a router-assigned
  // DNS name, a reverse proxy in front. Comma-separated.
  for (const extra of (process.env.NEXUS_ALLOWED_DEV_ORIGINS ?? "").split(",")) {
    const t = extra.trim();
    if (t) out.add(t);
  }
  return [...out];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ownDevOrigins(),

  // Next's dev-tools badge is a fixed circle in the bottom-left corner. On a
  // phone that is exactly where the attach button lives, and the badge sits on
  // top of it and swallows the tap — the button cannot be pressed at all. This
  // house runs the dev server as its normal mode of operation, so the badge is
  // permanent furniture rather than a passing development aid.
  // `false` is the schema-allowed value (config-schema.js: union of an object
  // with `position`, or literal false). Moving it instead (position:
  // 'bottom-right') would only trade one collision for another: the send button
  // is there. To get it back, delete this line.
  devIndicators: false,

  // Playwright must not be bundled. It loads its driver and the Chromium build
  // from %LOCALAPPDATA%\ms-playwright at runtime -- paths no bundler can trace.
  // Leaving it external means `await import('playwright')` in browserTools.ts
  // resolves against node_modules at run time, and a machine that never ran
  // `npx playwright install chromium` still boots (the import fails inside the
  // tool, not at startup).
  serverExternalPackages: ["playwright"],

  // Two Nexus instances share one local_data: the main house (port 3000,
  // web-app) and Cairn's frozen copy (port 3001, web-app-cairn, launched by
  // run-cairn.bat with NEXUS_INSTANCE=cairn).
  //
  // They are byte-identical in the browser, so a response that is read out of
  // context -- a curl, a script, a pasted log -- cannot be attributed to the
  // instance that produced it. This header makes every response say which one
  // answered. Server-side only: no UI change, no client bundle impact, and it
  // resolves to "main" wherever NEXUS_INSTANCE is unset.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Nexus-Instance",
            value: process.env.NEXUS_INSTANCE || "main",
          },
        ],
      },
    ];
  },
};

export default nextConfig;