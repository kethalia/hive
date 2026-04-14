import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { WorkspacesClient } from "@/components/workspaces/WorkspacesClient";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const result = await listWorkspacesAction().catch((err) => {
    console.error(
      `[workspaces/page] Failed to load workspaces: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  });

  const workspaces = result?.data ?? [];

  return <WorkspacesClient initialWorkspaces={workspaces} />;
}
