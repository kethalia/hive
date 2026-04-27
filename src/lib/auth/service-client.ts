import { AuthServiceClient } from "@hive/auth";

export { AuthServiceClient };

let client: AuthServiceClient | null = null;

export function getAuthServiceClient(): AuthServiceClient {
  if (!client) {
    const baseUrl = process.env.AUTH_SERVICE_URL ?? "http://localhost:4400";
    client = new AuthServiceClient(baseUrl);
  }
  return client;
}
