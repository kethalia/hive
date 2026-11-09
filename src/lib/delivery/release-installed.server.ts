import type { PrismaClient } from "@hive/db";
import { configuredAutomaticRelease } from "./release-automatic-host.server";
import { createAutomaticReleaseController } from "./release-automatic-installed.server";

/** The connected repository's single Worker Builds pipeline is the installed
 * publication path. Legacy engines remain readable for history and fixtures. */
export function createInstalledReleaseController(
  db: PrismaClient,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
) {
  if (env.HIVE_DELIVERY_RELEASE_ENABLED !== "true") return null;
  const raw = env.HIVE_DELIVERY_RELEASE_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw) > 16384) throw Error("release_controller_unavailable");
  if (JSON.parse(raw)?.mode !== "automatic-main-builds")
    throw Error("release_controller_unavailable");
  const config = configuredAutomaticRelease(env);
  return config ? createAutomaticReleaseController(db, config, fetcher) : null;
}
