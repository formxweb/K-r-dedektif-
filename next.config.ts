import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tüm sayfalar oturuma bağlı ve dinamik; Cache Components kullanılmıyor.
  serverExternalPackages: ["xlsx"],
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
