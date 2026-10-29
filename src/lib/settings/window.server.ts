import { getDb } from "@hive/db";
import type { SessionData } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { SETTINGS_UNAVAILABLE, settingsWindowSchema } from "./window-contracts";

/** The principal comes only from the authenticated route/action, never request input. */
export async function readSettingsWindow(user: SessionData["user"], signal?: AbortSignal) {
  try {
    return await loadSettingsWindow(user, signal);
  } catch {
    signal?.throwIfAborted();
    throw new Error(SETTINGS_UNAVAILABLE);
  }
}

async function loadSettingsWindow(user: SessionData["user"], signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Drain both reads before returning, including failure, so request-local DB
  // clients are not disconnected while the other read is still using them.
  const [sourcesResult, workspaceResult] = await Promise.allSettled([
    getDb().notificationSource.findMany({
      where: { userId: user.id },
      select: { workspaceId: true, workspaceName: true, pendingTokenHash: true },
    }),
    getCoderClientForUser(user.id, { signal }).then((client) => {
      signal?.throwIfAborted();
      return client.listWorkspaces({ owner: "me" });
    }),
  ]);
  signal?.throwIfAborted();
  if (sourcesResult.status !== "fulfilled") throw new Error(SETTINGS_UNAVAILABLE);
  const sources = sourcesResult.value;
  const workspacePage = workspaceResult.status === "fulfilled" ? workspaceResult.value : null;
  try {
    const workspaces =
      workspacePage?.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        running: workspace.latest_build.status === "running",
      })) ?? [];
    const present = new Set(workspaces.map((workspace) => workspace.id));
    for (const source of sources) {
      if (!present.has(source.workspaceId)) {
        workspaces.push({ id: source.workspaceId, name: source.workspaceName, running: false });
        present.add(source.workspaceId);
      }
    }
    return settingsWindowSchema.parse({
      email: user.email,
      coderUrl: user.coderUrl,
      connectedWorkspaceIds: sources.map((source) => source.workspaceId),
      pendingWorkspaceIds: sources
        .filter((source) => source.pendingTokenHash)
        .map((source) => source.workspaceId),
      workspaces,
      workspaceError: !workspacePage,
    });
  } catch {
    throw new Error(SETTINGS_UNAVAILABLE);
  }
}
