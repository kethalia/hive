import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { createFetchAuthHandler } from "../../../services/auth/src/fetch-handler";
import { runRequestLifetime } from "../app/request-lifetime";

type Environment = { DATABASE_URL?: string; AUTH_SERVICE_SECRET?: string };
type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

export default {
  async fetch(request: Request, env: Environment, context: Context): Promise<Response> {
    // Validate authority before constructing a database request. A missing
    // secret is a deployment error, never an unauthenticated service mode.
    if (!env.AUTH_SERVICE_SECRET)
      return Response.json({ error: "Authentication service is not configured" }, { status: 503 });
    const handle = createFetchAuthHandler(env.AUTH_SERVICE_SECRET);
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
    return runRequestLifetime(database, context, () => handle(request));
  },
};
