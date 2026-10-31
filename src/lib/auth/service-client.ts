import { AuthServiceClient, authServiceHeaders } from "@hive/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export { AuthServiceClient };

let client: AuthServiceClient | null = null;

export function getAuthServiceClient(): AuthServiceClient {
  if (process.env.HIVE_RUNTIME_TARGET === "cloudflare") {
    const env = getCloudflareContext().env as {
      AUTH_SERVICE?: { fetch: typeof fetch };
      AUTH_SERVICE_SECRET?: string;
    };
    if (!env.AUTH_SERVICE || typeof env.AUTH_SERVICE.fetch !== "function") {
      throw new Error("Cloudflare authentication service binding is not configured");
    }
    if (!env.AUTH_SERVICE_SECRET) {
      throw new Error("Cloudflare authentication service secret is not configured");
    }
    authServiceHeaders(env.AUTH_SERVICE_SECRET);
    // Bindings belong to the current request; never retain one in the Node singleton.
    return new AuthServiceClient("https://hive-auth.internal", undefined, {
      fetch: env.AUTH_SERVICE.fetch.bind(env.AUTH_SERVICE),
      serviceSecret: env.AUTH_SERVICE_SECRET,
    });
  }
  if (!client) {
    const baseUrl = process.env.AUTH_SERVICE_URL || "http://localhost:4400";
    client = new AuthServiceClient(baseUrl);
  }
  return client;
}
