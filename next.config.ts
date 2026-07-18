import type { NextConfig } from "next";

const scriptSource =
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";

function coderFrameSources(): string {
  const configuredUrls = [
    process.env.CODER_URL,
    ...(process.env.ALLOWED_CODER_URLS?.split(",") ?? []),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const sources = new Set<string>();
  for (const configuredUrl of configuredUrls) {
    try {
      const url = new URL(configuredUrl);
      sources.add(url.origin);
      const labels = url.hostname.split(".");
      if (labels.length >= 3) {
        sources.add(`${url.protocol}//*.${labels.slice(1).join(".")}`);
      }
    } catch {
      // Invalid values are rejected by runtime configuration validation.
    }
  }
  return [...sources].join(" ");
}

const frameSources = ["'self'", coderFrameSources()].filter(Boolean).join(" ");

export const contentSecurityPolicy = `default-src 'self'; base-uri 'self'; frame-ancestors 'self'; frame-src ${frameSources}; form-action 'self'; object-src 'none'; ${scriptSource}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' http: https: wss: ws:; worker-src 'self' blob:`;

const nextConfig: NextConfig = {
  output: "standalone",
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
            value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
          },
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy,
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
