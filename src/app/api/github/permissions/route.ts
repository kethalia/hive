import { z } from "zod";
import { getRequestSession } from "@/lib/auth/session";
import { GrantConflict, readGrants, repositoryCredential } from "@/lib/projects/grants.server";
import { workspaceBinding } from "@/lib/projects/installation.server";
import { ownsGrantWorkspace } from "@/lib/projects/permission-owner.server";
import { accessLevel, repoId } from "@/lib/projects/permissions";
import { publicationBody } from "@/lib/templates/publication-io";

const input = z
  .object({
    workspaceId: z.string().uuid(),
    change: z
      .object({ repoId, access: accessLevel, revision: z.string().uuid().nullable() })
      .strict()
      .optional(),
  })
  .strict();
const reply = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
export async function POST(request: Request) {
  if (process.env.HIVE_PROJECT_DISCOVERY_ENABLED !== "true") return reply({}, 404);
  const origin = process.env.HIVE_PUBLIC_ORIGIN;
  if (
    !origin ||
    new URL(request.url).origin !== origin ||
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    request.headers.get("content-type") !== "application/json"
  )
    return reply({}, 403);
  const session = await getRequestSession();
  if (!session) return reply({}, 401);
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
    const { workspaceId, change } = command;
    const binding = workspaceBinding(workspaceId);
    if (!binding) return reply({ managed: false, repositories: [] }, change ? 409 : 200);
    if (!(await ownsGrantWorkspace(workspaceId, binding, session.user, request.signal)))
      return reply({}, 403);
    if (change) {
      const repo = binding.repositories.find((repo) => repo.id === change.repoId);
      if (!repo) return reply({}, 403);
      await repositoryCredential(workspaceId, repo, change);
    }
    return reply({
      managed: true,
      repositories: await readGrants(workspaceId, binding.repositories),
    });
  } catch (error) {
    return reply({}, error instanceof GrantConflict ? 409 : 502);
  }
}
