import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "192.168.10.2:3000",
  ],

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