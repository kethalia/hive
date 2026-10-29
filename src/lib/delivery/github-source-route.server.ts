import { getDb } from "@hive/db";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ZodError, z } from "zod";
import { RegistrationRejected } from "@/lib/codex-session/registration-store.server";
import { boundedSessionJson, sessionService } from "@/lib/codex-session/route.server";
import { type EvidenceR2Bucket, R2GitHubArtifactStore } from "./github-artifacts.server";
import { GitHubSourceTransport } from "./github-transport.server";
import { DeliveryConflict } from "./state";

const response = (error: string, status: number) =>
  Response.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
export async function githubSourceRoute(request: Request, phase: "challenge" | "snapshot") {
  if (
    process.env.HIVE_DELIVERY_GITHUB_SOURCE_ENABLED !== "true" ||
    process.env.HIVE_DELIVERY_MANAGER_ENABLED !== "true"
  )
    return response("github_source_disabled", 404);
  if (request.headers.has("origin")) return response("host_authentication_required", 403);
  if (new URL(request.url).search) return response("invalid_request", 400);
  let value: unknown;
  try {
    value = await boundedSessionJson(request, phase === "challenge" ? 65536 : 1152 * 1024);
  } catch {
    return response("invalid_request", 400);
  }
  try {
    const raw = process.env.HIVE_DELIVERY_GITHUB_TARGETS_JSON;
    if (!raw || Buffer.byteLength(raw) > 65536) throw new Error("Source policy unavailable");
    // A controller-owned exact task map is the bounded initial policy boundary.
    // User/host JSON and repository files cannot install target/producer policy.
    const targets = z.record(z.string().uuid(), z.unknown()).parse(JSON.parse(raw));
    if (Object.keys(targets).length > 100) throw new Error("Source policy unavailable");
    const { env } = await getCloudflareContext({ async: true });
    const bucket = (env as unknown as { HIVE_DELIVERY_EVIDENCE?: EvidenceR2Bucket })
      .HIVE_DELIVERY_EVIDENCE;
    if (!bucket) throw new Error("Evidence binding unavailable");
    const sessions = sessionService();
    const service = new GitHubSourceTransport(
      getDb(),
      {
        reauthorize: (binding) => sessions.authority.reauthorize(binding),
        resolveTargetPolicy: ({ taskId }) => {
          if (!Object.hasOwn(targets, taskId))
            throw new DeliveryConflict("github_task_policy_missing");
          return targets[taskId];
        },
      },
      new R2GitHubArtifactStore(bucket),
    );
    const result =
      phase === "challenge" ? await service.requestChallenge(value) : await service.ingest(value);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ZodError) return response("invalid_request", 400);
    if (error instanceof RegistrationRejected) return response("host_authentication_required", 403);
    if (error instanceof DeliveryConflict) return response(error.code, 409);
    return response("github_source_unavailable", 503);
  }
}
