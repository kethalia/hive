import { z } from "zod";
import { inspectAgentToolsAction } from "@/lib/actions/agent-tools";
import { listGitClonesAction } from "@/lib/actions/git-clones";
import { listTemplateStatusesAction } from "@/lib/actions/templates";
import {
  getWorkspaceAgentAction,
  getWorkspaceSessionsAction,
  listWorkspacesAction,
  listWorkspaceTemplatesAction,
} from "@/lib/actions/workspaces";
import { getRequestSession } from "@/lib/auth/session";
import { discoveryErrorStatus } from "@/lib/discovery/error-status";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const inputSchema = z.object({ workspaceId: z.string().min(1).max(200), refresh: z.boolean() });

// Read-only requests bypass the browser's Server Action queue. Actions invoked here
// run on the server and retain their authentication, ownership checks and schemas.
export async function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
  if (!(await getRequestSession()))
    return Response.json({ error: "Not authenticated" }, { status: 401, headers });
  const { resource } = await context.params;
  const params = new URL(request.url).searchParams;
  const parsed = inputSchema.safeParse({
    workspaceId: params.get("workspaceId"),
    refresh: params.get("refresh") === "1",
  });
  let result: { data?: unknown; serverError?: string; validationErrors?: unknown } | undefined;
  switch (resource) {
    case "workspaces":
      result = await listWorkspacesAction();
      break;
    case "templates":
      result = await listTemplateStatusesAction();
      break;
    case "template-options":
      result = await listWorkspaceTemplatesAction();
      break;
    case "agent":
    case "sessions":
    case "repositories":
    case "agent-tools": {
      if (!parsed.success)
        return Response.json({ error: "Invalid workspace" }, { status: 400, headers });
      const { workspaceId, refresh } = parsed.data;
      if (resource === "agent") result = await getWorkspaceAgentAction({ workspaceId });
      if (resource === "sessions") result = await getWorkspaceSessionsAction({ workspaceId });
      if (resource === "agent-tools")
        result = await inspectAgentToolsAction({ workspaceId, refresh });
      if (resource === "repositories") {
        const response = await listGitClonesAction({ workspaceId, refresh });
        result = response?.data?.ok
          ? { data: response.data.tree }
          : {
              serverError:
                response?.serverError ?? response?.data?.message ?? "Could not read repositories.",
            };
      }
      break;
    }
    default:
      return Response.json({ error: "Unknown discovery resource" }, { status: 404, headers });
  }
  if (result?.data !== undefined) return Response.json({ data: result.data }, { headers });
  const error = result?.serverError ?? "Could not refresh workspace data.";
  const status = result?.validationErrors ? 400 : discoveryErrorStatus(error);
  return Response.json({ error }, { status, headers });
}
