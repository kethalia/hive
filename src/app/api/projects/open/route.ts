import { ZodError } from "zod";
import {
  authorizeSessionOwner,
  boundedSessionJson,
  sessionError,
  sessionResponseHeaders,
} from "@/lib/codex-session/route.server";
import { ProjectDiscoveryError } from "@/lib/projects/errors";
import { openProject } from "@/lib/projects/open.server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true")
    return sessionError("discovery_disabled", 404);
  try {
    const session = await authorizeSessionOwner(request);
    if (session instanceof Response) return session;
    if (new URL(request.url).search) return sessionError("invalid_request", 400);
    let input: unknown;
    try {
      input = await boundedSessionJson(request, 4096);
    } catch {
      return sessionError("invalid_request", 400);
    }
    return Response.json(await openProject(session.user, input), {
      headers: sessionResponseHeaders,
    });
  } catch (error) {
    if (error instanceof ZodError) return sessionError("invalid_request", 400);
    if (error instanceof ProjectDiscoveryError)
      return sessionError(error.code, error.code === "github_permission_denied" ? 403 : 502);
    return sessionError("discovery_unavailable", 503);
  }
}
