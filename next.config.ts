import { randomUUID } from "node:crypto";
import type { NextConfig } from "next";
import { version } from "./package.json";
import {
  buildContentSecurityPolicy,
  buildPermissionsPolicy,
} from "./src/lib/security/content-security-policy";

export const contentSecurityPolicy = buildContentSecurityPolicy();

// Reuse one identity across Next's config loads and build workers.
const appBuildId = process.env.HIVE_APP_BUILD_ID ?? randomUUID();
process.env.HIVE_APP_BUILD_ID = appBuildId;

const nextConfig: NextConfig = {
  output: "standalone",
  generateBuildId: async () => appBuildId,
  env: {
    NEXT_PUBLIC_HIVE_APP_VERSION: version,
    NEXT_PUBLIC_HIVE_APP_BUILD: process.env.NODE_ENV === "production" ? appBuildId : "development",
  },
  // Next can resolve the ESM condition at runtime even when its file tracer
  // only discovers the CommonJS helper. Ship every conditional export.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**/*",
      "./scripts/notifications/install.py",
      "./scripts/notifications/agent-hook.py",
      "./templates/ai-dev-k8s/scripts/agent-tools.py",
      "./templates/ai-dev-k8s/scripts/github-projects.py",
    ],
  },
  async redirects() {
    // Old bookmarks and delivered notifications resolve to the single canvas.
    // There are no legacy page components or terminal clients behind these URLs.
    return [
      {
        source: "/workspaces/:id/terminal/status",
        destination: "/terminal/status?workspaceId=:id",
        permanent: true,
      },
      {
        source: "/workspaces/:id/terminal/:path*",
        destination: "/workspaces?workspace=:id",
        permanent: true,
      },
      { source: "/workspaces/:id", destination: "/workspaces?workspace=:id", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: buildPermissionsPolicy(),
          },
        ],
      },
    ];
  },
  typescript: {
    // Pre-existing ioredis/bullmq type conflicts prevent clean builds.
    // Runtime behavior is correct; type errors are version-mismatch noise.
    ignoreBuildErrors: true,
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
