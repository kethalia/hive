import { z } from "zod";
import { AgentBridgeError } from "@/lib/agents/portable-client.server";
import { createProjectDiscoveryService } from "@/lib/agents/portable-config.server";
import { getRequestSession } from "@/lib/auth/session";
import { githubRevision } from "@/lib/projects/github-connection";
import { workspaceBinding } from "@/lib/projects/installation.server";
import { ownsGrantWorkspace } from "@/lib/projects/permission-owner.server";
import { publicationBody } from "@/lib/templates/publication-io";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
const scope = z.object({ workspaceId: z.string().uuid(), buildId: z.string().uuid() });
const command = z.union([
  scope.extend({ action: z.literal("status") }).strict(),
  scope.extend({ action: z.literal("start"), revision: githubRevision }).strict(),
  scope
    .extend({ action: z.enum(["poll", "cancel", "disconnect"]), revision: githubRevision })
    .strict(),
]);

export async function POST(request: Request) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true") return json({}, 404);
  const origin = process.env.HIVE_PUBLIC_ORIGIN;
  if (
    !origin ||
    new URL(request.url).origin !== origin ||
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    request.headers.get("content-type") !== "application/json"
  )
    return json({}, 403);
  const session = await getRequestSession();
  if (!session) return json({}, 401);
  let input: z.infer<typeof command>;
  try {
    const bytes = await publicationBody(
      new Response(request.body, { headers: request.headers }),
      2048,
      request.signal,
    );
    input = command.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return json({}, 400);
  }
  const { workspaceId, buildId, ...action } = input;
  try {
    const binding = workspaceBinding(workspaceId);
    if (binding) {
      if (!(await ownsGrantWorkspace(workspaceId, binding, session.user, request.signal)))
        return json({}, 403);
      if (action.action !== "status") return json({ error: "workspace_forbidden" }, 403);
      return json({ managed: true });
    }
    const result = await createProjectDiscoveryService().execute<"github-connection">(
      { hiveUserId: session.user.id, coderUserId: session.user.coderUserId },
      workspaceId,
      {
        operation: "github-connection",
        connection: action,
      },
      request.signal,
      buildId,
    );
    if ("error" in result) return json({ error: result.error }, 502);
    return json(result);
  } catch (error) {
    return json(
      {
        error:
          error instanceof AgentBridgeError && error.code === "unsupported"
            ? "unsupported_schema"
            : "workspace_unavailable",
      },
      502,
    );
  }
}
