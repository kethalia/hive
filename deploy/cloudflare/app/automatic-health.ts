import {
  AUTOMATIC_HEALTH_PATH,
  automaticHealthSchema,
} from "../../../src/lib/delivery/release-automatic-contracts";
import { providerBuildIdentitySchema } from "../../../src/lib/provider-build";
import { withReleaseDeadline } from "./release-health";
export type AutomaticHealthEnvironment = {
  HIVE_NATIVE_HEALTH_ENABLED?: string;
  HIVE_NATIVE_MODE?: string;
  HIVE_NATIVE_PRODUCTION_ACTIVE?: string;
  HIVE_PUBLIC_ORIGIN?: string;
  HIVE_NATIVE_BUILD_IDENTITY?: unknown;
};
export async function automaticWorkerHealth(
  request: Request,
  env: AutomaticHealthEnvironment,
  databaseReady: (signal: AbortSignal) => Promise<boolean>,
  authenticationReady: (signal: AbortSignal) => Promise<boolean>,
) {
  const headers = { "Cache-Control": "no-store, max-age=0", Vary: "X-Hive-Health-Nonce" };
  const url = new URL(request.url);
  if (
    env.HIVE_NATIVE_HEALTH_ENABLED !== "true" ||
    request.method !== "GET" ||
    url.pathname !== AUTOMATIC_HEALTH_PATH ||
    url.search ||
    url.hash
  )
    return new Response(null, { status: 404, headers });
  const build = providerBuildIdentitySchema.safeParse(env.HIVE_NATIVE_BUILD_IDENTITY),
    nonce = request.headers.get("X-Hive-Health-Nonce");
  if (
    !build.success ||
    build.data.status !== "available" ||
    build.data.branch !== "main" ||
    env.HIVE_NATIVE_MODE !== "production" ||
    env.HIVE_NATIVE_PRODUCTION_ACTIVE !== "true" ||
    url.protocol !== "https:" ||
    url.origin !== env.HIVE_PUBLIC_ORIGIN ||
    !nonce ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(nonce)
  )
    return new Response(null, { status: 503, headers });
  try {
    await withReleaseDeadline(
      async (signal) => {
        if (
          !(await databaseReady(signal)) ||
          !(await authenticationReady(signal)) ||
          signal.aborted
        )
          throw Error("unavailable");
      },
      request.signal,
      2500,
    );
    return Response.json(
      automaticHealthSchema.parse({
        schemaVersion: 1,
        kind: "automatic-worker-health",
        origin: url.origin,
        worker: "hive",
        mode: "production",
        nonce,
        build: build.data,
        readiness: { database: true, authentication: true },
        observedAt: new Date().toISOString(),
      }),
      { headers },
    );
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
