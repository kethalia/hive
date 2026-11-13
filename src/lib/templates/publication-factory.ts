import { getDb } from "@hive/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getRequestSession } from "@/lib/auth/session";
import { wakeCloudflareBackground } from "@/lib/queue/background-wake.server";
import type { TemplateAssets } from "./publication-artifact";
import { templatePublicationRoutes } from "./publication-routes";

export function cloudflareTemplatePublicationRoutes() {
  const { env } = getCloudflareContext();
  const bindings = env as { DATABASE_URL?: string; ASSETS?: TemplateAssets };
  if (!bindings.ASSETS) throw new Error("Template artifacts unavailable");
  const assets = bindings.ASSETS;
  return templatePublicationRoutes({
    db: getDb,
    session: getRequestSession,
    assets,
    kick: wakeCloudflareBackground,
  });
}
