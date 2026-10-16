import { getDb } from "@hive/db";
import { redirect } from "next/navigation";
import { NotificationSettings } from "@/components/notification-settings";
import { getRequestSession } from "@/lib/auth/session";
import { getCoderClientForUser } from "@/lib/coder/user-client";

export default async function NotificationsPage() {
  const session = await getRequestSession();
  if (!session) redirect("/login");
  const [sources, workspaceResult] = await Promise.all([
    getDb().notificationSource.findMany({
      where: { userId: session.user.id },
      select: { workspaceId: true, workspaceName: true },
    }),
    getCoderClientForUser(session.user.id)
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
  return (
    <NotificationSettings
      connectedWorkspaceIds={sources.map((source) => source.workspaceId)}
      workspaces={workspaces}
      workspaceError={!workspaceResult}
    />
  );
}
