import { getDb } from "@hive/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ZodError } from "zod";
import { lockProducerAdmission } from "@/lib/codex-session/guardian-store.server";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { boundedSessionJson, sessionService } from "@/lib/codex-session/route.server";
import { type EvidenceR2Bucket, R2GitHubArtifactStore } from "./github-artifacts.server";
import { resolveControllerSourcePolicy } from "./source-policy.server";
import { SourcePublicationTransport } from "./source-transport.server";
import { DeliveryConflict } from "./state";

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
export async function sourcePublicationRoute(
  request: Request,
  phase: "policy" | "challenge" | "publish",
) {
  if (
    process.env.HIVE_DELIVERY_SOURCE_PUBLICATION_ENABLED !== "true" ||
    process.env.HIVE_DELIVERY_MANAGER_ENABLED !== "true"
  )
    return json({ error: "source_publication_disabled" }, 404);
  if (request.headers.has("origin")) return json({ error: "host_authentication_required" }, 403);
  if (new URL(request.url).search) return json({ error: "invalid_request" }, 400);
  let value: unknown;
  try {
    value = await boundedSessionJson(request, 65536);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  try {
    const { env } = await getCloudflareContext({ async: true });
    const bucket = (env as unknown as { HIVE_DELIVERY_EVIDENCE?: EvidenceR2Bucket })
      .HIVE_DELIVERY_EVIDENCE;
    if (!bucket) throw new Error("Source proof binding unavailable");
    const sessions = sessionService();
    const transport = new SourcePublicationTransport(
      getDb(),
      {
        reauthorize: (binding) => sessions.authority.reauthorize(binding),
        lockProducerAdmission: (tx, scope) => lockProducerAdmission(tx, scope),
        resolvePolicy: (scope) => resolveControllerSourcePolicy(scope),
      },
      new R2GitHubArtifactStore(bucket),
    );
    return json(
      await (phase === "policy"
        ? transport.policy(value)
        : phase === "challenge"
          ? transport.issue(value)
          : transport.publish(value)),
    );
  } catch (error) {
    if (error instanceof ZodError) return json({ error: "invalid_request" }, 400);
    if (error instanceof RegistrationRejected)
      return json({ error: "host_authentication_required" }, 403);
    if (error instanceof DeliveryConflict) return json({ error: error.code }, 409);
    return json({ error: "source_publication_unavailable" }, 503);
  }
}
