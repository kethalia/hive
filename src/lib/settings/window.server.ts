import { getDb } from "@hive/db";
import type { SessionData } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { SETTINGS_UNAVAILABLE, settingsWindowSchema } from "./window-contracts";

/** Identity comes from the authenticated route/action, never request fields. */
export async function readSettingsWindow(user: SessionData["user"], callerSignal?: AbortSignal) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(15_000),
    ...(callerSignal ? [callerSignal] : []),
  ]);
  try {
    signal.throwIfAborted();
    // Drain both reads even after failure; request-local database teardown must
    // not race an outstanding credential or notification-source query.
    const [sourcesResult, workspaceResult] = await Promise.allSettled([
      getDb().notificationSource.findMany({
        where: { userId: user.id },
        select: { workspaceId: true, workspaceName: true, pendingTokenHash: true },
      }),
      getCoderClientForUser(user.id, { signal }).then((client) => {
        signal.throwIfAborted();
        return client.listWorkspaces({ owner: "me" });
      }),
    ]);
    signal.throwIfAborted();
    if (sourcesResult.status !== "fulfilled") throw new Error(SETTINGS_UNAVAILABLE);
    const sources = sourcesResult.value;
    const page = workspaceResult.status === "fulfilled" ? workspaceResult.value : null;
    const workspaces =
      page?.workspaces.map((workspace) => ({
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
      workspaceError: !page,
    });
  } catch {
    callerSignal?.throwIfAborted();
    throw new Error(SETTINGS_UNAVAILABLE);
  }
}
