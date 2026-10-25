"use server";
import { getDb } from "@hive/db";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { authActionClient } from "@/lib/safe-action";

export const getSettingsWindowAction = authActionClient.action(async ({ ctx }) => {
  const [sources, workspaceResult] = await Promise.all([
    getDb().notificationSource.findMany({
      where: { userId: ctx.user.id },
      select: { workspaceId: true, workspaceName: true, pendingTokenHash: true },
    }),
    getCoderClientForUser(ctx.user.id)
      .then((client) => client.listWorkspaces({ owner: "me" }))
      .catch(() => null),
  ]);
  const workspaces =
    workspaceResult?.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      running: workspace.latest_build.status === "running",
    })) ?? [];
  for (const source of sources) {
    if (!workspaces.some((workspace) => workspace.id === source.workspaceId)) {
      workspaces.push({ id: source.workspaceId, name: source.workspaceName, running: false });
    }
  }
  return {
    email: ctx.user.email,
    coderUrl: ctx.user.coderUrl,
    connectedWorkspaceIds: sources.map((source) => source.workspaceId),
    pendingWorkspaceIds: sources
      .filter((source) => source.pendingTokenHash)
      .map((source) => source.workspaceId),
    workspaces,
    workspaceError: !workspaceResult,
  };
});
