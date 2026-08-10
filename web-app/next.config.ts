import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "192.168.10.2:3000",
  ],

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