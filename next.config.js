const nextConfig = {
  output: 'standalone',
  images: {
    unoptimized: true,
  },
  experimental: {
    // Remove if not using Server Components
    serverComponentsExternalPackages: ['mongodb'],
  },
  webpack(config, { dev }) {
    if (dev) {
      // Reduce CPU/memory from file watching
      config.watchOptions = {
        poll: 2000, // check every 2 seconds
        aggregateTimeout: 300, // wait before rebuilding
        ignored: ['**/node_modules'],
      };
    }
    return config;
  },
  onDemandEntries: {
    maxInactiveAge: 10000,
    pagesBufferLength: 2,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "ALLOWALL" },
          { key: "Content-Security-Policy", value: "frame-ancestors *;" },
          { key: "Access-Control-Allow-Origin", value: process.env.CORS_ORIGINS || "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "*" },
        ],
      },
      {
        // Enhanced security headers for watch pages
        source: "/watch/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // ad-tech needs https: for the unpredictable creative chain
              // (HilltopAds → DSPs → trackers → creatives). 'unsafe-inline'
              // and 'unsafe-eval' are also required by their loader chain.
              "script-src 'self' 'unsafe-eval' 'unsafe-inline' https:",
              "style-src 'self' 'unsafe-inline' https:",
              "img-src 'self' data: blob: https://image.tmdb.org https://*.tmdb.org https:",
              "media-src 'self' blob: https://comet.elfhosted.com https://*.real-debrid.com https://*.alldebrid.com https://*.rdeb.io https://*.debrid.it",
              // ad scripts beacon to many subdomains we can't enumerate ahead of time
              "connect-src 'self' https://api.themoviedb.org https://comet.elfhosted.com https://api.opensubtitles.com https:",
              // ad creatives often render as iframes
              "frame-src 'self' https://vidlink.pro https://vidsrc.to https://embed.su https://multiembed.mov https://www.2embed.cc https:",
              "font-src 'self' data: https:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
