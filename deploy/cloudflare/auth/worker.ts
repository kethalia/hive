import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import { createFetchAuthHandler } from "../../../services/auth/src/fetch-handler";
import { type Context, runRequestLifetime } from "../app/request-lifetime";

export default {
  async fetch(
    request: Request,
    env: { DATABASE_URL?: string; AUTH_SERVICE_SECRET?: string },
    context: Context,
  ): Promise<Response> {
    if (!env.AUTH_SERVICE_SECRET)
      return Response.json({ error: "Authentication unavailable" }, { status: 503 });
    const handle = createFetchAuthHandler(env.AUTH_SERVICE_SECRET);
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
    return runRequestLifetime(database, context, () => handle(request));
  },
};
