import { getRequestSession } from "@/lib/auth/session";
import { projectErrorMessages, projectRequestSchema } from "@/lib/projects/contracts";
import { discoverWorkspaceProjects, ProjectDiscoveryError } from "@/lib/projects/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true")
    return Response.json({ error: "discovery_disabled" }, { status: 404, headers });
  const session = await getRequestSession();
  if (!session) return Response.json({ error: "not_authenticated" }, { status: 401, headers });
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return Response.json({ error: "invalid_origin" }, { status: 403, headers });
  const query = new URL(request.url).searchParams;
  const keys = [...query.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !["workspaceId", "page", "perPage"].includes(key)) ||
    [query.get("page"), query.get("perPage")].some(
      (value) => value !== null && !/^[1-9][0-9]{0,4}$/.test(value),
    )
  )
    return Response.json({ error: "invalid_request" }, { status: 400, headers });
  const input = {
    workspaceId: query.get("workspaceId"),
    page: Number(query.get("page") ?? 1),
    perPage: Number(query.get("perPage") ?? 100),
  };
  // Validate before accessing the workspace transport; nothing caller-supplied selects an API origin.
  const parsed = projectRequestSchema.safeParse(input);
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  try {
    return Response.json(await discoverWorkspaceProjects(session.user, parsed.data), { headers });
  } catch (error) {
    const code = error instanceof ProjectDiscoveryError ? error.code : "discovery_unavailable";
    const status =
      code === "workspace_forbidden" ? 403 : code === "github_auth_required" ? 401 : 502;
    return Response.json({ error: code, message: projectErrorMessages[code] }, { status, headers });
  }
}
