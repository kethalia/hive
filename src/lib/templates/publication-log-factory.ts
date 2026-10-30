import { getDb } from "@hive/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getAuthServiceClient } from "@/lib/auth/service-client";
import { getRequestSession } from "@/lib/auth/session";
import { publicationActorAuthorizer } from "./publication-actor";
import { templateLogRoute } from "./publication-log-routes";
import { TemplatePublicationLogService } from "./publication-log-service";

export function cloudflareTemplatePublicationLogRoute() {
  return templateLogRoute({
    enabled: () => process.env.HIVE_TEMPLATE_LOG_VIEW_ENABLED === "true",
    session: getRequestSession,
    retain: (task) => getCloudflareContext().ctx.waitUntil(task),
    service: () =>
      new TemplatePublicationLogService(
        getDb(),
        publicationActorAuthorizer(getAuthServiceClient()),
      ),
  });
}
