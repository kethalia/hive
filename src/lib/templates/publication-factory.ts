import { getDb } from "@hive/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { getRequestSession } from "@/lib/auth/session";
import { publicationActorAuthorizer } from "./publication-actor";
import { type TemplateAssets, templateAssetsLoader } from "./publication-artifact";
import { templatePublicationRoutes } from "./publication-routes";
import { TemplatePublicationService } from "./publication-service";

/** Request-scoped bindings only. Workers jobs inject their own auth/assets/db instead. */
export function cloudflareTemplatePublicationRoutes() {
  return templatePublicationRoutes({
    enabled: () => process.env.HIVE_TEMPLATE_PUBLICATION_ENABLED === "true",
    session: getRequestSession,
    retain: (task) => getCloudflareContext().ctx.waitUntil(task),
    service: () => {
      const env = getCloudflareContext().env as { ASSETS?: TemplateAssets };
      if (!env.ASSETS) throw new Error("Template artifact binding unavailable");
      return new TemplatePublicationService(getDb(), {
        authorizeActor: publicationActorAuthorizer(getAuthServiceClient()),
        loadArtifact: templateAssetsLoader(env.ASSETS),
      });
    },
  });
}
