import { getDb } from "@hive/db";
import { createCloudflareDatabaseRequest } from "@hive/db/cloudflare";
import * as authDomain from "../../../services/auth/src/auth/domain";
import { runCredentialRotation } from "../../../services/auth/src/auth/rotation-scheduler";
import { createFetchAuthHandler } from "../../../services/auth/src/fetch-handler";
import { RELEASE_HEALTH_PATH, releaseHealth } from "../app/release-health";
import { runRequestLifetime } from "../app/request-lifetime";

type Environment = {
  [key: string]: unknown;
  DATABASE_URL?: string;
  AUTH_SERVICE_SECRET?: string;
  HIVE_TOKEN_ROTATION_ENABLED?: string;
  HIVE_RELEASE_HEALTH_ENABLED?: string;
  HIVE_RELEASE_PROBE_SECRET?: string;
  HIVE_RELEASE_SOURCE_SHA?: string;
  HIVE_RELEASE_ARTIFACT_DIGEST?: string;
};
type Context = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

export default {
  async scheduled(_event: unknown, env: Environment) {
    if (env.HIVE_TOKEN_ROTATION_ENABLED !== "true") return;
    const database = createCloudflareDatabaseRequest(env.DATABASE_URL);
    try {
      const result = await database.run(() => runCredentialRotation({ enabled: true }));
      console.log(JSON.stringify({ event: "credential_rotation", ...result }));
    } catch {
      throw new Error("Credential rotation unavailable; durable reservations remain held.");
    } finally {
      await database.close();
    }
  },
  async fetch(request: Request, env: Environment, context: Context): Promise<Response> {
    // Validate authority before constructing a database request. A missing
    // secret is a deployment error, never an unauthenticated service mode.
    if (!env.AUTH_SERVICE_SECRET)
      return Response.json({ error: "Authentication service is not configured" }, { status: 503 });
    if (new URL(request.url).pathname === RELEASE_HEALTH_PATH) {
      const database = createCloudflareDatabaseRequest(env.DATABASE_URL, {
        queryTimeoutMillis: 2000,
        transactionTimeoutMillis: 3000,
      });
      return runRequestLifetime(database, context, () =>
        releaseHealth(request, env, "auth", async () => {
          const result = await getDb().$queryRaw<{ value: number }[]>`SELECT 1 AS value`;
          return result.length === 1 && Number(result[0].value) === 1;
        }),
      );
    }
    const variables = Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
    const handle = createFetchAuthHandler(env.AUTH_SERVICE_SECRET, {
      ...authDomain,
      readAuthenticationReadiness: (options) =>
        authDomain.readAuthenticationReadiness({ ...options, env: variables }),
    });
    const database = createCloudflareDatabaseRequest(
      env.DATABASE_URL,
      new URL(request.url).pathname === "/readiness"
        ? { queryTimeoutMillis: 1000, transactionTimeoutMillis: 2000 }
        : undefined,
    );
    return runRequestLifetime(database, context, () => handle(request));
  },
};
