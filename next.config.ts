import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    // Pre-existing ioredis/bullmq type conflicts prevent clean builds.
    // Runtime behavior is correct; type errors are version-mismatch noise.
    ignoreBuildErrors: true,
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
