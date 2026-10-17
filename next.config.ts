import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // The kill feed's kill cam links name the site that serves the viewer of the build that recorded
  // the replay; this site plays them from there.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default config;
