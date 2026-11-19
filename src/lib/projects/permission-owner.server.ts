import { getDb } from "@hive/db";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import type { workspaceBinding } from "./installation.server";

type Binding = NonNullable<ReturnType<typeof workspaceBinding>>;
export async function ownsGrantWorkspace(
  workspaceId: string,
  binding: Binding,
  user: { id: string; coderUserId: string },
  signal?: AbortSignal,
) {
  if (user.coderUserId !== binding.ownerId) return false;
  const coder = await getCoderClientForUser(user.id, { signal });
  const workspace = await coder.getWorkspace(workspaceId, signal);
  return (
    workspace.id === workspaceId &&
    workspace.template_id === binding.templateId &&
    workspace.owner_id === binding.ownerId &&
    workspace.latest_build.status === "running"
  );
}

export async function isActiveGrantWorkspace(
  workspaceId: string,
  binding: Binding,
  signal?: AbortSignal,
) {
  const origin = process.env.CODER_URL;
  if (!origin) return false;
  const user = await getDb().user.findUnique({
    where: {
      coderUrl_coderUserId: { coderUrl: new URL(origin).origin, coderUserId: binding.ownerId },
    },
    select: { id: true, coderUserId: true },
  });
  return !!user && ownsGrantWorkspace(workspaceId, binding, user, signal);
}
