import { z } from "zod";
import { AccessDenied, repositoryCredential } from "@/lib/projects/grants.server";
import { matchesWorkspaceKey, workspaceBinding } from "@/lib/projects/installation.server";
import { isActiveGrantWorkspace } from "@/lib/projects/permission-owner.server";
import { repoName } from "@/lib/projects/permissions";
import { publicationBody } from "@/lib/templates/publication-io";

const input = z.object({ workspaceId: z.string().uuid(), repository: repoName }).strict();
const reply = (data: unknown, status: number) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", Vary: "Authorization" } });
export async function POST(request: Request) {
  if (
    process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true" ||
    new URL(request.url).origin !== process.env.HIVE_PUBLIC_ORIGIN ||
    request.headers.has("origin") ||
    request.headers.has("cookie")
  )
    return reply({}, 403);
  let command: z.infer<typeof input>;
  try {
    const bytes = await publicationBody(
      new Response(request.body, { headers: request.headers }),
      2048,
      request.signal,
    );
    command = input.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return reply({}, 400);
  }
  try {
    const binding = workspaceBinding(command.workspaceId);
    if (!binding || !matchesWorkspaceKey(request.headers.get("authorization"), binding.keyHash))
      return reply({}, 403);
    const repo = binding.repositories.find(
      (r) => r.name.toLowerCase() === command.repository.toLowerCase(),
    );
    if (!repo || !(await isActiveGrantWorkspace(command.workspaceId, binding, request.signal)))
      return reply({}, 403);
    const { token } = await repositoryCredential(command.workspaceId, repo);
    return reply({ token }, 200);
  } catch (error) {
    return reply({}, error instanceof AccessDenied ? 403 : 503);
  }
}
